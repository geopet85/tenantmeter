import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, link, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockState, saveState } from '../src/state.ts';
import { newState } from '../src/model.ts';

test('checkpoint directory aliases share one lock', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-state-alias-'));
  try {
    const actual = join(dir, 'actual'); await mkdir(actual);
    const alias = join(dir, 'alias'); await symlink(actual, alias);
    const release = await lockState(join(actual, 'state.json'));
    try { await assert.rejects(lockState(join(alias, 'state.json')), /locked/); }
    finally { await release(); }
    const releaseAlias = await lockState(join(alias, 'state.json'));
    await releaseAlias();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkpoint links cannot bypass locks or replace a different file', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-state-links-'));
  try {
    const original = join(dir, 'original.json'); await writeFile(original, 'original');
    const symbolic = join(dir, 'symbolic.json'); await symlink(original, symbolic);
    const state = newState({ provider: 'demo', bucket: 'demo-bucket', pattern: 'customers/{tenant_id}/*', prefix: '', region: 'auto' });
    await assert.rejects(lockState(symbolic), /regular file/);
    await assert.rejects(saveState(symbolic, state), /regular file/);
    const hard = join(dir, 'hard.json'); await link(original, hard);
    await assert.rejects(lockState(hard), /regular file/);
    await assert.rejects(saveState(hard, state), /regular file/);
    assert.equal(await readFile(original, 'utf8'), 'original');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkpoint release is idempotent and leaves a replacement lock alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-state-owner-'));
  const path = join(dir, 'state.json');
  try {
    const releaseOld = await lockState(path);
    await rm(`${path}.lock`);
    const releaseNew = await lockState(path);
    const replacement = await readFile(`${path}.lock`, 'utf8');
    await releaseOld(); await releaseOld();
    assert.equal(await readFile(`${path}.lock`, 'utf8'), replacement);
    await assert.rejects(lockState(path), /locked/);
    await releaseNew();
    const releaseLast = await lockState(path);
    await releaseLast(); await releaseLast();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
