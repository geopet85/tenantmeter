import type { State } from './model.ts';

export function humanBytes(raw: string) {
  const bytes = BigInt(raw);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let divisor = 1n;
  let unit = 0;
  while (bytes >= divisor * 1024n && unit < units.length - 1) { divisor *= 1024n; unit++; }
  const hundredths = bytes * 100n / divisor;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')} ${units[unit]}`;
}
export function report(state: State) {
  const tenants = Object.entries(state.tenants).map(([tenantId, totals]) => ({ tenantId, ...totals }));
  tenants.sort((a, b) => BigInt(a.bytes) > BigInt(b.bytes) ? -1 : BigInt(a.bytes) < BigInt(b.bytes) ? 1 : a.tenantId.localeCompare(b.tenantId));
  return {
    schemaVersion: 1,
    status: state.status,
    reason: state.reason,
    provider: state.config.provider,
    bucket: state.config.bucket,
    prefix: state.config.prefix,
    pattern: state.config.pattern,
    inventoryCreatedAt: state.config.inventory?.createdAt ?? null,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    finishedAt: state.finishedAt,
    listingCalls: state.config.provider === 'inventory' ? 0 : state.requests,
    pageCalls: state.requests,
    pages: state.pages,
    total: { bytes: state.bytes, objects: state.objects },
    matched: { bytes: (BigInt(state.bytes) - BigInt(state.unmatched.bytes)).toString(), objects: state.objects - state.unmatched.objects },
    unmatched: state.unmatched,
    invalidTenantObjects: state.invalidTenantObjects,
    tenants,
    measurement: `${state.config.provider === 'inventory' ? 'Current-version bytes in the supplied inventory export' : 'Current listed object bytes'}; excludes old versions, deleted objects and incomplete uploads. Not a point-in-time snapshot or a provider bill. Partial reports cover only scanned objects. Byte totals are decimal strings.`
  };
}
export function csvCell(value: string | number) {
  let text = String(value);
  // Prevent customer-controlled identifiers becoming spreadsheet formulas.
  if (/^\s*[=+\-@\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function render(state: State, format: 'table' | 'json' | 'csv', top = 20) {
  const result = report(state);
  if (format === 'json') return JSON.stringify(result, null, 2) + '\n';
  if (format === 'csv') {
    const header = ['row_type', 'tenant_id', 'bytes', 'objects', 'status', 'reason', 'started_at', 'finished_at'];
    const rows = result.tenants.map(x => ['tenant', x.tenantId, x.bytes, x.objects, result.status, result.reason, result.startedAt, result.finishedAt ?? '']);
    rows.push(['unmatched', '', result.unmatched.bytes, result.unmatched.objects, result.status, result.reason, result.startedAt, result.finishedAt ?? '']);
    rows.push(['total', '', result.total.bytes, result.total.objects, result.status, result.reason, result.startedAt, result.finishedAt ?? '']);
    return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
  }
  const lines = [
    `TenantMeter — ${result.status.toUpperCase()} (${result.reason})`,
    `Bucket: ${JSON.stringify(result.bucket)} | Prefix: ${JSON.stringify(result.prefix)}`,
    `Pattern: ${JSON.stringify(result.pattern)}`,
    `Started: ${result.startedAt} | ${result.finishedAt ? `Finished: ${result.finishedAt}` : `Updated: ${result.updatedAt}`}`,
    `Scanned: ${result.total.objects.toLocaleString('en-US')} objects | ${humanBytes(result.total.bytes)} | ${result.pages} pages`,
    '', 'Customer                         Storage          Files',
    ...result.tenants.slice(0, top).map(x => `${JSON.stringify(x.tenantId).padEnd(32)} ${humanBytes(x.bytes).padStart(12)} ${String(x.objects).padStart(8)}`),
    '', `Matched: ${humanBytes(result.matched.bytes)} (${result.matched.objects} objects; ${result.tenants.length} customers)`,
    `Unmatched: ${humanBytes(result.unmatched.bytes)} (${result.unmatched.objects} objects)`,
    ...(result.invalidTenantObjects ? [`Invalid customer IDs: ${result.invalidTenantObjects} objects, included in unmatched.`] : []),
    ...(result.tenants.length > top ? [`Showing ${top} customers. CSV/JSON exports include every customer.`] : []),
    '', result.measurement
  ];
  return lines.join('\n') + '\n';
}
