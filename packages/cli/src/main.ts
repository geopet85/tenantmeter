import { access, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { compileTenantPattern } from '../../../lib/tenant/pattern.ts';
import { options, validateConfig } from './options.ts';
import { loadState, lockState, saveState } from './state.ts';
import { newState } from './model.ts';
import { createSource } from './source.ts';
import { scan, tenantFor } from './scan.ts';
import { diffStates, renderDiff } from './diff.ts';
import { renderChunks } from './report.ts';
import { exportFile, writeOutput, type Content } from './output.ts';
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
class OutputInterruptedError extends Error {
  constructor(readonly forceExit: boolean) { super('Report output interrupted.'); this.name = 'AbortError'; }
}
async function emit(content: Content, path?: string) {
  // Output has its own signal: an interrupted scan still needs to print its
  // partial report, while a later interrupt must stop a stalled report write.
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    if (path) await exportFile(path, content, controller.signal);
    else await writeOutput(content, process.stdout, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new OutputInterruptedError(!path);
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.early !== undefined) { await emit(opts.early); return; }
  if (opts.command === 'diff') {
    const paths = [resolve(opts.before!), resolve(opts.after!)];
    const [before, after] = await Promise.all(paths.map(loadState));
    validateConfig(before.config); validateConfig(after.config);
    const result = diffStates(before, after);
    const content = renderDiff(result, opts.format, opts.top);
    if (opts.output) {
      const output = resolve(opts.output);
      if (paths.some(path => output === path || output === `${path}.lock`)) throw new Error('Diff output must differ from its checkpoint and lock paths.');
      await emit(content, output); process.stderr.write(`Report: ${output}\n`);
    } else await emit(content);
    process.exitCode = result.hasDifferences ? 3 : 0;
    return;
  }
  if (opts.command === 'report' || opts.command === 'compare') {
    const path = resolve(opts.state!);
    const state = await loadState(path);
    validateConfig(state.config);
    const comparison = opts.command === 'compare' ? await compareCounters(state, opts.counters!) : undefined;
    const content = comparison ? renderComparison(comparison, opts.format, opts.top) : renderChunks(state, opts.format, opts.top);
    if (opts.output) {
      const output = resolve(opts.output);
      if (output === path || output === `${path}.lock`) throw new Error('Report output must differ from checkpoint and lock paths.');
      await emit(content, output);
      process.stderr.write(`Report: ${output}\n`);
    } else await emit(content);
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
  const timer = opts.maxSeconds ? setTimeout(() => controller.abort('time-limit'), opts.maxSeconds * 1000) : undefined;
  timer?.unref();
  let scanBegan = false;
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

    const began = Date.now();
    let lastProgress = 0;
    scanBegan = true;
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
    clearTimeout(timer);
    const content = renderChunks(state, opts.format, opts.top);
    if (outputPath) { await emit(content, outputPath); log(`Report: ${outputPath}`); }
    else await emit(content);
    if (state.status === 'partial') {
      log(`Partial report (${state.reason}). Resume with --resume and the checkpoint path above. Increase the reached limit.`);
      process.exitCode = state.reason === 'interrupted' ? 130 : 2;
    }
  } catch (error) {
    if (!scanBegan && controller.signal.aborted) {
      process.exitCode = controller.signal.reason === 'time-limit' ? 2 : 130;
      process.stderr.write('Stopped during input preparation. No report was generated. Start a fresh scan or resume the checkpoint if one was printed.\n');
    } else throw error;
  } finally {
    clearTimeout(timer);
    source?.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await unlock();
  }
}

main().catch(error => {
  // Node cannot cancel a pending stdio pipe write by destroying stdout. Exit
  // only here, after main's finally has closed sources and released locks.
  if (error instanceof OutputInterruptedError && error.forceExit) process.exit(130);
  if (error?.code === 'EPIPE') { process.exitCode = 0; return; }
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
// Output writes are awaited; their errors are handled by main after cleanup.
process.stdout.on('error', () => {});
