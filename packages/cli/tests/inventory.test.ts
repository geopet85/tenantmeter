import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { csvRows } from '../src/csv.ts';
import { prepareInventory, inventorySource } from '../src/inventory.ts';
import { compareCounters, renderComparison } from '../src/compare.ts';
import { newState, type Config } from '../src/model.ts';
import { scan } from '../src/scan.ts';
import { options } from '../src/options.ts';
const config: Config = { provider: 'inventory', bucket: 'test', pattern: 'customers/{tenant_id}/*', prefix: '', region: 'auto' };
async function collect(text: string) {
  async function* chunks() { for (const byte of Buffer.from(text)) yield Buffer.from([byte]); }
  const rows: string[][] = []; for await (const row of csvRows(chunks())) rows.push(row); return rows;
}
async function run(config: Config, maxObjects = Infinity, state = newState(config)) {
  const source = await inventorySource(config);
  try { return await scan({ source, state, maxObjects, signal: new AbortController().signal, save: async () => {} }); }
  finally { source.close(); }
}
test('CSV handles byte boundaries, Unicode, BOM, escaped quotes, CRLF and multiline fields', async () => {
  assert.deepEqual(await collect('\uFEFFa,b\r\n"東京","a""b\r\nc"\r\n\r\nx,\n'), [['a','b'], ['東京','a"b\r\nc'], ['x','']]);
  for (const value of ['"unclosed', 'a"b,c', '"a"x,b']) await assert.rejects(collect(value), /CSV/);
  async function* large() { yield 'a'.repeat(1_048_577); }
  await assert.rejects(async () => { for await (const _ of csvRows(large())) {} }, /exceeds/);
  await assert.rejects(collect(Array(257).fill('a').join(',')), /columns/);
});
test('inventory decodes keys, filters buckets and versions, resumes exactly and rejects changed input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-inventory-'));
  try {
    const path = join(dir, 'inventory.csv');
    const text = 'Bucket,Key,VersionId,IsLatest,IsDeleteMarker,Size\n' +
      'test,customers%2Facme%2Fa,v1,true,false,10\n' + 'test,customers%2Facme%2Fa,v0,false,false,99\n' +
      'test,customers%2Fdeleted%2Fa,v1,true,true,\n' + 'other,customers%2Facme%2Fa,v1,true,false,88\n' +
      'test,customers%2F%E6%9D%B1%E4%BA%AC%2Fa,v1,true,false,20\n' + 'test,system%2Fa,v1,true,false,3\n';
    await writeFile(path, text);
    const prepared = await prepareInventory(config, { input: path });
    const partial = await run(prepared, 1); assert.equal(partial.reason, 'object-limit');
    const result = await run(prepared, Infinity, partial);
    assert.equal(result.bytes, '33'); assert.equal(result.objects, 3); assert.equal(result.tenants['東京'].bytes, '20');
    assert.equal(result.unmatched.bytes, '3');
    await writeFile(path, text + 'test,new,v1,true,false,1\n'); await assert.rejects(inventorySource(prepared), /changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('manifest verifies MD5 and gzip data, records snapshot time and rejects traversal/checksum failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-manifest-'));
  const digest = (data: string | Buffer) => createHash('md5').update(data).digest('hex');
  try {
    await mkdir(join(dir, 'data'));
    const data = gzipSync('test,customers%2Facme%2Fa,7\ntest,customers%2Facme%2Fb,8\n');
    await writeFile(join(dir, 'data/part.csv.gz'), data);
    const manifest = { sourceBucket: 'arn:aws:s3:::test', creationTimestamp: '1767225600000', fileFormat: 'CSV', fileSchema: 'Bucket, Key, Size', files: [{key: 'data/part.csv.gz', size: data.length, MD5checksum: digest(data)}] };
    const path = join(dir, 'manifest.json');
    async function save() { const raw = JSON.stringify(manifest); await writeFile(path, raw); await writeFile(join(dir, 'manifest.checksum'), digest(raw)); }
    await save();
    const prepared = await prepareInventory({...config, bucket: ''}, { manifest: path, root: dir });
    assert.equal(prepared.inventory?.createdAt, '2026-01-01T00:00:00.000Z'); assert.equal((await run(prepared)).bytes, '15');
    manifest.files[0].key = '../escape'; await save(); await assert.rejects(prepareInventory(config, {manifest: path}), /Invalid file/);
    manifest.files[0].key = 'data/part.csv.gz'; manifest.files[0].MD5checksum = '0'.repeat(32); await save();
    await assert.rejects(prepareInventory(config, {manifest: path}), /MD5/);
    await writeFile(join(dir, 'manifest.checksum'), '0'.repeat(32)); await assert.rejects(prepareInventory(config, {manifest: path}), /manifest checksum/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('inventory rejects bad schemas, unsafe sizes, invalid encoding, row lengths and broken gzip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-bad-inventory-'));
  try {
    const path = join(dir, 'input.csv');
    for (const text of ['Key,Size\nx,1\n', 'Bucket,Key,Size\ntest,x,9007199254740992\n', 'Bucket,Key,Size\ntest,%ZZ,1\n', 'Bucket,Key,Size\ntest,x,-1\n', 'Bucket,Key,Size\ntest,x,1,extra\n', 'Bucket,Key,VersionId,Size\ntest,x,v1,1\n']) {
      await writeFile(path, text); await assert.rejects(run(await prepareInventory(config, {input: path})));
    }
    await writeFile(path, 'test,customers/a/x,1\n');
    assert.equal((await run(await prepareInventory(config, {input: path, columns: 'Bucket,Key,Size', rawKeys: true}))).bytes, '1');
    const gzip = join(dir, 'bad.csv.gz'); await writeFile(gzip, 'invalid gzip');
    await assert.rejects(run(await prepareInventory(config, {input: gzip, columns: 'Bucket,Key,Size'})));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('comparison preserves big integer deltas and missing zero counters; partial/duplicate inputs fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-compare-'));
  try {
    const path = join(dir, 'counters.csv'); const state = newState(config);
    await assert.rejects(compareCounters(state, path), /complete/);
    state.status = 'complete'; state.finishedAt = new Date().toISOString();
    state.tenants = { a: { bytes: '18014398509481982', objects: 2 }, '=1+1': {bytes: '0', objects: 1} };
    await writeFile(path, 'tenant_id,bytes\na,18014398509481980\nmissing,0\n');
    const result = await compareCounters(state, path); assert.equal(result.different, 3);
    assert.equal(result.rows.find(x => x.tenantId === 'a')?.deltaBytes, '2'); assert.match(renderComparison(result, 'csv', 20), /"'=1\+1"/);
    for (const text of ['tenant_id,bytes\na,1\na,2\n', 'tenant_id,bytes\na,1.2\n', 'bytes,tenant_id\n', '']) {
      await writeFile(path, text); await assert.rejects(compareCounters(state, path));
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});
test('commands reject ignored options and timer overflow', () => {
  for (const args of [['report','--state','x','--all'], ['demo','--prefix','x'], ['inventory','--input','x','--manifest','y'], ['demo','--max-seconds','2147484'], ['compare','--state','x']]) assert.throws(() => options(args));
});
