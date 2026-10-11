# Release the CLI

Run source commands from `packages/cli`. Use Node 24, npm registry access, and a clean checkout. JSON runtime support starts at Node 22.0; SQLite starts at 22.13. CI tests those exact versions and 24.0, plus current Node 22/24 on Linux, macOS, and Windows.

## Check the candidate

```sh
npm ci
npm run check
npm run test:runtime
npm run package:check
npm run release:check -- v0.1.0
npm audit --omit=dev
```

Use the version in `package.json` in place of `0.1.0` for later releases. A tag/name/lockfile mismatch fails metadata validation. `--version` comes from the package metadata. Confirm every job for the candidate commit passes in [Actions](https://github.com/geopet85/tenantmeter/actions).

## Verify cloud providers

Use disposable S3 and R2 buckets without object lock or versioning. Each live test uploads 1,005 tiny objects beneath a unique prefix, tests JSON and SQLite scans/resume/export, and deletes the keys it attempted. It can incur listing/storage/request charges. Failed cleanup can leave fixtures. It never creates or deletes buckets.

S3 credentials need `s3:ListBucket`, `s3:GetBucketVersioning`, and `s3:GetBucketObjectLockConfiguration` on the test bucket, plus `s3:PutObject` and `s3:DeleteObject` on its `tenantmeter-cli-test/*` keys. Bucket preflight refuses enabled/suspended versioning and object lock before writing. R2 needs a bucket-scoped S3 token with listing/write/delete access; choose a disposable bucket without retention rules. These permissions are for tests; the installed CLI only needs listing.

Configure credentials locally as described in [setup](../packages/cli/README.md#prerequisites). Do not put secret values in command history or the repository. Then:

```sh
npm run build
RUN_LIVE=1 TENANTMETER_ALLOW_TEST_WRITES=1 TENANTMETER_TEST_PROVIDER=s3 \
  TENANTMETER_TEST_BUCKET=YOUR_S3_TEST_BUCKET AWS_REGION=eu-west-1 npm run test:live:required
RUN_LIVE=1 TENANTMETER_ALLOW_TEST_WRITES=1 TENANTMETER_TEST_PROVIDER=r2 \
  TENANTMETER_TEST_BUCKET=YOUR_R2_TEST_BUCKET R2_JURISDICTION=default npm run test:live:required
```

The required runner fails on missing bucket/provider/opt-ins instead of accepting a skipped test. AWS may resolve credentials through a local profile, SSO session, or role; invalid/missing credentials fail before fixture uploads. Record successful run URLs or local logs with the candidate commit. Do not record secrets or real customer keys.

## Configure accounts once

1. Log in to the intended npm account with `npm login`, then run `npm whoami`.
2. Confirm that account owns the `tenantmeter` user scope or has publishing access to the `tenantmeter` organization. A GitHub username does not establish npm scope ownership. If unavailable, rename the package, regenerate its lockfile, update install examples and the release metadata check before publishing.
3. In [repository settings](https://github.com/geopet85/tenantmeter/settings/security_analysis), enable private vulnerability reporting and subscribe to security notifications. Update `packages/cli/SECURITY.md` once verified. The connected GitHub tools do not expose this administrative write.
4. Create GitHub environment `cloud-tests`. Set variables `S3_TEST_BUCKET`, `AWS_REGION`, `R2_TEST_BUCKET`, `R2_ACCOUNT_ID`, and `R2_JURISDICTION`. Set secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` to credentials limited to those disposable buckets. Refresh expiring credentials before a release.
5. Create GitHub environment `npm`, restrict it to release tags, and configure its protection rules as desired.

## First npm publication

The first package publication needs an authenticated owner; trusted publisher settings belong to an existing npm package. After all candidate checks and both live tests pass, verify private reporting with:

```sh
npm run release:check -- v0.1.0 --remote
npm publish --access public
npm view @tenantmeter/cli@0.1.0 version
```

`--remote` checks the repository's actual private-reporting setting. If your GitHub access requires authentication, set `GITHUB_TOKEN` locally with read access; do not print it. npm may require interactive two-factor authentication. Publication is permanent for users who install that version; only publish the tested candidate.

Once the package exists, add an npm [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for GitHub owner `geopet85`, repository `tenantmeter`, workflow filename `release.yml`, environment `npm`, with direct publishing enabled. The workflow uses Node 24 and npm 11.5.1, meeting npm's trusted publishing requirements. No npm token is stored in the repository.

## Tagged releases

Update package and lockfile versions together, update the changelog, commit, and push the candidate. From the repository root:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The tag must match the package version. `release.yml` reruns the six OS/current-Node jobs, three minimum-runtime jobs, both live provider tests, metadata/private-reporting checks, production audit, and installed-package checks. It publishes only after those jobs succeed. Missing cloud configuration or npm trust fails the release; it does not bypass checks. Reusing an already published version fails at npm.

After publication, verify the registry version and install it in a clean directory. Update install docs and changelog to reflect the published release. Keep pending account/live checks unchecked until they actually pass.
