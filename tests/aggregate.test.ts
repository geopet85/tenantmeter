import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateObjects } from '../lib/scans/aggregate.ts';

test('aggregates bytes and objects by tenant',()=>{
  const rows:any[]=[{key:'customers/a/x',sizeBytes:10},{key:'customers/a/y',sizeBytes:20},{key:'customers/b/z',sizeBytes:7},{key:'ignore/z',sizeBytes:999}];
  const result=aggregateObjects(rows,'customers/{tenant_id}/*');
  assert.deepEqual(result.get('a'),{tenantId:'a',bytes:30,objects:2});
  assert.deepEqual(result.get('b'),{tenantId:'b',bytes:7,objects:1});
});
