import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

export function validateRelease(manifest, lock, tag) {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'Release version must be a stable x.y.z version.');
  assert.equal(tag, `v${manifest.version}`, 'Git tag must match package version.');
  assert.equal(lock.version, manifest.version, 'Lockfile version differs from package version.');
  assert.equal(lock.packages[''].version, manifest.version, 'Lockfile root version differs.');
  assert.equal(lock.name, manifest.name, 'Lockfile package name differs.');
  assert.equal(lock.packages[''].name, manifest.name, 'Lockfile root name differs.');
  assert.equal(manifest.name, '@tenantmeter/cli', 'Update release ownership/configuration before renaming the package.');
  assert.equal(manifest.repository.url, 'git+https://github.com/geopet85/tenantmeter.git');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.private, undefined);
}

async function main() {
  const args = process.argv.slice(2);
  const remote = args.includes('--remote');
  const positional = args.filter(x => x !== '--remote');
  if (positional.length !== 1) throw new Error('Usage: node scripts/release-check.mjs vX.Y.Z [--remote]');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  validateRelease(manifest, JSON.parse(await readFile('package-lock.json', 'utf8')), positional[0]);
  if (remote) {
    const response = await fetch('https://api.github.com/repos/geopet85/tenantmeter/private-vulnerability-reporting', {
      headers: {Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? {Authorization: `Bearer ${process.env.GITHUB_TOKEN}`} : {})},
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok || (await response.json()).enabled !== true) {
      throw new Error(`Private vulnerability reporting could not be verified (HTTP ${response.status}). Enable it in repository Settings > Security before release.`);
    }
  }
  console.log(`Release metadata${remote ? ' and private vulnerability reporting' : ''} passed for ${positional[0]}.`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
