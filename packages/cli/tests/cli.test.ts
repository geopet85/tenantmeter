import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve('src/main.ts');
function cli(args: string[], cwd: string) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: resolve('node_modules') }
  });
}

test('CLI emits clean JSON, returns partial exit code, resumes, exports CSV and refuses overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-cli-'));
  try {
    const state = join(dir, 'state.json');
    const limited = cli(['demo', '--max-objects', '1001', '--state', state, '--format', 'json'], dir);
    assert.equal(limited.status, 2, limited.stderr);
    assert.equal(JSON.parse(limited.stdout).total.objects, 1001);
    const csv = join(dir, 'usage.csv');
    const resumed = cli(['analyze', '--resume', state, '--all', '--yes', '--format', 'csv', '--output', csv], dir);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.stdout, '');
    assert.ok((await readFile(csv, 'utf8')).includes('"5501000000"'));
    assert.equal(JSON.parse(await readFile(state, 'utf8')).status, 'complete');
    const report = cli(['report', '--state', state, '--format', 'json'], dir);
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(report.stdout).total.bytes, '5501000000');
    const overwrite = cli(['demo', '--output', csv], dir);
    assert.equal(overwrite.status, 1);
    assert.match(overwrite.stderr, /already exists/);
    const alreadyDone = cli(['analyze', '--resume', state, '--yes'], dir);
    assert.equal(alreadyDone.status, 1);
    assert.match(alreadyDone.stderr, /already complete/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI rejects unattended cloud scans before creating state or accessing credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-cli-'));
  try {
    const result = cli(['analyze', '--provider', 's3', '--bucket', 'test', '--pattern', 'customers/{tenant_id}/*'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /require --yes/);
    assert.equal(cli(['--help'], dir).status, 0);
    const {version} = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    assert.equal(cli(['--version'], dir).stdout, `${version}\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('source export includes required helpers and omits hosted code, dependencies, and filled contacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-export-'));
  const destination = join(dir, 'source');
  try {
    const command = [resolve('export-source.mjs'), destination];
    const result = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const file of ['packages/cli/src/main.ts', 'lib/tenant/pattern.ts', 'lib/providers/types.ts', 'LICENSE', 'packages/cli/src/diff.ts', 'packages/cli/scripts/scenario.mjs', 'docs/examples/scenario/data.jsonl', 'docs/examples/scenario/expected.json', 'docs/examples/scenario/offline-outcome.json', 'docs/PERFORMANCE.md']) {
      await access(join(destination, file));
    }
    for (const file of ['app', 'supabase', 'packages/cli/node_modules', 'packages/cli/dist']) {
      await assert.rejects(access(join(destination, file)));
    }
    assert.equal((await readFile(join(destination, 'docs/outreach/prospects.csv'), 'utf8')).trim().split('\n').length, 1);
    assert.match(await readFile(join(destination, 'README.md'), 'utf8'), /## Prerequisites/);
    assert.match(await readFile(join(destination, 'README.md'), 'utf8'), /npm run check/);
    const again = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.notEqual(again.status, 0);
    const nested = spawnSync(process.execPath, [resolve('export-source.mjs'), resolve('export-inside-project')], { encoding: 'utf8' });
    assert.notEqual(nested.status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('inventory and comparison commands work offline; invalid output fails before a scan starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-workflow-'));
  try {
    const state = join(dir, 'state.json');
    const inventory = resolve('../../docs/examples/inventory.csv');
    const counters = resolve('../../docs/examples/counters.csv');
    const scanned = cli(['inventory', '--input', inventory, '--bucket', 'example-bucket', '--pattern', 'customers/{tenant_id}/*', '--yes', '--state', state, '--format', 'json'], dir);
    assert.equal(scanned.status, 0, scanned.stderr); assert.equal(JSON.parse(scanned.stdout).total.bytes, '33');
    const comparison = cli(['compare', '--state', state, '--counters', counters, '--format', 'json'], dir);
    assert.equal(comparison.status, 3, comparison.stderr); assert.equal(JSON.parse(comparison.stdout).different, 1);
    const badState = join(dir, 'not-created.json');
    const bad = cli(['demo', '--state', badState, '--output', join(dir, 'missing/report.json')], dir);
    assert.equal(bad.status, 1); await assert.rejects(access(badState));
    const limited = cli(['demo', '--state', join(dir, 'limited.json'), '--max-requests', '1', '--format', 'json'], dir);
    assert.equal(limited.status, 2); assert.equal(JSON.parse(limited.stdout).reason, 'request-limit');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('resume acquires the lock before reading saved progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-lock-order-'));
  try {
    const {writeFile} = await import('node:fs/promises');
    const state = join(dir, 'state.json');
    await writeFile(state, 'invalid JSON'); await writeFile(`${state}.lock`, '{}');
    const result = cli(['analyze', '--resume', state, '--yes'], dir);
    assert.equal(result.status, 1); assert.match(result.stderr, /locked/);
    await rm(`${state}.lock`);
    const unlocked = cli(['analyze', '--resume', state, '--yes'], dir);
    assert.match(unlocked.stderr, /Cannot read checkpoint/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('diff CLI reports differences with total/unmatched CSV and equal exit codes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-diff-cli-'));
  try {
    const before = join(dir, 'before.json'), after = join(dir, 'after.json');
    const args = ['inventory', '--bucket', 'example-bucket', '--pattern', 'customers/{tenant_id}/*', '--yes'];
    assert.equal(cli([...args, '--input', resolve('../../docs/examples/inventory.csv'), '--state', before], dir).status, 0);
    assert.equal(cli([...args, '--input', resolve('../../docs/examples/inventory-after.csv'), '--state', after], dir).status, 0);
    const result = cli(['diff', '--before', before, '--after', after, '--format', 'csv'], dir);
    assert.equal(result.status, 3, result.stderr); assert.match(result.stdout, /"unmatched"/); assert.match(result.stdout, /"total"/);
    const equal = cli(['diff', '--before', before, '--after', before, '--format', 'json'], dir);
    assert.equal(equal.status, 0); assert.equal(JSON.parse(equal.stdout).hasDifferences, false);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('SIGINT cancels a stalled report writer and releases the completed scan lock', {skip: process.platform === 'win32', timeout: 15000}, async () => {
  const {spawn} = await import('node:child_process');
  const {writeFile} = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-stalled-output-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const input = join(dir, 'inventory.csv'), state = join(dir, 'state.json');
    await writeFile(input, 'Bucket,Key,Size\n' + Array.from({length: 6000}, (_, i) => `test,customers/t${i}/file,1\n`).join(''));
    child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry, 'inventory', '--input', input, '--bucket', 'test', '--pattern', 'customers/{tenant_id}/*', '--yes', '--state', state, '--format', 'json'], {cwd: dir, stdio: ['ignore', 'pipe', 'pipe']});
    const exited = new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code, signal) => resolve({code, signal}));
    });
    child.stderr!.resume();
    // Let the pipe fill without consuming any report bytes.
    child.stdout!.on('readable', () => {});
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { ready = JSON.parse(await readFile(state, 'utf8')).status === 'complete' && child.stdout!.readableLength > 0; }
      catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready, 'Report did not reach the blocked output stage.');
    await new Promise(resolve => setTimeout(resolve, 100));
    const guard = setTimeout(() => child!.kill('SIGKILL'), 5000);
    child.kill('SIGINT');
    const result = await exited.finally(() => clearTimeout(guard));
    assert.equal(result.code, 130); assert.equal(result.signal, null);
    await assert.rejects(access(`${state}.lock`));
    assert.equal(JSON.parse(await readFile(state, 'utf8')).status, 'complete');
  } finally {
    child?.kill('SIGKILL'); child?.stdout?.destroy(); child?.stderr?.destroy();
    await rm(dir, {recursive: true, force: true});
  }
});

test('a closed stdout pipe exits cleanly after releasing the scan lock', {skip: process.platform === 'win32', timeout: 10000}, async () => {
  const {spawn} = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-closed-output-'));
  try {
    const state = join(dir, 'state.json');
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry, 'demo', '--state', state, '--format', 'json'], {cwd: dir, stdio: ['ignore', 'pipe', 'pipe']});
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    child.stdout!.destroy(); child.stderr!.resume();
    assert.equal(await exited, 0);
    assert.equal(JSON.parse(await readFile(state, 'utf8')).status, 'complete');
    await assert.rejects(access(`${state}.lock`));
  } finally { await rm(dir, {recursive: true, force: true}); }
});
