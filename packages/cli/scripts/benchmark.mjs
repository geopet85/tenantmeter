import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { newState } from '../src/model.ts';
import { applyPage, tenantFor } from '../src/scan.ts';
import { compileTenantPattern } from '../../../lib/tenant/pattern.ts';
import assert from 'node:assert/strict';
const {values} = parseArgs({options: {objects: {type: 'string', default: '20000'}, tenants: {type: 'string', default: '20000'}, repeats: {type: 'string', default: '3'}}});
function number(value, max) { const n = Number(value); if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n) || n > max) throw new Error(`Use positive integers at most ${max}.`); return n; }
const count = number(values.objects, 200000), tenants = number(values.tenants, count), repeats = number(values.repeats, 10);
const config = {provider: 'demo', bucket: 'benchmark', region: 'auto', prefix: '', pattern: 'customers/{tenant_id}/*'};
const pages = Array.from({length: Math.ceil(count / 1000)}, (_, page) => ({objects: Array.from({length: Math.min(1000, count - page * 1000)}, (_, i) => {
  const index = page * 1000 + i; return {key: `customers/t${index % tenants}/file-${index}`, bytes: index % 65537};
}), nextCursor: page + 1 < Math.ceil(count / 1000) ? String((page + 1) * 1000) : null}));
// Original aggregation strategy retained only as a benchmark reference.
function baseline(state, page) {
  const next = structuredClone(state); next.tenants = Object.assign(Object.create(null), next.tenants);
  const pattern = compileTenantPattern(state.config.pattern);
  for (const object of page.objects) {
    const {tenant, invalid} = tenantFor(pattern, object.key);
    const totals = tenant === null ? next.unmatched : (next.tenants[tenant] ??= {bytes: '0', objects: 0});
    totals.bytes = String(BigInt(totals.bytes) + BigInt(object.bytes)); totals.objects++;
    next.objects++; next.bytes = String(BigInt(next.bytes) + BigInt(object.bytes));
    if (invalid) next.invalidTenantObjects++;
  }
  next.pages++; next.cursor = page.nextCursor;
  if (page.nextCursor === null) next.status = 'complete';
  return next;
}
function measure(apply) {
  const samples = []; let state;
  for (let run = 0; run < repeats; run++) {
    global.gc?.(); state = newState(config);
    const start = performance.now();
    for (const page of pages) state = apply(state, page);
    samples.push(performance.now() - start);
  }
  samples.sort((a,b) => a-b);
  return {medianMs: Number(samples[Math.floor(samples.length/2)].toFixed(2)), samplesMs: samples.map(x => Number(x.toFixed(2))), state};
}
const original = measure(baseline), current = measure(applyPage);
assert.deepEqual(current.state.tenants, original.state.tenants);
assert.equal(current.state.bytes, original.state.bytes);
const prettyBytes = Buffer.byteLength(JSON.stringify(current.state, null, 2));
const compactBytes = Buffer.byteLength(JSON.stringify(current.state));
console.log(JSON.stringify({node: process.version, platform: process.platform, architecture: process.arch, objects: count, tenants, repeats,
  baseline: {medianMs: original.medianMs, samplesMs: original.samplesMs}, current: {medianMs: current.medianMs, samplesMs: current.samplesMs},
  speedup: Number((original.medianMs/current.medianMs).toFixed(2)), checkpoint: {prettyBytes, compactBytes},
  scope: 'Aggregation only; excludes listing, parsing, checkpoint writes, report sorting, and fsync. Same deterministic pages and matcher for both strategies. Not a cloud throughput estimate.'}, null, 2));
