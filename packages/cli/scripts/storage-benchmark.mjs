import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { newState } from '../src/model.ts';
import { applyPage } from '../src/scan.ts';
import { saveState } from '../src/state.ts';
import { DiskStore } from '../src/disk.ts';
import { renderChunks } from '../src/report.ts';
import { batches } from '../src/output.ts';

const {values} = parseArgs({options: {
  objects: {type: 'string', default: '20000'}, storage: {type: 'string', default: 'both'},
  'heap-mib': {type: 'string'}, child: {type: 'boolean'}
}});
function integer(raw, max, name) {
  const n = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(n) || n > max) throw new Error(`${name} must be between 1 and ${max}.`);
  return n;
}
const objects = integer(values.objects, 1000000, '--objects');
if (!['json', 'sqlite', 'both'].includes(values.storage)) throw new Error('--storage must be json, sqlite, or both.');
const heap = values['heap-mib'] ? integer(values['heap-mib'], 8192, '--heap-mib') : undefined;
if (!values.child) {
  const results = [];
  for (const storage of values.storage === 'both' ? ['json', 'sqlite'] : [values.storage]) {
    const child = spawnSync(process.execPath, [...(heap ? [`--max-old-space-size=${heap}`] : []), '--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--child', '--objects', String(objects), '--storage', storage], {encoding: 'utf8'});
    if (child.status !== 0) throw new Error(`${storage} benchmark failed: ${child.stderr || child.stdout}`);
    results.push(JSON.parse(child.stdout));
  }
  if (results.length === 2) {
    assert.equal(results[0].reportSha256, results[1].reportSha256);
    assert.equal(results[0].reportBytes, results[1].reportBytes);
  }
  console.log(JSON.stringify({node: process.version, platform: process.platform, architecture: process.arch, objects, distinctTenants: objects, heapLimitMiB: heap ?? null, results,
    scope: 'Separate process per storage mode. Includes page aggregation, durable page commits, and streamed JSON report hashing. Excludes cloud listing and inventory parsing. Report timestamps normalized for byte/hash comparison. Peak RSS includes runtime and SQLite caches. Final checkpoint size excludes transient rollback journal; it is not total disk I/O. One run; timings are indicative.'}, null, 2));
} else {
  if (values.storage === 'both') throw new Error('Child requires one storage mode.');
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-storage-bench-'));
  let disk;
  try {
    const path = join(dir, `state.${values.storage}`);
    let state = newState({provider: 'demo', bucket: 'benchmark', prefix: '', pattern: 'customers/{tenant_id}/*', region: 'auto'});
    if (values.storage === 'sqlite') { disk = await DiskStore.create(path, state.config); state = disk.state(); }
    else await saveState(path, state);
    global.gc?.();
    const began = performance.now();
    for (let start = 0; start < objects; start += 1000) {
      const page = {objects: Array.from({length: Math.min(1000, objects - start)}, (_, offset) => {
        const index = start + offset;
        return {key: `customers/customer-${String(index).padStart(8, '0')}/file`, bytes: index % 65537};
      }), nextCursor: start + 1000 < objects ? String(start + 1000) : null};
      state = {...state, requests: state.requests + 1};
      if (disk) state = disk.applyPage(state, page);
      else { state = applyPage(state, page); await saveState(path, state); }
    }
    const commitMilliseconds = performance.now() - began;
    const normalized = {...state, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z'};
    const hash = createHash('sha256'); let reportBytes = 0;
    for (const chunk of batches(renderChunks(normalized, 'json', 20, disk ? {count: disk.tenantCount(), rows: () => disk.rows()} : undefined))) {
      reportBytes += chunk.length; hash.update(chunk);
    }
    assert.equal(state.objects, objects);
    console.log(JSON.stringify({storage: values.storage, commitMilliseconds: Number(commitMilliseconds.toFixed(2)), totalMilliseconds: Number((performance.now() - began).toFixed(2)), peakRssKiB: process.resourceUsage().maxRSS, finalCheckpointBytes: (await stat(path)).size, objects: state.objects, bytes: state.bytes, reportBytes, reportSha256: hash.digest('hex')}));
  } finally { disk?.close(); await rm(dir, {recursive: true, force: true}); }
}
