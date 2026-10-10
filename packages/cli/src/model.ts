export type Config = {
  provider: 's3' | 'r2' | 'demo' | 'inventory';
  bucket: string;
  pattern: string;
  prefix: string;
  region: string;
  accountId?: string;
  jurisdiction?: 'default' | 'eu' | 'us' | 'fedramp';
  inventory?: {
    files: { path: string; sha256: string }[];
    columns?: string[];
    encodedKeys: boolean;
    createdAt?: string;
  };
};
export type ObjectRow = { key: string; bytes: number };
export type Page = { objects: ObjectRow[]; nextCursor: string | null };
export interface Source {
  page(cursor: string | null, maxKeys: number, signal: AbortSignal): Promise<Page>;
  close(): void;
}
export type Totals = { bytes: string; objects: number };
export type State = {
  version: 1;
  config: Config;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  status: 'partial' | 'complete';
  reason: 'in-progress' | 'object-limit' | 'request-limit' | 'time-limit' | 'interrupted' | 'error' | 'complete';
  cursor: string | null;
  requests: number;
  pages: number;
  objects: number;
  bytes: string;
  unmatched: Totals;
  invalidTenantObjects: number;
  tenants: Record<string, Totals>;
};
export function newState(config: Config): State {
  const now = new Date().toISOString();
  return {
    version: 1, config, startedAt: now, updatedAt: now, finishedAt: null,
    status: 'partial', reason: 'in-progress', cursor: null, requests: 0,
    pages: 0, objects: 0, bytes: '0', unmatched: { bytes: '0', objects: 0 },
    invalidTenantObjects: 0, tenants: Object.create(null)
  };
}
