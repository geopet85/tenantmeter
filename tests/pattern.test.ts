import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTenantPattern, extractTenantId } from '../lib/tenant/pattern.ts';

test('extracts tenant from common prefix pattern',()=>{
  const p=compileTenantPattern('customers/{tenant_id}/*');
  assert.equal(extractTenantId(p,'customers/acme/files/a.pdf'),'acme');
  assert.equal(extractTenantId(p,'other/acme/a.pdf'),null);
});

test('supports prefix before tenant',()=>{
  assert.equal(extractTenantId('prod/tenants/{tenant_id}/objects/*','prod/tenants/t_123/objects/a'),'t_123');
});

test('requires tenant token',()=>assert.throws(()=>compileTenantPattern('customers/*')));

test('wildcards match nested paths and newlines in file names',()=>{
  assert.equal(extractTenantId('customers/{tenant_id}/*', 'customers/acme/files/a\nb.txt'), 'acme');
});

test('regex punctuation is literal and the whole key must match',()=>{
  assert.equal(extractTenantId('prod.v1/{tenant_id}/files[1]/*', 'prod.v1/acme/files[1]/a'), 'acme');
  assert.equal(extractTenantId('prod.v1/{tenant_id}/*', 'prodXv1/acme/a'), null);
  assert.equal(extractTenantId('customers/{tenant_id}/file', 'customers/acme/file-more'), null);
  assert.throws(()=>compileTenantPattern('{tenant_id}/{tenant_id}/*'));
});

test('requires exact end of key, including a final newline', () => {
  assert.equal(extractTenantId('customers/{tenant_id}/file', 'customers/acme/file\n'), null);
  assert.equal(extractTenantId('customers/{tenant_id}/*', 'customers/acme/file\n'), 'acme');
});
test('rejects ambiguous wildcard capture and supports literal affixes', () => {
  assert.throws(() => compileTenantPattern('*{tenant_id}/*'), /share a path segment/);
  assert.throws(() => compileTenantPattern('customers/{tenant_id}*/*'), /share a path segment/);
  assert.equal(extractTenantId('customers/account-{tenant_id}.prod/*', 'customers/account-acme.prod/a'), 'acme');
  assert.equal(extractTenantId('*/customers/{tenant_id}/*', 'prod/customers/acme/a'), 'acme');
});
test('adversarial wildcard patterns have bounded matching work', () => {
  const pattern = '*a'.repeat(20) + '/customers/{tenant_id}/x';
  assert.equal(extractTenantId(pattern, 'a'.repeat(70) + '/customers/acme/y'), null);
  assert.equal(extractTenantId(pattern, 'a'.repeat(70) + '/customers/acme/x'), 'acme');
});
test('leading slash and oversized keys terminate safely', () => {
  assert.equal(extractTenantId('*/{tenant_id}/*', '/a'), null);
  assert.equal(extractTenantId('{tenant_id}/*', 'a'.repeat(1025) + '/x'), null);
});
