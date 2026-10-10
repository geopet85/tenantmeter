import { link, lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { compileTenantPattern, type TenantPattern } from '../../../lib/tenant/pattern.ts';
import { newState, type Config, type Page, type State, type Totals } from './model.ts';
import { applyPage, tenantFor } from './scan.ts';
import { validateState } from './state.ts';

const APPLICATION_ID = 0x544d5452; // TMTR
const SCHEMA_VERSION = 1;
const activeFiles = new Set<string>();
const schemas = {
  metadata: 'CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL) STRICT',
  tenants: `CREATE TABLE tenants (tenantId TEXT PRIMARY KEY COLLATE BINARY, bytes TEXT NOT NULL CHECK (length(bytes) > 0 AND bytes NOT GLOB '*[^0-9]*' AND (bytes = '0' OR substr(bytes, 1, 1) != '0')), objects INTEGER NOT NULL CHECK (objects >= 0 AND objects <= 9007199254740991)) STRICT, WITHOUT ROWID`,
  cursors: 'CREATE TABLE cursors (cursor TEXT PRIMARY KEY COLLATE BINARY CHECK (length(cursor) > 0)) STRICT, WITHOUT ROWID',
  tenants_usage: 'CREATE INDEX tenants_usage ON tenants (length(bytes) DESC, bytes DESC, tenantId COLLATE BINARY ASC)'
};
export class DiskRecoveryRequiredError extends Error {
  constructor() { super('Disk checkpoint requires journal recovery. Reopen it with an exclusive checkpoint lock before reporting.'); this.name = 'DiskRecoveryRequiredError'; }
}
const invalid = () => new Error('Invalid or unsupported disk checkpoint. Use a valid TenantMeter SQLite checkpoint or a new state file.');

async function sqlite() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error('Disk storage requires Node.js 22.13 or newer. Upgrade Node.js or use the default JSON storage.');
  }
  try { return await import('node:sqlite'); }
  catch { throw new Error('Disk storage requires a Node.js build with node:sqlite (Node.js 22.13 or newer).'); }
}

async function safePath(path: string, existing: boolean) {
  const absolute = resolve(path);
  if (!existing) await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const canonical = join(await realpath(dirname(absolute)), basename(absolute));
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const entry = await lstat(canonical + suffix);
      if (!entry.isFile() || entry.nlink !== 1) throw new Error('Disk checkpoint must be a regular file without symbolic or hard links.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (existing && suffix === '')) throw error;
    }
  }
  return canonical;
}

function tune(db: DatabaseSync) {
  // SQLite's sort and cache stay bounded even when the number of tenants grows.
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
}
function metadata(state: State): State {
  return { ...state, unmatched: { ...state.unmatched }, tenants: Object.create(null) };
}
function assertProgressSame(a: State, b: State) {
  for (const key of ['config', 'startedAt', 'cursor', 'pages', 'objects', 'bytes', 'unmatched', 'invalidTenantObjects'] as const) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) throw new Error('Disk checkpoint progress must only be changed by an atomic page transaction.');
  }
}
function wellFormed(value: string) { return !/[\ud800-\udfff]/u.test(value); }
function validTenant(id: string) {
  return wellFormed(id) && id.length > 0 && Buffer.byteLength(id) <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(id);
}

/** Disk checkpoints keep only page-sized tenant maps in JavaScript memory. */
export class DiskStore {
  private closed = false;
  private constructor(readonly path: string, readonly db: DatabaseSync, private readonly readOnly = false, private readonly identityKey?: string) {}

  /** Guard raw header probes, whose descriptor close would release SQLite locks. */
  static async assertNotOpen(path: string): Promise<void> {
    try {
      const identity = await stat(path); // Follow aliases without opening a descriptor.
      if (activeFiles.has(`${identity.dev}:${identity.ino}`)) throw new Error('Disk checkpoint is already open in this process. Reuse the existing store or close it first.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  static async create(path: string, config: Config, signal?: AbortSignal): Promise<DiskStore> {
    return DiskStore.importJson(path, newState(config), signal);
  }

  /** Import to a new path; callers may replace their legacy file after success. */
  static async importJson(path: string, state: State, signal?: AbortSignal): Promise<DiskStore> {
    const options = { signal };
    signal?.throwIfAborted();
    validateState(state);
    for (const id of Object.keys(state.tenants)) if (!validTenant(id)) throw new Error('Disk checkpoint tenant IDs must contain valid Unicode.');
    if (state.cursor !== null && !wellFormed(state.cursor)) throw new Error('Disk checkpoint cursors must contain valid Unicode.');
    const { DatabaseSync } = await sqlite();
    path = await safePath(path, false);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    await file.close();
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(temporary);
      tune(db);
      db.exec('BEGIN IMMEDIATE');
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
      for (const sql of Object.values(schemas)) db.exec(sql);
      const insert = db.prepare('INSERT INTO tenants (tenantId, bytes, objects) VALUES (?, ?, ?)');
      let inserted = 0;
      for (const [id, totals] of Object.entries(state.tenants)) {
        insert.run(id, totals.bytes, totals.objects);
        if (++inserted % 1000 === 0) await setImmediate(undefined, { signal: options.signal });
      }
      options.signal?.throwIfAborted();
      db.prepare('INSERT INTO metadata (id, state) VALUES (1, ?)').run(JSON.stringify(metadata(state)));
      if (state.cursor !== null) db.prepare('INSERT INTO cursors (cursor) VALUES (?)').run(state.cursor);
      db.exec('COMMIT');
      db.close(); db = undefined;
      // Publish a complete database without ever replacing an existing file.
      options.signal?.throwIfAborted();
      await link(temporary, path);
      await rm(temporary);
      // Publication is the commit boundary. Cancellation after it must not
      // report a failed migration while leaving a successfully committed DB.
      return await DiskStore.open(path);
    } catch (error) {
      try { db?.close(); } catch { /* Preserve the import error. */ }
      await rm(temporary, { force: true });
      await rm(`${temporary}-journal`, { force: true });
      throw error;
    }
  }

  static async open(path: string, options: { readOnly?: boolean; signal?: AbortSignal } = {}): Promise<DiskStore> {
    options.signal?.throwIfAborted();
    const { DatabaseSync } = await sqlite();
    path = await safePath(path, true);
    const identity = await lstat(path);
    const identityKey = `${identity.dev}:${identity.ino}`;
    if (activeFiles.has(identityKey)) throw new Error('Disk checkpoint is already open in this process. Close the existing store before opening it again.');
    activeFiles.add(identityKey);
    let db: DatabaseSync | undefined;
    try {
      if (!identity.isFile() || identity.nlink !== 1) throw new Error('Disk checkpoint must be a regular file without symbolic or hard links.');
      const header = Buffer.alloc(100);
      let bytesRead: number;
      const guarded = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const openedIdentity = await guarded.stat();
        if (openedIdentity.dev !== identity.dev || openedIdentity.ino !== identity.ino || openedIdentity.nlink !== 1) throw new Error('Disk checkpoint file changed before validation.');
        ({ bytesRead } = await guarded.read(header, 0, 100, 0));
      } finally {
        // On POSIX closing any descriptor for this inode releases process-wide
        // SQLite locks, so no raw descriptors may survive connection creation.
        await guarded.close();
      }
      if (bytesRead !== 100 || header.subarray(0, 16).toString() !== 'SQLite format 3\u0000' ||
          header.readUInt32BE(68) !== APPLICATION_ID || header.readUInt32BE(60) !== SCHEMA_VERSION) throw invalid();
      // Validate on the connection that will be returned, before persistent PRAGMAs.
      db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000; BEGIN');
      if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
          db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION) throw invalid();
      const entries = db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name LIMIT 5").all();
      if (entries.length !== Object.keys(schemas).length || entries.some(row =>
        !(row.name as string in schemas) || row.sql !== schemas[row.name as keyof typeof schemas])) throw invalid();
      const store = new DiskStore(path, db);
      const state = store.state();
      if (Object.keys(state.tenants).length || db.prepare('SELECT count(*) AS count FROM metadata').get()?.count !== 1) throw invalid();
      let bytes = BigInt(state.unmatched.bytes), objects = state.unmatched.objects, checked = 0;
      for (const row of db.prepare('SELECT tenantId, bytes, objects FROM tenants').iterate()) {
        if (typeof row.tenantId !== 'string' || !validTenant(row.tenantId) || typeof row.bytes !== 'string' ||
            !/^(0|[1-9][0-9]*)$/.test(row.bytes) || typeof row.objects !== 'number' || !Number.isSafeInteger(row.objects) || row.objects < 0) throw invalid();
        bytes += BigInt(row.bytes); objects += row.objects;
        if (!Number.isSafeInteger(objects)) throw invalid();
        if (++checked % 1000 === 0) await setImmediate(undefined, { signal: options.signal });
      }
      if (bytes.toString() !== state.bytes || objects !== state.objects) throw invalid();
      for (const row of db.prepare('SELECT cursor FROM cursors').iterate()) {
        if (typeof row.cursor !== 'string' || !row.cursor.length || !wellFormed(row.cursor)) throw invalid();
        if (++checked % 1000 === 0) await setImmediate(undefined, { signal: options.signal });
      }
      if (state.cursor !== null && !store.hasCursor(state.cursor)) throw invalid();
      options.signal?.throwIfAborted();
      const currentIdentity = await lstat(path);
      if (!currentIdentity.isFile() || currentIdentity.nlink !== 1 || currentIdentity.dev !== identity.dev || currentIdentity.ino !== identity.ino) {
        throw new Error('Disk checkpoint file changed during validation. Retry with its original path.');
      }
      if (options.readOnly) return new DiskStore(path, db, true, identityKey);
      options.signal?.throwIfAborted();
      db.exec('ROLLBACK');
      tune(db);
      return new DiskStore(path, db, false, identityKey);
    } catch (error) {
      try { db?.close(); } catch { /* Preserve the validation error. */ }
      activeFiles.delete(identityKey);
      if (options.signal?.aborted) throw options.signal.reason;
      const code = (error as { errcode?: number }).errcode;
      if (options.readOnly && typeof code === 'number' && (code & 255) === 8) throw new DiskRecoveryRequiredError();
      if (error instanceof Error && /checkpoint|regular file/i.test(error.message)) throw error;
      throw invalid();
    }
  }

  state(): State {
    const value = this.db.prepare('SELECT state FROM metadata WHERE id = 1').get()?.state;
    if (typeof value !== 'string') throw invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw invalid(); }
    const state = validateState(parsed, false);
    if (state.cursor !== null && !wellFormed(state.cursor)) throw invalid();
    return state;
  }
  tenantCount(): number {
    return this.db.prepare('SELECT count(*) AS count FROM tenants').get()!.count as number;
  }
  get(tenantId: string): Totals | undefined {
    if (!wellFormed(tenantId)) throw new Error('Disk checkpoint tenant IDs must contain valid Unicode.');
    const row = this.db.prepare('SELECT bytes, objects FROM tenants WHERE tenantId = ?').get(tenantId);
    return row ? { bytes: row.bytes as string, objects: row.objects as number } : undefined;
  }
  hasCursor(cursor: string): boolean {
    if (!wellFormed(cursor)) throw new Error('Disk checkpoint cursors must contain valid Unicode.');
    return this.db.prepare('SELECT 1 FROM cursors WHERE cursor = ?').get(cursor) !== undefined;
  }
  *rows(): IterableIterator<{ tenantId: string; bytes: string; objects: number }> {
    for (const row of this.db.prepare('SELECT tenantId, bytes, objects FROM tenants ORDER BY length(bytes) DESC, bytes DESC, tenantId COLLATE BINARY ASC').iterate()) {
      yield { tenantId: row.tenantId as string, bytes: row.bytes as string, objects: row.objects as number };
    }
  }

  applyPage(state: State, page: Page, pattern: TenantPattern = compileTenantPattern(state.config.pattern)): State {
    validateState(state, false);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.state();
      assertProgressSame(state, current);
      if (state.requests !== current.requests + 1 || !Number.isSafeInteger(state.requests)) throw new Error('Disk page requires one safe request increment.');
      if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || this.hasCursor(page.nextCursor))) {
        throw new Error('Provider returned an invalid/repeated cursor.');
      }
      const touched: Record<string, Totals> = Object.create(null);
      const select = this.db.prepare('SELECT bytes, objects FROM tenants WHERE tenantId = ?');
      for (const object of page.objects) {
        if (typeof object.key !== 'string') throw new Error('Provider returned an invalid key.');
        const { tenant } = tenantFor(pattern, object.key);
        if (tenant !== null && !validTenant(tenant)) throw new Error('Disk checkpoint tenant IDs must contain valid Unicode.');
        if (tenant !== null && !(tenant in touched)) {
          const row = select.get(tenant);
          touched[tenant] = row ? { bytes: row.bytes as string, objects: row.objects as number } : { bytes: '0', objects: 0 };
        }
      }
      const next = applyPage({ ...state, tenants: touched }, page, pattern);
      validateState(next, false);
      const upsert = this.db.prepare('INSERT INTO tenants (tenantId, bytes, objects) VALUES (?, ?, ?) ON CONFLICT (tenantId) DO UPDATE SET bytes=excluded.bytes, objects=excluded.objects');
      for (const [id, totals] of Object.entries(next.tenants)) upsert.run(id, totals.bytes, totals.objects);
      const saved = metadata(next);
      this.writeMetadata(saved);
      if (page.nextCursor !== null) this.db.prepare('INSERT INTO cursors (cursor) VALUES (?)').run(page.nextCursor);
      this.db.exec('COMMIT');
      return saved;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    }
  }

  save(state: State): void {
    validateState(state, false);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.state();
      assertProgressSame(state, current);
      if (state.requests < current.requests) throw new Error('Disk checkpoint request count cannot decrease.');
      this.writeMetadata(metadata(state));
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    }
  }
  private writeMetadata(state: State) {
    this.db.prepare('UPDATE metadata SET state = ? WHERE id = 1').run(JSON.stringify(state));
  }
  close(): void {
    if (this.closed) return;
    if (this.readOnly) this.db.exec('ROLLBACK');
    this.db.close(); this.closed = true;
    if (this.identityKey) activeFiles.delete(this.identityKey);
  }
}
