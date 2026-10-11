import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm run package:check.');
function npmRun(args, cwd) { return run(process.execPath, [npmCli, ...args], cwd); }
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
}
const temp = await mkdtemp(join(tmpdir(), 'tenantmeter-package-'));
try {
  const pack = JSON.parse(npmRun(['pack', '--json', '--ignore-scripts', '--pack-destination', temp], process.cwd()))[0];
  const allowed = /^(dist\/tenantmeter\.js|package\.json|README\.md|INSTALL\.md|SCALING\.md|LICENSE|CONTRIBUTING\.md|SECURITY\.md|CHANGELOG\.md|TODO\.md|scripts\/(scheduled-scan|package-check|test|examples)\.mjs)$/;
  for (const file of pack.files) assert.match(file.path, allowed, `Unexpected package file: ${file.path}`);
  for (const name of ['dist/tenantmeter.js', 'LICENSE', 'README.md', 'INSTALL.md', 'SCALING.md', 'TODO.md', 'scripts/scheduled-scan.mjs']) assert.ok(pack.files.some(x => x.path === name), `Missing ${name}`);
  // Install the locked production dependency graph before testing the package.
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const bootstrap = {...manifest, name: 'tenantmeter-package-verification', private: true};
  delete bootstrap.scripts; delete bootstrap.bin;
  lock.name = bootstrap.name; lock.packages[''].name = bootstrap.name;
  await writeFile(join(temp, 'package.json'), JSON.stringify(bootstrap));
  await writeFile(join(temp, 'package-lock.json'), JSON.stringify(lock));
  const offline = process.argv.includes('--offline') ? ['--offline'] : [];
  npmRun(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], temp);
  npmRun(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : []), join(temp, pack.filename)], temp);
  const installed = JSON.parse(await readFile(join(temp, 'node_modules', ...manifest.name.split('/'), 'package.json'), 'utf8'));
  assert.deepEqual(installed.dependencies, manifest.dependencies);
  const entry = join(temp, 'node_modules', ...manifest.name.split('/'), 'dist/tenantmeter.js');
  assert.equal(run(process.execPath, [entry, '--version'], temp).trim(), manifest.version);
  const diagnostic = JSON.parse(run(process.execPath, [entry, 'doctor', '--storage', 'sqlite', '--format', 'json'], temp));
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.version, manifest.version);
  const report = JSON.parse(run(process.execPath, [entry, 'demo', '--state', join(temp, 'state.json'), '--format', 'json'], temp));
  assert.equal(report.total.bytes, '5501000000'); assert.equal(report.total.objects, 2505);
  const state = JSON.parse(await readFile(join(temp, 'state.json'), 'utf8'));
  assert.equal(state.status, 'complete');
  const diskPath = join(temp, 'state.sqlite');
  run(process.execPath, [entry, 'migrate', '--state', join(temp, 'state.json'), '--output', diskPath], temp);
  const diskReport = JSON.parse(run(process.execPath, [entry, 'report', '--state', diskPath, '--format', 'json'], temp));
  assert.deepEqual(diskReport, report);
  const diskDemo = JSON.parse(run(process.execPath, [entry, 'demo', '--storage', 'sqlite', '--state', join(temp, 'demo.sqlite'), '--format', 'json'], temp));
  assert.equal(diskDemo.total.bytes, '5501000000');
  const schedule = join(temp, 'schedule.json');
  await writeFile(schedule, JSON.stringify({outputDir: './scheduled', args: ['demo', '--storage', 'sqlite']}));
  run(process.execPath, [join(temp, 'node_modules', ...manifest.name.split('/'), 'scripts/scheduled-scan.mjs'), schedule], temp);
  const {readdir} = await import('node:fs/promises');
  const reports = (await readdir(join(temp, 'scheduled'))).filter(x => x.endsWith('.report.json'));
  assert.equal(reports.length, 1);
  assert.equal((await readdir(join(temp, 'scheduled'))).filter(x => x.endsWith('.state.sqlite')).length, 1);
  assert.equal(JSON.parse(await readFile(join(temp, 'scheduled', reports[0]), 'utf8')).total.bytes, '5501000000');
  console.log('Package contents, installed JSON/SQLite CLI, migration, and scheduled run passed.');
} finally { await rm(temp, { recursive: true, force: true }); }
