import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
