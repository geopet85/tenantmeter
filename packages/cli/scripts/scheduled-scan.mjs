import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scheduled-scan.mjs /absolute/path/schedule.json');
  const configPath = resolve(process.argv[2]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!Array.isArray(config.args) || !['analyze', 'inventory', 'demo'].includes(config.args[0]) ||
      config.args.some(x => typeof x !== 'string' || /^--(state|resume|output|format|help|version)(=|$)/.test(x)) ||
      typeof config.outputDir !== 'string' || !config.outputDir) throw new Error('Set args to a scan command and outputDir to a directory. Do not set state, resume, output, format, help, or version.');
  const directory = resolve(dirname(configPath), config.outputDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, '.scheduled-scan.lock');
  const handle = await open(lock, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Scheduled scan is locked. Check for a running process before removing .scheduled-scan.lock.');
    throw error;
  });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const name = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
    const bin = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/tenantmeter.js');
    const child = spawn(process.execPath, [bin, ...config.args, '--yes', '--format', 'json', '--state', resolve(directory, `${name}.state.json`), '--output', resolve(directory, `${name}.report.json`)], { stdio: 'inherit', cwd: dirname(configPath) });
    const stop = signal => child.kill(signal);
    const int = () => stop('SIGINT');
    const term = () => stop('SIGTERM');
    process.on('SIGINT', int); process.on('SIGTERM', term);
    try {
      process.exitCode = await new Promise((resolveCode, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolveCode(code ?? (signal === 'SIGINT' ? 130 : 1)));
      });
    } finally { process.off('SIGINT', int); process.off('SIGTERM', term); }
  } finally { await handle.close(); await rm(lock, { force: true }); }
}
main().catch(error => { process.stderr.write(`TenantMeter schedule: ${error.message}\n`); process.exitCode = 1; });
