# TenantMeter CLI

Local storage usage reports per customer for AWS S3 and Cloudflare R2. Free, MIT licensed, with no account or telemetry.

Cloud scans list object keys and sizes. They do not download payloads, upload objects, delete objects, or change billing counters. Local inventory imports need no cloud access.

## Prerequisites

- **Node.js 22 or newer and npm.** Check with `node --version` and `npm --version`. Download Node from [nodejs.org](https://nodejs.org/en/download) or use your version manager.
- **Source checkout.** Git is needed only to clone the repository. A downloaded source archive works too. `npm ci` needs access to the npm registry on the first install.
- **AWS scans:** an existing S3 bucket, its region, and credentials with `s3:ListBucket` permission. Use an AWS profile/SSO session, environment credentials, or an IAM role. AWS CLI is optional unless you use it to configure or sign in to your profile.
- **R2 scans:** an existing bucket, your Cloudflare account ID, and bucket-scoped S3 Access Key ID and Secret Access Key with listing permission. A Cloudflare bearer token will not work.
- **Inventory imports:** downloaded CSV or CSV.gz files. An S3 Inventory manifest import also needs its checksum and every listed data file.
- **Customer mapping:** a key pattern such as `customers/{tenant_id}/*`. Use `--prefix customers/` when that is the intended scan scope.

No database, Docker, Python, Rust, or hosted service is required. Commands below use a POSIX shell; on Windows, use the same CLI arguments and set credentials through PowerShell environment variables or your credential manager.

## Build and try

```sh
git clone https://github.com/geopet85/tenantmeter.git
cd tenantmeter/packages/cli
npm ci
npm run check
node dist/tenantmeter.js demo
```

`check` typechecks, runs offline tests, and builds the command. The demo needs no credentials. It reports **2,505 objects and 5,501,000,000 bytes**, including five unmatched objects. Checkpoints are saved under `.tenantmeter-state/`.

The npm package is not published. Run `node dist/tenantmeter.js` from `packages/cli`, or [install a locally built tarball](packages/cli/README.md#install-from-this-checkout).

## First cloud scan

Set up credentials using the [AWS](packages/cli/README.md#aws-s3) or [R2](packages/cli/README.md#cloudflare-r2) instructions. Replace the bucket, region, prefix, and mapping below with your values:

```sh
node dist/tenantmeter.js analyze --provider s3 --bucket YOUR_BUCKET \
  --region eu-west-1 --prefix 'customers/' --pattern 'customers/{tenant_id}/*' \
  --max-objects 1000 --max-requests 2 --max-seconds 60 --state trial-state.json
```

The first page shows a mapping preview and asks for confirmation. Add `--yes` for unattended runs after checking the mapping. Listing may incur provider charges.

Exit **2** means a limit stopped the scan and the report is partial. It is expected for a bucket larger than this trial. Resume the saved checkpoint with a higher total limit:

```sh
node dist/tenantmeter.js analyze --resume trial-state.json --max-objects 10000 --yes
node dist/tenantmeter.js report --state trial-state.json --format json --output trial-report.json
```

Use a new state file for a new measurement. Report files must be new, and their parent directory must exist. Read the [limits and exit codes](packages/cli/README.md#limits-progress-and-resume) before using reports in automation. A scan is not an atomic snapshot or an invoice.

## Offline inventory example

From `packages/cli`:

```sh
node dist/tenantmeter.js inventory --input ../../docs/examples/inventory.csv \
  --bucket example-bucket --pattern 'customers/{tenant_id}/*' \
  --state inventory-state.json --yes
node dist/tenantmeter.js compare --state inventory-state.json \
  --counters ../../docs/examples/counters.csv --format json
```

The inventory contains 33 bytes. Comparison exits **3** because acme's measured usage is one byte above its example counter. It does not change the counter.

- [Complete setup, inventory, comparison, diff, and scheduling commands](packages/cli/README.md)
- [Fake-data cloud scenario: plan, upload, verify, and clean up](docs/examples/scenario/README.md)
- [Sample reports and expected totals](docs/examples/README.md)
- [Technical work done and remaining](packages/cli/TODO.md)
- [Release checks](docs/CLI_NEXT_STEPS.md)
- [Contributing](packages/cli/CONTRIBUTING.md) and [security](packages/cli/SECURITY.md)
- [Promotion and prospecting](docs/CLI_LAUNCH_GUIDE.md)
- [MIT license](LICENSE)

The source is public at [geopet85/tenantmeter](https://github.com/geopet85/tenantmeter). Live S3/R2 tests still need credentials; mocked SDK tests do not establish live provider compatibility.
