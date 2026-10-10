# Synthetic storage scenario

This models a shared S3 bucket with six customers. Customers store receipts, images and backups. Traffic is uneven. Some objects have zero bytes. Two customer names use Unicode. System audit objects sit outside the customer pattern.

The default dataset contains 1,203 objects and 17,301,632 bytes (16.5 MiB). It crosses the 1,000-object listing boundary. Payloads contain only repeated `x` bytes; the names and counts are synthetic.

## Prerequisites

- [Node.js 22 or newer and npm](../../../packages/cli/INSTALL.md); follow the OS-specific installation and version checks.
- The source repository. This helper is not included in the published CLI package.
- Run the commands below from `packages/cli`.
- For AWS: an existing general-purpose S3 bucket in the chosen region. Use a bucket that has **never enabled versioning**. Enabled and suspended versioning are rejected.
- For AWS: credentials available through the AWS default credential chain. `AWS_PROFILE` can select an existing local profile. Do not save credentials in a scenario file.
- For AWS: the permissions below. Bucket encryption policies can require additional KMS permissions. The helper does not create buckets, configure encryption, or change lifecycle rules.

```sh
npm ci
npm run build
```

## Files

| File | Purpose |
| --- | --- |
| `data.jsonl` | One planned object per line: key, size, intended tenant. |
| `expected.json` | Expected totals calculated during data generation, independently of CLI matching and listing. |
| `plan.json` | Bucket, region, unique prefix, seed, count and checksums. |
| `inventory.csv` | URL-encoded keys for running the same dataset offline. |
| `offline-actual.json` | Report produced by the CLI from the inventory. |
| `offline-outcome.json` | Comparison of the offline report with expected totals. |
| `aws-actual.json` | Report produced by the CLI from live S3 listing. Created by AWS verification. |
| `aws-outcome.json` | Comparison of the live report with expected totals. Created by AWS verification. |
| `upload.jsonl` | Attempted and confirmed uploads. Created before AWS writes. Needed for cleanup after failures. |
| `cleanup.json` | Successful cleanup record. |

The checked-in files use a fake bucket. Their offline outcome passed. They do not claim a live AWS test. Create a new plan with a random prefix for every AWS run; do not upload the checked-in example.

## Create a plan and test offline

Choose a new directory. The helper refuses to overwrite an existing directory.

```sh
node scripts/scenario.mjs plan \
  --directory /tmp/tenantmeter-scenario \
  --bucket YOUR_BUCKET \
  --region eu-central-1

node scripts/scenario.mjs verify \
  --directory /tmp/tenantmeter-scenario \
  --offline
```

Replace `YOUR_BUCKET` and the region with your existing bucket and its region. Offline verification does not contact AWS or need credentials. Windows users can replace `/tmp/tenantmeter-scenario` with a new local path such as `C:\Temp\tenantmeter-scenario`.

Optional plan arguments: `--seed 42` and `--count 1203`. Count must be between 1 and 10,000. A seed controls tenant distribution and sizes. Each plan still gets a new random prefix.

Read `plan.json`, `data.jsonl` and `expected.json` before uploading. All planned keys start with `tenantmeter-scenario/<random UUID>/`. Each object is at most 65,536 bytes.

## AWS permissions

Replace `YOUR_BUCKET` and `SCENARIO_UUID` with the bucket and UUID shown in `plan.json`. Apply this policy through your normal AWS access setup. List permission is limited to the scenario prefix. The bucket versioning check needs its own statement because it has no prefix parameter.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetBucketVersioning",
      "Resource": "arn:aws:s3:::YOUR_BUCKET"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::YOUR_BUCKET",
      "Condition": {
        "StringLike": {
          "s3:prefix": "tenantmeter-scenario/SCENARIO_UUID/*"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/tenantmeter-scenario/SCENARIO_UUID/*"
    }
  ]
}
```

The CLI verification needs only the `s3:ListBucket` statement. The helper needs the other statements to prepare and remove synthetic data. Neither reads object payloads.

## Upload, verify, remove

```sh
# Optional: select a configured local AWS profile.
export AWS_PROFILE=your-test-profile

node scripts/scenario.mjs upload \
  --directory /tmp/tenantmeter-scenario \
  --allow-writes

node scripts/scenario.mjs verify \
  --directory /tmp/tenantmeter-scenario

node scripts/scenario.mjs cleanup \
  --directory /tmp/tenantmeter-scenario \
  --allow-writes
```

PowerShell profile selection: `$env:AWS_PROFILE = 'your-test-profile'`.

Upload uses eight workers by default. `--concurrency 4` reduces this; the allowed range is 1–32. It checks that the prefix is empty before writing, uses conditional writes to avoid replacing an existing key, and records each attempt before sending it. It stops starting new uploads after an error and waits for in-flight workers.

Cleanup deletes only exact keys recorded as attempted uploads and present in the original plan. Known conditional-write rejections are recorded as `not_created` and excluded. Ambiguous timeouts remain eligible because AWS may have accepted the request. Keep the randomly generated prefix exclusive to this test until cleanup completes. It never deletes a bucket or discovers unrelated keys for deletion. Keep the plan and ledger until cleanup succeeds. Cleanup can be rerun. An upload cannot be rerun with the same ledger; clean it up, then create a new plan.

The helper locks upload and cleanup operations per directory. If a process is killed, `operation.lock` can remain. Check the PID in that file and confirm the process has stopped before removing the lock and running cleanup. Do not upload and verify simultaneously.

Each verification refuses to overwrite its checkpoint or report. To repeat verification, make a separate copy of the plan directory containing only `plan.json`, `data.jsonl`, `expected.json` and `inventory.csv`; keep the original upload ledger for cleanup.

If upload or verification fails, run cleanup anyway. A timeout can occur after AWS accepted an upload. If cleanup fails, retain all files and rerun it after fixing credentials or permissions.

## Expected outcome

For seed 42 and count 1,203:

| Customer | Objects | Bytes |
| --- | ---: | ---: |
| acme | 304 | 4,154,752 |
| northwind | 317 | 4,895,744 |
| contoso | 124 | 2,005,760 |
| studio-42 | 157 | 2,988,544 |
| café | 127 | 1,495,808 |
| 東京 | 135 | 1,455,872 |
| Unmatched system objects | 39 | 305,152 |
| Total | 1,203 | 17,301,632 |

A passing outcome has `"passed": true` and an empty `failures` list. Verification checks every tenant's bytes and object count, overall totals, unmatched totals, duplicate tenant rows, and scan completion. It exits with code 1 on a mismatch or command failure.

## Requests and storage

A successful default run, excluding SDK retries:

- Upload: one versioning check, one prefix-emptiness listing, and 1,203 PUT requests.
- Verification: two LIST requests for 1,203 objects. No GET requests for payloads.
- Cleanup: one versioning check and two multi-object delete requests.
- Stored payloads before cleanup: 17,301,632 bytes. Local manifests add roughly a few hundred KiB.

AWS request charges and temporary storage charges apply. KMS encryption can add KMS requests. The helper does not calculate a bill. Remove the objects promptly with cleanup and retain the reports as the test result.
