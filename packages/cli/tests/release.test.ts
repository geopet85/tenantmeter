import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
// @ts-expect-error Source-only release helper uses JavaScript.
import {validateRelease} from '../scripts/release-check.mjs';

test('release metadata rejects a mismatched tag, lock, ownership and repository', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.doesNotThrow(() => validateRelease(manifest, lock, `v${manifest.version}`));
  assert.throws(() => validateRelease(manifest, lock, 'v999.0.0'), /tag must match/);
  assert.throws(() => validateRelease(manifest, {...lock, version: '999.0.0'}, `v${manifest.version}`), /Lockfile version/);
  assert.throws(() => validateRelease({...manifest, private: true}, lock, `v${manifest.version}`));
  assert.throws(() => validateRelease({...manifest, repository: {url: 'https://example.com'}}, lock, `v${manifest.version}`));
});

test('required live runner rejects missing opt-ins and bucket instead of skipping', () => {
  const env = {...process.env, RUN_LIVE: '', TENANTMETER_ALLOW_TEST_WRITES: '', TENANTMETER_TEST_BUCKET: ''};
  const result = spawnSync(process.execPath, ['scripts/live-required.mjs'], {env, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skipped test does not pass release checks/);
  assert.doesNotMatch(result.stdout, /TAP version/);
});
