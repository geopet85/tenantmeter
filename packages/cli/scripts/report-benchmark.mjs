import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { newState } from '../src/model.ts';
import { csvCell, report, renderChunks } from '../src/report.ts';
import { batches } from '../src/output.ts';

const {values} = parseArgs({options: {
  tenants: {type: 'string', default: '100000'}, mode: {type: 'string'}, format: {type: 'string'}
}});
const count = Number(values.tenants);
if (!/^[1-9][0-9]*$/.test(values.tenants) || !Number.isSafeInteger(count) || count > 500000) throw new Error('Use --tenants between 1 and 500000.');
if (!values.mode) {
  const results = [];
  for (const format of ['json', 'csv']) {
    const pair = [];
    for (const mode of ['baseline', 'stream']) {
      const child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--tenants', String(count), '--mode', mode, '--format', format], {encoding: 'utf8'});
      if (child.status !== 0) throw new Error(child.stderr || child.stdout || 'Benchmark failed.');
      pair.push(JSON.parse(child.stdout));
    }
    assert.equal(pair[0].bytes, pair[1].bytes);
    assert.equal(pair[0].sha256, pair[1].sha256);
    results.push({format, baseline: pair[0], stream: pair[1]});
  }
  console.log(JSON.stringify({node: process.version, platform: process.platform, architecture: process.arch, tenants: count, results,
    scope: 'Separate child process per strategy/format. Peak RSS includes Node, fixture creation, rendering, UTF-8 encoding and hashing. Excludes checkpoint loading, disk writes, fsync and cloud calls. One run per combination; timing is indicative. Equal bytes and SHA-256 required.'}, null, 2));
} else {
  if (!['baseline', 'stream'].includes(values.mode) || !['json', 'csv'].includes(values.format)) throw new Error('Invalid benchmark strategy or format.');
  const state = newState({provider: 'demo', bucket: 'benchmark', region: 'auto', prefix: '', pattern: 'customers/{tenant_id}/*'});
  state.startedAt = state.updatedAt = '2026-01-01T00:00:00.000Z';
  state.finishedAt = state.updatedAt; state.status = 'complete'; state.reason = 'complete';
  for (let i = 0; i < count; i++) state.tenants[`customer-${String(i).padStart(8, '0')}`] = {bytes: String(i % 65537), objects: 1};
  state.objects = count; state.bytes = Object.values(state.tenants).reduce((sum, x) => sum + BigInt(x.bytes), 0n).toString();
  global.gc?.();
  const began = performance.now();
  const hash = createHash('sha256'); let bytes = 0;
  if (values.mode === 'baseline') {
    const result = report(state);
    let text;
    if (values.format === 'json') text = JSON.stringify(result, null, 2) + '\n';
    else {
      const header = ['row_type', 'tenant_id', 'bytes', 'objects', 'status', 'reason', 'started_at', 'finished_at'];
      const rows = result.tenants.map(x => ['tenant', x.tenantId, x.bytes, x.objects, result.status, result.reason, result.startedAt, result.finishedAt ?? '']);
      for (const [kind, totals] of [['unmatched', result.unmatched], ['total', result.total]]) rows.push([kind, '', totals.bytes, totals.objects, result.status, result.reason, result.startedAt, result.finishedAt ?? '']);
      text = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
    }
    const encoded = Buffer.from(text); bytes = encoded.length; hash.update(encoded);
  } else {
    for (const chunk of batches(renderChunks(state, values.format))) { bytes += chunk.length; hash.update(chunk); }
  }
  console.log(JSON.stringify({milliseconds: Number((performance.now() - began).toFixed(2)), peakRssKiB: process.resourceUsage().maxRSS, bytes, sha256: hash.digest('hex')}));
}
