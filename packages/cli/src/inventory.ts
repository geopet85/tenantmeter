import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { csvRows, columns, decimalBytes } from './csv.ts';
import type { Config, ObjectRow, Source } from './model.ts';

const preparedConfigurations = new WeakSet<Config>();

export async function fileHashes(path: string, signal?: AbortSignal) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  const input = createReadStream(path, { signal });
  for await (const chunk of input) { sha256.update(chunk); md5.update(chunk); }
  return { sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}
function indexColumns(names: string[]) { return Object.fromEntries(names.map((name, index) => [name, index])); }
function schema(value: string | string[]) {
  const names = columns(value);
  if (!['Bucket', 'Key', 'Size'].every(x => names.includes(x))) throw new Error('Inventory columns must include Bucket, Key, and Size.');
  if (names.includes('VersionId') && (!names.includes('IsLatest') || !names.includes('IsDeleteMarker'))) {
    throw new Error('Versioned inventory requires IsLatest and IsDeleteMarker columns.');
  }
  return names;
}
export async function prepareInventory(config: Config, options: {
  input?: string; manifest?: string; root?: string; columns?: string; rawKeys?: boolean;
}, signal?: AbortSignal): Promise<Config> {
  let paths: { path: string; size?: number; md5?: string }[];
  let names: string[] | undefined;
  let createdAt: string | undefined;
  let bucket = config.bucket;
  if (options.manifest) {
    const path = resolve(options.manifest);
    const raw = await readFile(path, {signal});
    const checksum = (await readFile(resolve(dirname(path), 'manifest.checksum'), 'utf8')).trim();
    if (!/^[a-f0-9]{32}$/i.test(checksum) || createHash('md5').update(raw).digest('hex') !== checksum.toLowerCase()) {
      throw new Error('Inventory manifest checksum does not match manifest.checksum.');
    }
    const manifest = JSON.parse(raw.toString('utf8'));
    if (manifest.fileFormat !== 'CSV' || typeof manifest.fileSchema !== 'string' || !Array.isArray(manifest.files) || !manifest.files.length) {
      throw new Error('Only CSV inventory manifests with at least one file are supported.');
    }
    const sourceBucket = String(manifest.sourceBucket ?? '').replace(/^arn:aws[^:]*:s3:::/, '');
    if (!sourceBucket || (bucket && bucket !== sourceBucket)) throw new Error('Inventory manifest source bucket does not match --bucket.');
    bucket = sourceBucket;
    const timestamp = Number(manifest.creationTimestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isFinite(new Date(timestamp).getTime())) throw new Error('Inventory manifest has an invalid creationTimestamp.');
    createdAt = new Date(timestamp).toISOString();
    names = schema(manifest.fileSchema);
    const root = await realpath(resolve(options.root ?? dirname(path)));
    paths = await Promise.all(manifest.files.map(async (entry: { key?: unknown; size?: unknown; MD5checksum?: unknown }) => {
      if (typeof entry.key !== 'string' || !entry.key || entry.key.includes('\\') || isAbsolute(entry.key) ||
          entry.key.split('/').some(x => x === '..' || x === '.' || !x) ||
          typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
          typeof entry.MD5checksum !== 'string' || !/^[a-f0-9]{32}$/i.test(entry.MD5checksum)) throw new Error('Invalid file entry in inventory manifest.');
      const local = await realpath(resolve(root, entry.key));
      const distance = relative(root, local);
      if (distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) throw new Error('Inventory file escapes --inventory-root.');
      return { path: local, size: entry.size, md5: entry.MD5checksum.toLowerCase() };
    }));
  } else {
    if (!options.input || !bucket) throw new Error('Inventory input requires --input FILE and --bucket NAME.');
    names = options.columns ? schema(options.columns) : undefined;
    paths = [{ path: await realpath(resolve(options.input)) }];
  }
  if (new Set(paths.map(x => x.path)).size !== paths.length) throw new Error('Inventory manifest lists the same file more than once.');
  const files = [];
  for (const file of paths) {
    const info = await stat(file.path);
    if (!info.isFile() || (file.size !== undefined && file.size !== info.size)) throw new Error('Inventory file size does not match the manifest.');
    const hashes = await fileHashes(file.path, signal);
    if (file.md5 && hashes.md5 !== file.md5) throw new Error('Inventory file MD5 checksum does not match the manifest.');
    files.push({ path: file.path, sha256: hashes.sha256 });
  }
  const prepared = { ...config, bucket, inventory: { files, columns: names, encodedKeys: !options.rawKeys, createdAt } };
  preparedConfigurations.add(prepared);
  return prepared;
}

type InventoryRow = { object: ObjectRow; cursor: string };
async function* objects(config: Config, signal: AbortSignal, startFile = 0, startRow = 0): AsyncGenerator<InventoryRow> {
  const inventory = config.inventory!;
  for (let fileIndex = startFile; fileIndex < inventory.files.length; fileIndex++) {
    const file = inventory.files[fileIndex];
    const skipRows = fileIndex === startFile ? startRow : 0;
    let rowIndex = 0;
    const input = createReadStream(file.path, { signal });
    const hash = createHash('sha256');
    input.on('data', chunk => hash.update(chunk));
    const gzip = file.path.endsWith('.gz') ? createGunzip() : undefined;
    if (gzip) input.on('error', error => gzip.destroy(error));
    const stream = gzip ? input.pipe(gzip) : input;
    let names = inventory.columns;
    let indices = names ? indexColumns(names) : undefined;
    try {
      for await (const row of csvRows(stream)) {
        signal.throwIfAborted();
        if (!names) { names = schema(row); indices = indexColumns(names); continue; }
        rowIndex++;
        if (rowIndex <= skipRows) continue;
        if (row.length !== names.length) throw new Error('Inventory row has the wrong number of columns.');
        const value = (name: string) => row[indices![name]];
        if (Object.hasOwn(indices!, 'IsLatest') && !['true', 'false'].includes(value('IsLatest'))) throw new Error('Invalid IsLatest value in inventory.');
        if (Object.hasOwn(indices!, 'IsDeleteMarker') && !['true', 'false'].includes(value('IsDeleteMarker'))) throw new Error('Invalid IsDeleteMarker value in inventory.');
        if ((Object.hasOwn(indices!, 'IsLatest') && value('IsLatest') !== 'true') || (Object.hasOwn(indices!, 'IsDeleteMarker') && value('IsDeleteMarker') === 'true')) continue;
        if (value('Bucket') !== config.bucket) continue;
        let key = value('Key');
        if (inventory.encodedKeys) {
          try { key = decodeURIComponent(key); } catch { throw new Error('Inventory key has invalid URL encoding. Use --raw-keys only for an unencoded export.'); }
        }
        const size = decimalBytes(value('Size'), 'Inventory Size');
        if (!Number.isSafeInteger(Number(size))) throw new Error('Inventory object size exceeds the safe integer range.');
        if (key.startsWith(config.prefix)) yield { object: { key, bytes: Number(size) }, cursor: `v2:${fileIndex}:${rowIndex}` };
      }
      if (rowIndex < skipRows) throw new Error('Inventory cursor exceeds the file contents.');
      if (!names) throw new Error('Inventory has no CSV header. Supply --columns for a headerless file.');
      if (hash.digest('hex') !== file.sha256) throw new Error('Inventory file changed while reading. Start a fresh scan from an unchanged export.');
    } finally { input.destroy(); gzip?.destroy(); }
  }
}

export async function inventorySource(config: Config, signal?: AbortSignal): Promise<Source> {
  if (!config.inventory?.files.length) throw new Error('Inventory checkpoint has no files.');
  // Only skip the duplicate preflight for this process's just-prepared configuration.
  // Loaded/resumed checkpoints must rehash all files before accepting any saved totals.
  if (!preparedConfigurations.delete(config)) for (const file of config.inventory.files) {
    if ((await fileHashes(file.path, signal)).sha256 !== file.sha256) throw new Error('Inventory file changed since this scan started. Start a new scan.');
  }
  let iterator: AsyncGenerator<InventoryRow> | undefined;
  let position = 0;
  let pending: IteratorResult<InventoryRow> | undefined;
  let expectedCursor: string | null = null;
  return {
    async page(cursor, maxKeys, signal) {
      if (!iterator) {
        const location = cursor?.match(/^v2:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/);
        if (location) {
          const fileIndex = Number(location[1]);
          const rowIndex = Number(location[2]);
          if (!Number.isSafeInteger(fileIndex) || fileIndex >= config.inventory!.files.length ||
              !Number.isSafeInteger(rowIndex)) throw new Error('Invalid inventory cursor.');
          iterator = objects(config, signal, fileIndex, rowIndex);
        } else {
          if (cursor !== null && !/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error('Invalid inventory cursor.');
          const offset = cursor === null ? 0 : Number(cursor);
          if (!Number.isSafeInteger(offset)) throw new Error('Invalid inventory cursor.');
          // Version 1 checkpoints counted emitted objects across the complete export.
          iterator = objects(config, signal);
          while (position < offset) {
            if ((await iterator.next()).done) throw new Error('Inventory cursor exceeds the file contents.');
            position++;
          }
        }
        expectedCursor = cursor;
      }
      if (cursor !== expectedCursor) throw new Error('Inventory cursor is out of sequence.');
      const page: ObjectRow[] = [];
      while (page.length < maxKeys) {
        const next = pending ?? await iterator.next();
        pending = undefined;
        if (next.done) break;
        page.push(next.value.object); expectedCursor = next.value.cursor;
      }
      pending = await iterator.next();
      return { objects: page, nextCursor: pending.done ? null : expectedCursor };
    },
    close() { void iterator?.return(undefined).catch(() => {}); }
  };
}
