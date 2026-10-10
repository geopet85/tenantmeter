#!/usr/bin/env node
// Source-only AWS integration scenario. Never used by the read-only CLI.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, GetBucketVersioningCommand } from '@aws-sdk/client-s3';

const sha = text => createHash('sha256').update(text).digest('hex');
const prefixPattern = /^tenantmeter-scenario\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/$/;
const sizes = [0, 64, 512, 4096, 16384, 65536];
const tenantIds = ['acme', 'northwind', 'contoso', 'studio-42', '東京', 'café'];
function positive(value, max, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${label} must be an integer between 1 and ${max}.`);
  return n;
}
export function generateScenario({ bucket, region = 'us-east-1', count = 1203, seed = 42, id = randomUUID() }) {
  count = positive(count, 10000, 'count'); seed = positive(seed, 0xffffffff, 'seed');
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Supply an existing S3 bucket name.');
  const prefix = `tenantmeter-scenario/${id}/`;
  if (!prefixPattern.test(prefix)) throw new Error('Scenario ID must be a version 4 UUID.');
  let value = seed;
  const random = () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return value >>> 0; };
  const tenants = new Map();
  let bytes = 0n, unmatchedBytes = 0n, unmatchedObjects = 0;
  const records = Array.from({ length: count }, (_, index) => {
    // Uneven tenant traffic, receipts/images/backups, empty markers and system files.
    const tenantId = index % 31 === 0 ? null : tenantIds[random() % (index % 3 === 0 ? 2 : tenantIds.length)];
    const size = sizes[random() % sizes.length];
    const key = tenantId === null ? `${prefix}system/audit-${index}.json` : `${prefix}customers/${tenantId}/${['receipts', 'images', 'backups'][index % 3]}/${String(index).padStart(6, '0')}.bin`;
    bytes += BigInt(size);
    if (tenantId === null) { unmatchedBytes += BigInt(size); unmatchedObjects++; }
    else { const previous = tenants.get(tenantId) ?? { tenantId, bytes: 0n, objects: 0 }; previous.bytes += BigInt(size); previous.objects++; tenants.set(tenantId, previous); }
    return { key, size, tenantId };
  });
  // Totals come from generation intent, before CLI parsing or listing.
  const expected = { schemaVersion: 1, total: { bytes: String(bytes), objects: count }, unmatched: { bytes: String(unmatchedBytes), objects: unmatchedObjects }, tenants: [...tenants.values()].map(t => ({ ...t, bytes: String(t.bytes) })).sort((a, b) => a.tenantId.localeCompare(b.tenantId)) };
  return { config: { schemaVersion: 1, bucket, region, prefix, pattern: `${prefix}customers/{tenant_id}/*`, seed, count }, records, expected };
}
async function exclusive(path, text) { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); }
export async function writeScenario(directory, options) {
  const plan = generateScenario(options);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const data = plan.records.map(r => JSON.stringify(r)).join('\n') + '\n';
  const expected = JSON.stringify(plan.expected, null, 2) + '\n';
  await exclusive(join(directory, 'data.jsonl'), data);
  await exclusive(join(directory, 'expected.json'), expected);
  await exclusive(join(directory, 'plan.json'), JSON.stringify({ ...plan.config, dataSha256: sha(data), expectedSha256: sha(expected) }, null, 2) + '\n');
  // Allows a full offline run of the same scenario through the real inventory CLI.
  const csv = ['Bucket,Key,Size', ...plan.records.map(r => `${plan.config.bucket},${encodeURIComponent(r.key)},${r.size}`)].join('\n') + '\n';
  await exclusive(join(directory, 'inventory.csv'), csv);
  return plan;
}
export async function loadScenario(directory) {
  const config = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
  const generated = generateScenario({ ...config, id: config.prefix?.split('/')[1] });
  if (config.schemaVersion !== 1 || config.prefix !== generated.config.prefix || config.pattern !== generated.config.pattern) throw new Error('Invalid scenario configuration.');
  const data = await readFile(join(directory, 'data.jsonl'), 'utf8');
  const expectedText = await readFile(join(directory, 'expected.json'), 'utf8');
  if (sha(data) !== config.dataSha256 || sha(expectedText) !== config.expectedSha256) throw new Error('Scenario files changed; refusing cloud operations.');
  if (data !== generated.records.map(r => JSON.stringify(r)).join('\n') + '\n' || expectedText !== JSON.stringify(generated.expected, null, 2) + '\n') throw new Error('Scenario data does not match its seed.');
  return { ...generated, config };
}
export function verifyReport(actual, expected) {
  const failures = [];
  if (actual.status !== 'complete') failures.push('Scan is incomplete.');
  for (const section of ['total', 'unmatched']) {
    for (const field of ['bytes', 'objects']) if (actual[section]?.[field] !== expected[section][field]) failures.push(`${section}.${field}: expected ${expected[section][field]}, received ${actual[section]?.[field]}`);
  }
  const observed = new Map();
  for (const tenant of actual.tenants ?? []) {
    if (observed.has(tenant.tenantId)) failures.push(`Duplicate tenant ${tenant.tenantId}.`);
    observed.set(tenant.tenantId, tenant);
  }
  if (observed.size !== expected.tenants.length) failures.push('Tenant count differs.');
  for (const tenant of expected.tenants) for (const field of ['bytes', 'objects']) if (observed.get(tenant.tenantId)?.[field] !== tenant[field]) failures.push(`${tenant.tenantId}.${field} differs.`);
  return { schemaVersion: 1, passed: failures.length === 0, failures, expectedObjects: expected.total.objects, expectedBytes: expected.total.bytes };
}
async function unversioned(client, bucket) {
  const result = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  if (result.Status) throw new Error('Use a bucket that has never enabled versioning. Cleanup must remove payloads without leaving object versions.');
}
export async function uploadScenario(directory, plan, client, concurrency = 8) {
  concurrency = positive(concurrency, 32, 'concurrency');
  await unversioned(client, plan.config.bucket);
  const listed = await client.send(new ListObjectsV2Command({ Bucket: plan.config.bucket, Prefix: plan.config.prefix, MaxKeys: 1 }));
  if (listed.Contents?.length) throw new Error('Scenario prefix is occupied; generate a new plan.');
  const ledger = join(directory, 'upload.jsonl');
  const handle = await open(ledger, 'wx', 0o600); await handle.close();
  let cursor = 0, failure;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!failure && cursor < plan.records.length) {
      const record = plan.records[cursor++];
      try {
        // Record the attempt before sending: a lost response can still create an object.
        await appendFile(ledger, JSON.stringify({ event: 'attempt', key: record.key }) + '\n');
        await client.send(new PutObjectCommand({ Bucket: plan.config.bucket, Key: record.key, Body: Buffer.alloc(record.size, 0x78), ContentType: 'application/octet-stream', IfNoneMatch: '*' }));
        await appendFile(ledger, JSON.stringify({ event: 'created', key: record.key }) + '\n');
      } catch (error) {
        // A conditional-write rejection proves this attempt did not create the key.
        if (error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412) {
          try { await appendFile(ledger, JSON.stringify({ event: 'not_created', key: record.key }) + '\n'); }
          catch (ledgerError) { failure ??= new Error(`Cannot record conditional rejection for ${record.key}; inspect the ledger before cleanup: ${ledgerError.message}`); }
        }
        failure ??= error;
      }
    }
  }));
  if (failure) throw new Error(`Upload stopped. Run cleanup with this plan, including after a timeout. ${failure.message}`);
}
export async function cleanupScenario(directory, plan, client) {
  await unversioned(client, plan.config.bucket);
  // Delete only attempted uploads. An occupied prefix that failed preflight has no ledger.
  const allowed = new Set(plan.records.map(record => record.key));
  const attempted = new Set();
  const ledger = await readFile(join(directory, 'upload.jsonl'), 'utf8');
  for (const line of ledger.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (!['attempt', 'created', 'not_created'].includes(event.event) || !allowed.has(event.key)) throw new Error('Invalid upload ledger; refusing deletion.');
    if (event.event === 'attempt') attempted.add(event.key);
    if (event.event === 'not_created') attempted.delete(event.key);
  }
  const keys = [...attempted];
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const result = await client.send(new DeleteObjectsCommand({ Bucket: plan.config.bucket, Delete: { Objects: keys.slice(offset, offset + 1000).map(key => ({ Key: key })), Quiet: true } }));
    if (result.Errors?.length) throw new Error(`Cleanup failed for ${result.Errors.length} objects; rerun cleanup. First error: ${result.Errors[0].Code}`);
  }
  await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ complete: true, keys: keys.length }) + '\n', { mode: 0o600 });
  return keys.length;
}
async function main(args) {
  const command = args.shift();
  if (!['plan', 'upload', 'verify', 'cleanup'].includes(command)) throw new Error('Usage: node scripts/scenario.mjs plan|upload|verify|cleanup --directory PATH [--bucket NAME --region REGION --count 1203 --seed 42] [--offline] [--allow-writes] [--concurrency 8]');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--directory', '--bucket', '--region', '--count', '--seed', '--offline', '--allow-writes', '--concurrency'].includes(flag) || Object.hasOwn(options, flag.slice(2))) throw new Error(`Unknown or duplicate option: ${flag}`);
    if (['--offline', '--allow-writes'].includes(flag)) options[flag.slice(2)] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value: ${flag}`); options[flag.slice(2)] = args[++i]; }
  }
  const allowed = { plan: ['directory', 'bucket', 'region', 'count', 'seed'], upload: ['directory', 'allow-writes', 'concurrency'], verify: ['directory', 'offline'], cleanup: ['directory', 'allow-writes'] }[command];
  for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new Error(`Option --${name} is not used by ${command}.`);
  if (!options.directory) throw new Error('--directory is required.');
  const directory = resolve(options.directory);
  if (command === 'plan') {
    const plan = await writeScenario(directory, options);
    console.log(JSON.stringify({ directory, ...plan.config, bytes: plan.expected.total.bytes, putRequests: plan.records.length, scanPages: Math.ceil(plan.records.length / 1000), deleteRequests: Math.ceil(plan.records.length / 1000) }, null, 2)); return;
  }
  const plan = await loadScenario(directory);
  if (command === 'verify') {
    const cli = fileURLToPath(new URL('../dist/tenantmeter.js', import.meta.url));
    const basename = options.offline ? 'offline' : 'aws';
    const report = join(directory, `${basename}-actual.json`);
    const scanArgs = options.offline ? ['inventory', '--input', join(directory, 'inventory.csv'), '--bucket', plan.config.bucket] : ['analyze', '--provider', 's3', '--bucket', plan.config.bucket, '--region', plan.config.region];
    const result = spawnSync(process.execPath, [cli, ...scanArgs, '--pattern', plan.config.pattern, '--prefix', plan.config.prefix, '--all', '--yes', '--state', join(directory, `${basename}-state.json`), '--format', 'json', '--output', report], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`CLI failed: ${result.error?.message ?? result.status}. Keep the checkpoint for inspection.`);
    const actual = JSON.parse(await readFile(report, 'utf8'));
    const outcome = verifyReport(actual, plan.expected);
    await exclusive(join(directory, `${basename}-outcome.json`), JSON.stringify(outcome, null, 2) + '\n');
    console.log(JSON.stringify(outcome, null, 2)); if (!outcome.passed) process.exitCode = 1; return;
  }
  if (!options['allow-writes']) throw new Error(`${command} requires --allow-writes. Only synthetic keys in ${plan.config.prefix} are affected.`);
  const lockPath = join(directory, 'operation.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, command }) + '\n');
  await lock.close();
  const client = new S3Client({ region: plan.config.region, maxAttempts: 3 });
  let processed = plan.records.length;
  try { if (command === 'upload') await uploadScenario(directory, plan, client, options.concurrency ?? 8); else processed = await cleanupScenario(directory, plan, client); }
  finally { client.destroy(); await rm(lockPath); }
  console.log(`${command} complete: ${processed} keys in ${plan.config.bucket}/${plan.config.prefix}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
