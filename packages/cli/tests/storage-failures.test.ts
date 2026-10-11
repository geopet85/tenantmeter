import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskStore } from '../src/disk.ts';
import { newState, type Page, type State } from '../src/model.ts';
import { applyPage, scan } from '../src/scan.ts';
import { loadState, lockState, saveState } from '../src/state.ts';
import { exportFile } from '../src/output.ts';
import { renderChunks } from '../src/report.ts';

const [major, minor] = process.versions.node.split('.').map(Number);
const diskSupported = major > 22 || major === 22 && minor >= 13;
const config = {provider: 'demo', bucket: 'demo-bucket', region: 'auto', prefix: '', pattern: 'customers/{tenant_id}/*'} as const;
type Fault = {stage: 'open' | 'write' | 'sync' | 'publish'; code: 'EACCES' | 'ENOSPC'};
const failures: Fault[] = [
  {stage: 'open', code: 'EACCES'}, {stage: 'write', code: 'ENOSPC'},
  {stage: 'sync', code: 'ENOSPC'}, {stage: 'publish', code: 'EACCES'}
];
function ioError(code: string) {
  return Object.assign(new Error(`${code}: injected persistence failure`), {code});
}
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'tenantmeter-storage-failure-'));
  try { await run(dir); } finally { await fs.rm(dir, {recursive: true, force: true}); }
}

// Patch actual file operations, not production orchestration. Every write fault
// leaves bytes in the real temporary file, exercising cleanup after partial I/O.
async function withFileFault(fault: Fault, run: () => Promise<void>) {
  const originalOpen = fs.open, originalLink = fs.link, originalRename = fs.rename;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    if (!String(args[0]).endsWith('.tmp')) return originalOpen(...args);
    if (fault.stage === 'open') throw ioError(fault.code);
    const file = await originalOpen(...args);
    if (fault.stage === 'write') {
      const originalWrite = file.writeFile.bind(file);
      file.writeFile = async () => { await originalWrite('partial bytes'); throw ioError(fault.code); };
    }
    if (fault.stage === 'sync') file.sync = async () => { throw ioError(fault.code); };
    return file;
  };
  fs.link = async (from, to) => {
    if (fault.stage === 'publish' && String(from).endsWith('.tmp')) throw ioError(fault.code);
    return originalLink(from, to);
  };
  fs.rename = async (from, to) => {
    if (fault.stage === 'publish' && String(from).endsWith('.tmp')) throw ioError(fault.code);
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try { await run(); }
  finally {
    fs.open = originalOpen; fs.link = originalLink; fs.rename = originalRename;
    syncBuiltinESMExports();
  }
}

function partial() {
  return applyPage({...newState(config), requests: 1}, {objects: [{key: 'customers/a/one', bytes: 7}], nextCursor: 'next'});
}

test('JSON checkpoint permission, partial-write, fsync and rename failures preserve durable progress and release locks', async () => {
  for (const fault of failures) await fixture(async dir => {
    const path = join(dir, 'state.json');
    const previous = partial(); await saveState(path, previous);
    const original = await fs.readFile(path);
    const next = applyPage({...previous, requests: 2}, {objects: [{key: 'customers/b/two', bytes: 9}], nextCursor: null});
    const unlock = await lockState(path);
    try {
      await withFileFault(fault, async () => {
        await assert.rejects(saveState(path, next), {code: fault.code});
        await assert.rejects(saveState(join(dir, 'new.json'), next), {code: fault.code});
      });
    } finally { await unlock(); }
    assert.deepEqual(await fs.readFile(path), original, fault.stage);
    assert.deepEqual(await loadState(path), previous, fault.stage);
    assert.deepEqual(await fs.readdir(dir), ['state.json'], fault.stage);
    const unlockAgain = await lockState(path); await unlockAgain();
  });
});

test('exports clean partial files on permission, write, fsync and publication failures without replacing existing reports', async () => {
  for (const fault of failures) await fixture(async dir => {
    const existing = join(dir, 'existing.csv'), fresh = join(dir, 'new.csv');
    await fs.writeFile(existing, 'previous report');
    await withFileFault(fault, async () => {
      await assert.rejects(exportFile(fresh, ['header\n', 'x'.repeat(70000)]), {code: fault.code});
      await assert.rejects(exportFile(existing, ['replacement report']), {code: fault.code});
    });
    assert.equal(await fs.readFile(existing, 'utf8'), 'previous report', fault.stage);
    assert.deepEqual(await fs.readdir(dir), ['existing.csv'], fault.stage);
    await exportFile(fresh, ['complete report']);
    assert.equal(await fs.readFile(fresh, 'utf8'), 'complete report');
  });
});

test('SQLite scan disk-full errors retain the previous cursor and resume each object exactly once', {skip: !diskSupported}, async () => {
  await fixture(async dir => {
    const path = join(dir, 'state.sqlite');
    const store = await DiskStore.create(path, config);
    try {
      const previous = store.applyPage({...store.state(), requests: 1}, {objects: [{key: 'customers/a/one', bytes: 7}], nextCursor: 'next'});
      const count = store.db.prepare('PRAGMA page_count').get()!.page_count;
      store.db.exec(`PRAGMA max_page_count=${count}`);
      const page: Page = {objects: Array.from({length: 150}, (_, i) => ({key: `customers/${String(i).padStart(4, '0')}${'x'.repeat(480)}/file`, bytes: i})), nextCursor: null};
      const run = () => scan({state: store.state(), source: {close() {}, async page() { return page; }}, maxObjects: Infinity,
        signal: new AbortController().signal, commit: (state, value, pattern) => store.applyPage(state, value, pattern),
        hasCursor: cursor => store.hasCursor(cursor), save: async state => {store.save(state);}});
      await assert.rejects(run(), /database or disk is full/i);
      const saved = store.state();
      assert.equal(saved.reason, 'error'); assert.equal(saved.requests, 2);
      assert.equal(saved.cursor, previous.cursor); assert.equal(saved.pages, previous.pages);
      assert.equal(saved.bytes, previous.bytes); assert.equal(saved.objects, previous.objects);
      assert.equal(store.tenantCount(), 1); assert.deepEqual(store.get('a'), {bytes: '7', objects: 1});
      store.db.exec('PRAGMA max_page_count=2147483646');
      const resumed = await run();
      assert.equal(resumed.status, 'complete'); assert.equal(resumed.objects, 151);
      assert.equal(resumed.bytes, String(7 + 149 * 150 / 2));
      assert.equal(store.tenantCount(), 151);
    } finally { store.close(); }
    const reopened = await DiskStore.open(path); reopened.close();
  });
});

test('SQLite readonly permission failures cannot advance checkpoint progress', {skip: !diskSupported}, async () => {
  await fixture(async dir => {
    const store = await DiskStore.create(join(dir, 'state.sqlite'), config);
    try {
      const previous = store.state(); store.db.exec('PRAGMA query_only=ON');
      await assert.rejects(async () => store.applyPage({...previous, requests: 1}, {objects: [{key: 'customers/a/file', bytes: 1}], nextCursor: null}), /readonly/i);
      await assert.rejects(async () => store.save({...previous, requests: 1, reason: 'error'}), /readonly/i);
      assert.deepEqual(store.state(), previous); assert.equal(store.tenantCount(), 0);
      store.db.exec('PRAGMA query_only=OFF');
      assert.equal(store.applyPage({...previous, requests: 1}, {objects: [], nextCursor: null}).status, 'complete');
    } finally { store.close(); }
  });
});

test('SQLite migration permission and publication failures preserve legacy JSON and publish no database', {skip: !diskSupported}, async () => {
  for (const fault of [failures[0], failures[3]]) await fixture(async dir => {
    const legacy = join(dir, 'legacy.json'), output = join(dir, 'migrated.sqlite');
    const state = partial(); await saveState(legacy, state);
    const bytes = await fs.readFile(legacy);
    await withFileFault(fault, async () => {
      await assert.rejects(DiskStore.importJson(output, await loadState(legacy)), {code: fault.code});
    });
    assert.deepEqual(await fs.readFile(legacy), bytes); assert.deepEqual(await fs.readdir(dir), ['legacy.json']);
    const migrated = await DiskStore.importJson(output, await loadState(legacy)); migrated.close();
  });
});

test('SQLite migration disk-full rollback removes temporary database and journal and preserves legacy JSON', {skip: !diskSupported}, async () => {
  await fixture(async dir => {
    const legacy = join(dir, 'legacy.json'), output = join(dir, 'migrated.sqlite');
    const state = newState(config);
    for (let i = 0; i < 150; i++) state.tenants[`${i}${'x'.repeat(480)}`] = {bytes: '1', objects: 1};
    state.bytes = '150'; state.objects = 150;
    await saveState(legacy, state); const bytes = await fs.readFile(legacy);
    const {DatabaseSync} = await import('node:sqlite');
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql: string) {
      const result = original.call(this, sql);
      if (sql.startsWith('CREATE INDEX tenants_usage')) {
        const count = this.prepare('PRAGMA page_count').get()!.page_count;
        original.call(this, `PRAGMA max_page_count=${count}`);
      }
      return result;
    };
    try { await assert.rejects(DiskStore.importJson(output, state), /database or disk is full/i); }
    finally { DatabaseSync.prototype.exec = original; }
    assert.deepEqual(await fs.readFile(legacy), bytes); assert.deepEqual(await fs.readdir(dir), ['legacy.json']);
    const migrated = await DiskStore.importJson(output, await loadState(legacy));
    try { assert.equal(migrated.tenantCount(), 150); assert.equal(migrated.state().objects, 150); }
    finally { migrated.close(); }
  });
});

test('failed SQLite report export leaves its snapshot usable and can retry after storage recovers', {skip: !diskSupported}, async () => {
  await fixture(async dir => {
    const path = join(dir, 'state.sqlite'), reportPath = join(dir, 'report.json');
    const created = await DiskStore.importJson(path, partial()); created.close();
    const store = await DiskStore.open(path, {readOnly: true});
    try {
      const source = {count: store.tenantCount(), rows: () => store.rows()};
      await withFileFault({stage: 'write', code: 'ENOSPC'}, async () => {
        await assert.rejects(exportFile(reportPath, renderChunks(store.state(), 'json', 20, source)), {code: 'ENOSPC'});
      });
      assert.deepEqual(await fs.readdir(dir), ['state.sqlite']);
      assert.deepEqual(store.get('a'), {bytes: '7', objects: 1});
      await exportFile(reportPath, renderChunks(store.state(), 'json', 20, source));
      assert.equal(JSON.parse(await fs.readFile(reportPath, 'utf8')).total.bytes, '7');
    } finally { store.close(); }
  });
});
