import { constants } from 'node:fs';
import { access, lstat, open, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { csvCell } from './report.ts';
import { validateConfig, version } from './options.ts';
import { protectOutput } from './checkpoint.ts';
import type { Config } from './model.ts';

export type DoctorInput = {
  storage: 'json' | 'sqlite';
  state?: string;
  output?: string;
  config: {
    provider?: string;
    bucket?: string;
    pattern?: string;
    region?: string;
    accountId?: string;
    jurisdiction?: string;
    prefix?: string;
  };
};
type Check = {name: string; status: 'pass' | 'fail' | 'info'; detail: string};

function nodeAtLeast(major: number, minor = 0) {
  const [currentMajor, currentMinor] = process.versions.node.split('.').map(Number);
  return currentMajor > major || (currentMajor === major && currentMinor >= minor);
}

async function sqliteCheck(required: boolean): Promise<Check> {
  let available = false;
  if (nodeAtLeast(22, 13)) {
    try {
      const {DatabaseSync} = await import('node:sqlite');
      const db = new DatabaseSync(':memory:');
      try { db.prepare('SELECT 1').get(); available = true; }
      finally { db.close(); }
    } catch { /* Availability is reported without exposing local module errors. */ }
  }
  return available
    ? {name: 'SQLite', status: 'pass', detail: 'Available for disk checkpoints.'}
    : {name: 'SQLite', status: required ? 'fail' : 'info', detail: 'Unavailable; disk checkpoints need Node.js 22.13 or newer with node:sqlite.'};
}

function configCheck(raw: DoctorInput['config']): Check {
  if (Object.values(raw).every(value => value === undefined)) {
    return {name: 'Configuration', status: 'info', detail: 'No provider settings supplied; pass scan flags to validate them.'};
  }
  if (raw.provider !== 's3' && raw.provider !== 'r2') {
    return {name: 'Configuration', status: 'fail', detail: 'Provide --provider s3 or r2 with --bucket and --pattern.'};
  }
  if (raw.provider === 's3' && (raw.accountId || raw.jurisdiction)) {
    return {name: 'Configuration', status: 'fail', detail: 'R2 account and jurisdiction flags do not apply to S3.'};
  }
  if (raw.provider === 'r2' && raw.region) {
    return {name: 'Configuration', status: 'fail', detail: 'R2 uses region auto; remove --region.'};
  }
  const config: Config = {
    provider: raw.provider,
    bucket: raw.bucket ?? '',
    pattern: raw.pattern ?? '',
    prefix: raw.prefix ?? '',
    region: raw.provider === 'r2' ? 'auto' : raw.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(raw.provider === 'r2' ? {accountId: raw.accountId ?? process.env.R2_ACCOUNT_ID,
      jurisdiction: (raw.jurisdiction ?? 'default') as Config['jurisdiction']} : {})
  };
  try {
    validateConfig(config);
    return {name: 'Configuration', status: 'pass', detail: 'Provider, bucket, mapping, and scope flags are valid.'};
  } catch (error) {
    // Validation messages describe syntax only; flag values and credentials
    // never appear in diagnostic output.
    const detail = error instanceof Error ? error.message : 'Invalid scan configuration.';
    return {name: 'Configuration', status: 'fail', detail};
  }
}

async function pathCheck(name: 'Checkpoint path' | 'Report path', path: string, explicit: boolean): Promise<Check> {
  const target = resolve(path);
  if (explicit) {
    try {
      await lstat(target);
      return {name, status: 'fail', detail: 'Target already exists; choose a new file.'};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {name, status: 'fail', detail: 'Cannot inspect the proposed file.'};
      }
    }
  }
  let directory = dirname(target);
  for (;;) {
    try {
      const entry = await stat(directory);
      if (!entry.isDirectory()) return {name, status: 'fail', detail: 'A parent path is not a directory.'};
      await access(directory, constants.W_OK | constants.X_OK);
      const probe = join(directory, `.tenantmeter-doctor-${randomUUID()}.tmp`);
      const file = await open(probe, 'wx', 0o600);
      try { await file.close(); }
      finally { await rm(probe, {force: true}); }
      return {name, status: 'pass', detail: 'A parent directory accepted a temporary write probe.'};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {name, status: 'fail', detail: 'Cannot write through the proposed parent directory.'};
      }
      if (name === 'Report path') {
        return {name, status: 'fail', detail: 'The report parent directory must already exist.'};
      }
      // A dangling symlink is not a directory the scan can create through.
      try {
        await lstat(directory);
        return {name, status: 'fail', detail: 'A parent path is not a usable directory.'};
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') {
          return {name, status: 'fail', detail: 'Cannot inspect the proposed parent directory.'};
        }
      }
      const next = dirname(directory);
      if (next === directory) return {name, status: 'fail', detail: 'No writable parent directory found.'};
      directory = next;
    }
  }
}

export async function doctor(input: DoctorInput) {
  const node: Check = nodeAtLeast(22)
    ? {name: 'Node.js', status: 'pass', detail: `Node.js ${process.versions.node} meets the 22+ requirement.`}
    : {name: 'Node.js', status: 'fail', detail: `Node.js ${process.versions.node} is too old; install 22 or newer.`};
  const checks: Check[] = [node, await sqliteCheck(input.storage === 'sqlite'), configCheck(input.config)];
  const state = input.state ?? join(process.cwd(), '.tenantmeter-state', input.storage === 'sqlite' ? 'new-checkpoint.sqlite' : 'new-checkpoint.json');
  checks.push(await pathCheck('Checkpoint path', state, input.state !== undefined));
  if (input.output) {
    let overlap = false;
    if (input.state) {
      try { await protectOutput(input.output, [input.state]); }
      catch { overlap = true; }
    }
    checks.push(overlap
      ? {name: 'Report path', status: 'fail', detail: 'Report path conflicts with the checkpoint or cannot be safely resolved.'}
      : await pathCheck('Report path', input.output, true));
  } else checks.push({name: 'Report path', status: 'info', detail: 'No report file requested; output will use stdout.'});
  return {schemaVersion: 1, version, ok: checks.every(check => check.status !== 'fail'), checks};
}

export function renderDoctor(result: Awaited<ReturnType<typeof doctor>>, format: 'table' | 'json' | 'csv') {
  if (format === 'json') return JSON.stringify(result, null, 2) + '\n';
  if (format === 'csv') {
    return [['check', 'status', 'detail'], ...result.checks.map(check => [check.name, check.status, check.detail])]
      .map(row => row.map(csvCell).join(',')).join('\n') + '\n';
  }
  return [`TenantMeter doctor: ${result.ok ? 'READY' : 'NEEDS ATTENTION'}`,
    ...result.checks.map(check => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`),
    'No cloud requests were made.'].join('\n') + '\n';
}
