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
function sortedTenantIds(state: State) {
  return Object.keys(state.tenants).sort((a, b) => {
    const left = BigInt(state.tenants[a].bytes), right = BigInt(state.tenants[b].bytes);
    return left > right ? -1 : left < right ? 1 : a.localeCompare(b);
  });
}
function metadata(state: State) {
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
    measurement: `${state.config.provider === 'inventory' ? 'Current-version bytes in the supplied inventory export' : 'Current listed object bytes'}; excludes old versions, deleted objects and incomplete uploads. Not a point-in-time snapshot or a provider bill. Partial reports cover only scanned objects. Byte totals are decimal strings.`
  };
}
export function csvCell(value: string | number) {
  let text = String(value);
  // Prevent customer-controlled identifiers becoming spreadsheet formulas.
  if (/^\s*[=+\-@\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function report(state: State) {
  const {measurement, ...header} = metadata(state);
  return {...header, tenants: sortedTenantIds(state).map(tenantId => ({tenantId, ...state.tenants[tenantId]})), measurement};
}

// The CLI consumes this iterator without retaining the complete encoded report.
export function* renderChunks(state: State, format: 'table' | 'json' | 'csv', top = 20, source?: {count: number; rows(): Iterable<{tenantId: string; bytes: string; objects: number}>}): Generator<string> {
  const {measurement, ...result} = metadata(state);
  const ids = source ? [] : sortedTenantIds(state);
  const count = source?.count ?? ids.length;
  function* rows() {
    if (source) yield* source.rows();
    else for (const tenantId of ids) yield {tenantId, ...state.tenants[tenantId]};
  }
  if (format === 'json') {
    yield JSON.stringify(result, null, 2).slice(0, -2) + ',\n  "tenants": [';
    let index = 0;
    for (const tenant of rows()) {
      const row = JSON.stringify(tenant, null, 2).replaceAll('\n', '\n    ');
      yield `${index++ ? ',\n' : '\n'}    ${row}`;
    }
    yield `${count ? '\n  ' : ''}],\n  "measurement": ${JSON.stringify(measurement)}\n}\n`;
    return;
  }
  if (format === 'csv') {
    const row = (cells: (string | number)[]) => cells.map(csvCell).join(',') + '\n';
    yield row(['row_type', 'tenant_id', 'bytes', 'objects', 'status', 'reason', 'started_at', 'finished_at']);
    for (const totals of rows()) {
      yield row(['tenant', totals.tenantId, totals.bytes, totals.objects, result.status, result.reason, result.startedAt, result.finishedAt ?? '']);
    }
    for (const [kind, totals] of [['unmatched', result.unmatched], ['total', result.total]] as const) {
      yield row([kind, '', totals.bytes, totals.objects, result.status, result.reason, result.startedAt, result.finishedAt ?? '']);
    }
    return;
  }
  const displayed: string[] = [];
  for (const tenant of rows()) {
    if (displayed.length >= top) break;
    displayed.push(`${JSON.stringify(tenant.tenantId).padEnd(32)} ${humanBytes(tenant.bytes).padStart(12)} ${String(tenant.objects).padStart(8)}`);
  }
  const lines = [
    `TenantMeter — ${result.status.toUpperCase()} (${result.reason})`,
    `Bucket: ${JSON.stringify(result.bucket)} | Prefix: ${JSON.stringify(result.prefix)}`,
    `Pattern: ${JSON.stringify(result.pattern)}`,
    `Started: ${result.startedAt} | ${result.finishedAt ? `Finished: ${result.finishedAt}` : `Updated: ${result.updatedAt}`}`,
    `Scanned: ${result.total.objects.toLocaleString('en-US')} objects | ${humanBytes(result.total.bytes)} | ${result.pages} pages`,
    '', 'Customer                         Storage          Files',
    ...displayed,
    '', `Matched: ${humanBytes(result.matched.bytes)} (${result.matched.objects} objects; ${count} customers)`,
    `Unmatched: ${humanBytes(result.unmatched.bytes)} (${result.unmatched.objects} objects)`,
    ...(result.invalidTenantObjects ? [`Invalid customer IDs: ${result.invalidTenantObjects} objects, included in unmatched.`] : []),
    ...(count > top ? [`Showing ${top} customers. CSV/JSON exports include every customer.`] : []),
    '', measurement
  ];
  for (const line of lines) yield line + '\n';
}

// Retained for callers that explicitly need a string; CLI paths use renderChunks.
export function render(state: State, format: 'table' | 'json' | 'csv', top = 20) {
  return Array.from(renderChunks(state, format, top)).join('');
}
