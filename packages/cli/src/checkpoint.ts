import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DiskStore, DiskRecoveryRequiredError } from './disk.ts';
import { loadState, lockState } from './state.ts';
import { validateConfig } from './options.ts';
import type { Snapshot } from './disk-commands.ts';

export async function isSqlite(path: string) {
  await DiskStore.assertNotOpen(path);
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const {bytesRead} = await file.read(buffer, 0, 16, 0);
    return bytesRead === 16 && buffer.toString('binary') === 'SQLite format 3\0';
  } finally { await file.close(); }
}
async function openDisk(path: string, readOnly: boolean, signal?: AbortSignal) {
  try { return await DiskStore.open(path, {readOnly, signal}); }
  catch (error) {
    if (!readOnly || !(error instanceof DiskRecoveryRequiredError)) throw error;
    // Crash recovery modifies the rollback journal. Serialize it with writers,
    // then reopen a read transaction for the report's consistent snapshot.
    const unlock = await lockState(path);
    try {
      const recovered = await DiskStore.open(path, {signal});
      recovered.close();
    } finally { await unlock(); }
    return DiskStore.open(path, {readOnly: true, signal});
  }
}
export async function openCheckpoint(path: string, readOnly = true, signal?: AbortSignal) {
  const disk = await isSqlite(path) ? await openDisk(path, readOnly, signal) : undefined;
  try {
    const state = disk ? disk.state() : await loadState(path);
    validateConfig(state.config);
    const snapshot: Snapshot = {
      state,
      count: disk ? disk.tenantCount() : Object.keys(state.tenants).length,
      *rows() {
        if (disk) yield* disk.rows();
        else for (const tenantId in state.tenants) yield {tenantId, ...state.tenants[tenantId]};
      },
      get(tenantId) { return disk ? disk.get(tenantId) : state.tenants[tenantId]; }
    };
    return {state, disk, snapshot, close: () => disk?.close()};
  } catch (error) { disk?.close(); throw error; }
}

// Resolve existing directory aliases even when a new checkpoint's parent has
// not been created yet. Outputs must never replace SQLite journal/lock files.
async function canonicalTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return join(await realpath(dirname(absolute)), basename(absolute)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(absolute) === absolute) throw error;
    return join(await canonicalTarget(dirname(absolute)), basename(absolute));
  }
}
export async function protectOutput(output: string, checkpoints: string[]) {
  const target = await canonicalTarget(output);
  for (const checkpoint of checkpoints) {
    const state = await canonicalTarget(checkpoint);
    if (['', '.lock', '-journal', '-wal', '-shm'].some(suffix => target === state + suffix)) {
      throw new Error('Output must differ from checkpoint, lock, and SQLite journal paths.');
    }
  }
}
