import type { S3ClientConfig } from '@aws-sdk/client-s3';
import type { Config, Source } from './model.ts';
import { inventorySource } from './inventory.ts';

export const demoObjects = [
  ...Array.from({ length: 1250 }, (_, i) => ({ key: `customers/acme/file-${i}.pdf`, bytes: 2_000_000 })),
  ...Array.from({ length: 750 }, (_, i) => ({ key: `customers/northwind/file-${i}.png`, bytes: 4_000_000 })),
  ...Array.from({ length: 500 }, (_, i) => ({ key: `customers/東京/file-${i}.txt`, bytes: 1000 })),
  ...Array.from({ length: 5 }, (_, i) => ({ key: `system/log-${i}`, bytes: 100_000 }))
];

export async function createSource(config: Config, sdkOptions: Pick<S3ClientConfig, 'requestHandler'> = {}, signal?: AbortSignal): Promise<Source> {
  if (config.provider === 'inventory') return inventorySource(config, signal);
  if (config.provider === 'demo') return {
    async page(cursor, maxKeys, signal) {
      signal.throwIfAborted();
      const rows = demoObjects.filter(x => x.key.startsWith(config.prefix));
      const start = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid demo cursor.');
      const end = Math.min(start + maxKeys, rows.length);
      return { objects: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null };
    },
    close() {}
  };
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  if (config.provider === 'r2' && (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)) {
    throw new Error('Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in your environment.');
  }
  const suffix = config.jurisdiction && config.jurisdiction !== 'default' ? `.${config.jurisdiction}` : '';
  const client = new S3Client({
    region: config.region,
    endpoint: config.provider === 'r2' ? `https://${config.accountId}${suffix}.r2.cloudflarestorage.com` : undefined,
    forcePathStyle: config.provider === 'r2',
    maxAttempts: 4,
    retryMode: 'standard',
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000 },
    ...sdkOptions,
    credentials: config.provider === 'r2' ? {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      sessionToken: process.env.R2_SESSION_TOKEN
    } : undefined
  });
  return {
    async page(cursor, maxKeys, signal) {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket, Prefix: config.prefix || undefined,
        ContinuationToken: cursor ?? undefined, MaxKeys: maxKeys
      }), { abortSignal: signal });
      if (response.IsTruncated && !response.NextContinuationToken) {
        throw new Error('Provider returned a truncated page without a continuation token.');
      }
      return {
        objects: (response.Contents ?? []).map(x => {
          if (x.Key === undefined || x.Size === undefined) throw new Error('Provider omitted an object key or size.');
          return { key: x.Key, bytes: x.Size };
        }),
        nextCursor: response.IsTruncated ? response.NextContinuationToken! : null
      };
    },
    close() { client.destroy(); }
  };
}
