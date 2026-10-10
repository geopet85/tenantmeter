import { compileTenantPattern, extractTenantId } from '../tenant/pattern.ts';
import type { ObjectRecord } from '../providers/types.ts';

export type TenantAggregate = { tenantId: string; bytes: number; objects: number };

export function aggregateObjects(objects: ObjectRecord[], pattern: string, target = new Map<string, TenantAggregate>()) {
  const compiled = compileTenantPattern(pattern);
  for (const object of objects) {
    const tenantId = extractTenantId(compiled, object.key);
    if (!tenantId) continue;
    const current = target.get(tenantId) ?? { tenantId, bytes: 0, objects: 0 };
    current.bytes += object.sizeBytes;
    current.objects += 1;
    target.set(tenantId, current);
  }
  return target;
}
