import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { help, options, version } from '../src/options.ts';

const entry = resolve('src/main.ts');
function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
    cwd, encoding: 'utf8', env: {...process.env, ...env, NODE_PATH: resolve('node_modules')}
  });
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'tenantmeter-doctor-'));
  try { await run(directory); } finally { await rm(directory, {recursive: true, force: true}); }
}
function check(result: {checks: {name: string; status: string; detail: string}[]}, name: string) {
  const found = result.checks.find(item => item.name === name);
  assert.ok(found, `Missing ${name} check`);
  return found;
}

test('help and --version derive from package metadata', async () => {
  const metadata = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(version, metadata.version);
  assert.match(help, new RegExp(`TenantMeter ${metadata.version.replaceAll('.', '\\.')} —`));
  assert.equal(options(['--version']).early, `${metadata.version}\n`);
});

test('doctor validates local configuration and paths without leaving files or exposing secrets', async () => temporary(async directory => {
  const state = join(directory, 'checkpoint.sqlite');
  const output = join(directory, 'report.json');
  const secret = 'never-print-this-secret';
  const account = 'a'.repeat(32);
  const bucket = 'private-bucket-name';
  const result = cli(['doctor', '--storage', 'sqlite', '--provider', 'r2', '--bucket', bucket,
    '--pattern', 'customers/{tenant_id}/*', '--account-id', account, '--state', state,
    '--output', output, '--format', 'json'], directory, {R2_SECRET_ACCESS_KEY: secret});
  assert.equal(result.status, 0, result.stderr);
  const diagnosis = JSON.parse(result.stdout);
  assert.equal(diagnosis.ok, true);
  for (const name of ['Node.js', 'SQLite', 'Configuration', 'Checkpoint path', 'Report path']) {
    assert.equal(check(diagnosis, name).status, 'pass');
  }
  for (const sensitive of [secret, account, bucket, state, output]) {
    assert.ok(!result.stdout.includes(sensitive), `Doctor printed ${sensitive}`);
    assert.ok(!result.stderr.includes(sensitive), `Doctor warning printed ${sensitive}`);
  }
  await assert.rejects(access(state), {code: 'ENOENT'});
  await assert.rejects(access(output), {code: 'ENOENT'});
  assert.deepEqual(await readdir(directory), []);
}));

test('doctor reports invalid scan flags and unusable new-file paths', async () => temporary(async directory => {
  const existing = join(directory, 'existing.json');
  await writeFile(existing, 'untouched');
  const result = cli(['doctor', '--provider', 's3', '--bucket', 'example', '--pattern', 'missing-tenant-token/*',
    '--state', existing, '--output', existing, '--format', 'json'], directory);
  assert.equal(result.status, 1, result.stderr);
  const diagnosis = JSON.parse(result.stdout);
  assert.equal(diagnosis.ok, false);
  assert.equal(check(diagnosis, 'Configuration').status, 'fail');
  assert.equal(check(diagnosis, 'Checkpoint path').status, 'fail');
  assert.equal(check(diagnosis, 'Report path').status, 'fail');
  assert.equal(await readFile(existing, 'utf8'), 'untouched');

  const incomplete = cli(['doctor', '--bucket', 'example', '--format', 'json'], directory);
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.equal(check(JSON.parse(incomplete.stdout), 'Configuration').status, 'fail');
  const r2Region = cli(['doctor', '--provider', 'r2', '--bucket', 'example', '--pattern', '{tenant_id}/*',
    '--region', 'eu-west-1', '--format', 'json'], directory);
  assert.equal(r2Region.status, 1, r2Region.stderr);
  assert.match(check(JSON.parse(r2Region.stdout), 'Configuration').detail, /R2 uses region auto/);
  const absentParent = cli(['doctor', '--state', join(directory, 'new-state-directory', 'state.json'),
    '--output', join(directory, 'missing-report-directory', 'report.json'), '--format', 'json'], directory);
  assert.equal(absentParent.status, 1, absentParent.stderr);
  assert.equal(check(JSON.parse(absentParent.stdout), 'Checkpoint path').status, 'pass');
  assert.equal(check(JSON.parse(absentParent.stdout), 'Report path').status, 'fail');
  assert.match(check(JSON.parse(absentParent.stdout), 'Report path').detail, /must already exist/);
}));

test('doctor formats table and CSV, and rejects unrelated scan options', async () => temporary(async directory => {
  const table = cli(['doctor'], directory);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /TenantMeter doctor: READY/);
  assert.match(table.stdout, /No cloud requests were made/);
  const csv = cli(['doctor', '--format', 'csv'], directory);
  assert.equal(csv.status, 0, csv.stderr);
  assert.match(csv.stdout, /^"check","status","detail"\n/);
  const invalid = cli(['doctor', '--max-objects', '10'], directory);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not supported by doctor/);
}));

test('doctor rejects a dangling parent alias before a scan writes anything', {skip: process.platform === 'win32'}, async () => temporary(async directory => {
  const alias = join(directory, 'missing-alias');
  await symlink(join(directory, 'absent'), alias, 'dir');
  const result = cli(['doctor', '--state', join(alias, 'checkpoint.json'), '--format', 'json'], directory);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check(JSON.parse(result.stdout), 'Checkpoint path').status, 'fail');
  await assert.rejects(access(join(alias, 'checkpoint.json')), {code: 'ENOENT'});
}));
