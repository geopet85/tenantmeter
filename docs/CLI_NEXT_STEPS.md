# Release steps

The technical checklist is [packages/cli/TODO.md](../packages/cli/TODO.md). Setup and commands are in [packages/cli/README.md](../packages/cli/README.md).

## Local checks

Run with Node.js 22+ from `packages/cli`:

```sh
npm ci
npm run check
npm run package:check
npm run examples:generate
npm audit --omit=dev
```

`check` typechecks, tests, and builds. `package:check` checks allowed tarball files, installs locked production dependencies and the tarball into a fresh temporary directory, then verifies demo totals. `examples:generate` runs the documented fake inventory/manifest/comparison commands and checks their totals.

The configured GitHub matrix covers Linux, macOS, and Windows with Node 22 and 24. Run it before release; local macOS/Node 22 checks do not establish that the other jobs pass. Dependency auditing in this workspace failed because registry DNS was unavailable. Live provider tests have not run here.

## Live provider tests

Use an existing disposable bucket. The opt-in test creates 1,005 small objects under a unique `tenantmeter-cli-test/UUID/` prefix, verifies known totals, pagination, resume, prefix filtering, unmatched objects, and offline export, then deletes the attempted fixture keys. It does not create or delete buckets. Failed cleanup may leave fixtures; inspect that test prefix. Use a bucket without versioning/object lock so fixture deletion is effective. Listing, writes, deletes, and retained versions may incur provider charges.

The test needs listing, upload, and deletion permissions. The distributed CLI still only lists metadata. Configure the same credentials described in the README, then build and run:

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

1. Choose an owned npm scope and public repository.
2. Set the actual package name, `repository`, `bugs`, and `homepage` in `packages/cli/package.json`. Run `npm install --package-lock-only` afterward. If renaming, update global-install examples too.
3. Configure GitHub private vulnerability reporting or a monitored security contact. Update `SECURITY.md`.
4. Run local checks, audit, live tests, and the GitHub matrix. Review the checklist and generated tarball.
5. Publish only the reviewed source export. Its MIT license covers the CLI and bundled shared parser; it does not relicense the hosted application.
6. Run `npm pack`, inspect the tarball, and install it on a second machine.
7. Authenticate to npm and intentionally run `npm publish --access public` from `packages/cli`.
8. Update the launch guide with real repository and issue links.

Publication is not automated. This workspace has not published the source or package.

## After release

Follow [CLI_LAUNCH_GUIDE.md](CLI_LAUNCH_GUIDE.md). Prioritize failed installs and incorrect totals. Record voluntary successful scans and repeated use; stars and downloads do not prove demand. Validate payment for recurring reports before adding hosted accounts, scheduling, or billing submission.
