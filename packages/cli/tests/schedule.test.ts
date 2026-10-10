import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

test('schedule preserves CLI exit codes and releases its lock; overlapping runs are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-schedule-'));
  try {
    // Isolate the wrapper with a deterministic CLI stub: no build required for unit tests.
    await mkdir(join(dir, 'scripts')); await mkdir(join(dir, 'dist'));
    await cp(resolve('scripts/scheduled-scan.mjs'), join(dir, 'scripts/scheduled-scan.mjs'));
    await writeFile(join(dir, 'dist/tenantmeter.js'), `const fs=require('node:fs');const a=process.argv;fs.writeFileSync(a[a.indexOf('--output')+1],JSON.stringify({args:a.slice(2)}));process.exit(a.includes('partial')?2:0);`);
    const config = join(dir, 'schedule.json');
    const reports = join(dir, 'reports');
    await writeFile(config, JSON.stringify({outputDir: './reports', args: ['demo', 'partial']}));
    const run = () => spawnSync(process.execPath, [join(dir, 'scripts/scheduled-scan.mjs'), config], {encoding: 'utf8'});
    assert.equal(run().status, 2);
    const files = await readdir(reports); assert.equal(files.length, 1);
    const report = JSON.parse(await readFile(join(reports, files[0]), 'utf8'));
    assert.ok(report.args.includes('--yes')); assert.ok(report.args.includes('--state'));
    await writeFile(join(reports, '.scheduled-scan.lock'), '{}');
    const locked = run(); assert.equal(locked.status, 1); assert.match(locked.stderr, /locked/);
    await rm(join(reports, '.scheduled-scan.lock'));
    await writeFile(config, JSON.stringify({outputDir: './reports', args: ['demo', '--output=elsewhere']}));
    assert.equal(run().status, 1); assert.equal((await readdir(reports)).length, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('schedule rejects malformed configuration and cleans up after child failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-schedule-errors-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await cp(resolve('scripts/scheduled-scan.mjs'), join(dir, 'scripts/scheduled-scan.mjs'));
    const config = join(dir, 'schedule.json');
    const run = () => spawnSync(process.execPath, [join(dir, 'scripts/scheduled-scan.mjs'), config], { encoding: 'utf8' });
    for (const value of [null, [], {}, {args: ['demo'], outputDir: 'reports', output: 'typo'},
      {args: ['demo', '--'], outputDir: 'reports'}, {args: ['demo', '\0'], outputDir: 'reports'},
      {args: ['demo'], outputDir: '   '}, {args: ['demo', '--resume=x'], outputDir: 'reports'}]) {
      await writeFile(config, JSON.stringify(value));
      const result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /Allowed configuration keys/);
    }
    await writeFile(config, JSON.stringify({args: ['demo'], outputDir: 'reports'}));
    const result = run(); assert.equal(result.status, 1); // Missing CLI entry point.
    assert.deepEqual(await readdir(join(dir, 'reports')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('schedule forwards termination, preserves its exit code, and removes the lock', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-schedule-signal-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(join(dir, 'scripts')); await mkdir(join(dir, 'dist'));
    await cp(resolve('scripts/scheduled-scan.mjs'), join(dir, 'scripts/scheduled-scan.mjs'));
    await writeFile(join(dir, 'dist/tenantmeter.js'), `process.stdout.write('ready\\n');setInterval(()=>{},1000);`);
    const config = join(dir, 'schedule.json');
    await writeFile(config, JSON.stringify({args: ['demo'], outputDir: 'reports'}));
    child = spawn(process.execPath, [join(dir, 'scripts/scheduled-scan.mjs'), config], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout!, 'data', { signal: AbortSignal.timeout(10_000) });
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [143, null]);
    assert.deepEqual(await readdir(join(dir, 'reports')), []);
  } finally { child?.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});
