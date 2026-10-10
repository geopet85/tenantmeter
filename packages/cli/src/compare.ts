import { createReadStream } from 'node:fs';
import { csvRows, decimalBytes } from './csv.ts';
import { csvCell } from './report.ts';
import type { State } from './model.ts';

export async function compareCounters(state: State, path: string) {
  if (state.status !== 'complete') throw new Error('Comparison requires a complete scan. Resume it first.');
  const counters = new Map<string, string>();
  let header = false;
  for await (const row of csvRows(createReadStream(path))) {
    if (!header) {
      if (row.length !== 2 || row[0] !== 'tenant_id' || row[1] !== 'bytes') throw new Error('Counter CSV header must be tenant_id,bytes.');
      header = true;
      continue;
    }
    if (row.length !== 2 || !row[0] || Buffer.byteLength(row[0]) > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(row[0])) throw new Error('Counter CSV contains an invalid customer ID or column count.');
    if (counters.has(row[0])) throw new Error('Counter CSV contains a duplicate customer ID.');
    counters.set(row[0], decimalBytes(row[1], 'Counter bytes'));
  }
  if (!header) throw new Error('Counter CSV is empty.');
  const ids = new Set([...Object.keys(state.tenants), ...counters.keys()]);
  const rows = [...ids].sort().map(tenantId => {
    const observedBytes = state.tenants[tenantId]?.bytes ?? '0';
    const counterBytes = counters.get(tenantId) ?? '0';
    const deltaBytes = (BigInt(observedBytes) - BigInt(counterBytes)).toString();
    return { tenantId, observedBytes, counterBytes, deltaBytes,
      status: !Object.hasOwn(state.tenants, tenantId) ? 'missing_in_scan' : !counters.has(tenantId) ? 'missing_in_counters' : deltaBytes === '0' ? 'equal' : 'different' };
  });
  return { schemaVersion: 1, bucket: state.config.bucket, prefix: state.config.prefix, scanStartedAt: state.startedAt,
    scanFinishedAt: state.finishedAt, different: rows.filter(x => x.status !== 'equal').length,
    unmatched: state.unmatched, rows,
    note: 'Delta is scanned bytes minus counter bytes. Missing customers are differences even when their bytes are zero. Match measurement scope and dates before changing counters. Unmatched objects are reported separately.' };
}
export function renderComparison(result: Awaited<ReturnType<typeof compareCounters>>, format: 'table' | 'json' | 'csv', top: number) {
  if (format === 'json') return JSON.stringify(result, null, 2) + '\n';
  if (format === 'csv') return [
    ['tenant_id', 'observed_bytes', 'counter_bytes', 'delta_bytes', 'status'],
    ...result.rows.map(x => [x.tenantId, x.observedBytes, x.counterBytes, x.deltaBytes, x.status])
  ].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
  const changed = result.rows.filter(x => x.status !== 'equal');
  return [
    `Counter comparison: ${result.different} customer differences`,
    'Customer | Scanned bytes | Counter bytes | Delta bytes | Status',
    ...changed.slice(0, top).map(x => `${JSON.stringify(x.tenantId)} | ${x.observedBytes} | ${x.counterBytes} | ${x.deltaBytes} | ${x.status}`),
    ...(changed.length > top ? [`Showing ${top} differences; JSON/CSV include all customers.`] : []),
    `Unmatched: ${result.unmatched.bytes} bytes in ${result.unmatched.objects} objects.`, result.note
  ].join('\n') + '\n';
}
