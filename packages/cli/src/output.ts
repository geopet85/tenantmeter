import { link, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type Content = string | Iterable<string>;

// Batch small rows to avoid a system call for every tenant. Bound encoded buffers
// even when a single metadata field is larger than the target batch size.
export function* batches(content: Content): Generator<Buffer> {
  const chunks = typeof content === 'string' ? [content] : content;
  const size = 64 * 1024;
  let parts: Buffer[] = [];
  let length = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk);
    for (let offset = 0; offset < bytes.length;) {
      const end = Math.min(bytes.length, offset + size - length);
      parts.push(bytes.subarray(offset, end));
      length += end - offset;
      offset = end;
      if (length === size) { yield Buffer.concat(parts, length); parts = []; length = 0; }
    }
  }
  if (length) yield Buffer.concat(parts, length);
}

export async function writeOutput(content: Content, destination: Writable, signal?: AbortSignal) {
  await pipeline(Readable.from(batches(content), {objectMode: false, highWaterMark: 64 * 1024}), destination, {signal});
}

export async function exportFile(path: string, content: Content, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const temp = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const file = await open(temp, 'wx', 0o600);
    created = true;
    try { await file.writeFile(batches(content), {signal}); await file.sync(); }
    finally { await file.close(); }
    // Publish a complete report atomically without replacing an existing path.
    signal?.throwIfAborted();
    await link(temp, path);
  } finally { if (created) await rm(temp, {force: true}); }
}
