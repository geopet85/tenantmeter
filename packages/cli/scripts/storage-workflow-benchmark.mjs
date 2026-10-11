// Full disk workflow benchmark; the smaller JSON/SQLite baseline stays separate.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { DiskStore } from '../src/disk.ts';
import { compareDisk, diffDisk } from '../src/disk-commands.ts';
import { renderChunks } from '../src/report.ts';
import { exportFile } from '../src/output.ts';
import { csvRows } from '../src/csv.ts';

const { values } = parseArgs({ options: {
  tenants: { type: 'string', default: '1000000' }, 'heap-mib': { type: 'string', default: '64' }, child: { type: 'boolean' }
} });
function positive(raw, max, label) {
  const n = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(n) || n > max) throw new Error(`${label} must be between 1 and ${max}.`);
  return n;
}
const tenants = positive(values.tenants, 10000000, '--tenants');
const heapMiB = positive(values['heap-mib'], 8192, '--heap-mib');
const round = n => Number(n.toFixed(2));
const idFor = n => `customer-${String(n).padStart(8, '0')}`;
const bytesFor = n => n % 65537;
const changeFor = n => n % 97 + 1;
const config = { provider: 'demo', bucket: 'benchmark', prefix: '', pattern: 'customers/{tenant_id}/*', region: 'auto' };
const fixedTime = '2026-01-01T00:00:00.000Z';

async function diskUsage(root) {
  const totals = { namedScratchBytes: 0, namedScratchAllocatedBytes: 0, checkpointBytes: 0, inputBytes: 0, exportBytes: 0, allNamedBytes: 0 };
  const seen = new Set();
  async function walk(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      let info;
      try { info = await stat(full); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const key = `${info.dev}:${info.ino}`;
      if (seen.has(key)) continue; // Atomic export briefly links the same file twice.
      seen.add(key);
      const name = relative(root, full).replaceAll('\\', '/');
      totals.allNamedBytes += info.size;
      if (name.startsWith('tmp/tenantmeter-command-')) {
        totals.namedScratchBytes += info.size; totals.namedScratchAllocatedBytes += info.blocks * 512;
      } else if (name.startsWith('checkpoints/')) totals.checkpointBytes += info.size;
      else if (name.startsWith('inputs/')) totals.inputBytes += info.size;
      else if (name.startsWith('exports/')) totals.exportBytes += info.size;
    }
  }
  await walk(root);
  return totals;
}

if (!values.child) {
  const root = await mkdtemp(join(tmpdir(), 'tenantmeter-workflow-bench-'));
  for (const name of ['checkpoints', 'inputs', 'exports', 'tmp']) await mkdir(join(root, name));
  const peaks = {}, stagePeaks = {};
  let currentStage = 'startup', busy = false, pollError, sampleCount = 0, result;
  async function sample() {
    if (busy) return;
    busy = true;
    const stage = currentStage;
    try {
      const usage = await diskUsage(root); sampleCount++;
      const stagePeak = stagePeaks[stage] ??= {};
      for (const [key, n] of Object.entries(usage)) { peaks[key] = Math.max(peaks[key] ?? 0, n); stagePeak[key] = Math.max(stagePeak[key] ?? 0, n); }
    } catch (error) { pollError = error; }
    finally { busy = false; }
  }
  const interval = setInterval(() => { void sample(); }, 50);
  try {
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--child', '--tenants', String(tenants), '--heap-mib', String(heapMiB)], {
      env: { ...process.env, TENANTMETER_BENCH_ROOT: root, TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), SQLITE_TMPDIR: join(root, 'tmp') },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    child.on('message', message => {
      if (message.kind === 'stage') { currentStage = message.name; process.stderr.write(`Benchmark: ${message.name}\n`); }
      else if (message.kind === 'result') result = message.result;
    });
    const completion = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await sample();
    if (completion.code !== 0 || !result) throw new Error(`Workflow benchmark failed: exit ${completion.code}, signal ${completion.signal ?? 'none'}.`);
    if (pollError) throw pollError;
    console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch,
      tenants, heapLimitMiB: heapMiB, ...result,
      disk: { sampleIntervalMilliseconds: 50, sampleCount, sampledPeaks: peaks, stageSampledPeaks: stagePeaks },
      scope: 'One local synthetic run, sequential stages in one heap-limited child. Includes durable page transactions of at most 1000 objects, halfway close/reopen and resume, full checkpoint validation, actual synced JSON/CSV report files, counter CSV import, scratch joins, diff sorting and full comparison/diff CSV exports. Excludes cloud listing and inventory parsing. RSS is the child lifetime high-water mark; sampled heap and named-file disk peaks can miss brief peaks. Disk sizes are logical file lengths (plus allocated blocks for named scratch); transient journals are included when sampled. Unlinked SQLite sorter spill files and total disk I/O are not measured. Parent polls independently of blocked child SQLite operations. Fixtures and outputs are removed after completion.'
    }, null, 2));
  } finally {
    clearInterval(interval);
    while (busy) await yieldToEventLoop();
    await rm(root, { recursive: true, force: true });
  }
} else {
  const root = process.env.TENANTMETER_BENCH_ROOT;
  if (!root || !process.send) throw new Error('Run the parent benchmark without --child.');
  const started = performance.now(), stages = [], exports = [];
  let currentHeapPeak = 0, heapPeak = 0;
  function sampleHeap() { const n = process.memoryUsage().heapUsed; currentHeapPeak = Math.max(currentHeapPeak, n); heapPeak = Math.max(heapPeak, n); }
  const heapTimer = setInterval(sampleHeap, 50);
  async function stage(name, run) {
    global.gc?.(); currentHeapPeak = 0; sampleHeap();
    process.send({ kind: 'stage', name });
    const began = performance.now(), value = await run();
    sampleHeap();
    stages.push({ name, milliseconds: round(performance.now() - began), sampledPeakHeapUsedBytes: currentHeapPeak, lifetimePeakRssKiB: process.resourceUsage().maxRSS });
    return value;
  }
  function snapshot(store) {
    const state = store.state();
    return { state: { ...state, startedAt: fixedTime, updatedAt: fixedTime, finishedAt: fixedTime }, count: store.tenantCount(), rows: () => store.rows(), get: id => store.get(id) };
  }
  async function exportHashed(name, chunks) {
    const hash = createHash('sha256'); let bytes = 0;
    function* measured() { for (const chunk of chunks) { const buffer = Buffer.from(chunk); hash.update(buffer); bytes += buffer.length; yield chunk; } }
    const path = join(root, 'exports', name);
    await exportFile(path, measured()); assert.equal((await stat(path)).size, bytes);
    return { file: name, bytes, sha256: hash.digest('hex') };
  }
  async function pages(store, from, to, changed = false) {
    let state = store.state();
    for (let start = from; start < to; start += 1000) {
      const end = Math.min(to, start + 1000);
      const objects = Array.from({ length: end - start }, (_, offset) => {
        const n = start + offset;
        return { key: `customers/${idFor(n)}/file`, bytes: bytesFor(n) + (changed ? changeFor(n) : 0) };
      });
      state = store.applyPage({ ...state, requests: state.requests + 1 }, { objects, nextCursor: end === tenants ? null : String(end) });
      if ((start - from) % 10000 === 0) { sampleHeap(); await yieldToEventLoop(); }
    }
    return state;
  }
  const beforePath = join(root, 'checkpoints', 'before.sqlite'), afterPath = join(root, 'checkpoints', 'after.sqlite');
  const counterPath = join(root, 'inputs', 'counters.csv'), halfway = Math.max(1, Math.floor(tenants / 2));
  let before, after, comparison, diff, compareScratchBytes, diffScratchBytes;
  let expectedBytes = 0n, expectedDelta = 0n;
  for (let n = 0; n < tenants; n++) { expectedBytes += BigInt(bytesFor(n)); expectedDelta += BigInt(changeFor(n)); }
  try {
    await stage('scan_first_half', async () => { before = await DiskStore.create(beforePath, config); await pages(before, 0, halfway); before.close(); before = undefined; });
    await stage('resume_validation', async () => {
      before = await DiskStore.open(beforePath);
      assert.equal(before.state().objects, halfway); assert.equal(before.tenantCount(), halfway);
      if (halfway < tenants) assert.equal(before.hasCursor(String(halfway)), true);
    });
    await stage('scan_second_half', async () => {
      const state = await pages(before, halfway, tenants);
      assert.equal(state.objects, tenants); assert.equal(state.bytes, String(expectedBytes)); assert.equal(state.status, 'complete');
      before.close(); before = undefined;
    });
    await stage('report_open_validation', async () => { before = await DiskStore.open(beforePath, { readOnly: true }); });
    for (const format of ['json', 'csv']) await stage(`report_${format}_export`, async () => {
      const input = snapshot(before); exports.push(await exportHashed(`report.${format}`, renderChunks(input.state, format, 20, input)));
    });
    await stage('verify_report_csv', async () => {
      let rows = 0, previousBytes, previousId;
      for await (const row of csvRows(createReadStream(join(root, 'exports', 'report.csv')))) {
        if (row[0] !== 'tenant') continue;
        const n = Number(row[1].slice('customer-'.length));
        assert.equal(row[1], idFor(n)); assert.equal(row[2], String(bytesFor(n))); assert.equal(row[3], '1');
        if (previousBytes !== undefined) assert.ok(previousBytes > Number(row[2]) || (previousBytes === Number(row[2]) && previousId < row[1]));
        previousBytes = Number(row[2]); previousId = row[1]; rows++;
      }
      assert.equal(rows, tenants);
    });
    await stage('counter_fixture', async () => {
      function* lines() { yield 'tenant_id,bytes\n'; for (let n = 0; n < tenants; n++) yield `${idFor(n)},${bytesFor(n) + (n % 10 === 0 ? 1 : 0)}\n`; }
      await exportFile(counterPath, lines());
    });
    const compareDifferences = Math.ceil(tenants / 10);
    await stage('comparison_build', async () => {
      comparison = await compareDisk(snapshot(before), counterPath); assert.equal(comparison.different, compareDifferences);
      compareScratchBytes = (await stat(join(comparison.scratchPath, 'rows.sqlite'))).size;
    });
    await stage('comparison_csv_export', async () => { exports.push(await exportHashed('comparison.csv', comparison.chunks('csv', 20))); });
    await comparison.close(); comparison = undefined;
    await stage('changed_snapshot_scan', async () => {
      after = await DiskStore.create(afterPath, config);
      const state = await pages(after, 0, tenants, true);
      assert.equal(state.bytes, String(expectedBytes + expectedDelta)); assert.equal(state.objects, tenants);
      after.close(); after = undefined;
    });
    await stage('diff_open_validation', async () => { after = await DiskStore.open(afterPath, { readOnly: true }); });
    await stage('diff_build', async () => {
      diff = await diffDisk(snapshot(before), snapshot(after)); assert.equal(diff.different, tenants); assert.equal(diff.hasDifferences, true);
      diffScratchBytes = (await stat(join(diff.scratchPath, 'rows.sqlite'))).size;
    });
    await stage('diff_csv_sort_export', async () => { exports.push(await exportHashed('diff.csv', diff.chunks('csv', 20))); });
    await diff.close(); diff = undefined;
    await stage('verify_comparison_and_diff_csv', async () => {
      let rows = 0, different = 0;
      for await (const row of csvRows(createReadStream(join(root, 'exports', 'comparison.csv')))) {
        if (row[0] === 'tenant_id') continue;
        const n = rows++; assert.equal(row[0], idFor(n)); assert.equal(row[1], String(bytesFor(n)));
        assert.equal(row[3], n % 10 === 0 ? "'-1" : '0'); assert.equal(row[4], n % 10 === 0 ? 'different' : 'equal');
        if (row[4] === 'different') different++;
      }
      assert.equal(rows, tenants); assert.equal(different, compareDifferences);
      rows = 0; let previousDelta = Infinity, previousId = '';
      for await (const row of csvRows(createReadStream(join(root, 'exports', 'diff.csv')))) {
        if (row[0] !== 'tenant') continue;
        const n = Number(row[1].slice('customer-'.length)), delta = changeFor(n);
        assert.equal(row[1], idFor(n)); assert.equal(row[2], 'changed'); assert.equal(row[3], String(bytesFor(n)));
        assert.equal(row[4], String(bytesFor(n) + delta)); assert.equal(row[5], String(delta));
        assert.equal(row[6], '1'); assert.equal(row[7], '1'); assert.equal(row[8], '0');
        assert.ok(previousDelta > delta || (previousDelta === delta && previousId < row[1]));
        previousDelta = delta; previousId = row[1]; rows++;
      }
      assert.equal(rows, tenants);
    });
    const finalDisk = await diskUsage(root); assert.equal(finalDisk.namedScratchBytes, 0);
    process.send({ kind: 'result', result: {
      totalMilliseconds: round(performance.now() - started), peakRssKiB: process.resourceUsage().maxRSS, sampledPeakHeapUsedBytes: heapPeak, stages,
      verified: { beforeObjects: tenants, beforeBytes: String(expectedBytes), afterBytes: String(expectedBytes + expectedDelta), compareDifferences, diffDifferences: tenants, diffDeltaBytes: String(expectedDelta), fullCsvRowsAndOrderingChecked: true, scratchRemoved: true },
      files: { beforeCheckpointBytes: (await stat(beforePath)).size, afterCheckpointBytes: (await stat(afterPath)).size, counterCsvBytes: (await stat(counterPath)).size, comparisonScratchDatabaseBytes: compareScratchBytes, diffScratchDatabaseBytes: diffScratchBytes, exports, finalDisk }
    } });
  } finally {
    clearInterval(heapTimer); await comparison?.close(); await diff?.close(); before?.close(); after?.close();
  }
}
