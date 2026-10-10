# TenantMeter CLI

Report storage usage per customer in an existing AWS S3 or Cloudflare R2 bucket. Runs locally. No account, telemetry, database, or hosted service required.

Cloud scans only call `ListObjectsV2`. Inventory imports and counter comparisons read local files. It reads keys and sizes, never object payloads, and never uploads or deletes objects. Listing requests can incur provider charges.

## Install from this checkout

Requires Node.js 22 or newer and npm. Install Node from [nodejs.org](https://nodejs.org/en/download) or your existing version manager.

```sh
cd packages/cli
npm ci
npm run build
node dist/tenantmeter.js demo
```

To install the command from the built package:

```sh
npm pack
npm install --global ./tenantmeter-cli-0.1.0.tgz
tenantmeter --help
tenantmeter demo
```

The provisional package name is `@tenantmeter/cli`; npm ownership and availability have not been verified. Nothing has been published. After publishing under an owned scope, installation becomes `npm install --global @YOUR_SCOPE/cli`.

## Try without credentials

```sh
tenantmeter demo
tenantmeter demo --format json --output demo.json
tenantmeter demo --format csv --output demo.csv
```

Each invocation creates a separate local checkpoint. Output files must not already exist. The demo contains 2,505 fake objects:

| Customer | Bytes | Objects |
| --- | ---: | ---: |
| northwind | 3,000,000,000 | 750 |
| acme | 2,500,000,000 | 1,250 |
| 東京 | 500,000 | 500 |
| unmatched | 500,000 | 5 |

Total: **5,501,000,000 bytes**, including unmatched objects. Demo results are synthetic, not customer evidence.

## AWS S3

Use the [AWS SDK default credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html). Existing profiles, SSO sessions, environment credentials, and configured roles are supported by the SDK. The CLI has no credential flags and does not store credentials.

For an existing SSO profile, authenticate with your usual AWS CLI flow, then select the profile:

```sh
aws sso login --profile YOUR_PROFILE
AWS_PROFILE=YOUR_PROFILE tenantmeter analyze \
  --provider s3 \
  --region eu-west-1 \
  --bucket YOUR_BUCKET \
  --pattern 'customers/{tenant_id}/*' \
  --max-objects 10000
```

Use the bucket's actual region. The fallback is `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`.

Minimum bucket policy permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "s3:ListBucket",
    "Resource": "arn:aws:s3:::YOUR_BUCKET"
  }]
}
```

Role assumption or SSO may separately need permission to obtain credentials. No `s3:GetObject` permission is needed. If your IAM policy restricts allowed prefixes, supply the corresponding `--prefix`.

## Cloudflare R2

Create a bucket-scoped Object Read token following [Cloudflare's instructions](https://developers.cloudflare.com/r2/api/tokens/). That token may permit object downloads, but TenantMeter only uses listing. Supply its S3 Access Key ID and Secret Access Key, not a general Cloudflare bearer token.

Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` using your shell or secret manager. Avoid putting real secrets in command history or committed files. Optional temporary credentials can also use `R2_SESSION_TOKEN`.

```sh
tenantmeter analyze \
  --provider r2 \
  --bucket YOUR_BUCKET \
  --pattern 'customers/{tenant_id}/*' \
  --max-objects 10000
```

The account ID can alternatively be supplied with `--account-id`. For a jurisdictional bucket, use `--jurisdiction eu`, `us`, or `fedramp`. Default is the global endpoint. R2 region is always `auto`.

## Patterns and scan scope

Exactly one `{tenant_id}` token is required. It captures characters within one path segment. `*` matches any characters, including `/`. All other pattern characters are literal. Matching is case-sensitive and covers the whole key.

```text
customers/{tenant_id}/*
prod/tenants/{tenant_id}/files/*
{tenant_id}/*
```

The pattern maps keys after listing. It does not limit provider requests. Use a literal prefix to reduce the scan:

```sh
tenantmeter analyze --provider s3 --bucket YOUR_BUCKET \
  --pattern 'customers/{tenant_id}/*' --prefix 'customers/' --yes
```

Unmatched totals describe only the scanned scope. A prefix-scoped report does not account for the rest of the bucket. Customer IDs containing control characters or exceeding 512 UTF-8 bytes count as unmatched and are reported separately.

The first listing request tests access and supplies a five-key mapping preview. There is no separate `HeadBucket` request. The first page is not a random sample. Interactive runs ask for confirmation; `--yes` skips confirmation. Non-interactive scans require `--yes`. Preview keys are printed only to local stderr, not stored in the checkpoint.

## Limits, progress, and resume

Default limits: **100,000 objects and 10,000 logical page calls total**, including objects already saved in a resumed scan. Reaching the limit produces a partial report and exits with code 2. For a smaller first trial:

```sh
tenantmeter analyze --provider s3 --bucket YOUR_BUCKET \
  --pattern 'customers/{tenant_id}/*' \
  --max-objects 1000 --state trial-state.json --yes
```

Increase the total cap or explicitly remove it:

```sh
tenantmeter analyze --resume trial-state.json --max-objects 10000 --yes
tenantmeter analyze --resume trial-state.json --all --yes
```

`--all` removes only the object limit. Use `--max-requests N` to change the page-call cap. SDK retries are additional HTTP requests; this is not a spending cap. `--max-seconds N` limits the scan phase of this invocation, including preview confirmation. Initial file hashing, configuration, final report writes, and cleanup are outside that timer.

`--all` can cause many requests. Optional `--estimate-objects NUMBER` prints an approximate request count based on 1,000 objects per page. This is not bucket discovery or a spending cap: short pages and SDK retries can increase requests. Cloud costs are charged to your provider account. `listingCalls` counts logical SDK calls, not internal HTTP retries.

Press Ctrl-C to stop. A successful page's aggregates and its next cursor are saved together using a temporary file and atomic rename. Failed or interrupted pages do not advance the checkpoint. A resumed scan retains its bucket, region, prefix, and mapping; those options cannot be changed. Start a fresh scan when changing mappings or measuring again after completion.

Checkpoint files default to `.tenantmeter-state/`. They contain bucket/configuration metadata, tenant IDs, aggregated usage, and a continuation token. They contain no credentials or raw object list. Files are created with mode `0600`; directory mode `0700` is requested for newly created directories. These modes are subject to operating-system support. Treat checkpoints and reports as private customer metadata.

A `.lock` file prevents concurrent writers to the same checkpoint. Different checkpoint files do not prevent two scans of the same bucket. If a process is killed without cleanup, inspect the PID in the lock file; remove only that `.lock` file after confirming its process is no longer running. Do not edit the checkpoint totals or cursor.

## Reports and automation

```sh
tenantmeter analyze --provider s3 --bucket YOUR_BUCKET \
  --pattern 'customers/{tenant_id}/*' --yes --format json --output usage.json

tenantmeter report --state trial-state.json --format csv --output usage.csv
tenantmeter report --state trial-state.json --format table --top 50
```

`report` reads a checkpoint locally without network calls. It can export complete or partial scans. JSON byte totals are decimal strings to preserve large integers. CSV includes `tenant`, `unmatched`, and `total` row types: filter to `tenant` rows when importing customer quantities. IDs beginning with spreadsheet formula characters, including after whitespace, are prefixed with an apostrophe in CSV; JSON preserves exact IDs. Spreadsheet applications can round large numbers on import; use a string-aware JSON reader when exact large totals matter.

Table output shows the 20 largest customers by default. CSV and JSON contain all customers. Progress, previews, and errors go to stderr; stdout contains only the selected report. `--output` publishes a new report atomically without overwriting an existing file. Its parent directory must already exist.

| Exit code | Meaning |
| --- | --- |
| 0 | Complete report, equal counters, or help |
| 1 | Invalid input, provider failure, or file error |
| 2 | Partial report / object, request, or runtime limit reached |
| 3 | Counter differences |
| 130 | Interrupted scan or exported interrupted checkpoint |

Check the exit code and JSON `status` before using totals. No report is generated on provider failure; use `report --state PATH` to inspect saved progress.

## Local inventory

Run these examples from `packages/cli`, before installing globally. Each checkpoint path must be new:

```sh
node dist/tenantmeter.js inventory \
  --input ../../docs/examples/inventory.csv --bucket example-bucket \
  --pattern 'customers/{tenant_id}/*' --state inventory-state.json --yes --format json

node dist/tenantmeter.js inventory \
  --manifest ../../docs/examples/manifest/manifest.json \
  --inventory-root ../../docs/examples/manifest \
  --pattern 'customers/{tenant_id}/*' --state manifest-state.json --yes
```

Both fixtures contain 33 bytes: acme 10, 東京 20, unmatched 3. Files are streamed, including `.csv.gz`. Headers must include `Bucket,Key,Size`. For headerless CSV, supply `--columns 'Bucket,Key,Size'`; use the complete ordered schema for your file. Keys are URL-decoded by default. Use `--raw-keys` for exports whose keys are already decoded.

For an AWS inventory, download the manifest, its sibling `manifest.checksum`, and the listed CSV.gz files yourself. Preserve each manifest file key under `--inventory-root`. The CLI verifies manifest MD5, compressed-file sizes and MD5 checksums, then records SHA-256 hashes in the checkpoint. Resume rejects changed files. MD5 checks consistency with the downloaded manifest; it does not authenticate the source.

Only CSV manifests with at least one file are supported. Parquet and ORC are unsupported. Versioned exports must contain `IsLatest` and `IsDeleteMarker`; old versions and delete markers are excluded. Rows from other buckets are excluded. Use one complete export with nonoverlapping files; duplicate object rows will be counted twice.

An import's timestamp is `inventoryCreatedAt` when supplied by a manifest. It describes the supplied export, not current bucket contents. A standalone CSV has no snapshot timestamp. Inventory resume rereads earlier rows to reach its saved offset. Files are hashed before processing and checked again while reading; this adds disk reads but avoids loading the object list into memory. No cloud credentials or cloud calls are needed.

## Compare existing counters

Export counters as UTF-8 CSV with exactly these columns:

```csv
tenant_id,bytes
acme,9
東京,20
```

Run against the completed inventory checkpoint above:

```sh
node dist/tenantmeter.js compare --state inventory-state.json \
  --counters ../../docs/examples/counters.csv --format json
```

This fixture exits with code 3: acme is one byte above its counter. Delta is scanned bytes minus counter bytes. JSON byte values and deltas are decimal strings. Missing customers count as differences, including zero-byte customers. Duplicate customer IDs, invalid sizes, and partial scans fail. Unmatched usage is reported separately. Comparison never changes counters. Match bucket scope, versions, and measurement dates before acting on differences.

## Scheduled runs

Copy `../../docs/examples/schedule.json` to a private directory and edit it:

```json
{
  "outputDir": "./reports",
  "args": [
    "analyze", "--provider", "s3", "--bucket", "YOUR_BUCKET",
    "--region", "eu-west-1", "--pattern", "customers/{tenant_id}/*",
    "--all", "--max-requests", "10000", "--max-seconds", "3600"
  ]
}
```

Run with absolute paths to Node, the wrapper, and config:

```sh
/absolute/path/to/node /absolute/path/to/packages/cli/scripts/scheduled-scan.mjs /absolute/path/to/schedule.json
```

For an installed package, locate the wrapper at `$(npm root -g)/@tenantmeter/cli/scripts/scheduled-scan.mjs` on POSIX shells. Paths inside the config are relative to its directory. Arguments are passed directly to the CLI without a shell. The wrapper supplies `--yes`, unique state/report paths, and JSON output. It refuses `--state`, `--resume`, `--output`, and `--format` in the config. An output-directory lock prevents overlapping scheduled runs. Interrupted or failed runs retain their checkpoint; the next scheduled invocation starts a new measurement. Resume an old checkpoint explicitly when needed.

Cron example (replace every absolute path):

```cron
0 2 * * * /absolute/path/to/node /absolute/path/to/scheduled-scan.mjs /absolute/path/to/schedule.json >> /absolute/path/to/scan.log 2>&1
```

For Windows Task Scheduler, set Program to the full `node.exe` path and Arguments to the wrapper path and config path, quoting each path. Enable “Do not start a new instance.” Run under an account with the required credentials. For cron, use an unattended AWS profile/role or a credential manager; an expired interactive SSO session will fail.

The wrapper returns the CLI exit code. Treat 1, 2, and 130 as failed measurements and alert through your existing scheduler or monitoring. Cron alone only records the exit code in the command's result; configure log/error monitoring yourself. Check report `status` before importing quantities. Apply a retention policy to private reports and logs. Remove a stale `.scheduled-scan.lock` only after checking its PID and confirming the process stopped.

## Verify and regenerate examples

```sh
npm run check
npm run package:check
npm run examples:generate
```

`package:check` builds, checks tarball contents, installs the tarball into a fresh temporary directory, and checks demo totals. Add `-- --offline` to use cached npm dependencies. `examples:generate` overwrites only the named fake fixtures and reports under `docs/examples`; generated timestamps change on each run. Technical work and external checks are tracked in [TODO.md](TODO.md).

JSON reports use `schemaVersion: 1`. Checkpoints use `version: 1` and are resume files, not the report API. Report fields include source/scope, timestamps, status/reason, total/matched/unmatched usage, and tenant rows. `pageCalls` counts logical page requests including failed attempts; `listingCalls` is zero for inventory. Neither counts SDK HTTP retries. Treat added report fields as backward-compatible; reject unknown schema versions in your importer. Counter comparison has its own `schemaVersion: 1` with `rows`, `different`, and scan timestamps. See the checked sample JSON files in `docs/examples`.

## Measurement limits

- Counts current listed object sizes. Excludes old versions, delete markers, incomplete uploads, provider minimum charges, and request/egress costs.
- Scanning a changing bucket is not an atomic snapshot. Resume later can widen that measurement window.
- Daily snapshots miss files created and deleted between scans. They are not time-weighted storage or daily peaks.
- Reports are not provider bills, invoice-ready measurements, or hard quota enforcement.
- AWS general-purpose buckets and R2 are the intended targets. Directory buckets, requester-pays buckets, access-point ARNs, and arbitrary S3-compatible services are not supported targets for this release.
- Aggregates live in memory, and checkpoints are rewritten after each page. Very large tenant populations or billion-object scans need a different ingestion/storage design.
- No live S3/R2 smoke test has been run in this workspace. The SDK boundary is tested with mock HTTP responses, including retries and pagination. Complete the live release checks before advertising tested provider compatibility.

For large AWS buckets, import a downloaded [S3 Inventory](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-inventory.html) or consider [Storage Lens](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage_lens.html).

## Contribute

From `packages/cli`:

```sh
npm ci
npm run check
```

Tests cover pagination, resumable totals, interruption, failed checkpoints, large integers, unmatched keys, special customer IDs, output escaping, SDK retries, R2 endpoint selection, CLI exit codes, and exports. They use fake credentials and mocked responses; they do not access your buckets.

The shared tenant parser is bundled from `../../lib/tenant/pattern.ts`; package users do not need the web app or the source checkout. CLI changes should include a short reproduction or a focused test when correctness changes. Do not paste real bucket paths, reports, credentials, or checkpoints into public issues.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). In the full checkout, [../../docs/CLI_NEXT_STEPS.md](../../docs/CLI_NEXT_STEPS.md) tracks release work and [../../docs/CLI_LAUNCH_GUIDE.md](../../docs/CLI_LAUNCH_GUIDE.md) covers promotion and prospecting.

## License

MIT for the CLI package and the shared tenant-pattern code bundled into it. See [LICENSE](LICENSE). This does not relicense the rest of the hosted application.
