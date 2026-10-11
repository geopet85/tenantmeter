import {spawnSync} from 'node:child_process';

const provider = process.env.TENANTMETER_TEST_PROVIDER;
const required = ['TENANTMETER_TEST_BUCKET', ...(provider === 'r2' ? ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] : [])];
if (process.env.RUN_LIVE !== '1' || process.env.TENANTMETER_ALLOW_TEST_WRITES !== '1' || !['s3', 'r2'].includes(provider) || required.some(key => !process.env[key])) {
  console.error('Live verification requires both write opt-ins, provider s3|r2, a disposable bucket, and provider credentials. A skipped test does not pass release checks.');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/live/provider.test.ts'], {stdio: 'inherit'});
  process.exitCode = result.status ?? 1;
}
