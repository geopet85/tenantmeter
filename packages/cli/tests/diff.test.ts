import test from 'node:test';
import assert from 'node:assert/strict';
import { newState } from '../src/model.ts';
import { applyPage } from '../src/scan.ts';
import { diffStates, renderDiff } from '../src/diff.ts';
import { options } from '../src/options.ts';
const config = {provider: 'demo' as const, bucket: 'demo-bucket', region: 'auto', prefix: '', pattern: 'customers/{tenant_id}/*'};
const complete = (rows: {key: string; bytes: number}[]) => applyPage(newState(config), {objects: rows, nextCursor: null});
test('diff handles growth, deletion, zero-byte additions, object-count changes and exact integers', () => {
  const before = complete([{key: 'customers/growing/a', bytes: Number.MAX_SAFE_INTEGER}, {key: 'customers/growing/b', bytes: Number.MAX_SAFE_INTEGER},
    {key: 'customers/deleted/a', bytes: 4}, {key: 'customers/same/a', bytes: 2}, {key: 'system/a', bytes: 8}]);
  const after = complete([{key: 'customers/growing/a', bytes: Number.MAX_SAFE_INTEGER}, {key: 'customers/growing/b', bytes: Number.MAX_SAFE_INTEGER},
    {key: 'customers/growing/c', bytes: 1}, {key: 'customers/new/a', bytes: 0}, {key: 'customers/same/a', bytes: 1}, {key: 'customers/same/b', bytes: 1}]);
  const result = diffStates(before, after);
  assert.equal(result.different, 4); assert.equal(result.hasDifferences, true);
  assert.equal(result.rows.find(x => x.tenantId === 'growing')?.beforeBytes, '18014398509481982');
  assert.equal(result.rows.find(x => x.tenantId === 'growing')?.deltaBytes, '1');
  assert.equal(result.rows.find(x => x.tenantId === 'deleted')?.status, 'removed');
  assert.equal(result.rows.find(x => x.tenantId === 'new')?.status, 'added');
  assert.equal(result.rows.find(x => x.tenantId === 'same')?.deltaObjects, 1);
  assert.equal(result.unmatched.deltaBytes, '-8'); assert.equal(result.total.deltaBytes, '-11');
  assert.equal(JSON.parse(renderDiff(result, 'json', 1)).rows.length, 4);
  assert.match(renderDiff(result, 'table', 1), /Showing 1 differences/);
});
test('diff detects unmatched-only changes and rejects incomplete/different scopes', () => {
  const empty = complete([]), unmatched = complete([{key: 'system/a', bytes: 2}]);
  assert.equal(diffStates(empty, unmatched).hasDifferences, true);
  assert.equal(diffStates(empty, empty).hasDifferences, false);
  assert.throws(() => diffStates(newState(config), empty), /complete/);
  for (const field of ['bucket','prefix','pattern','provider','accountId','jurisdiction']) {
    const changed = structuredClone(empty); (changed.config as any)[field] = 'other';
    assert.throws(() => diffStates(empty, changed), /scope differs/);
  }
  assert.throws(() => options(['diff', '--before', 'a']));
  assert.throws(() => options(['diff', '--before', 'a', '--after', 'b', '--all']));
});
