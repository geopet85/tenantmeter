import type { State } from './model.ts';
import { csvCell } from './report.ts';

export function diffStates(before: State, after: State) {
  if (before.status !== 'complete' || after.status !== 'complete') throw new Error('Diff requires two complete checkpoints. Resume partial scans first.');
  for (const field of ['provider', 'bucket', 'prefix', 'pattern', 'accountId', 'jurisdiction'] as const) {
    if ((before.config[field] ?? '') !== (after.config[field] ?? '')) throw new Error(`Diff scope differs: ${field}. Use checkpoints with the same source, bucket, prefix, and mapping.`);
  }
  const ids = new Set([...Object.keys(before.tenants), ...Object.keys(after.tenants)]);
  const rows = [...ids].map(tenantId => {
    const old = Object.hasOwn(before.tenants, tenantId) ? before.tenants[tenantId] : undefined;
    const current = Object.hasOwn(after.tenants, tenantId) ? after.tenants[tenantId] : undefined;
    const beforeBytes = old?.bytes ?? '0', afterBytes = current?.bytes ?? '0';
    const deltaBytes = (BigInt(afterBytes) - BigInt(beforeBytes)).toString();
    const beforeObjects = old?.objects ?? 0, afterObjects = current?.objects ?? 0;
    const deltaObjects = afterObjects - beforeObjects;
    const status = !old ? 'added' : !current ? 'removed' : deltaBytes === '0' && !deltaObjects ? 'unchanged' : 'changed';
    return {tenantId, status, beforeBytes, afterBytes, deltaBytes, beforeObjects, afterObjects, deltaObjects};
  });
  const absolute = (value: string) => { const n = BigInt(value); return n < 0n ? -n : n; };
  rows.sort((a, b) => {
    const x = absolute(a.deltaBytes), y = absolute(b.deltaBytes);
    return x > y ? -1 : x < y ? 1 : a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0;
  });
  const different = rows.filter(x => x.status !== 'unchanged').length;
  const unmatched = {beforeBytes: before.unmatched.bytes, afterBytes: after.unmatched.bytes,
    deltaBytes: (BigInt(after.unmatched.bytes) - BigInt(before.unmatched.bytes)).toString(),
    beforeObjects: before.unmatched.objects, afterObjects: after.unmatched.objects,
    deltaObjects: after.unmatched.objects - before.unmatched.objects};
  return {schemaVersion: 1, scope: {provider: after.config.provider, bucket: after.config.bucket, prefix: after.config.prefix, pattern: after.config.pattern},
    beforeStartedAt: before.startedAt, beforeFinishedAt: before.finishedAt, afterStartedAt: after.startedAt, afterFinishedAt: after.finishedAt,
    different, hasDifferences: different > 0 || unmatched.deltaBytes !== '0' || unmatched.deltaObjects !== 0,
    total: {beforeBytes: before.bytes, afterBytes: after.bytes, deltaBytes: (BigInt(after.bytes) - BigInt(before.bytes)).toString(),
      beforeObjects: before.objects, afterObjects: after.objects, deltaObjects: after.objects - before.objects},
    unmatched, rows, note: 'Delta is after minus before. Same usage does not prove objects are unchanged. Scans measure current versions over their stated windows; changes between scans are not time-weighted billing.'};
}
export function renderDiff(result: ReturnType<typeof diffStates>, format: 'json' | 'csv' | 'table', top: number) {
  if (format === 'json') return JSON.stringify(result, null, 2) + '\n';
  if (format === 'csv') {
    const columns = ['row_type','tenant_id','status','before_bytes','after_bytes','delta_bytes','before_objects','after_objects','delta_objects'];
    const summary = (kind: string, x: typeof result.total) => [kind, '', x.deltaBytes !== '0' || x.deltaObjects ? 'changed' : 'unchanged', x.beforeBytes,x.afterBytes,x.deltaBytes,x.beforeObjects,x.afterObjects,x.deltaObjects];
    return [columns, ...result.rows.map(x => ['tenant',x.tenantId,x.status,x.beforeBytes,x.afterBytes,x.deltaBytes,x.beforeObjects,x.afterObjects,x.deltaObjects]), summary('unmatched', result.unmatched), summary('total', result.total)].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
  }
  const changed = result.rows.filter(x => x.status !== 'unchanged');
  return [`Snapshot diff: ${result.different} customer differences`, 'Customer | Before bytes | After bytes | Delta bytes | Delta objects | Status',
    ...changed.slice(0, top).map(x => `${JSON.stringify(x.tenantId)} | ${x.beforeBytes} | ${x.afterBytes} | ${x.deltaBytes} | ${x.deltaObjects} | ${x.status}`),
    ...(changed.length > top ? [`Showing ${top} differences; JSON/CSV contain all customers.`] : []),
    `Total delta: ${result.total.deltaBytes} bytes, ${result.total.deltaObjects} objects.`,
    `Unmatched delta: ${result.unmatched.deltaBytes} bytes, ${result.unmatched.deltaObjects} objects.`, result.note].join('\n') + '\n';
}
