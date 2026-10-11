import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const entry = resolve('dist/tenantmeter.js');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'tenantmeter-runtime-'));
function cli(args, expected = 0) {
  const result = spawnSync(process.execPath, [entry, ...args], {cwd: directory, encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, expected, result.stderr || String(result.error));
  return result;
}
try {
  assert.equal(cli(['--version']).stdout.trim(), manifest.version);
  assert.match(cli(['--help']).stdout, /tenantmeter/i);
  const state = join(directory, 'partial.json');
  assert.equal(JSON.parse(cli(['demo', '--state', state, '--max-objects', '1001', '--format', 'json'], 2).stdout).total.objects, 1001);
  const complete = JSON.parse(cli(['analyze', '--resume', state, '--all', '--yes', '--format', 'json']).stdout);
  assert.equal(complete.total.bytes, '5501000000');
  assert.equal(complete.total.objects, 2505);
  assert.deepEqual(JSON.parse(cli(['report', '--state', state, '--format', 'json']).stdout), complete);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major === 22 && minor < 13) {
    assert.match(cli(['demo', '--storage', 'sqlite', '--state', join(directory, 'unsupported.sqlite')], 1).stderr, /Node.js 22.13 or newer/);
  } else {
    const migrated = join(directory, 'migrated.sqlite');
    cli(['migrate', '--state', state, '--output', migrated]);
    assert.deepEqual(JSON.parse(cli(['report', '--state', migrated, '--format', 'json']).stdout), complete);
    assert.equal(JSON.parse(cli(['demo', '--storage', 'sqlite', '--state', join(directory, 'demo.sqlite'), '--format', 'json']).stdout).total.bytes, complete.total.bytes);
  }
  console.log(`Runtime smoke checks passed on ${process.version}.`);
} finally { await rm(directory, {recursive: true, force: true}); }
