import { compileTenantPattern, extractTenantId } from '../../../lib/tenant/pattern.ts';
import type { Page, Source, State } from './model.ts';

function addCount(a: number, b: number) {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new Error('Object count exceeds the supported safe integer range.');
  return value;
}
export function tenantFor(pattern: ReturnType<typeof compileTenantPattern>, key: string) {
  const tenant = extractTenantId(pattern, key);
  if (tenant === null) return { tenant: null, invalid: false };
  const invalid = Buffer.byteLength(tenant) > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(tenant);
  return { tenant: invalid ? null : tenant, invalid };
}

// A page is applied to a copy. Only the complete page and its next cursor are saved.
export function applyPage(state: State, page: Page): State {
  const next: State = structuredClone(state);
  next.tenants = Object.assign(Object.create(null), next.tenants);
  const pattern = compileTenantPattern(state.config.pattern);
  for (const object of page.objects) {
    if (typeof object.key !== 'string' || !Number.isSafeInteger(object.bytes) || object.bytes < 0) {
      throw new Error('Provider returned an invalid key or unsafe object size. Progress was not advanced.');
    }
    const { tenant, invalid } = tenantFor(pattern, object.key);
    const totals = tenant === null
      ? next.unmatched
      : (next.tenants[tenant] ??= { bytes: '0', objects: 0 });
    totals.bytes = (BigInt(totals.bytes) + BigInt(object.bytes)).toString();
    totals.objects = addCount(totals.objects, 1);
    next.objects = addCount(next.objects, 1);
    next.bytes = (BigInt(next.bytes) + BigInt(object.bytes)).toString();
    if (invalid) next.invalidTenantObjects = addCount(next.invalidTenantObjects, 1);
  }
  next.pages = addCount(next.pages, 1);
  next.cursor = page.nextCursor;
  next.updatedAt = new Date().toISOString();
  if (page.nextCursor === null) {
    next.status = 'complete';
    next.reason = 'complete';
    next.finishedAt = next.updatedAt;
  }
  return next;
}

export async function scan(options: {
  source: Source;
  state: State;
  maxObjects: number;
  maxRequests?: number;
  signal: AbortSignal;
  save: (state: State) => Promise<void>;
  progress?: (state: State) => void;
  preview?: (page: Page) => Promise<void>;
}) {
  let state = options.state;
  try {
    while (state.status !== 'complete' && state.objects < options.maxObjects && state.requests < (options.maxRequests ?? Infinity)) {
      options.signal.throwIfAborted();
      const maxKeys = Math.min(1000, options.maxObjects - state.objects);
      state = { ...state, requests: state.requests + 1 };
      const page = await options.source.page(state.cursor, maxKeys, options.signal);
      if (page.objects.length > maxKeys || (page.nextCursor !== null && page.nextCursor === state.cursor)) {
        throw new Error('Provider returned an oversized page or a repeated cursor.');
      }
      if (state.pages === 0 && options.preview) await options.preview(page);
      options.signal.throwIfAborted();
      const next = applyPage(state, page);
      await options.save(next);
      state = next;
      options.progress?.(state);
    }
    if (state.status !== 'complete') {
      state = { ...state, reason: state.objects >= options.maxObjects ? 'object-limit' : 'request-limit', updatedAt: new Date().toISOString() };
      await options.save(state);
    }
    return state;
  } catch (error) {
    state = {
      ...state, status: 'partial', finishedAt: null,
      reason: options.signal.aborted ? options.signal.reason === 'time-limit' ? 'time-limit' : 'interrupted' : 'error', updatedAt: new Date().toISOString()
    };
    await options.save(state);
    if (options.signal.aborted) return state;
    throw error;
  }
}
