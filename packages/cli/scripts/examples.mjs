import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
const directory = resolve('../../docs/examples');
await mkdir(directory, {recursive: true});
const temp = await mkdtemp(join(tmpdir(), 'tenantmeter-examples-'));
const entry = resolve('dist/tenantmeter.js');
function run(args, code = 0) {
  const result = spawnSync(process.execPath, [entry, ...args], {encoding: 'utf8'});
  assert.equal(result.status, code, result.stderr); return result.stdout;
}
try {
  const state = join(temp, 'demo.json');
  run(['demo', '--state', state]);
  for (const [format, extension] of [['table', 'txt'], ['json', 'json'], ['csv', 'csv']]) {
    await writeFile(join(directory, `demo.${extension}`), run(['report', '--state', state, '--format', format]));
  }
  const rows = 'example-bucket,customers%2Facme%2Fa.txt,10\nexample-bucket,customers%2F%E6%9D%B1%E4%BA%AC%2Fb.txt,20\nexample-bucket,system%2Flog,3\n';
  await writeFile(join(directory, 'inventory.csv'), 'Bucket,Key,Size\n' + rows);
  await writeFile(join(directory, 'counters.csv'), 'tenant_id,bytes\nacme,9\n東京,20\n');
  const inventoryState = join(temp, 'inventory.json');
  const report = run(['inventory', '--input', join(directory, 'inventory.csv'), '--bucket', 'example-bucket', '--pattern', 'customers/{tenant_id}/*', '--yes', '--state', inventoryState, '--format', 'json']);
  assert.equal(JSON.parse(report).total.bytes, '33');
  await writeFile(join(directory, 'inventory-report.json'), report);
  await writeFile(join(directory, 'comparison.json'), run(['compare', '--state', inventoryState, '--counters', join(directory, 'counters.csv'), '--format', 'json'], 3));
  const root = join(directory, 'manifest'); await mkdir(join(root, 'data'), {recursive: true});
  const data = gzipSync(rows); const md5 = bytes => createHash('md5').update(bytes).digest('hex');
  await writeFile(join(root, 'data/part.csv.gz'), data);
  const manifest = JSON.stringify({sourceBucket: 'arn:aws:s3:::example-bucket', creationTimestamp: '1767225600000', fileFormat: 'CSV', fileSchema: 'Bucket, Key, Size', files: [{key: 'data/part.csv.gz', size: data.length, MD5checksum: md5(data)}]}, null, 2) + '\n';
  await writeFile(join(root, 'manifest.json'), manifest); await writeFile(join(root, 'manifest.checksum'), md5(manifest) + '\n');
  const fromManifest = JSON.parse(run(['inventory', '--manifest', join(root, 'manifest.json'), '--inventory-root', root, '--pattern', 'customers/{tenant_id}/*', '--yes', '--state', join(temp, 'manifest.json'), '--format', 'json']));
  assert.equal(fromManifest.total.bytes, '33');
  await writeFile(join(directory, 'schedule.json'), JSON.stringify({outputDir: './scheduled-reports', args: ['demo', '--max-requests', '10', '--max-seconds', '300']}, null, 2) + '\n');
  console.log('Generated and checked demo, inventory, comparison, manifest and schedule examples.');
} finally { await rm(temp, {recursive: true, force: true}); }
