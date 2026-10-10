import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve('src/main.ts');
const inventory = resolve('../../docs/examples/inventory.csv');
const inventoryAfter = resolve('../../docs/examples/inventory-after.csv');
const counters = resolve('../../docs/examples/counters.csv');

function cli(args: string[], cwd: string) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
    cwd, encoding: 'utf8', env: {...process.env, NODE_PATH: resolve('node_modules')},
    maxBuffer: 8 * 1024 * 1024
  });
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'tenantmeter-disk-cli-'));
  try { await run(directory); } finally { await rm(directory, {recursive: true, force: true}); }
}
async function sqliteHeader(path: string) {
  assert.equal((await readFile(path)).subarray(0, 16).toString('binary'), 'SQLite format 3\0');
}

test('SQLite demo scan resumes past a limit and reports JSON, CSV and table', async () => temporary(async directory => {
  const path = join(directory, 'demo.sqlite');
  const limited = cli(['demo', '--storage', 'sqlite', '--state', path, '--max-objects', '1001', '--format', 'json'], directory);
  assert.equal(limited.status, 2, limited.stderr);
  assert.equal(JSON.parse(limited.stdout).total.objects, 1001);
  await sqliteHeader(path);
  await assert.rejects(access(`${path}.lock`), {code: 'ENOENT'});

  const resumed = cli(['analyze', '--resume', path, '--all', '--yes', '--format', 'json'], directory);
  assert.equal(resumed.status, 0, resumed.stderr);
  const complete = JSON.parse(resumed.stdout);
  assert.equal(complete.status, 'complete');
  assert.deepEqual(complete.total, {bytes: '5501000000', objects: 2505});
  assert.equal(complete.tenants.length, 3);
  await sqliteHeader(path);

  const json = cli(['report', '--state', path, '--format', 'json'], directory);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), complete);
  const csv = cli(['report', '--state', path, '--format', 'csv'], directory);
  assert.equal(csv.status, 0, csv.stderr);
  assert.match(csv.stdout, /"total","","5501000000","2505"/);
  assert.match(csv.stdout, /"tenant","東京","500000","500"/);
  const table = cli(['report', '--state', path, '--format', 'table', '--top', '1'], directory);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /TenantMeter — COMPLETE/);
  assert.match(table.stdout, /Showing 1 customers/);
  const self = cli(['diff', '--before', path, '--after', path, '--format', 'json'], directory);
  assert.equal(self.status, 0, self.stderr);
  assert.equal(JSON.parse(self.stdout).hasDifferences, false);
}));

test('SQLite inventory compare and mixed JSON/SQLite diff preserve exit and report semantics', async () => temporary(async directory => {
  const original = join(directory, 'before.json');
  const diskBefore = join(directory, 'before.sqlite');
  const diskAfter = join(directory, 'after.sqlite');
  const argumentsBefore = ['inventory', '--input', inventory, '--bucket', 'example-bucket', '--pattern', 'customers/{tenant_id}/*', '--yes'];
  const scanned = cli([...argumentsBefore, '--state', original, '--format', 'json'], directory);
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.equal(JSON.parse(scanned.stdout).total.bytes, '33');

  const migrated = cli(['migrate', '--state', original, '--output', diskBefore], directory);
  assert.equal(migrated.status, 0, migrated.stderr);
  await sqliteHeader(diskBefore);
  const compared = cli(['compare', '--state', diskBefore, '--counters', counters, '--format', 'json'], directory);
  assert.equal(compared.status, 3, compared.stderr);
  assert.equal(JSON.parse(compared.stdout).different, 1);
  const compareCsv = cli(['compare', '--state', diskBefore, '--counters', counters, '--format', 'csv'], directory);
  assert.equal(compareCsv.status, 3, compareCsv.stderr);
  assert.match(compareCsv.stdout, /"tenant_id","observed_bytes","counter_bytes","delta_bytes","status"/);

  const equal = cli(['diff', '--before', original, '--after', diskBefore, '--format', 'json'], directory);
  assert.equal(equal.status, 0, equal.stderr);
  assert.equal(JSON.parse(equal.stdout).hasDifferences, false);
  const later = cli(['inventory', '--input', inventoryAfter, '--bucket', 'example-bucket', '--pattern', 'customers/{tenant_id}/*',
    '--yes', '--storage', 'sqlite', '--state', diskAfter], directory);
  assert.equal(later.status, 0, later.stderr);
  const changed = cli(['diff', '--before', original, '--after', diskAfter, '--format', 'csv'], directory);
  assert.equal(changed.status, 3, changed.stderr);
  assert.match(changed.stdout, /"unmatched"/);
  assert.match(changed.stdout, /"total"/);
  const reverse = cli(['diff', '--before', diskBefore, '--after', original, '--format', 'json'], directory);
  assert.equal(reverse.status, 0, reverse.stderr);
  assert.equal(JSON.parse(reverse.stdout).hasDifferences, false);
}));

test('migrate preserves a partial JSON checkpoint and its exact resume path', async () => temporary(async directory => {
  const source = join(directory, 'partial.json');
  const target = join(directory, 'partial.sqlite');
  const partial = cli(['demo', '--state', source, '--max-objects', '1001', '--format', 'json'], directory);
  assert.equal(partial.status, 2, partial.stderr);
  const sourceBytes = await readFile(source);
  const migrated = cli(['migrate', '--state', source, '--output', target], directory);
  assert.equal(migrated.status, 0, migrated.stderr);
  await sqliteHeader(target);
  assert.deepEqual(await readFile(source), sourceBytes);
  const migratedReport = cli(['report', '--state', target, '--format', 'json'], directory);
  assert.equal(migratedReport.status, 2, migratedReport.stderr);
  assert.deepEqual(JSON.parse(migratedReport.stdout), JSON.parse(partial.stdout));
  const overwrite = cli(['migrate', '--state', source, '--output', target], directory);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /already exists/);
  const resumed = cli(['analyze', '--resume', target, '--all', '--yes', '--format', 'json'], directory);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout).total, {bytes: '5501000000', objects: 2505});
  assert.deepEqual(await readFile(source), sourceBytes);
}));

test('storage and migration reject ignored or conflicting options', async () => temporary(async directory => {
  const state = join(directory, 'state.sqlite');
  const badStorage = cli(['demo', '--storage', 'other', '--state', state], directory);
  assert.equal(badStorage.status, 1);
  assert.match(badStorage.stderr, /--storage must be json or sqlite/);
  const scan = cli(['demo', '--storage', 'sqlite', '--state', state, '--max-objects', '1'], directory);
  assert.equal(scan.status, 2, scan.stderr);
  const storageOnResume = cli(['analyze', '--resume', state, '--storage', 'sqlite', '--all', '--yes'], directory);
  assert.equal(storageOnResume.status, 1);
  assert.match(storageOnResume.stderr, /Resume detects checkpoint storage/);
  for (const option of [['--all'], ['--format', 'json'], ['--storage', 'sqlite'], ['--provider', 's3']]) {
    const target = join(directory, `ignored-${option[0].slice(2)}.sqlite`);
    const result = cli(['migrate', '--state', state, '--output', target, ...option], directory);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /not supported by migrate/);
    await assert.rejects(access(target), {code: 'ENOENT'});
  }
}));

test('SQLite outputs protect checkpoint, lock and journal paths through directory aliases', {skip: process.platform === 'win32'}, async () => temporary(async directory => {
  const state = join(directory, 'state.sqlite');
  const scan = cli(['demo', '--storage', 'sqlite', '--state', state, '--max-objects', '1'], directory);
  assert.equal(scan.status, 2, scan.stderr);
  const alias = join(directory, 'alias');
  await symlink(directory, alias, 'dir');
  for (const suffix of ['', '.lock', '-journal', '-wal', '-shm']) {
    const output = join(alias, `state.sqlite${suffix}`);
    const result = cli(['report', '--state', state, '--output', output], directory);
    assert.equal(result.status, 1, `${suffix}: ${result.stderr}`);
    assert.match(result.stderr, /Output must differ from checkpoint, lock, and SQLite journal paths/);
  }
  const stillReadable = cli(['report', '--state', state, '--format', 'json'], directory);
  assert.equal(stillReadable.status, 2, stillReadable.stderr);
  assert.equal(JSON.parse(stillReadable.stdout).total.objects, 1);
  await sqliteHeader(state);
}));

test('report recovers a hot SQLite rollback journal and keeps committed totals', {skip: process.platform === 'win32'}, async () => temporary(async directory => {
  const input = join(directory, 'inventory.csv');
  const state = join(directory, 'state.sqlite');
  const foreign = join(directory, 'foreign.txt');
  await writeFile(input, 'Bucket,Key,Size\n' + Array.from({length: 3000}, (_, index) =>
    `example-bucket,customers/t${index}/file,1\n`).join(''));
  await writeFile(foreign, 'foreign bytes stay intact');
  const scanned = cli(['inventory', '--input', input, '--bucket', 'example-bucket', '--pattern', 'customers/{tenant_id}/*',
    '--yes', '--storage', 'sqlite', '--state', state, '--format', 'table'], directory);
  assert.equal(scanned.status, 0, scanned.stderr);
  await sqliteHeader(state);

  const crash = spawnSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE tenants SET bytes='9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999'");
    process.kill(process.pid, 'SIGKILL');
  `, state], {encoding: 'utf8'});
  assert.equal(crash.signal, 'SIGKILL', crash.stderr);
  assert.ok((await lstat(`${state}-journal`)).size > 0);

  const reported = cli(['report', '--state', state, '--format', 'json'], directory);
  assert.equal(reported.status, 0, reported.stderr);
  const result = JSON.parse(reported.stdout);
  assert.deepEqual(result.total, {bytes: '3000', objects: 3000});
  assert.equal(result.tenants.length, 3000);
  assert.ok(result.tenants.every((row: {bytes: string; objects: number}) => row.bytes === '1' && row.objects === 1));
  await assert.rejects(access(`${state}.lock`), {code: 'ENOENT'});
  assert.equal(await readFile(foreign, 'utf8'), 'foreign bytes stay intact');
  await sqliteHeader(state);
}));

test('SIGINT during stalled SQLite comparison output cleans scratch and read transaction', {skip: process.platform === 'win32', timeout: 15000}, async () => temporary(async directory => {
  const input = join(directory, 'inventory.csv');
  const counters = join(directory, 'counters.csv');
  const state = join(directory, 'state.sqlite');
  const scratchBase = join(directory, 'scratch');
  await mkdir(scratchBase);
  await writeFile(input, 'Bucket,Key,Size\n' + Array.from({length: 6000}, (_, index) =>
    `example-bucket,customers/t${index}/file,1\n`).join(''));
  await writeFile(counters, 'tenant_id,bytes\n');
  const scanned = cli(['inventory', '--input', input, '--bucket', 'example-bucket', '--pattern', 'customers/{tenant_id}/*',
    '--yes', '--storage', 'sqlite', '--state', state, '--format', 'table'], directory);
  assert.equal(scanned.status, 0, scanned.stderr);

  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry,
    'compare', '--state', state, '--counters', counters, '--format', 'json'], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, NODE_PATH: resolve('node_modules'), TMPDIR: scratchBase}
  });
  const exited = new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  child.stderr!.resume();
  child.stdout!.on('readable', () => {});
  try {
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      ready = child.stdout!.readableLength > 0 && (await readdir(scratchBase)).some(name => name.startsWith('tenantmeter-command-'));
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready, 'Comparison did not reach blocked output with scratch open.');
    await new Promise(resolve => setTimeout(resolve, 100));
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGINT');
    const result = await exited.finally(() => clearTimeout(guard));
    assert.equal(result.code, 130);
    assert.equal(result.signal, null);
    assert.deepEqual((await readdir(scratchBase)).filter(name => name.startsWith('tenantmeter-command-')), []);
    await assert.rejects(access(`${state}.lock`), {code: 'ENOENT'});
    const report = cli(['report', '--state', state, '--format', 'json'], directory);
    assert.equal(report.status, 0, report.stderr);
    assert.deepEqual(JSON.parse(report.stdout).total, {bytes: '6000', objects: 6000});
  } finally {
    child.kill('SIGKILL'); child.stdout?.destroy(); child.stderr?.destroy();
  }
}));
