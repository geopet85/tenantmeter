import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = dirname(fileURLToPath(import.meta.url));
const root = resolve(cli, '../..');
const argument = process.argv[2];
if (!argument || process.argv.length !== 3) {
  throw new Error('Usage: npm run source:export -- /absolute/path/to/new-directory');
}
const destination = resolve(argument);
const distance = relative(root, destination);
if (!isAbsolute(argument) || (!distance.startsWith(`..${sep}`) && distance !== '..' && !isAbsolute(distance))) {
  throw new Error('Choose an absolute destination outside this project to avoid recursive copies.');
}
await mkdir(destination, { recursive: false }); // Refuse to overwrite an existing directory.
const files = [
  '.nvmrc', '.gitignore', '.github/workflows/cli.yml', '.github/ISSUE_TEMPLATE/cli-feedback.yml',
  ...['src', 'tests', 'scripts', 'TODO.md', 'SOURCE_README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'build.mjs', 'export-source.mjs',
    'README.md', 'INSTALL.md', 'SCALING.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].map(path => `packages/cli/${path}`),
  'lib/tenant/pattern.ts', 'lib/scans/aggregate.ts', 'lib/providers/types.ts',
  'tests/pattern.test.ts', 'tests/aggregate.test.ts',
  'docs/CLI_NEXT_STEPS.md', 'docs/CLI_LAUNCH_GUIDE.md', 'docs/PERFORMANCE.md', 'docs/SCALING.md',
  ...['README.md', 'demo.txt', 'demo.json', 'demo.csv', 'inventory.csv', 'counters.csv', 'inventory-report.json', 'inventory-after.csv', 'diff.json', 'comparison.json', 'schedule.json', 'manifest', 'scenario'].map(path => `docs/examples/${path}`)
];
for (const path of files) {
  const target = resolve(destination, path);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(root, path), target, {
    recursive: true,
    filter: source => {
      const parts = relative(root, source).split(sep);
      if (parts.some(part => ['node_modules', 'dist', '.tenantmeter-state', '.env', '.env.local'].includes(part) || part.endsWith('.tgz'))) return false;
      if (parts.slice(0, 3).join('/') === 'docs/examples/scenario' && parts.length > 3) {
        return parts.length === 4 && ['README.md', 'data.jsonl', 'expected.json', 'inventory.csv', 'plan.json', 'offline-actual.json', 'offline-outcome.json'].includes(parts[3]);
      }
      return true;
    }
  });
}
await mkdir(resolve(destination, 'docs/outreach'), { recursive: true });
// Copy only the spreadsheet schemas. Never export filled prospect/contact rows.
for (const file of ['prospects.csv', 'experiments.csv', 'do-not-contact.csv']) {
  const text = await readFile(resolve(root, 'docs/outreach', file), 'utf8');
  await writeFile(resolve(destination, 'docs/outreach', file), text.split('\n')[0] + '\n');
}
await cp(resolve(cli, 'LICENSE'), resolve(destination, 'LICENSE'));
await cp(resolve(cli, 'SOURCE_README.md'), resolve(destination, 'README.md'));
process.stdout.write(`CLI source exported to ${destination}\nReview it before publishing.\n`);
