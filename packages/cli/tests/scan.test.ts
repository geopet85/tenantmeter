import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { newState, type Config, type Source, type State } from '../src/model.ts';
import { applyPage, scan } from '../src/scan.ts';
import { createSource } from '../src/source.ts';
import { loadState, lockState, saveState } from '../src/state.ts';
import { options } from '../src/options.ts';
import { render, report } from '../src/report.ts';

const config: Config = { provider: 'demo', bucket: 'demo-bucket', region: 'auto', prefix: '', pattern: 'customers/{tenant_id}/*' };
async function run(state: State, maxObjects = Infinity) {
  const source = await createSource(state.config);
  return scan({ state, source, maxObjects, signal: new AbortController().signal, save: async () => {} });
}

test('full demo traverses pages and accounts for all matched and unmatched objects', async () => {
  const state = await run(newState(config));
  assert.equal(state.status, 'complete');
  assert.equal(state.pages, 3);
  assert.equal(state.objects, 2505);
  assert.equal(state.bytes, '5501000000');
  assert.deepEqual(state.unmatched, { objects: 5, bytes: '500000' });
  assert.deepEqual(state.tenants['東京'], { objects: 500, bytes: '500000' });
  assert.equal(report(state).tenants[0].tenantId, 'northwind');
});

test('object limit stops exactly; increasing it and resuming produces identical totals', async () => {
  const partial = await run(newState(config), 1001);
  assert.equal(partial.reason, 'object-limit');
  assert.equal(partial.objects, 1001);
  assert.equal(partial.cursor, '1001');
  const resumed = await run(partial);
  const full = await run(newState(config));
  assert.equal(resumed.bytes, full.bytes);
  assert.deepEqual(resumed.tenants, full.tenants);
  assert.deepEqual(resumed.unmatched, full.unmatched);
});

test('interruption keeps the last complete page and can resume without duplication', async () => {
  const controller = new AbortController();
  const saved: State[] = [];
  const partial = await scan({ state: newState(config), source: await createSource(config), maxObjects: Infinity,
    signal: controller.signal, save: async s => { saved.push(s); },
    progress: () => controller.abort() });
  assert.equal(partial.reason, 'interrupted');
  assert.equal(partial.objects, 1000);
  assert.equal(saved.at(-1)?.cursor, '1000');
  const result = await run(partial);
  assert.equal(result.objects, 2505);
});

test('failed provider page does not change totals or advance the cursor', async () => {
  let saved = newState(config);
  let calls = 0;
  const demo = await createSource(config);
  const source: Source = { close() {}, async page(cursor, maxKeys, signal) {
    if (++calls === 2) throw new Error('temporary failure');
    return demo.page(cursor, maxKeys, signal);
  } };
  await assert.rejects(scan({ state: saved, source, maxObjects: Infinity,
    signal: new AbortController().signal, save: async s => { saved = s; } }), /temporary failure/);
  assert.equal(saved.reason, 'error');
  assert.equal(saved.objects, 1000);
  assert.equal(saved.cursor, '1000');
  assert.equal((await run(saved)).bytes, '5501000000');
});

test('checkpoint write failure leaves the failed page uncounted', async () => {
  let saved = newState(config);
  let failedOnce = false;
  await assert.rejects(scan({ state: saved, source: await createSource(config), maxObjects: Infinity,
    signal: new AbortController().signal, save: async s => {
      if (s.pages === 2 && !failedOnce) { failedOnce = true; throw new Error('disk full'); }
      saved = s;
    } }), /disk full/);
  assert.equal(saved.objects, 1000);
  assert.equal((await run(saved)).objects, 2505);
});

test('huge totals remain exact; unsafe individual sizes fail', () => {
  const state = applyPage(newState(config), { objects: [
    { key: 'customers/a/1', bytes: Number.MAX_SAFE_INTEGER },
    { key: 'customers/a/2', bytes: Number.MAX_SAFE_INTEGER }
  ], nextCursor: null });
  assert.equal(state.bytes, '18014398509481982');
  assert.equal(JSON.parse(render(state, 'json')).total.bytes, state.bytes);
  assert.throws(() => applyPage(newState(config), { objects: [{ key: 'customers/a/1', bytes: Number.MAX_SAFE_INTEGER + 1 }], nextCursor: null }), /unsafe/);
});

test('special property names, unicode, empty buckets, and invalid tenant IDs are handled', async () => {
  const state = applyPage(newState(config), { objects: [
    { key: 'customers/__proto__/a', bytes: 5 },
    { key: 'customers/constructor/a', bytes: 7 },
    { key: 'customers/東京/a', bytes: 3 },
    { key: 'customers/evil\u001b/a', bytes: 2 },
    { key: `customers/${'a'.repeat(513)}/a`, bytes: 1 }
  ], nextCursor: null });
  assert.equal(state.tenants['__proto__'].bytes, '5');
  assert.equal(state.tenants['constructor'].bytes, '7');
  assert.equal(state.invalidTenantObjects, 2);
  assert.equal(state.unmatched.bytes, '3');
  const empty = await run(newState({ ...config, prefix: 'does-not-exist/' }));
  assert.equal(empty.status, 'complete');
  assert.equal(empty.objects, 0);
});

test('CSV escapes quotes, commas, and spreadsheet formulas; JSON preserves IDs', () => {
  const state = applyPage(newState(config), { objects: [
    { key: 'customers/=SUM(1,2)/a', bytes: 2 }, { key: 'customers/a"b,c/a', bytes: 1 },
    { key: 'customers/ =1+2/a', bytes: 1 }
  ], nextCursor: null });
  const csv = render(state, 'csv');
  assert.ok(csv.includes('"\'=SUM(1,2)"'));
  assert.ok(csv.includes('"a""b,c"'));
  assert.ok(csv.includes('"\' =1+2"'));
  assert.ok(csv.includes('"unmatched"'));
  assert.equal(report(state).tenants[0].tenantId, '=SUM(1,2)');
});

test('checkpoint round-trip validates totals, keeps private permissions and refuses concurrent locks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-test-'));
  const path = join(dir, 'state.json');
  try {
    const partial = await run(newState(config), 1000);
    await saveState(path, partial);
    assert.deepEqual(await loadState(path), partial);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const release = await lockState(path);
    await assert.rejects(lockState(path), /locked/);
    await release();
    const releaseAgain = await lockState(path);
    await releaseAgain();
    const bad = JSON.parse(await readFile(path, 'utf8'));
    bad.bytes = '123';
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(loadState(path), /inconsistent/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('arguments reject missing provider, unsafe limits, conflicting resume options, and malformed R2 IDs', () => {
  for (const args of [
    ['analyze'], ['demo', '--max-objects', '0'], ['demo', '--max-objects', '1e6'],
    ['demo', '--all', '--max-objects', '3'], ['analyze', '--resume', 'x', '--pattern', '{tenant_id}/*'],
    ['analyze', '--provider', 'r2', '--bucket', 'bucket', '--pattern', '{tenant_id}/*', '--account-id', 'https://evil.example'],
    ['demo', '--format', 'xml'], ['demo', '--unknown']
  ]) assert.throws(() => options(args));
  assert.equal(options(['demo']).config?.provider, 'demo');
});

test('oversized pages and repeated cursors fail safely', async () => {
  const source: Source = { close() {}, async page() { return { objects: [{ key: 'customers/a/x', bytes: 1 }, { key: 'customers/a/y', bytes: 1 }], nextCursor: null }; } };
  await assert.rejects(scan({ state: newState(config), source, maxObjects: 1,
    signal: new AbortController().signal, save: async () => {} }), /oversized/);
  const partial = await run(newState(config), 1000);
  source.page = async () => ({ objects: [], nextCursor: partial.cursor });
  await assert.rejects(scan({ state: partial, source, maxObjects: Infinity,
    signal: new AbortController().signal, save: async () => {} }), /repeated/);
});

test('R2 credentials are explicit and a truncated SDK response without a cursor is rejected', async () => {
  const r2 = { ...config, provider: 'r2' as const, accountId: 'a'.repeat(32) };
  const oldId = process.env.R2_ACCESS_KEY_ID;
  const oldSecret = process.env.R2_SECRET_ACCESS_KEY;
  const requests: { hostname: string; path: string }[] = [];
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  let source: Source | undefined;
  try {
    await assert.rejects(createSource(r2), /R2_ACCESS_KEY_ID/);
    process.env.R2_ACCESS_KEY_ID = 'test-r2';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    source = await createSource({ ...r2, jurisdiction: 'eu' }, { requestHandler: {
      async handle(request: any) {
        requests.push({ hostname: request.hostname, path: request.path });
        return { response: { statusCode: 200, headers: { 'content-type': 'application/xml' }, body: Readable.from(['<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>']) } };
      }
    } });
    await assert.rejects(source.page(null, 10, new AbortController().signal), /without a continuation token/);
    assert.equal(requests[0].hostname, `${'a'.repeat(32)}.eu.r2.cloudflarestorage.com`);
    assert.equal(requests[0].path, '/demo-bucket/');
  } finally {
    source?.close();
    if (oldId === undefined) delete process.env.R2_ACCESS_KEY_ID; else process.env.R2_ACCESS_KEY_ID = oldId;
    if (oldSecret === undefined) delete process.env.R2_SECRET_ACCESS_KEY; else process.env.R2_SECRET_ACCESS_KEY = oldSecret;
  }
});

test('real AWS SDK serializes listing requests, follows tokens, and retries a transient HTTP error', async () => {
  const requests: { query: Record<string, string>, method: string }[] = [];
  let transient = true;
  const old = { access: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  let source: Source | undefined;
  try {
    source = await createSource({ ...config, provider: 's3', bucket: 'test-bucket', region: 'us-east-1' }, {
      requestHandler: { async handle(request: any) {
        requests.push({ query: request.query, method: request.method });
        if (transient) {
          transient = false;
          return { response: { statusCode: 503, headers: { 'content-type': 'application/xml' }, body: Readable.from(['<Error><Code>SlowDown</Code></Error>']) } };
        }
        const second = request.query['continuation-token'] === 'page2';
        const xml = `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${!second}</IsTruncated>${second ? '' : '<NextContinuationToken>page2</NextContinuationToken>'}<Contents><Key>customers/acme/${second ? 'b' : 'a'}</Key><Size>${second ? 20 : 10}</Size></Contents></ListBucketResult>`;
        return { response: { statusCode: 200, headers: { 'content-type': 'application/xml' }, body: Readable.from([xml]) } };
      } }
    });
    const state = await scan({ state: newState(config), source, maxObjects: Infinity,
      signal: new AbortController().signal, save: async () => {} });
    assert.equal(state.bytes, '30');
    assert.equal(state.objects, 2);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(req => req.query['list-type'] === '2' && req.method === 'GET'));
    assert.equal(requests.at(-1)?.query['continuation-token'], 'page2');
  } finally {
    source?.close();
    if (old.access === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = old.access;
    if (old.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = old.secret;
  }
});

test('request limit includes saved progress and runtime abort keeps an uncommitted page out', async () => {
  const limited = await scan({state: newState(config), source: await createSource(config), maxObjects: Infinity, maxRequests: 1,
    signal: new AbortController().signal, save: async () => {}});
  assert.equal(limited.objects, 1000); assert.equal(limited.reason, 'request-limit');
  const resumed = await scan({state: limited, source: await createSource(config), maxObjects: Infinity, maxRequests: 3,
    signal: new AbortController().signal, save: async () => {}});
  assert.equal(resumed.bytes, '5501000000'); assert.equal(resumed.requests, 3);
  const controller = new AbortController();
  const source: Source = { close() {}, async page() { controller.abort('time-limit'); return {objects: [{key: 'customers/a/x', bytes: 1}], nextCursor: null}; } };
  const stopped = await scan({ state: newState(config), source, maxObjects: Infinity, signal: controller.signal, save: async () => {} });
  assert.equal(stopped.reason, 'time-limit'); assert.equal(stopped.objects, 0);
});
