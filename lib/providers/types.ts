export type ProviderKind = 'aws_s3' | 'cloudflare_r2';

export type ObjectRecord = {
  key: string;
  sizeBytes: number;
  lastModified: Date | null;
  storageClass: string | null;
  etag: string | null;
};

export type ScanPage = {
  objects: ObjectRecord[];
  nextCursor: string | null;
};

export type StorageConnectionConfig = {
  provider: ProviderKind;
  bucket: string;
  region?: string | null;
  endpoint?: string | null;
  accountId?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  roleArn?: string | null;
  externalId?: string | null;
};

export interface ObjectStorageProvider {
  testConnection(): Promise<{ bucket: string }>;
  scanPage(cursor?: string | null): Promise<ScanPage>;
}
