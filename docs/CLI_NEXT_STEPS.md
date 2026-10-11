# Release steps

The technical checklist is [packages/cli/TODO.md](../packages/cli/TODO.md). Setup and commands are in [packages/cli/README.md](../packages/cli/README.md).

## Local checks

Prerequisites: [Node.js 22+ and npm setup](../packages/cli/INSTALL.md), a source checkout, and npm registry access for the first install and dependency audit. Git is optional for a downloaded archive. Offline tests, demo, packaging checks, examples, and benchmarks need no cloud credentials. Run from `packages/cli`:

```sh
npm ci
npm run check
npm run package:check
npm run examples:generate
npm run bench
npm run bench:storage
npm audit --omit=dev
```

`check` typechecks, tests, and builds. `package:check` checks allowed tarball files, installs locked production dependencies and the tarball into a fresh temporary directory, then verifies demo totals. `examples:generate` runs the documented fake inventory/manifest/comparison/diff commands and checks their totals.

`bench` measures local aggregation only. `bench:storage` compares durable JSON/SQLite page commits and validates matching exports; SQLite needs Node 22.13 or newer. See [disk commands and crash recovery](SCALING.md). See [PERFORMANCE.md](PERFORMANCE.md) for workload details. The [scenario helper](examples/scenario/README.md) checks known quantities offline and provides separate cloud upload, verification, and cleanup steps.

The GitHub matrix covers Linux, macOS, and Windows with current Node 22 and 24, plus exact Node 22.0 (JSON runtime smoke), 22.13, and 24.0. All nine jobs passed for code commit `58b3033` in [run 38168362522](https://github.com/geopet85/tenantmeter/actions/runs/38168362522). Local full checks and a fresh source export each passed 111 tests with one expected skip; installed-package checks passed on Node 22.13. Full and production-only dependency audits reported zero vulnerabilities on 2026-10-11. Live provider tests have not run here because AWS/R2 credentials and disposable buckets are unavailable; npm ownership/publication and private-reporting setup remain pending.

## Live provider tests

Use an existing disposable bucket. The opt-in test creates 1,005 small objects under a unique `tenantmeter-cli-test/UUID/` prefix, verifies known totals, pagination, resume, prefix filtering, unmatched objects, and offline export, then deletes the attempted fixture keys. It does not create or delete buckets. Failed cleanup may leave fixtures; inspect that test prefix. Use a bucket without versioning/object lock so fixture deletion is effective. Listing, writes, deletes, and retained versions may incur provider charges.

The test needs listing, upload, and deletion permissions. The distributed CLI still only lists metadata. For AWS, use an existing profile/SSO session, environment credentials, or an IAM role; AWS CLI is only needed if your authentication flow uses it. For R2, provide the account ID and bucket-scoped S3 credentials. Configure the credentials described in the [CLI README](../packages/cli/README.md), then build and run:

```sh
npm run build
RUN_LIVE=1 TENANTMETER_ALLOW_TEST_WRITES=1 \
  TENANTMETER_TEST_PROVIDER=s3 TENANTMETER_TEST_BUCKET=YOUR_DISPOSABLE_BUCKET \
  AWS_REGION=eu-west-1 npm run test:live
```

For R2, set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`, then:

```sh
RUN_LIVE=1 TENANTMETER_ALLOW_TEST_WRITES=1 \
  TENANTMETER_TEST_PROVIDER=r2 TENANTMETER_TEST_BUCKET=YOUR_DISPOSABLE_BUCKET \
  R2_JURISDICTION=default npm run test:live
```

Set R2 jurisdiction to the bucket's jurisdiction. In PowerShell, assign these values using `$env:NAME='value'` before `npm run test:live`. Without both opt-in flags, the test is skipped. A skipped test is not provider verification.

Also check your intended AWS profile/SSO flow, denied listing permissions, and Ctrl-C on a real scan. Record provider, region/jurisdiction, OS, Node/CLI version, date, expected totals, observed totals, and failures. Keep credentials and real customer keys out of the record.

## Source export

From `packages/cli`, choose a new absolute directory outside this project:

```sh
npm run source:export -- /tmp/tenantmeter-public-source
cd /tmp/tenantmeter-public-source/packages/cli
npm ci
npm run check
npm run package:check
```

The export includes source, tests, scripts, helpers, fixtures, license, CI, and docs. It excludes the hosted application, dependencies, builds, and filled outreach rows. Review the destination before publishing.

## Publication

Follow [release setup and tagged publication](RELEASING.md) for the tested commands, npm ownership, private reporting, GitHub environments, and automated release gates.

1. Verify ownership of the intended npm scope. The source repository is [geopet85/tenantmeter](https://github.com/geopet85/tenantmeter).
2. Set the actual package name; repository/issue/homepage URLs already point to this repository. Verify those links in `packages/cli/package.json`. Run `npm install --package-lock-only` afterward. If renaming, update global-install examples too.
3. Configure GitHub private vulnerability reporting or a monitored security contact. Update `SECURITY.md`.
4. Run local checks, audit, live tests, and the GitHub matrix. Review the checklist and generated tarball.
5. Review the source export if publishing a separate copy. Its MIT license covers the CLI and bundled shared helpers. Keep credentials, reports, checkpoints, and filled outreach files out of public commits.
6. Run `npm pack`, inspect the tarball, and install it on a second machine.
7. Authenticate to npm and intentionally run `npm publish --access public` from `packages/cli`.
8. Update install instructions with the verified npm package name and release version. Keep repository and issue links current.

Source is already public on GitHub. The npm package is not published. Tagged publication is automated after account setup and live verification; missing configuration fails the release.

## After release

Follow [CLI_LAUNCH_GUIDE.md](CLI_LAUNCH_GUIDE.md). Prioritize failed installs and incorrect totals. Record voluntary successful scans and repeated use; stars and downloads do not prove demand. Validate payment for recurring reports before adding hosted accounts, managed scheduling, or billing submission.
