import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error source-only JavaScript helper has no declarations
import { generateScenario, writeScenario, loadScenario, verifyReport, uploadScenario, cleanupScenario } from '../scripts/scenario.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const options = { bucket: 'tenantmeter-fake-bucket', id };
async function temporary(run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'tenantmeter-scenario-test-'));
  try { await run(join(root, 'scenario')); } finally { await rm(root, { recursive: true, force: true }); }
}
test('scenario is deterministic, spans pages, includes empty, Unicode and unmatched objects', () => {
  const plan = generateScenario(options);
  assert.deepEqual(plan, generateScenario(options));
  assert.equal(plan.records.length, 1203);
  assert.equal(plan.expected.total.objects, 1203);
  assert.equal(new Set(plan.records.map((r: any) => r.key)).size, 1203);
  assert.ok(plan.records.some((r: any) => r.size === 0));
  assert.ok(plan.records.some((r: any) => r.tenantId === '東京'));
  assert.ok(plan.expected.unmatched.objects > 0);
  assert.equal(BigInt(plan.expected.total.bytes), plan.records.reduce((sum: bigint, r: any) => sum + BigInt(r.size), 0n));
  assert.throws(() => generateScenario({ ...options, count: 10001 }), /count/);
  assert.throws(() => generateScenario({ ...options, id: '../escape' }), /UUID/);
});
test('scenario files refuse overwrite and tampering', async () => temporary(async directory => {
  await writeScenario(directory, options);
  await loadScenario(directory);
  await assert.rejects(writeScenario(directory, options), /EEXIST/);
  await appendFile(join(directory, 'data.jsonl'), '{}\n');
  await assert.rejects(loadScenario(directory), /changed/);
}));
test('outcome checker catches incomplete, missing, duplicate and incorrect totals', () => {
  const { expected } = generateScenario(options);
  const actual = { status: 'complete', ...expected };
  assert.equal(verifyReport(actual, expected).passed, true);
  for (const mutation of [{ status: 'partial' }, { total: { bytes: '0', objects: 1 } }, { tenants: [] }, { tenants: [...expected.tenants, expected.tenants[0]] }]) assert.equal(verifyReport({ ...actual, ...mutation }, expected).passed, false);
});
test('failed upload records attempts and cleanup deletes only those exact keys', async () => temporary(async directory => {
  const plan = await writeScenario(directory, { ...options, count: 9 });
  let puts = 0;
  const removed: string[] = [];
  const client = { send: async (command: any) => {
    if (command.constructor.name === 'PutObjectCommand') { puts++; if (puts === 3) throw new Error('synthetic timeout'); }
    if (command.constructor.name === 'DeleteObjectsCommand') removed.push(...command.input.Delete.Objects.map((r: any) => r.Key));
    return {};
  } };
  await assert.rejects(uploadScenario(directory, plan, client, 1), /Run cleanup/);
  const ledger = (await readFile(join(directory, 'upload.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(ledger.filter(event => event.event === 'attempt').length, 3);
  await cleanupScenario(directory, plan, client);
  assert.deepEqual(removed, plan.records.slice(0, 3).map((r: any) => r.key));
  await appendFile(join(directory, 'upload.jsonl'), JSON.stringify({ event: 'attempt', key: 'unrelated/key' }) + '\n');
  await assert.rejects(cleanupScenario(directory, plan, client), /refusing deletion/);
}));
test('upload rejects versioned or occupied buckets before any writes', async () => temporary(async directory => {
  const plan = await writeScenario(directory, { ...options, count: 1 });
  await assert.rejects(uploadScenario(directory, plan, { send: async () => ({ Status: 'Enabled' }) }), /never enabled versioning/);
  await assert.rejects(uploadScenario(directory, plan, { send: async (command: any) => command.constructor.name === 'ListObjectsV2Command' ? { Contents: [{ Key: 'occupied' }] } : {} }), /occupied/);
  await assert.rejects(readFile(join(directory, 'upload.jsonl')), /ENOENT/);
}));
test('scenario CLI refuses write commands without explicit allow-writes', async () => temporary(async directory => {
  await writeScenario(directory, { ...options, count: 1 });
  const result = spawnSync(process.execPath, ['scripts/scenario.mjs', 'upload', '--directory', directory], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --allow-writes/);
}));
test('cleanup excludes a conditional-write rejection after the empty-prefix check', async () => temporary(async directory => {
  const plan = await writeScenario(directory, { ...options, count: 3 });
  const removed: string[] = [];
  let puts = 0;
  const client = { send: async (command: any) => {
    if (command.constructor.name === 'PutObjectCommand' && ++puts === 2) throw Object.assign(new Error('Already exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
    if (command.constructor.name === 'DeleteObjectsCommand') removed.push(...command.input.Delete.Objects.map((r: any) => r.Key));
    return {};
  } };
  await assert.rejects(uploadScenario(directory, plan, client, 1), /Run cleanup/);
  assert.match(await readFile(join(directory, 'upload.jsonl'), 'utf8'), /not_created/);
  await cleanupScenario(directory, plan, client);
  assert.deepEqual(removed, [plan.records[0].key]);
}));
test('upload concurrency is bounded and cleanup surfaces AWS partial delete failures', async () => temporary(async directory => {
  const plan = await writeScenario(directory, { ...options, count: 21 });
  let active = 0, peak = 0;
  const client = { send: async (command: any) => {
    if (command.constructor.name === 'PutObjectCommand') {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
    }
    if (command.constructor.name === 'DeleteObjectsCommand') return { Errors: [{ Code: 'AccessDenied' }] };
    return {};
  } };
  await uploadScenario(directory, plan, client, 3);
  assert.equal(peak, 3);
  await assert.rejects(cleanupScenario(directory, plan, client), /Cleanup failed.*AccessDenied/);
}));
