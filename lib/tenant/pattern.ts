// SPDX-License-Identifier: MIT — see ../../packages/cli/LICENSE.
export type TenantPattern = { raw: string; before: string; after: string; prefix: string; suffix: string };
const TOKEN = '{tenant_id}';

// Greedy wildcard matching with one retry position. No regular-expression backtracking.
function glob(pattern: string, text: string) {
  let p = 0, t = 0, star = -1, retry = 0;
  while (t < text.length) {
    if (pattern[p] === '*') { star = p++; retry = t; }
    else if (p < pattern.length && pattern[p] === text[t]) { p++; t++; }
    else if (star >= 0) { p = star + 1; t = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function compileTenantPattern(pattern: string): TenantPattern {
  if (typeof pattern !== 'string' || pattern.length > 2048) throw new Error('Pattern must be a string of at most 2048 characters.');
  const tokenIndex = pattern.indexOf(TOKEN);
  if (tokenIndex === -1) throw new Error(`Pattern must include ${TOKEN}`);
  if (pattern.indexOf(TOKEN, tokenIndex + TOKEN.length) !== -1) throw new Error('Pattern may include {tenant_id} only once');
  const start = pattern.lastIndexOf('/', tokenIndex) + 1;
  const boundary = pattern.indexOf('/', tokenIndex + TOKEN.length);
  const end = boundary < 0 ? pattern.length : boundary;
  const prefix = pattern.slice(start, tokenIndex);
  const suffix = pattern.slice(tokenIndex + TOKEN.length, end);
  if (prefix.includes('*') || suffix.includes('*')) throw new Error('Wildcards cannot share a path segment with {tenant_id}. Use a literal tenant segment, such as customers/{tenant_id}/*.');
  return {raw: pattern, before: pattern.slice(0, start).replace(/\*+/g, '*'), after: pattern.slice(end).replace(/\*+/g, '*'), prefix, suffix};
}
export function extractTenantId(pattern: TenantPattern | string, key: string): string | null {
  if (key.length > 1024) return null; // S3 object keys cannot exceed 1024 bytes.
  const compiled = typeof pattern === 'string' ? compileTenantPattern(pattern) : pattern;
  const capture = (start: number, end: number) => {
    const segment = key.slice(start, end);
    if (!segment.startsWith(compiled.prefix) || !segment.endsWith(compiled.suffix) || segment.length <= compiled.prefix.length + compiled.suffix.length) return null;
    if (!glob(compiled.after, key.slice(end))) return null;
    return segment.slice(compiled.prefix.length, segment.length - compiled.suffix.length);
  };
  if (!compiled.before.includes('*')) {
    if (!key.startsWith(compiled.before)) return null;
    const start = compiled.before.length;
    const slash = key.indexOf('/', start);
    return capture(start, slash < 0 ? key.length : slash);
  }
  // Prefer the rightmost matching segment, as greedy prefix wildcards did previously.
  let end = key.length;
  while (end >= 0) {
    const start = end === 0 ? 0 : key.lastIndexOf('/', end - 1) + 1;
    if (glob(compiled.before, key.slice(0, start))) {
      const result = capture(start, end);
      if (result !== null) return result;
    }
    if (start === 0) break;
    end = start - 1;
  }
  return null;
}
