import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newState, type State, type Totals } from '../src/model.ts';
import { compareCounters, renderComparison } from '../src/compare.ts';
import { diffStates, renderDiff } from '../src/diff.ts';
import { compareDisk, diffDisk, type Snapshot } from '../src/disk-commands.ts';
import { DiskStore } from '../src/disk.ts';
import { loadState } from '../src/state.ts';

const config = {provider: 'demo' as const, bucket: 'demo-bucket', region: 'auto', prefix: '', pattern: 'customers/{tenant_id}/*'};
function state(rows: Record<string, Totals>, unmatched: Totals = {bytes: '0', objects: 0}): State {
  const result = newState(config);
  result.status = 'complete'; result.reason = 'complete'; result.finishedAt = result.startedAt;
  result.tenants = Object.assign(Object.create(null), rows);
  result.unmatched = unmatched;
  result.bytes = (Object.values(rows).reduce((sum, x) => sum + BigInt(x.bytes), BigInt(unmatched.bytes))).toString();
  result.objects = Object.values(rows).reduce((sum, x) => sum + x.objects, unmatched.objects);
  return result;
}
function snapshot(value: State): Snapshot {
  return {
    state: value, count: Object.keys(value.tenants).length,
    *rows() { for (const [tenantId, totals] of Object.entries(value.tenants)) yield {tenantId, ...totals}; },
    get(tenantId) { return value.tenants[tenantId]; }
  };
}
function render(chunks: Iterable<string>) { return Array.from(chunks).join(''); }

test('disk comparison matches in-memory schema, status and CSV/table output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenantmeter-disk-test-'));
  const path = join(directory, 'counter.csv');
  const scanned = state({a: {bytes: '18014398509481982', objects: 2}, zero: {bytes: '0', objects: 1},
    changed: {bytes: '2', objects: 1}}, {bytes: '3', objects: 1});
  await writeFile(path, 'tenant_id,bytes\na,18014398509481981\nchanged,2\nonly-counter,0\n');
  const result = await compareDisk(snapshot(scanned), path);
  try {
    const expected = await compareCounters(scanned, path);
    assert.deepEqual(JSON.parse(render(result.chunks('json', 1))), expected);
    assert.equal(render(result.chunks('csv', 1)), renderComparison(expected, 'csv', 1));
    assert.equal(render(result.chunks('table', 1)), renderComparison(expected, 'table', 1));
    assert.equal(result.different, 3);
    assert.equal(result.hasDifferences, true);
    assert.equal((await stat(result.scratchPath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(result.scratchPath, 'rows.sqlite'))).mode & 0o777, 0o600);
  } finally {
    await result.close();
    await rm(directory, {recursive: true, force: true});
  }
  await assert.rejects(stat(result.scratchPath), {code: 'ENOENT'});
});

test('disk diff preserves exact integers, zero-byte additions and magnitude ordering', async () => {
  const before = state({a: {bytes: '1000000000000000000000000000000', objects: 1},
    removed: {bytes: '0', objects: 1}, same: {bytes: '2', objects: 1}, tiny: {bytes: '1', objects: 1}},
    {bytes: '8', objects: 1});
  const after = state({a: {bytes: '1000000000000000000000000000100', objects: 1},
    added: {bytes: '0', objects: 1}, same: {bytes: '2', objects: 2}, tiny: {bytes: '11', objects: 1}},
    {bytes: '0', objects: 0});
  const result = await diffDisk(snapshot(before), snapshot(after));
  try {
    const expected = diffStates(before, after);
    assert.deepEqual(JSON.parse(render(result.chunks('json', 2))), expected);
    assert.equal(render(result.chunks('csv', 2)), renderDiff(expected, 'csv', 2));
    assert.equal(render(result.chunks('table', 2)), renderDiff(expected, 'table', 2));
    assert.equal(result.different, 5);
    assert.equal(result.hasDifferences, true);
    assert.deepEqual(JSON.parse(render(result.chunks('json', 1))).rows.map((row: {tenantId: string}) => row.tenantId),
      ['a', 'tiny', 'added', 'removed', 'same']);
  } finally { await result.close(); }
  await assert.rejects(stat(result.scratchPath), {code: 'ENOENT'});
});

test('disk commands reject incomplete scans and mismatched scopes', async () => {
  const complete = state({});
  const partial = newState(config);
  await assert.rejects(diffDisk(snapshot(partial), snapshot(complete)), /complete/);
  await assert.rejects(compareDisk(snapshot(partial), 'unused'), /complete/);
  const mismatch = state({}); mismatch.config = {...mismatch.config, bucket: 'other'};
  await assert.rejects(diffDisk(snapshot(complete), snapshot(mismatch)), /scope differs: bucket/);
});

test('diff joins a JSON snapshot and a read-only SQLite checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenantmeter-disk-test-'));
  const path = join(directory, 'before.sqlite');
  const before = state({old: {bytes: '9007199254740993', objects: 2}, same: {bytes: '0', objects: 1}});
  const after = state({old: {bytes: '9007199254740994', objects: 2}, added: {bytes: '0', objects: 1}});
  let opened: DiskStore | undefined;
  try {
    const imported = await DiskStore.importJson(path, before);
    imported.close();
    opened = await DiskStore.open(path, {readOnly: true});
    const sqliteSnapshot: Snapshot = {state: opened.state(), count: opened.tenantCount(),
      rows: () => opened!.rows(), get: tenantId => opened!.get(tenantId)};
    const result = await diffDisk(sqliteSnapshot, snapshot(after));
    try { assert.deepEqual(JSON.parse(render(result.chunks('json', 10))), diffStates(before, after)); }
    finally { await result.close(); }
  } finally {
    opened?.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('mixed JSON/SQLite diff rejects malformed Unicode IDs and removes scratch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenantmeter-disk-test-'));
  const scratchBase = join(directory, 'scratch');
  await mkdir(scratchBase);
  const jsonPath = join(directory, 'before.json');
  const sqlitePath = join(directory, 'after.sqlite');
  const malformed = state({['broken' + String.fromCharCode(0xd800)]: {bytes: '1', objects: 1}});
  await writeFile(jsonPath, JSON.stringify(malformed));
  const imported = await DiskStore.importJson(sqlitePath, state({valid: {bytes: '1', objects: 1}}));
  imported.close();
  const opened = await DiskStore.open(sqlitePath, {readOnly: true});
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = scratchBase;
  try {
    const sqliteSnapshot: Snapshot = {state: opened.state(), count: opened.tenantCount(),
      rows: () => opened.rows(), get: tenantId => opened.get(tenantId)};
    await assert.rejects(diffDisk(snapshot(await loadState(jsonPath)), sqliteSnapshot), /invalid Unicode customer ID/);
    assert.deepEqual(await readdir(scratchBase), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    opened.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('invalid and duplicate counters remove scratch files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenantmeter-disk-test-'));
  const scratchBase = join(directory, 'scratch');
  await mkdir(scratchBase);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = scratchBase;
  try {
    for (const [body, pattern] of [
      ['tenant_id,bytes\na,1\na,2\n', /duplicate customer ID/],
      ['tenant_id,bytes\na,1\na,invalid\n', /duplicate customer ID/],
      ['tenant_id,bytes\na,not-a-number\n', /nonnegative decimal/],
      ['bad,header\na,1\n', /header must/]
    ] as const) {
      const path = join(directory, 'counter.csv');
      await writeFile(path, body);
      await assert.rejects(compareDisk(snapshot(state({a: {bytes: '1', objects: 1}})), path), pattern);
      assert.deepEqual(await readdir(scratchBase), []);
    }
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(directory, {recursive: true, force: true});
  }
});

test('cancellation during a large import closes and removes scratch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenantmeter-disk-test-'));
  const scratchBase = join(directory, 'scratch');
  await mkdir(scratchBase);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = scratchBase;
  try {
    const rows: Record<string, Totals> = Object.create(null);
    for (let index = 0; index < 4096; index++) rows[`tenant-${index}`] = {bytes: String(index), objects: 1};
    const input = snapshot(state(rows));
    const originalRows = input.rows.bind(input);
    const controller = new AbortController();
    input.rows = function* () {
      setImmediate(() => controller.abort());
      yield* originalRows();
    };
    await assert.rejects(compareDisk(input, join(directory, 'unused.csv'), controller.signal), {name: 'AbortError'});
    assert.deepEqual(await readdir(scratchBase), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(directory, {recursive: true, force: true});
  }
});
