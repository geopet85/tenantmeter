# Technical checklist

Scope: the free local CLI. Hosted accounts, billing submission, alerts, and hard quota enforcement are outside this release.

## Done

- [x] Local AWS credentials and bucket-scoped R2 credentials.
- [x] Read-only metadata listing with retries and pagination.
- [x] Tenant patterns, prefix scope, unmatched counts, and exact byte totals.
- [x] Mapping preview, object limits, interruption, and resumable checkpoints.
- [x] CSV, JSON, and terminal reports; offline checkpoint export.
- [x] Demo data, MIT license, contribution and security instructions.
- [x] Source export without the hosted application or contact rows.

## Completed implementation

- [x] Read resumed checkpoints after acquiring their lock.
- [x] Reject unsupported options rather than silently ignoring them.
- [x] Check output paths before starting a scan.
- [x] Add request and runtime limits.
- [x] Read local S3 Inventory CSV and gzip files as streams.
- [x] Read local inventory manifests and verify file checksums.
- [x] Reject changed inventory files on resume.
- [x] Compare reports with an existing customer-counter export.
- [x] Provide tested commands and fixtures for inventory and comparison.
- [x] Provide scheduled local-run examples with overlap protection and explicit failure handling.
- [x] Automate tarball content checks and installed-package smoke tests.
- [x] Automate example generation and document schema/exit codes.
- [x] Add opt-in live provider tests with deterministic fixtures.
- [x] Configure CI for Linux, macOS, and Windows with Node 22 and 24.
- [x] Add tests for the new commands, limits, errors, and file handling.

## External checks

- [ ] Run the live S3 test with a disposable bucket and credentials.
- [ ] Run the live R2 test with a disposable bucket and credentials.
- [ ] Run the CI matrix on GitHub.
- [ ] Run the dependency audit with registry access.
- [ ] Set an owned npm scope, repository URLs, and private security-reporting contact.
- [ ] Publish the reviewed source and npm package.

Local verification: typecheck, build, unit/CLI tests, generated examples, source export, and installed tarball checks on macOS with Node 22. External checks above remain open; CI configuration and skipped live tests are not passing results.
