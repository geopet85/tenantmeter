import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const files = ['tests', '../../tests'].flatMap(dir => readdirSync(dir).filter(x => x.endsWith('.test.ts')).map(x => resolve(dir, x)));
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
