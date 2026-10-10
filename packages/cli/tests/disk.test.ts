import test from 'node:test';
import assert from 'node:assert/strict';
import { access, link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DiskStore, DiskRecoveryRequiredError } from '../src/disk.ts';
import { newState, type State } from '../src/model.ts';

const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 13);
const config = { provider: 'demo', bucket: 'demo-bucket', pattern: 'customers/{tenant_id}/*', prefix: '', region: 'auto' } as const;
async function fixture(run: (path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-disk-'));
  try { await run(join(dir, 'state.sqlite'), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
function requested(store: DiskStore): State {
  const state = store.state();
  return { ...state, requests: state.requests + 1 };
}

test('disk pages persist metadata, exact tenant totals and cursor history across resume', { skip: !supported }, async () => {
  await fixture(async path => {
    let store = await DiskStore.create(path, config);
    try {
      const first = store.applyPage(requested(store), { objects: [
        { key: 'customers/a/one', bytes: Number.MAX_SAFE_INTEGER },
        { key: 'customers/a/two', bytes: 4 }, { key: 'elsewhere', bytes: 3 },
        { key: 'customers/bad\u0000id/file', bytes: 2 }
      ], nextCursor: 'page-2' });
      assert.equal(first.bytes, '9007199254741000');
      assert.deepEqual(first.unmatched, { bytes: '5', objects: 2 });
      assert.equal(first.invalidTenantObjects, 1);
      assert.equal(Object.keys(first.tenants).length, 0);
      assert.equal(store.tenantCount(), 1);
      assert.deepEqual(store.get('a'), { bytes: '9007199254740995', objects: 2 });
      assert.equal(store.get('absent'), undefined);
      store.save({ ...first, requests: 2, reason: 'error' });
      store.close(); store = await DiskStore.open(path);
      assert.equal(store.state().reason, 'error'); assert.equal(store.state().requests, 2);
      assert.equal(store.hasCursor('page-2'), true);
      const second = store.applyPage(requested(store), { objects: [{ key: 'customers/b/file', bytes: 8 }], nextCursor: 'page-3' });
      assert.equal(second.objects, 5); assert.equal(second.pages, 2); assert.equal(second.requests, 3);
      assert.equal(store.hasCursor('page-2'), true); assert.equal(store.hasCursor('page-3'), true);
      assert.throws(() => store.applyPage(requested(store), { objects: [], nextCursor: 'page-2' }), /repeated cursor/);
      assert.equal(store.state().pages, 2);
      const complete = store.applyPage(requested(store), { objects: [], nextCursor: null });
      assert.equal(complete.status, 'complete'); assert.equal(complete.reason, 'complete');
      assert.equal(complete.cursor, null); assert.ok(complete.finishedAt);
      assert.equal(Object.keys(complete.tenants).length, 0);
    } finally { store.close(); }
    const readOnly = await DiskStore.open(path, { readOnly: true });
    try {
      assert.equal(readOnly.state().objects, 5); assert.equal(readOnly.tenantCount(), 2);
      assert.throws(() => readOnly.save(readOnly.state()), /transaction|readonly/i);
    } finally { readOnly.close(); readOnly.close(); }
    if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
  });
});

test('disk transactions roll back tenant updates, metadata and cursor on failure', { skip: !supported }, async () => {
  await fixture(async path => {
    const store = await DiskStore.create(path, config);
    try {
      const previous = store.applyPage(requested(store), { objects: [{ key: 'customers/a/one', bytes: 10 }], nextCursor: 'next' });
      store.db.exec("CREATE TRIGGER fail_metadata BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END");
      assert.throws(() => store.applyPage(requested(store), { objects: [
        { key: 'customers/a/two', bytes: 20 }, { key: 'customers/b/one', bytes: 30 }
      ], nextCursor: 'later' }), /injected transaction failure/);
      assert.deepEqual(store.state(), previous); assert.deepEqual(store.get('a'), { bytes: '10', objects: 1 });
      assert.equal(store.get('b'), undefined); assert.equal(store.hasCursor('later'), false);
      store.db.exec('DROP TRIGGER fail_metadata');
      store.applyPage(requested(store), { objects: [{ key: 'customers/b/one', bytes: 30 }], nextCursor: null });
      assert.equal(store.state().objects, 2);
    } finally { store.close(); }
  });
});

test('disk import and index preserve exact decimal ordering and binary UTF-8 ties', { skip: !supported }, async () => {
  await fixture(async path => {
    const state = newState(config);
    const totals = { z: '999999999999999999999999999999', a: '1000000000000000000000000000000', A: '9', Z: '9', 'é': '9', '😀': '9', ten: '10', zero: '0' };
    let bytes = 0n;
    for (const [id, value] of Object.entries(totals)) { state.tenants[id] = { bytes: value, objects: 1 }; bytes += BigInt(value); }
    state.bytes = bytes.toString(); state.objects = Object.keys(totals).length;
    const store = await DiskStore.importJson(path, state);
    try {
      assert.deepEqual([...store.rows()].map(row => row.tenantId), ['a', 'z', 'ten', 'A', 'Z', 'é', '😀', 'zero']);
      assert.equal(store.state().bytes, state.bytes); assert.equal(Object.keys(store.state().tenants).length, 0);
      assert.equal(store.db.prepare('PRAGMA temp_store').get()?.temp_store, 1);
      assert.equal(store.db.prepare('PRAGMA cache_size').get()?.cache_size, -4096);
      assert.equal(store.db.prepare('PRAGMA mmap_size').get()?.mmap_size, 0);
      assert.equal(store.db.prepare('PRAGMA synchronous').get()?.synchronous, 2);
      assert.equal(store.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
      const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT tenantId, bytes, objects FROM tenants ORDER BY length(bytes) DESC, bytes DESC, tenantId COLLATE BINARY ASC').all();
      assert.ok(plan.some(row => String(row.detail).includes('tenants_usage')));
    } finally { store.close(); }
  });
});

test('disk rejects unsafe counters and metadata-only changes to progress', { skip: !supported }, async () => {
  await fixture(async path => {
    const state = newState(config); state.objects = Number.MAX_SAFE_INTEGER;
    state.tenants.a = { bytes: '0', objects: Number.MAX_SAFE_INTEGER };
    const store = await DiskStore.importJson(path, state);
    try {
      assert.throws(() => store.applyPage(requested(store), { objects: [{ key: 'customers/a/one', bytes: 1 }], nextCursor: null }), /safe integer/);
      assert.equal(store.state().objects, Number.MAX_SAFE_INTEGER); assert.equal(store.state().bytes, '0');
      assert.throws(() => store.save({ ...store.state(), bytes: '1' }), /atomic page/);
      assert.throws(() => store.save({ ...store.state(), requests: Number.MAX_SAFE_INTEGER + 1 }), /checkpoint/);
      assert.throws(() => store.applyPage(store.state(), { objects: [], nextCursor: null }), /request increment/);
    } finally { store.close(); }
  });
});

test('disk opens reject missing, foreign, unknown-schema and inconsistent databases', { skip: !supported }, async () => {
  await fixture(async (path, dir) => {
    await assert.rejects(DiskStore.open(path), /ENOENT/); await assert.rejects(access(path), /ENOENT/);
    const { DatabaseSync } = await import('node:sqlite');
    const foreign = new DatabaseSync(path); foreign.exec('CREATE TABLE foreign_data (value TEXT)'); foreign.close();
    const original = await readFile(path);
    await assert.rejects(DiskStore.open(path), /unsupported disk checkpoint/); assert.deepEqual(await readFile(path), original);
    await rm(path);
    const store = await DiskStore.create(path, config); store.db.exec('CREATE TABLE unexpected (value TEXT)'); store.close();
    await assert.rejects(DiskStore.open(path), /unsupported disk checkpoint/); await rm(path);
    const inconsistent = await DiskStore.create(path, config);
    inconsistent.db.prepare('INSERT INTO tenants VALUES (?, ?, ?)').run('orphan', '10', 1); inconsistent.close();
    await assert.rejects(DiskStore.open(path), /unsupported disk checkpoint/); await rm(path);
    await writeFile(path, '{"version":1}'); await assert.rejects(DiskStore.open(path), /unsupported disk checkpoint/);
    assert.deepEqual(await readdir(dir), ['state.sqlite']);
  });
});

test('disk publication preserves existing files and failed imports leave no temporary file', { skip: !supported }, async () => {
  await fixture(async (path, dir) => {
    await writeFile(path, 'existing data'); await assert.rejects(DiskStore.create(path, config), /EEXIST/);
    assert.equal(await readFile(path, 'utf8'), 'existing data'); assert.deepEqual(await readdir(dir), ['state.sqlite']);
    await rm(path);
    await assert.rejects(DiskStore.importJson(path, { ...newState(config), bytes: 'not-decimal' }), /checkpoint/);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('disk files and journal sidecars reject symbolic and hard links', { skip: !supported || process.platform === 'win32' }, async () => {
  await fixture(async (path, dir) => {
    const original = join(dir, 'original.sqlite'); const store = await DiskStore.create(original, config); store.close();
    await symlink(original, path);
    await assert.rejects(DiskStore.open(path), /regular file/); await assert.rejects(DiskStore.create(path, config), /regular file/);
    await rm(path); await link(original, path);
    await assert.rejects(DiskStore.open(path), /regular file/); await assert.rejects(DiskStore.open(original), /regular file/);
    await rm(path);
    const target = join(dir, 'target'); await writeFile(target, 'untouched'); await symlink(target, `${original}-journal`);
    await assert.rejects(DiskStore.open(original), /regular file/); assert.equal(await readFile(target, 'utf8'), 'untouched');
  });
});

test('disk open validation yields and respects an aborted signal', { skip: !supported }, async () => {
  await fixture(async path => {
    const state = newState(config);
    for (let i = 0; i < 3000; i++) state.tenants[String(i)] = { bytes: '1', objects: 1 };
    state.objects = 3000; state.bytes = '3000';
    const store = await DiskStore.importJson(path, state); store.close();
    const controller = new AbortController();
    setImmediate(() => controller.abort(new Error('stop validation')));
    await assert.rejects(DiskStore.open(path, { signal: controller.signal }), /stop validation/);
    const reopened = await DiskStore.open(path); reopened.close();
  });
});

test('disk support is optional and gives an actionable Node upgrade error', { skip: supported }, async () => {
  await fixture(async path => {
    await assert.rejects(DiskStore.create(path, config), /Node.js 22.13 or newer/); await assert.rejects(access(path), /ENOENT/);
  });
});


test('disk open rejects pathname replacement during validation without modifying the replacement', { skip: !supported }, async () => {
  await fixture(async (path, dir) => {
    const store = await DiskStore.create(path, config); store.close();
    const foreignPath = join(dir, 'foreign.sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    const foreign = new DatabaseSync(foreignPath); foreign.exec('CREATE TABLE foreign_data (value TEXT)'); foreign.close();
    const bytes = await readFile(foreignPath);
    const signal = new AbortController().signal;
    let checks = 0;
    signal.throwIfAborted = () => {
      if (++checks === 2) { renameSync(path, join(dir, 'original.sqlite')); writeFileSync(path, bytes); }
    };
    await assert.rejects(DiskStore.open(path, { signal }), /changed during validation/);
    assert.deepEqual(await readFile(path), bytes);
    const original = await DiskStore.open(join(dir, 'original.sqlite')); original.close();
  });
});

test('disk import cancellation leaves no published database or temporary journal', { skip: !supported }, async () => {
  await fixture(async (path, dir) => {
    const state = newState(config);
    for (let i = 0; i < 3000; i++) state.tenants[String(i)] = { bytes: '1', objects: 1 };
    state.objects = 3000; state.bytes = '3000';
    const controller = new AbortController();
    setImmediate(() => controller.abort(new Error('stop import')));
    await assert.rejects(DiskStore.importJson(path, state, controller.signal), /stop import|aborted/i);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('disk rejects malformed Unicode IDs and cursors before persistence', { skip: !supported }, async () => {
  await fixture(async (path, dir) => {
    const legacy = JSON.parse(JSON.stringify({ ...newState(config), objects: 1, bytes: '1', tenants: { '\ud800': { bytes: '1', objects: 1 } } })) as State;
    await assert.rejects(DiskStore.importJson(path, legacy), /valid Unicode/);
    assert.deepEqual(await readdir(dir), []);
    const cursorState = { ...newState(config), cursor: '\ud800' };
    await assert.rejects(DiskStore.importJson(path, cursorState), /valid Unicode/);
    const store = await DiskStore.create(path, config);
    try {
      assert.throws(() => store.applyPage(requested(store), { objects: [{ key: 'customers/\ud800/file', bytes: 1 }], nextCursor: null }), /valid Unicode/);
      assert.throws(() => store.applyPage(requested(store), { objects: [], nextCursor: '\ud800' }), /valid Unicode/);
      assert.throws(() => store.hasCursor('\ud800'), /valid Unicode/);
      assert.equal(store.state().objects, 0);
    } finally { store.close(); }
  });
});

test('disk detects readonly hot journals and recovers atomically with a mutable connection', { skip: !supported || process.platform === 'win32' }, async () => {
  await fixture(async path => {
    const state = newState(config);
    for (let i = 0; i < 3000; i++) state.tenants[String(i)] = { bytes: '1', objects: 1 };
    state.objects = 3000; state.bytes = '3000';
    const store = await DiskStore.importJson(path, state); store.close();
    const child = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE tenants SET bytes='9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999'");
      process.kill(process.pid, 'SIGKILL');
    `, path], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.ok((await lstat(`${path}-journal`)).size > 0);
    await assert.rejects(DiskStore.open(path, { readOnly: true }), DiskRecoveryRequiredError);
    const recovered = await DiskStore.open(path);
    try { assert.equal(recovered.state().bytes, '3000'); assert.deepEqual(recovered.get('0'), { bytes: '1', objects: 1 }); }
    finally { recovered.close(); }
    const readonly = await DiskStore.open(path, { readOnly: true }); readonly.close();
  });
});

test('disk readonly snapshots retain SQLite locks and reject duplicate inode opens', { skip: !supported || process.platform === 'win32' }, async () => {
  await fixture(async (path, dir) => {
    const original = await DiskStore.create(path, config);
    original.applyPage(requested(original), { objects: [{ key: 'customers/a/file', bytes: 1 }], nextCursor: null });
    original.close();
    const snapshot = await DiskStore.open(path, { readOnly: true });
    const childUpdate = () => spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      try { db.exec("UPDATE tenants SET bytes='2' WHERE tenantId='a'"); db.close(); }
      catch (error) { console.error(error.message); process.exit(7); }
    `, path], { encoding: 'utf8' });
    try {
      await assert.rejects(DiskStore.open(path), /already open/);
      await assert.rejects(DiskStore.assertNotOpen(path), /already open/);
      const alias = join(dir, 'alias'); await symlink(dir, alias);
      await assert.rejects(DiskStore.open(join(alias, 'state.sqlite'), { readOnly: true }), /already open/);
      await assert.rejects(DiskStore.assertNotOpen(join(alias, 'state.sqlite')), /already open/);
      const blocked = childUpdate();
      assert.equal(blocked.status, 7, blocked.stderr);
      assert.match(blocked.stderr, /locked/);
      assert.deepEqual(snapshot.get('a'), { bytes: '1', objects: 1 });
    } finally { snapshot.close(); }
    const reopened = await DiskStore.open(path, { readOnly: true }); reopened.close();
    const unlocked = childUpdate(); assert.equal(unlocked.status, 0, unlocked.stderr);
  });
});


test('disk import treats successful publication as the cancellation commit boundary', { skip: !supported }, async () => {
  await fixture(async path => {
    const state = newState(config);
    state.objects = 1; state.bytes = '1'; state.tenants.a = { bytes: '1', objects: 1 };
    const controller = new AbortController();
    let checks = 0;
    const originalCheck = controller.signal.throwIfAborted.bind(controller.signal);
    controller.signal.throwIfAborted = () => {
      originalCheck();
      if (++checks === 3) setImmediate(() => controller.abort(new Error('late abort')));
    };
    const committed = await DiskStore.importJson(path, state, controller.signal);
    try {
      assert.equal(controller.signal.aborted, true);
      assert.equal(committed.state().objects, 1);
      assert.deepEqual(committed.get('a'), { bytes: '1', objects: 1 });
    } finally { committed.close(); }
    const reopened = await DiskStore.open(path, { readOnly: true }); reopened.close();
  });
});
