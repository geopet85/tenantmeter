// SPDX-License-Identifier: MIT — see ../../packages/cli/LICENSE.
export type TenantPattern = {
  raw: string;
  regex: RegExp;
};

const TOKEN = '{tenant_id}';

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileTenantPattern(pattern: string): TenantPattern {
  const tokenIndex = pattern.indexOf(TOKEN);
  if (tokenIndex === -1) throw new Error(`Pattern must include ${TOKEN}`);
  if (pattern.indexOf(TOKEN, tokenIndex + TOKEN.length) !== -1) throw new Error('Pattern may include {tenant_id} only once');

  const before = pattern.slice(0, tokenIndex);
  const after = pattern.slice(tokenIndex + TOKEN.length);
  const wildcard = (input: string) => escapeRegex(input).replace(/\\\*/g, '[\\s\\S]*');
  const source = `^${wildcard(before)}(?<tenant_id>[^/]+)${wildcard(after)}$`;
  return { raw: pattern, regex: new RegExp(source) };
}

export function extractTenantId(pattern: TenantPattern | string, key: string): string | null {
  const compiled = typeof pattern === 'string' ? compileTenantPattern(pattern) : pattern;
  return compiled.regex.exec(key)?.groups?.tenant_id ?? null;
}
