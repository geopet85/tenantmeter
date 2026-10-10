import { parseArgs } from 'node:util';
import { compileTenantPattern } from '../../../lib/tenant/pattern.ts';
import type { Config } from './model.ts';

export const help = `TenantMeter 0.1.0 — local storage usage by customer

Usage:
  tenantmeter demo [options]
  tenantmeter analyze --provider s3|r2 --bucket NAME --pattern 'customers/{tenant_id}/*' [options]
  tenantmeter analyze --resume STATE_FILE [options]
  tenantmeter report --state STATE_FILE [--format table|json|csv] [--output PATH]
  tenantmeter inventory --input FILE --bucket NAME --pattern PATTERN [options]
  tenantmeter inventory --manifest FILE --inventory-root DIR --pattern PATTERN [options]
  tenantmeter compare --state STATE_FILE --counters FILE [--format table|json|csv]
  tenantmeter diff --before STATE_FILE --after STATE_FILE [--format table|json|csv]
  tenantmeter migrate --state JSON_CHECKPOINT --output NEW_SQLITE_FILE

Options:
  --provider s3|r2         Storage provider
  --bucket NAME            Bucket to list
  --pattern PATTERN        Exactly one {tenant_id}; * matches any characters
  --region REGION          AWS region (default: AWS_REGION, AWS_DEFAULT_REGION, us-east-1)
  --account-id ID          R2 account ID (or R2_ACCOUNT_ID)
  --jurisdiction VALUE     R2 default, eu, us, or fedramp (default: default)
  --prefix PREFIX          Restrict listing to this literal prefix (default: whole bucket)
  --max-objects NUMBER     Total scan limit, including saved progress (default: 100000)
  --max-requests NUMBER    Total page-call limit, including saved progress (default: 10000)
  --max-seconds NUMBER     Stop after this many seconds in this invocation
  --all                    Remove object limit; listing charges may apply
  --estimate-objects N     Optional estimate to show listing request count before starting
  --storage json|sqlite    Checkpoint storage for NEW scans (default: json; sqlite needs Node 22.13+)
  --state PATH             Checkpoint path (default: unique file under .tenantmeter-state/)
  --resume PATH            Resume an existing checkpoint; retain its bucket and mapping
  --yes                    Skip preview confirmation (required without an interactive terminal)
  --format table|json|csv   Output format (default: table)
  --output PATH            Save output to a NEW file instead of stdout
  --top NUMBER             Customers shown in table (default: 20; exports contain all)
  --input FILE             Local inventory CSV or CSV.gz (header required by default)
  --manifest FILE          Local S3 Inventory manifest.json; requires manifest.checksum
  --inventory-root DIR     Local directory containing manifest file keys
  --columns LIST           Comma-separated columns for a headerless inventory
  --raw-keys               Do not URL-decode inventory keys
  --counters FILE          Compare against CSV with tenant_id,bytes columns
  --before FILE            Earlier complete checkpoint for diff
  --after FILE             Later complete checkpoint for diff
  --help                   Show help
  --version                Show version

Demo uses fake data, needs no credentials, and asks no confirmation.
Progress and preview go to stderr. Reports go to stdout or --output.
Exit codes: 0 complete/equal, 1 error, 2 scan limit, 3 counter differences, 130 interrupted.
No telemetry, account, payload downloads, uploads, or deletes.
`;

export function positive(value: string | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive safe integer.`);
  return Number(value);
}
export function validateConfig(config: Config): Config {
  if (!['s3', 'r2', 'demo', 'inventory'].includes(config.provider) || typeof config.bucket !== 'string' || (!config.bucket && config.provider !== 'inventory') ||
      config.bucket.length > 255 || /[\s/\\\u0000-\u001f\u007f]/u.test(config.bucket) ||
      typeof config.pattern !== 'string' || config.pattern.length > 2048 || /[\u0000-\u001f\u007f]/u.test(config.pattern) ||
      typeof config.prefix !== 'string' || Buffer.byteLength(config.prefix) > 1024 || /[\u0000-\u001f\u007f]/u.test(config.prefix) ||
      typeof config.region !== 'string' || !/^[a-z0-9-]+$/.test(config.region)) throw new Error('Invalid provider, bucket, pattern, prefix, or region.');
  compileTenantPattern(config.pattern);
  if (config.provider === 'r2' && (!/^[a-f0-9]{32}$/i.test(config.accountId ?? '') ||
      !['default', 'eu', 'us', 'fedramp'].includes(config.jurisdiction ?? 'default'))) {
    throw new Error('R2 requires a 32-character hex account ID and jurisdiction default, eu, us, or fedramp.');
  }
  if (config.inventory && (config.provider !== 'inventory' || !Array.isArray(config.inventory.files) || !config.inventory.files.length ||
      config.inventory.files.some(x => typeof x.path !== 'string' || !x.path || !/^[a-f0-9]{64}$/.test(x.sha256)) ||
      typeof config.inventory.encodedKeys !== 'boolean' ||
      (config.inventory.columns !== undefined && (!Array.isArray(config.inventory.columns) || config.inventory.columns.some(x => typeof x !== 'string'))) ||
      (config.inventory.createdAt !== undefined && !Number.isFinite(Date.parse(config.inventory.createdAt))))) throw new Error('Invalid inventory checkpoint configuration.');
  return config;
}
export function options(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    provider: { type: 'string' }, bucket: { type: 'string' }, pattern: { type: 'string' },
    region: { type: 'string' }, 'account-id': { type: 'string' }, jurisdiction: { type: 'string' },
    prefix: { type: 'string' }, 'max-objects': { type: 'string' }, 'estimate-objects': { type: 'string' },
    'max-requests': { type: 'string' }, 'max-seconds': { type: 'string' },
    storage: { type: 'string' }, state: { type: 'string' }, resume: { type: 'string' }, format: { type: 'string' },
    output: { type: 'string' }, top: { type: 'string' }, all: { type: 'boolean' },
    yes: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
    before: { type: 'string' }, after: { type: 'string' },
    input: { type: 'string' }, manifest: { type: 'string' }, 'inventory-root': { type: 'string' },
    columns: { type: 'string' }, 'raw-keys': { type: 'boolean' }, counters: { type: 'string' }
  } });
  if (values.help || values.version || args.length === 0) return { early: values.version ? '0.1.0\n' : help } as const;
  const command = positionals[0];
  if (positionals.length !== 1 || !['demo', 'analyze', 'report', 'inventory', 'compare', 'diff', 'migrate'].includes(command)) throw new Error('Choose analyze, demo, inventory, report, compare, diff, or migrate. Run tenantmeter --help.');
  const allowed: Record<string, Set<string>> = {
    demo: new Set(['storage', 'state', 'resume', 'max-objects', 'max-requests', 'max-seconds', 'all', 'estimate-objects', 'format', 'output', 'top', 'yes']),
    analyze: new Set(['storage', 'provider', 'bucket', 'pattern', 'region', 'account-id', 'jurisdiction', 'prefix', 'state', 'resume', 'max-objects', 'max-requests', 'max-seconds', 'all', 'estimate-objects', 'format', 'output', 'top', 'yes']),
    inventory: new Set(['storage', 'input', 'manifest', 'inventory-root', 'columns', 'raw-keys', 'bucket', 'pattern', 'prefix', 'state', 'resume', 'max-objects', 'max-requests', 'max-seconds', 'all', 'format', 'output', 'top', 'yes']),
    report: new Set(['state', 'format', 'output', 'top']),
    compare: new Set(['state', 'counters', 'format', 'output', 'top']),
    diff: new Set(['before', 'after', 'format', 'output', 'top']),
    migrate: new Set(['state', 'output'])
  };
  for (const key of Object.keys(values)) if (!allowed[command].has(key)) throw new Error(`--${key} is not supported by ${command}.`);
  if (values.storage !== undefined && !['json', 'sqlite'].includes(values.storage)) throw new Error('--storage must be json or sqlite.');
  if (values.resume && values.storage) throw new Error('Resume detects checkpoint storage. Remove --storage.');
  if (command === 'migrate' && (!values.state || !values.output)) throw new Error('Migrate requires --state JSON_CHECKPOINT and --output NEW_SQLITE_FILE.');
  if (values.all && values['max-objects']) throw new Error('Use --all or --max-objects, not both.');
  if (values.resume && values.state) throw new Error('Use --resume or --state, not both.');
  const configKeys = ['provider', 'bucket', 'pattern', 'region', 'account-id', 'jurisdiction', 'prefix'] as const;
  if ((command === 'report' || command === 'compare') && !values.state) throw new Error(`${command} requires --state PATH.`);
  if (command === 'compare' && !values.counters) throw new Error('Compare requires --counters FILE.');
  if (command === 'diff' && (!values.before || !values.after)) throw new Error('Diff requires --before FILE and --after FILE.');
  if (values.resume && configKeys.some(key => values[key] !== undefined)) throw new Error('Resume uses the saved connection and pattern. Remove connection options.');
  if (command === 'demo' && configKeys.some(key => values[key] !== undefined)) throw new Error('Demo uses its own fake bucket and pattern.');
  const inventoryKeys = ['input', 'manifest', 'inventory-root', 'columns', 'raw-keys'] as const;
  if (values.resume && inventoryKeys.some(key => values[key] !== undefined)) throw new Error('Resume uses saved inventory settings. Remove inventory options.');
  if (command === 'inventory' && !values.resume) {
    if (!!values.input === !!values.manifest) throw new Error('Inventory requires exactly one of --input or --manifest.');
    if (values.input && values['inventory-root']) throw new Error('--inventory-root requires --manifest.');
    if (values.manifest && values.columns) throw new Error('Manifest supplies its own columns. Remove --columns.');
  }
  if (positive(values['max-seconds'], '--max-seconds', 0) > 2_147_483) throw new Error('--max-seconds must not exceed 2147483.');
  const format = values.format ?? 'table';
  if (!['table', 'json', 'csv'].includes(format)) throw new Error('--format must be table, json, or csv.');
  const config: Config | undefined = values.resume || command === 'report' || command === 'compare' || command === 'diff' || command === 'migrate' ? undefined : validateConfig({
    provider: (command === 'demo' ? 'demo' : command === 'inventory' ? 'inventory' : values.provider) as Config['provider'],
    bucket: command === 'demo' ? 'demo-bucket' : values.bucket ?? '',
    pattern: command === 'demo' ? 'customers/{tenant_id}/*' : values.pattern ?? '',
    prefix: values.prefix ?? '',
    region: command === 'demo' || command === 'inventory' || values.provider === 'r2' ? 'auto' : values.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(values.provider === 'r2' ? { accountId: values['account-id'] ?? process.env.R2_ACCOUNT_ID, jurisdiction: (values.jurisdiction ?? 'default') as Config['jurisdiction'] } : {})
  });
  if (values.provider === 's3' && (values['account-id'] || values.jurisdiction)) throw new Error('--account-id and --jurisdiction apply only to R2.');
  if (command === 'analyze' && !values.resume && !['s3', 'r2'].includes(values.provider ?? '')) throw new Error('--provider must be s3 or r2.');
  if (values.provider === 'r2' && values.region) throw new Error('R2 uses region auto. Remove --region.');
  return {
    early: undefined, command, config, storage: (values.storage ?? 'json') as 'json' | 'sqlite', resume: values.resume, state: values.state,
    maxObjects: values.all ? Infinity : positive(values['max-objects'], '--max-objects', 100_000),
    maxRequests: positive(values['max-requests'], '--max-requests', 10_000),
    maxSeconds: positive(values['max-seconds'], '--max-seconds', 0),
    estimateObjects: positive(values['estimate-objects'], '--estimate-objects', 0),
    format: format as 'table' | 'json' | 'csv', output: values.output,
    top: positive(values.top, '--top', 20), yes: values.yes ?? command === 'demo',
    counters: values.counters, before: values.before, after: values.after,
    inventoryOptions: { input: values.input, manifest: values.manifest, root: values['inventory-root'], columns: values.columns, rawKeys: values['raw-keys'] }
  };
}
