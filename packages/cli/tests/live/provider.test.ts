import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
const exec = promisify(execFile);
const enabled = process.env.RUN_LIVE === '1' && process.env.TENANTMETER_ALLOW_TEST_WRITES === '1';

test('live provider: known fixtures, pagination, resume, prefix, unmatched and offline export', {skip: !enabled, timeout: 300_000}, async () => {
  const provider = process.env.TENANTMETER_TEST_PROVIDER;
  const bucket = process.env.TENANTMETER_TEST_BUCKET;
  assert.ok(provider === 's3' || provider === 'r2', 'Set TENANTMETER_TEST_PROVIDER=s3 or r2');
  assert.ok(bucket, 'Set TENANTMETER_TEST_BUCKET to an existing disposable bucket');
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const jurisdiction = process.env.R2_JURISDICTION ?? 'default';
  const suffix = jurisdiction === 'default' ? '' : `.${jurisdiction}`;
  if (provider === 'r2') {
    assert.match(process.env.R2_ACCOUNT_ID ?? '', /^[a-f0-9]{32}$/i);
    assert.ok(['default','eu','us','fedramp'].includes(jurisdiction));
    assert.ok(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
  }
  const client = new S3Client({region: provider === 'r2' ? 'auto' : region, maxAttempts: 4,
    requestHandler: {connectionTimeout: 10_000, requestTimeout: 60_000},
    ...(provider === 'r2' ? {forcePathStyle: true, endpoint: `https://${process.env.R2_ACCOUNT_ID}${suffix}.r2.cloudflarestorage.com`, credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!, sessionToken: process.env.R2_SESSION_TOKEN
    }} : {})});
  const prefix = `tenantmeter-cli-test/${randomUUID()}/`;
  const fixtures = [...Array.from({length: 1002}, (_, i) => ({key: `${prefix}customers/${i % 2 ? 'beta' : 'alpha'}/${i}`, bytes: i % 2 ? 7 : 3})),
    ...Array.from({length: 3}, (_, i) => ({key: `${prefix}system/${i}`, bytes: 5}))];
  const attempted: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-live-'));
  const entry = resolve('dist/tenantmeter.js');
  async function cli(args: string[], expected = 0) {
    try {
      const {stdout} = await exec(process.execPath, [entry, ...args], {cwd: dir, maxBuffer: 2_000_000, timeout: 120_000});
      assert.equal(expected, 0); return JSON.parse(stdout);
    } catch (error) {
      const failure = error as Error & {code?: number; stdout?: string};
      assert.equal(failure.code, expected, 'CLI returned an unexpected exit code');
      return JSON.parse(failure.stdout!);
    }
  }
  try {
    for (let index = 0; index < fixtures.length; index += 16) {
      const results = await Promise.allSettled(fixtures.slice(index, index + 16).map(async row => {
        attempted.push(row.key);
        await client.send(new PutObjectCommand({Bucket: bucket, Key: row.key, Body: Buffer.alloc(row.bytes, 120)}));
      }));
      const failure = results.find(x => x.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
    const base = ['analyze', '--provider', provider, '--bucket', bucket, '--pattern', `${prefix}customers/{tenant_id}/*`, '--prefix', prefix,
      '--yes', '--format', 'json', ...(provider === 'r2' ? ['--jurisdiction', jurisdiction] : ['--region', region])];
    const state = join(dir, 'partial.json');
    const partial = await cli([...base, '--state', state, '--max-objects', '1001'], 2);
    assert.equal(partial.total.objects, 1001);
    const resumed = await cli(['analyze', '--resume', state, '--all', '--yes', '--format', 'json']);
    const fresh = await cli([...base, '--state', join(dir, 'fresh.json'), '--all']);
    for (const result of [resumed, fresh]) {
      assert.equal(result.total.objects, 1005); assert.equal(result.total.bytes, '5025');
      assert.deepEqual(result.unmatched, {objects: 3, bytes: '15'});
      assert.equal(result.tenants.find((x: any) => x.tenantId === 'alpha').bytes, '1503');
      assert.equal(result.tenants.find((x: any) => x.tenantId === 'beta').bytes, '3507');
    }
    assert.deepEqual((await cli(['report', '--state', state, '--format', 'json'])).total, resumed.total);
    const empty = [...base]; empty[empty.indexOf('--prefix') + 1] = `${prefix}absent/`;
    assert.equal((await cli([...empty, '--state', join(dir, 'empty.json')])).total.objects, 0);
    const unmatched = [...base]; unmatched[unmatched.indexOf('--pattern') + 1] = 'absent/{tenant_id}/*';
    assert.equal((await cli([...unmatched, '--state', join(dir, 'unmatched.json')])).unmatched.objects, 1005);
  } finally {
    try {
      for (let index = 0; index < attempted.length; index += 1000) {
        const deleted = await client.send(new DeleteObjectsCommand({Bucket: bucket, Delete: {Quiet: true, Objects: attempted.slice(index, index + 1000).map(Key => ({Key}))}}));
        assert.ok(!deleted.Errors?.length, 'Fixture cleanup failed. Remove only this test prefix from the disposable bucket.');
      }
    } finally { client.destroy(); await rm(dir, {recursive: true, force: true}); }
  }
});
