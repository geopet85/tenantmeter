import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskStore } from '../src/disk.ts';
import { newState, type Config, type ObjectRow, type Source, type State } from '../src/model.ts';
import { scan } from '../src/scan.ts';
import { loadState, saveState } from '../src/state.ts';
import { renderChunks } from '../src/report.ts';
import { compareCounters, renderComparison } from '../src/compare.ts';
import { diffStates, renderDiff } from '../src/diff.ts';
import { compareDisk, diffDisk, type Snapshot } from '../src/disk-commands.ts';

const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || major === 22 && minor >= 13;
const seeds = [0, 1, 2, 3, 4, 17, 33, 12345, 0xc0ffee, 0xdeadbeef, 20261010, 0xffffffff];
const ids = ['a', 'Z', '__proto__', 'constructor', '=SUM(1,2)', 'a"b,c', '東京', 'é', '😀', '\ue000', 'zero', 'bad\u0001id', 'x'.repeat(513), ''];
function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ value >>> 15, value | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return (mixed ^ mixed >>> 14) >>> 0;
  };
}
function configuration(seed: number): Config {
  return {provider: 'demo', bucket: 'demo-bucket', region: 'auto', prefix: '',
    pattern: seed % 2 ? 'root/*/prefix-{tenant_id}-suffix/*' : 'customers/{tenant_id}/*'};
}
function key(config: Config, id: string, index: number) {
  return config.pattern.startsWith('root/') ? `root/shard-${index % 3}/prefix-${id}-suffix/file-${index}` : `customers/${id}/file-${index}`;
}
function objects(seed: number, config: Config, length: number) {
  const next = random(seed);
  const rows: ObjectRow[] = [];
  for (let i = 0; i < length; i++) {
    const id = ids[next() % ids.length];
    const bytes = [0, 1, 7, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, next() % 1000000][next() % 6];
    rows.push({key: next() % 7 ? key(config, id, i) : `unmatched/file-${i}`, bytes});
  }
  if (length > 2) {
    rows[0] = {key: key(config, '__proto__', 0), bytes: Number.MAX_SAFE_INTEGER};
    rows[1] = {key: key(config, 'constructor', 1), bytes: Number.MAX_SAFE_INTEGER};
    rows[2] = {key: key(config, 'zero', 2), bytes: 0};
  }
  return rows;
}
function source(rows: ObjectRow[], seed: number, failSecond = false): Source {
  let calls = 0;
  return {close() {}, async page(cursor, maxKeys) {
    if (failSecond && ++calls === 2) throw new Error('seeded provider failure');
    const offset = cursor === null ? 0 : Number(cursor.slice('offset:'.length));
    const size = Math.min(maxKeys, 5 + ((seed ^ Math.imul(offset + 1, 2654435761)) >>> 0) % 19);
    const next = Math.min(rows.length, offset + size);
    return {objects: rows.slice(offset, next), nextCursor: next === rows.length ? null : `offset:${next}`};
  }};
}
function snapshot(state: State, disk?: DiskStore): Snapshot {
  return {state, count: disk ? disk.tenantCount() : Object.keys(state.tenants).length,
    *rows() { if (disk) yield* disk.rows(); else for (const [tenantId, totals] of Object.entries(state.tenants)) yield {tenantId, ...totals}; },
    get(tenantId) { return disk ? disk.get(tenantId) : state.tenants[tenantId]; }};
}
function materialized(disk: DiskStore): State {
  return {...disk.state(), tenants: Object.fromEntries([...disk.rows()].map(({tenantId, ...totals}) => [tenantId, totals]))};
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(normalize);
    // JSON uses existing locale/UTF-16 ordering; opt-in SQLite uses binary UTF-8.
    if (normalized.every(row => row !== null && typeof row === 'object' && 'tenantId' in row)) {
      normalized.sort((a, b) => Buffer.compare(Buffer.from((a as {tenantId: string}).tenantId), Buffer.from((b as {tenantId: string}).tenantId)));
    }
    return normalized;
  }
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, content]) =>
    [name, /(?:started|updated|finished)at$/i.test(name) && content !== null ? '<timestamp>' : normalize(content)]));
  return value;
}
function accounting(state: State) {
  return {objects: state.objects, bytes: state.bytes, tenants: state.tenants,
    unmatched: state.unmatched, invalidTenantObjects: state.invalidTenantObjects};
}
function output(chunks: Iterable<string>) { return [...chunks].join(''); }
function unorderedLines(text: string) {
  return text.trimEnd().replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<timestamp>').split('\n').sort();
}

async function runStage(state: State, rows: ObjectRow[], seed: number, path: string, disk?: DiskStore, mode?: number) {
  const controller = new AbortController();
  let progress = 0;
  const limit = rows.length ? 1 + random(seed ^ 0xbadcafe)() % Math.max(1, rows.length - 1) : Infinity;
  const requestLimit = 1 + seed % 3;
  try {
    await scan({state, source: source(rows, seed, mode === 2),
      maxObjects: mode === 0 ? limit : Infinity, maxRequests: mode === 1 ? requestLimit : undefined,
      signal: controller.signal,
      save: value => disk ? Promise.resolve(disk.save(value)) : saveState(path, value),
      commit: disk ? (value, page, pattern) => disk.applyPage(value, page, pattern) : undefined,
      hasCursor: disk ? cursor => disk.hasCursor(cursor) : undefined,
      progress: mode === 3 ? () => { if (++progress === 1) controller.abort(); } : undefined});
  } catch (error) {
    if (mode !== 2 || !(error instanceof Error) || error.message !== 'seeded provider failure') throw error;
  }
  return disk ? disk.state() : loadState(path);
}

async function pair(dir: string, label: string, rows: ObjectRow[], seed: number, seen: Set<string>) {
  const config = configuration(seed);
  const jsonPath = join(dir, `${label}.json`), diskPath = join(dir, `${label}.sqlite`);
  await saveState(jsonPath, newState(config));
  let disk = await DiskStore.create(diskPath, config);
  try {
    const mode = seed % 4;
    let json = await runStage(await loadState(jsonPath), rows, seed, jsonPath, undefined, mode);
    let stored = await runStage(disk.state(), rows, seed, diskPath, disk, mode);
    seen.add(json.reason);
    assert.deepEqual(normalize(materialized(disk)), normalize(json), `seed ${seed}: persisted initial stop`);
    assert.equal(stored.reason, json.reason);
    disk.close(); disk = await DiskStore.open(diskPath);
    json = await loadState(jsonPath);
    assert.deepEqual(normalize(materialized(disk)), normalize(json), `seed ${seed}: reopened checkpoint`);
    json = await runStage(json, rows, seed, jsonPath);
    stored = await runStage(disk.state(), rows, seed, diskPath, disk);
    assert.deepEqual(normalize(materialized(disk)), normalize(json), `seed ${seed}: resumed complete scan`);
    assert.equal(stored.status, 'complete');
    const full = await scan({state: newState(config), source: source(rows, seed), maxObjects: Infinity,
      signal: new AbortController().signal, save: async () => {}});
    assert.deepEqual(normalize(accounting(json)), normalize(accounting(full)), `seed ${seed}: resume equals uninterrupted scan`);
    assert.deepEqual(normalize(JSON.parse(output(renderChunks(stored, 'json', 20, snapshot(stored, disk))))),
      normalize(JSON.parse(output(renderChunks(json, 'json')))), `seed ${seed}: JSON report equivalence`);
    assert.deepEqual(unorderedLines(output(renderChunks(stored, 'csv', 20, snapshot(stored, disk)))),
      unorderedLines(output(renderChunks(json, 'csv'))), `seed ${seed}: CSV report equivalence`);
    return {json, disk};
  } catch (error) { disk.close(); throw error; }
}

function counterCsv(state: State, seed: number) {
  const next = random(seed ^ 0xfeedface), lines = ['tenant_id,bytes'];
  const cell = (id: string) => `"${id.replaceAll('"', '""')}"`;
  for (const [id, totals] of Object.entries(state.tenants)) {
    const kind = next() % 5;
    if (kind === 0) continue;
    const delta = kind < 3 ? 0n : BigInt(next() % 500) * (kind === 3 ? -1n : 1n);
    const changed = BigInt(totals.bytes) + delta;
    lines.push(`${cell(id)},${changed < 0n ? '0' : changed.toString()}`);
  }
  lines.push(`counter-only-${seed},0`);
  return lines.join('\n') + '\n';
}

test('seeded JSON and SQLite scans/resumes, reports, counter comparisons and mixed diffs are semantically equivalent', {skip: !supported}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-storage-equivalence-'));
  const reasons = new Set<string>();
  try {
    for (const seed of seeds) {
      const config = configuration(seed), next = random(seed);
      const rows = objects(seed, config, seed === 0 ? 0 : 70 + next() % 60);
      const afterRows = rows.filter(() => next() % 4 !== 0).map(row => ({...row, bytes: next() % 3 ? row.bytes : next() % 200}));
      afterRows.push(...objects(seed ^ 0x13579bdf, config, 20).map(row => ({...row, key: row.key + '/added'})));
      const before = await pair(dir, `${seed}-before`, rows, seed, reasons);
      let after: Awaited<ReturnType<typeof pair>> | undefined;
      try {
        after = await pair(dir, `${seed}-after`, afterRows, seed, reasons);
        const counters = join(dir, `${seed}-counters.csv`); await writeFile(counters, counterCsv(after.json, seed));
        const expectedComparison = await compareCounters(after.json, counters);
        const actualComparison = await compareDisk(snapshot(after.disk.state(), after.disk), counters);
        try {
          assert.deepEqual(normalize(JSON.parse(output(actualComparison.chunks('json', 1000)))), normalize(expectedComparison), `seed ${seed}: comparison schema and rows`);
          for (const format of ['csv', 'table'] as const) assert.deepEqual(unorderedLines(output(actualComparison.chunks(format, 1000))),
            unorderedLines(renderComparison(expectedComparison, format, 1000)), `seed ${seed}: ${format} comparison`);
        } finally { await actualComparison.close(); }
        const expectedDiff = diffStates(before.json, after.json);
        for (const [left, right] of [
          [snapshot(before.disk.state(), before.disk), snapshot(after.disk.state(), after.disk)],
          [snapshot(before.json), snapshot(after.disk.state(), after.disk)],
          [snapshot(before.disk.state(), before.disk), snapshot(after.json)]
        ]) {
          const actualDiff = await diffDisk(left, right);
          try {
            assert.deepEqual(normalize(JSON.parse(output(actualDiff.chunks('json', 1000)))), normalize(expectedDiff), `seed ${seed}: mixed diff schema and rows`);
            for (const format of ['csv', 'table'] as const) assert.deepEqual(unorderedLines(output(actualDiff.chunks(format, 1000))),
              unorderedLines(renderDiff(expectedDiff, format, 1000)), `seed ${seed}: ${format} mixed diff`);
          } finally { await actualDiff.close(); }
        }
      } finally { before.disk.close(); after?.disk.close(); }
    }
    for (const reason of ['complete', 'object-limit', 'request-limit', 'error', 'interrupted']) assert.ok(reasons.has(reason), `Missing seeded stop scenario: ${reason}`);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
