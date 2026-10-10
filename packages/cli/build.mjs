import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/tenantmeter.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' }
});
await chmod('dist/tenantmeter.js', 0o755);
