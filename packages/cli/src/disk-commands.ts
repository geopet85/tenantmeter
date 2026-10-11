import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { csvRows, decimalBytes } from './csv.ts';
import { csvCell } from './report.ts';
import type { State, Totals } from './model.ts';
import { sqliteRows } from './sqlite-rows.ts';

export interface Snapshot {
  state: State;
  count: number;
  rows(): Iterable<{ tenantId: string; bytes: string; objects: number }>;
  get(tenantId: string): Totals | undefined;
}

type Format = 'table' | 'json' | 'csv';
type SqlRow = Record<string, string | number | null>;
type ResultRow = {
  tenantId: string;
  status: string;
  leftBytes: string;
  rightBytes: string;
  deltaBytes: string;
  leftObjects: number;
  rightObjects: number;
  deltaObjects: number;
};

const comparisonNote = 'Delta is scanned bytes minus counter bytes. Missing customers are differences even when their bytes are zero. Match measurement scope and dates before changing counters. Unmatched objects are reported separately.';
const diffNote = 'Delta is after minus before. Same usage does not prove objects are unchanged. Scans measure current versions over their stated windows; changes between scans are not time-weighted billing.';

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('Operation interrupted.');
    error.name = 'AbortError';
    throw error;
  }
}

function asText(value: unknown): string { return String(value); }
function asNumber(value: unknown): number { return Number(value); }
function magnitude(value: string) { return value.startsWith('-') ? value.slice(1) : value; }
function csvLine(cells: (string | number)[]) { return cells.map(csvCell).join(',') + '\n'; }
function wellFormed(text: string) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

// The private directory protects SQLite's temporary and journal files too.
async function scratch() {
  const path = await mkdtemp(join(tmpdir(), 'tenantmeter-command-'));
  let db: DatabaseSync | undefined;
  try {
    await chmod(path, 0o700);
    const file = join(path, 'rows.sqlite');
    const sqlite = await import('node:sqlite');
    db = new sqlite.DatabaseSync(file);
    await chmod(file, 0o600);
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;');
    db.exec(`CREATE TABLE entries (
      side INTEGER NOT NULL, tenant_id TEXT COLLATE BINARY NOT NULL,
      bytes TEXT NOT NULL, objects INTEGER NOT NULL,
      PRIMARY KEY (side, tenant_id)
    ) WITHOUT ROWID;
    CREATE TABLE results (
      tenant_id TEXT COLLATE BINARY PRIMARY KEY, status TEXT NOT NULL,
      left_bytes TEXT NOT NULL, right_bytes TEXT NOT NULL, delta_bytes TEXT NOT NULL,
      left_objects INTEGER NOT NULL, right_objects INTEGER NOT NULL, delta_objects INTEGER NOT NULL,
      abs_delta TEXT NOT NULL
    ) WITHOUT ROWID;`);
    const database = db;
    let closed = false;
    return {
      db: database,
      path,
      async close() {
        if (closed) return;
        closed = true;
        try { database.close(); } finally { await rm(path, { recursive: true, force: true }); }
      }
    };
  } catch (error) {
    try { db?.close(); } finally { await rm(path, { recursive: true, force: true }); }
    throw error;
  }
}

const joined = `SELECT ids.tenant_id, left_side.bytes AS left_bytes, left_side.objects AS left_objects,
  right_side.bytes AS right_bytes, right_side.objects AS right_objects
  FROM (SELECT tenant_id FROM entries WHERE side=0 UNION SELECT tenant_id FROM entries WHERE side=1) AS ids
  LEFT JOIN entries AS left_side ON left_side.side=0 AND left_side.tenant_id=ids.tenant_id
  LEFT JOIN entries AS right_side ON right_side.side=1 AND right_side.tenant_id=ids.tenant_id`;

async function insertSnapshot(db: DatabaseSync, snapshot: Snapshot, side: number, signal?: AbortSignal) {
  const insert = db.prepare('INSERT INTO entries(side,tenant_id,bytes,objects) VALUES(?,?,?,?)');
  db.exec('BEGIN');
  try {
    let count = 0;
    for (const row of snapshot.rows()) {
      checkAbort(signal);
      if (!wellFormed(row.tenantId)) throw new Error('Snapshot contains an invalid Unicode customer ID.');
      insert.run(side, row.tenantId, row.bytes, row.objects);
      if (++count % 1024 === 0) await yieldToEventLoop();
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

async function buildResults(db: DatabaseSync, kind: 'compare' | 'diff', signal?: AbortSignal) {
  const insert = db.prepare(`INSERT INTO results
    (tenant_id,status,left_bytes,right_bytes,delta_bytes,left_objects,right_objects,delta_objects,abs_delta)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  let different = 0;
  db.exec('BEGIN');
  try {
    let count = 0;
    for (const row of sqliteRows(db.prepare(joined)) as Iterable<SqlRow>) {
      checkAbort(signal);
      const leftPresent = row.left_bytes !== null;
      const rightPresent = row.right_bytes !== null;
      const leftBytes = leftPresent ? asText(row.left_bytes) : '0';
      const rightBytes = rightPresent ? asText(row.right_bytes) : '0';
      const deltaBytes = (kind === 'compare'
        ? BigInt(leftBytes) - BigInt(rightBytes)
        : BigInt(rightBytes) - BigInt(leftBytes)).toString();
      const leftObjects = leftPresent ? asNumber(row.left_objects) : 0;
      const rightObjects = rightPresent ? asNumber(row.right_objects) : 0;
      const deltaObjects = rightObjects - leftObjects;
      const status = kind === 'compare'
        ? !leftPresent ? 'missing_in_scan' : !rightPresent ? 'missing_in_counters' : deltaBytes === '0' ? 'equal' : 'different'
        : !leftPresent ? 'added' : !rightPresent ? 'removed' : deltaBytes === '0' && deltaObjects === 0 ? 'unchanged' : 'changed';
      if (status !== (kind === 'compare' ? 'equal' : 'unchanged')) different++;
      insert.run(asText(row.tenant_id), status, leftBytes, rightBytes, deltaBytes,
        leftObjects, rightObjects, deltaObjects, magnitude(deltaBytes));
      if (++count % 1024 === 0) await yieldToEventLoop();
    }
    db.exec('COMMIT');
    return different;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Binary UTF-8 tenant ordering is deterministic across hosts. Numeric magnitude
// sorts by digit count then decimal text, without SQLite REAL or 64-bit casts.
function* resultRows(db: DatabaseSync, kind: 'compare' | 'diff', changedOnly = false, limit?: number): Generator<ResultRow> {
  const order = kind === 'compare' ? 'tenant_id COLLATE BINARY ASC'
    : 'length(abs_delta) DESC, abs_delta COLLATE BINARY DESC, tenant_id COLLATE BINARY ASC';
  const where = changedOnly ? `WHERE status != '${kind === 'compare' ? 'equal' : 'unchanged'}'` : '';
  const sql = `SELECT tenant_id,status,left_bytes,right_bytes,delta_bytes,left_objects,right_objects,delta_objects FROM results ${where} ORDER BY ${order}${limit === undefined ? '' : ' LIMIT ?'}`;
  const statement = db.prepare(sql);
  const rows = (limit === undefined ? sqliteRows(statement) : sqliteRows(statement, limit)) as Iterable<SqlRow>;
  for (const row of rows) yield {
    tenantId: asText(row.tenant_id), status: asText(row.status),
    leftBytes: asText(row.left_bytes), rightBytes: asText(row.right_bytes), deltaBytes: asText(row.delta_bytes),
    leftObjects: asNumber(row.left_objects), rightObjects: asNumber(row.right_objects), deltaObjects: asNumber(row.delta_objects)
  };
}

function* jsonRows(prefix: object, rows: Iterable<object>, note: string): Generator<string> {
  yield JSON.stringify(prefix, null, 2).slice(0, -2) + ',\n  "rows": [';
  let count = 0;
  for (const row of rows) {
    yield `${count++ ? ',\n' : '\n'}    ${JSON.stringify(row, null, 2).replaceAll('\n', '\n    ')}`;
  }
  yield `${count ? '\n  ' : ''}],\n  "note": ${JSON.stringify(note)}\n}\n`;
}

export async function compareDisk(snapshot: Snapshot, counterPath: string, signal?: AbortSignal) {
  if (snapshot.state.status !== 'complete') throw new Error('Comparison requires a complete scan. Resume it first.');
  checkAbort(signal);
  const store = await scratch();
  try {
    await insertSnapshot(store.db, snapshot, 0, signal);
    const insert = store.db.prepare('INSERT INTO entries(side,tenant_id,bytes,objects) VALUES(1,?,?,0)');
    const duplicate = store.db.prepare('SELECT 1 FROM entries WHERE side=1 AND tenant_id=?');
    let header = false;
    store.db.exec('BEGIN');
    try {
      for await (const row of csvRows(createReadStream(counterPath, { signal }))) {
        checkAbort(signal);
        if (!header) {
          if (row.length !== 2 || row[0] !== 'tenant_id' || row[1] !== 'bytes') throw new Error('Counter CSV header must be tenant_id,bytes.');
          header = true;
          continue;
        }
        if (row.length !== 2 || !row[0] || !wellFormed(row[0]) || Buffer.byteLength(row[0]) > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(row[0])) throw new Error('Counter CSV contains an invalid customer ID or column count.');
        if (duplicate.get(row[0])) throw new Error('Counter CSV contains a duplicate customer ID.');
        const bytes = decimalBytes(row[1], 'Counter bytes');
        insert.run(row[0], bytes);
      }
      if (!header) throw new Error('Counter CSV is empty.');
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    const different = await buildResults(store.db, 'compare', signal);
    const prefix = {schemaVersion: 1, bucket: snapshot.state.config.bucket, prefix: snapshot.state.config.prefix,
      scanStartedAt: snapshot.state.startedAt, scanFinishedAt: snapshot.state.finishedAt,
      different, unmatched: snapshot.state.unmatched};
    let closed = false;
    return {
      different, hasDifferences: different > 0, scratchPath: store.path,
      close: async () => { closed = true; await store.close(); },
      *chunks(format: Format, top: number): Generator<string> {
        if (closed) throw new Error('Comparison result is closed.');
        if (format === 'json') {
          yield* jsonRows(prefix, (function* () {
            for (const row of resultRows(store.db, 'compare')) {
              checkAbort(signal);
              yield {tenantId: row.tenantId, observedBytes: row.leftBytes, counterBytes: row.rightBytes, deltaBytes: row.deltaBytes, status: row.status};
            }
          })(), comparisonNote);
        } else if (format === 'csv') {
          yield csvLine(['tenant_id', 'observed_bytes', 'counter_bytes', 'delta_bytes', 'status']);
          for (const row of resultRows(store.db, 'compare')) {
            checkAbort(signal);
            yield csvLine([row.tenantId, row.leftBytes, row.rightBytes, row.deltaBytes, row.status]);
          }
        } else {
          yield `Counter comparison: ${different} customer differences\n`;
          yield 'Customer | Scanned bytes | Counter bytes | Delta bytes | Status\n';
          for (const row of resultRows(store.db, 'compare', true, top)) {
            checkAbort(signal);
            yield `${JSON.stringify(row.tenantId)} | ${row.leftBytes} | ${row.rightBytes} | ${row.deltaBytes} | ${row.status}\n`;
          }
          if (different > top) yield `Showing ${top} differences; JSON/CSV include all customers.\n`;
          yield `Unmatched: ${snapshot.state.unmatched.bytes} bytes in ${snapshot.state.unmatched.objects} objects.\n`;
          yield comparisonNote + '\n';
        }
      }
    };
  } catch (error) { await store.close(); throw error; }
}

export async function diffDisk(before: Snapshot, after: Snapshot, signal?: AbortSignal) {
  if (before.state.status !== 'complete' || after.state.status !== 'complete') throw new Error('Diff requires two complete checkpoints. Resume partial scans first.');
  for (const field of ['provider', 'bucket', 'prefix', 'pattern', 'accountId', 'jurisdiction'] as const) {
    if ((before.state.config[field] ?? '') !== (after.state.config[field] ?? '')) throw new Error(`Diff scope differs: ${field}. Use checkpoints with the same source, bucket, prefix, and mapping.`);
  }
  checkAbort(signal);
  const store = await scratch();
  try {
    await insertSnapshot(store.db, before, 0, signal);
    await insertSnapshot(store.db, after, 1, signal);
    const different = await buildResults(store.db, 'diff', signal);
    const delta = (left: Totals, right: Totals) => ({
      beforeBytes: left.bytes, afterBytes: right.bytes,
      deltaBytes: (BigInt(right.bytes) - BigInt(left.bytes)).toString(),
      beforeObjects: left.objects, afterObjects: right.objects, deltaObjects: right.objects - left.objects
    });
    const unmatched = delta(before.state.unmatched, after.state.unmatched);
    const total = delta({bytes: before.state.bytes, objects: before.state.objects}, {bytes: after.state.bytes, objects: after.state.objects});
    const hasDifferences = different > 0 || unmatched.deltaBytes !== '0' || unmatched.deltaObjects !== 0;
    const prefix = {schemaVersion: 1,
      scope: {provider: after.state.config.provider, bucket: after.state.config.bucket, prefix: after.state.config.prefix, pattern: after.state.config.pattern},
      beforeStartedAt: before.state.startedAt, beforeFinishedAt: before.state.finishedAt,
      afterStartedAt: after.state.startedAt, afterFinishedAt: after.state.finishedAt,
      different, hasDifferences, total, unmatched};
    let closed = false;
    return {
      different, hasDifferences, scratchPath: store.path,
      close: async () => { closed = true; await store.close(); },
      *chunks(format: Format, top: number): Generator<string> {
        if (closed) throw new Error('Diff result is closed.');
        if (format === 'json') {
          yield* jsonRows(prefix, (function* () {
            for (const row of resultRows(store.db, 'diff')) {
              checkAbort(signal);
              yield {tenantId: row.tenantId, status: row.status, beforeBytes: row.leftBytes, afterBytes: row.rightBytes,
                deltaBytes: row.deltaBytes, beforeObjects: row.leftObjects, afterObjects: row.rightObjects, deltaObjects: row.deltaObjects};
            }
          })(), diffNote);
        } else if (format === 'csv') {
          yield csvLine(['row_type','tenant_id','status','before_bytes','after_bytes','delta_bytes','before_objects','after_objects','delta_objects']);
          for (const row of resultRows(store.db, 'diff')) {
            checkAbort(signal);
            yield csvLine(['tenant',row.tenantId,row.status,row.leftBytes,row.rightBytes,row.deltaBytes,row.leftObjects,row.rightObjects,row.deltaObjects]);
          }
          for (const [kind, x] of [['unmatched', unmatched], ['total', total]] as const) {
            yield csvLine([kind,'',x.deltaBytes !== '0' || x.deltaObjects ? 'changed' : 'unchanged',
              x.beforeBytes,x.afterBytes,x.deltaBytes,x.beforeObjects,x.afterObjects,x.deltaObjects]);
          }
        } else {
          yield `Snapshot diff: ${different} customer differences\n`;
          yield 'Customer | Before bytes | After bytes | Delta bytes | Delta objects | Status\n';
          for (const row of resultRows(store.db, 'diff', true, top)) {
            checkAbort(signal);
            yield `${JSON.stringify(row.tenantId)} | ${row.leftBytes} | ${row.rightBytes} | ${row.deltaBytes} | ${row.deltaObjects} | ${row.status}\n`;
          }
          if (different > top) yield `Showing ${top} differences; JSON/CSV contain all customers.\n`;
          yield `Total delta: ${total.deltaBytes} bytes, ${total.deltaObjects} objects.\n`;
          yield `Unmatched delta: ${unmatched.deltaBytes} bytes, ${unmatched.deltaObjects} objects.\n`;
          yield diffNote + '\n';
        }
      }
    };
  } catch (error) { await store.close(); throw error; }
}
