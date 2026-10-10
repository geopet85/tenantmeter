import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batches, exportFile, writeOutput } from '../src/output.ts';
import { renderChunks, report } from '../src/report.ts';
import { newState } from '../src/model.ts';

function fixture() {
  const state = newState({provider: 'demo', bucket: 'test', region: 'auto', prefix: '', pattern: 'customers/{tenant_id}/*'});
  state.tenants = Object.assign(Object.create(null), {
    '東京\n"quoted"': {bytes: '9007199254740993', objects: 1},
    '=SUM(1,2)': {bytes: '0', objects: 1}
  });
  Object.defineProperty(state.tenants, '__proto__', {value: {bytes: '0', objects: 1}, enumerable: true});
  state.objects = 5; state.bytes = '9007199254740996'; state.unmatched = {bytes: '3', objects: 2};
  return state;
}

test('streamed reports preserve schema, formatting, exact totals, empty tenants and escaped IDs', () => {
  for (const state of [fixture(), newState(fixture().config)]) {
    const content = Array.from(renderChunks(state, 'json')).join('');
    assert.equal(content, JSON.stringify(report(state), null, 2) + '\n');
    assert.deepEqual(JSON.parse(content), report(state));
  }
  const state = fixture();
  const csv = Array.from(renderChunks(state, 'csv')).join('');
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.match(csv, /"東京\n""quoted"""/);
  assert.match(csv, /"__proto__"/);
  assert.ok(csv.endsWith(`"total","","9007199254740996","5","partial","in-progress","${state.startedAt}",""\n`));
});

test('batching bounds writes and preserves multibyte text split across buffer boundaries', () => {
  const text = 'a'.repeat(65535) + '東京'.repeat(30000) + '\n';
  const chunks = Array.from(batches([text, 'last']));
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(chunk => chunk.length <= 65536));
  assert.equal(Buffer.concat(chunks).toString('utf8'), text + 'last');
});

test('output honors backpressure and waits for the destination to finish', async () => {
  let produced = 0, completed = 0;
  function* rows() { for (let i = 0; i < 100; i++) { produced++; yield 'x'.repeat(65536); } }
  const output = new Writable({highWaterMark: 1, write(chunk, encoding, callback) {
    if (!chunk.length) { callback(); return; }
    assert.ok(produced - completed <= 3, `Producer ran ahead: ${produced - completed}`);
    setTimeout(() => { completed++; callback(); }, 1);
  }});
  await writeOutput(rows(), output);
  assert.equal(completed, 100);
  assert.equal(output.writableFinished, true);
  output.destroy();
});

test('destination failures stop generation and propagate the write error', async () => {
  let produced = 0, closed = false;
  function* rows() {
    try { for (let i = 0; i < 1000; i++) { produced++; yield 'x'.repeat(65536); } }
    finally { closed = true; }
  }
  const output = new Writable({write(chunk, encoding, callback) { callback(new Error('write failed')); }});
  await assert.rejects(writeOutput(rows(), output), /write failed/);
  assert.ok(produced < 1000);
  assert.equal(closed, true);
});

test('file exports publish complete content, refuse races and clean temporary files on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-output-'));
  try {
    const path = join(dir, 'report.json');
    const content = Array.from(renderChunks(fixture(), 'json')).join('');
    await exportFile(path, [content]);
    assert.equal(await readFile(path, 'utf8'), content);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(exportFile(path, ['replacement']), {code: 'EEXIST'});
    assert.equal(await readFile(path, 'utf8'), content);
    const failed = join(dir, 'failed.csv');
    function* broken() { yield 'header\n'; throw new Error('encoding failed'); }
    await assert.rejects(exportFile(failed, broken()), /encoding failed/);
    assert.deepEqual(await readdir(dir), ['report.json']);
    const racing = join(dir, 'racing.csv');
    function* collision() { yield 'partial'; writeFileSync(racing, 'other writer'); yield 'complete'; }
    await assert.rejects(exportFile(racing, collision()), {code: 'EEXIST'});
    assert.equal(await readFile(racing, 'utf8'), 'other writer');
    assert.deepEqual((await readdir(dir)).sort(), ['racing.csv', 'report.json']);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('aborting blocked output rejects promptly and closes its producer', async () => {
  const controller = new AbortController();
  let closed = false;
  function* rows() {
    try { while (true) yield 'x'.repeat(65536); }
    finally { closed = true; }
  }
  const output = new Writable({write(chunk, encoding, callback) { controller.abort(); }});
  await assert.rejects(writeOutput(rows(), output, controller.signal), {name: 'AbortError'});
  assert.equal(output.destroyed, true);
  assert.equal(closed, true);
});

test('aborting a file export removes its temporary file without publishing a report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-aborted-output-'));
  const controller = new AbortController();
  try {
    function* rows() { yield 'x'.repeat(65536); controller.abort(); yield 'last'; }
    await assert.rejects(exportFile(join(dir, 'report.csv'), rows(), controller.signal), {name: 'AbortError'});
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('a failure in the final delayed write rejects instead of reporting success', async () => {
  const output = new Writable({write(chunk, encoding, callback) {
    setTimeout(() => callback(new Error('last write failed')), 10);
  }});
  await assert.rejects(writeOutput(['only row'], output), /last write failed/);
});
