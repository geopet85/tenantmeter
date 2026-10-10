import { access, link, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { compileTenantPattern } from '../../../lib/tenant/pattern.ts';
import { options, validateConfig } from './options.ts';
import { loadState, lockState, saveState } from './state.ts';
import { newState } from './model.ts';
import { createSource } from './source.ts';
import { scan, tenantFor } from './scan.ts';
import { render } from './report.ts';
import { prepareInventory } from './inventory.ts';
import { compareCounters, renderComparison } from './compare.ts';

async function ensureNew(path: string) {
  try { await access(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    const probe = `${dirname(path)}/.tenantmeter-${randomUUID()}.tmp`;
    const file = await open(probe, 'wx', 0o600);
    await file.close(); await rm(probe); return;
  } throw error; }
  throw new Error(`File already exists: ${path}. Choose a new path.`);
}
async function exportFile(path: string, content: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    // A hard link publishes atomically and refuses to overwrite an existing report.
    await link(temp, path);
  } finally { await rm(temp, { force: true }); }
}
async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.early !== undefined) { process.stdout.write(opts.early); return; }
  if (opts.command === 'report' || opts.command === 'compare') {
    const path = resolve(opts.state!);
    const state = await loadState(path);
    validateConfig(state.config);
    const comparison = opts.command === 'compare' ? await compareCounters(state, opts.counters!) : undefined;
    const content = comparison ? renderComparison(comparison, opts.format, opts.top) : render(state, opts.format, opts.top);
    if (opts.output) {
      const output = resolve(opts.output);
      if (output === path || output === `${path}.lock`) throw new Error('Report output must differ from checkpoint and lock paths.');
      await exportFile(output, content);
      process.stderr.write(`Report: ${output}\n`);
    } else process.stdout.write(content);
    process.exitCode = comparison ? comparison.different ? 3 : 0 : state.status === 'complete' ? 0 : state.reason === 'interrupted' ? 130 : 2;
    return;
  }
  if (!opts.yes && !process.stdin.isTTY) throw new Error('Non-interactive scans require --yes after reviewing --help and the mapping.');
  const statePath = resolve(opts.resume ?? opts.state ?? `.tenantmeter-state/${Date.now()}-${randomUUID()}.json`);
  const outputPath = opts.output ? resolve(opts.output) : undefined;
  if (outputPath === statePath || outputPath === `${statePath}.lock`) throw new Error('Report output must differ from checkpoint and lock paths.');
  if (outputPath) await ensureNew(outputPath);
  const unlock = await lockState(statePath);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let source;
  let timer: NodeJS.Timeout | undefined;
  try {
    // Read only after acquiring the lock: another process may have advanced this file.
    let state = opts.resume ? await loadState(statePath) : newState(opts.config!);
    if (!opts.resume && opts.command === 'inventory') state = newState(await prepareInventory(state.config, opts.inventoryOptions, controller.signal));
    validateConfig(state.config);
    if (opts.command === 'demo' && state.config.provider !== 'demo') throw new Error('Use analyze to resume a real bucket scan.');
    if (opts.command === 'inventory' && state.config.provider !== 'inventory') throw new Error('Checkpoint is not an inventory scan.');
    if (state.status === 'complete') throw new Error('This scan is already complete. Start a new scan to measure again.');
    if (state.objects >= opts.maxObjects) throw new Error('Saved progress has reached this limit. Increase --max-objects or use --all.');
    if (state.requests >= opts.maxRequests) throw new Error('Saved progress has reached the request limit. Increase --max-requests.');
    if (!opts.resume) { await ensureNew(statePath); await saveState(statePath, state); }
    const log = (text: string) => process.stderr.write(text + '\n');
    log(`Checkpoint: ${statePath}`);
    log(`Scope: ${JSON.stringify(state.config.bucket)}, prefix ${JSON.stringify(state.config.prefix)}. Limit: ${Number.isFinite(opts.maxObjects) ? opts.maxObjects : 'unlimited'} total objects.`);
    const estimated = opts.estimateObjects || (Number.isFinite(opts.maxObjects) ? opts.maxObjects : 0);
    if (state.config.provider === 'inventory') log('Local inventory input; no cloud listing calls. File hashing and resume rereads add disk reads.');
    else if (estimated) {
      const target = Math.min(estimated, opts.maxObjects);
      log(`Planning estimate: ~${Math.ceil(Math.max(0, target - state.objects) / 1000)} further list calls with full pages. Sparse pages, preview retries, and SDK retries can add calls.`);
    } else log('Bucket object count is unknown. No request-count estimate available.');
    if (['s3', 'r2'].includes(state.config.provider)) log('Listing charges apply to your cloud account. No object payloads are read.');
    source = await createSource(state.config, {}, controller.signal);
    timer = opts.maxSeconds ? setTimeout(() => controller.abort('time-limit'), opts.maxSeconds * 1000) : undefined;
    timer?.unref();
    const began = Date.now();
    let lastProgress = 0;
    state = await scan({
      source, state, maxObjects: opts.maxObjects, maxRequests: opts.maxRequests, signal: controller.signal,
      save: next => saveState(statePath, next),
      progress: next => {
        if (Date.now() - lastProgress > 1000 || next.status === 'complete') {
          log(`${next.objects} objects, ${Object.keys(next.tenants).length} customers, ${next.pages} pages; ${Math.round((Date.now() - began) / 1000)}s this run.`);
          lastProgress = Date.now();
        }
      },
      preview: async page => {
        const compiled = compileTenantPattern(state.config.pattern);
        log('Source works. Mapping preview (up to 5 keys; shown locally only):');
        for (const object of page.objects.slice(0, 5)) {
          const { tenant, invalid } = tenantFor(compiled, object.key);
          log(`  ${JSON.stringify(object.key)} -> ${tenant === null ? invalid ? 'UNMATCHED (invalid customer ID)' : 'UNMATCHED' : JSON.stringify(tenant)}`);
        }
        const matched = page.objects.filter(x => tenantFor(compiled, x.key).tenant !== null).length;
        log(`First page: ${matched}/${page.objects.length} objects match. This is a preview, not a representative sample.`);
        if (!opts.yes && page.objects.length) {
          const reader = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = await reader.question('Continue with this mapping? [y/N] ', { signal: controller.signal });
            if (!/^y(es)?$/i.test(answer.trim())) controller.abort();
          } finally { reader.close(); }
        }
      }
    });
    const content = render(state, opts.format, opts.top);
    if (outputPath) { await exportFile(outputPath, content); log(`Report: ${outputPath}`); }
    else process.stdout.write(content);
    if (state.status === 'partial') {
      log(`Partial report (${state.reason}). Resume with --resume and the checkpoint path above. Increase the reached limit.`);
      process.exitCode = state.reason === 'interrupted' ? 130 : 2;
    }
  } finally {
    clearTimeout(timer);
    source?.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await unlock();
  }
}

main().catch(error => {
  let message: string;
  if (error?.$metadata || error?.name === 'CredentialsProviderError') {
    const name = error?.name;
    message = name === 'AccessDenied' || name === 'Forbidden'
      ? 'Access denied. Check bucket listing permissions and the selected credentials.'
      : name === 'NoSuchBucket' ? 'Bucket not found. Check bucket name, region, account, and jurisdiction.'
      : name === 'CredentialsProviderError' ? 'AWS credentials unavailable. Sign in to your AWS profile or configure the SDK credential chain.'
      : 'Cloud request failed. Check credentials, region, jurisdiction, connectivity, and provider status. Resume using the checkpoint printed above.';
  } else message = error instanceof Error ? error.message : 'Unexpected failure.';
  process.stderr.write(`TenantMeter: ${message}\n`);
  process.exitCode = error?.name === 'AbortError' ? 130 : 1;
});
process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  else throw error;
});
