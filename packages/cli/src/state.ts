import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { State, Totals } from './model.ts';

async function checkpointPath(path: string) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const canonical = join(await realpath(dirname(absolute)), basename(absolute));
  try {
    const entry = await lstat(canonical);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error('Checkpoint must be a regular file without symbolic or hard links. Use its original path or a new file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return canonical;
}

export async function saveState(path: string, state: State) {
  path = await checkpointPath(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function totals(value: unknown): value is Totals {
  if (!value || typeof value !== 'object') return false;
  const row = value as Totals;
  return typeof row.bytes === 'string' && /^(0|[1-9][0-9]*)$/.test(row.bytes) && count(row.objects);
}
export async function loadState(path: string): Promise<State> {
  let state: State;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Cannot read checkpoint. Check its path and JSON contents.'); }
  return validateState(state);
}

export function validateState(value: unknown, verifyTotals = true): State {
  const state = value as State;
  if (!state || state.version !== 1 || !state.config ||
      !['partial', 'complete'].includes(state.status) ||
      !['in-progress', 'object-limit', 'request-limit', 'time-limit', 'interrupted', 'error', 'complete'].includes(state.reason) ||
      ![state.startedAt, state.updatedAt].every(x => typeof x === 'string' && Number.isFinite(Date.parse(x))) ||
      !(state.finishedAt === null || (typeof state.finishedAt === 'string' && Number.isFinite(Date.parse(state.finishedAt)))) ||
      !(state.cursor === null || (typeof state.cursor === 'string' && state.cursor.length > 0)) ||
      !totals(state) || !totals(state.unmatched) || !count(state.pages) || !count(state.requests) ||
      !count(state.invalidTenantObjects) || !state.tenants || typeof state.tenants !== 'object' || Array.isArray(state.tenants)) {
    throw new Error('Invalid or unsupported checkpoint. Start a fresh scan with a new state file.');
  }
  let bytes = BigInt(state.unmatched.bytes);
  let objects = state.unmatched.objects;
  for (const [tenant, value] of Object.entries(state.tenants)) {
    if (!tenant || Buffer.byteLength(tenant) > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(tenant) || !totals(value)) {
      throw new Error('Invalid tenant totals in checkpoint.');
    }
    bytes += BigInt(value.bytes);
    objects += value.objects;
  }
  if ((verifyTotals && (bytes.toString() !== state.bytes || objects !== state.objects)) || state.invalidTenantObjects > state.unmatched.objects ||
      state.requests < state.pages || (state.status === 'complete' && (state.cursor !== null || !state.finishedAt || state.reason !== 'complete')) ||
      (state.status === 'partial' && (state.finishedAt !== null || state.reason === 'complete' || (state.pages > 0 && state.cursor === null)))) {
    throw new Error('Checkpoint totals or cursor are inconsistent. Start a fresh scan.');
  }
  state.tenants = Object.assign(Object.create(null), state.tenants);
  return state;
}

export async function lockState(path: string) {
  path = await checkpointPath(path);
  const lock = `${path}.lock`;
  const token = randomUUID();
  const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token });
  let file;
  try { file = await open(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Checkpoint is locked: ${lock}. If its process has stopped, remove only the .lock file and retry.`);
    }
    throw error;
  }
  try { await file.writeFile(record); }
  catch (error) { await file.close(); await rm(lock, { force: true }); throw error; }
  await file.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      // A user may remove a stale lock while an old process is still exiting.
      // That process must not remove the replacement lock.
      const current = await readFile(lock, 'utf8');
      if (current === record) await rm(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}
