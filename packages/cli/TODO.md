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

## Review and efficiency work

- [x] Replace backtracking regex matching and fix final-newline matching.
- [x] Reject wildcards sharing the tenant path segment.
- [x] Request XML-safe S3 keys and decode once.
- [x] Prevent checkpoint lock bypass through directory aliases and linked files.
- [x] Preserve replacement locks and scheduler termination codes.
- [x] Enforce runtime limits during inventory preparation.
- [x] Remove duplicate fresh-inventory preflight hashing and repeated column searches.
- [x] Aggregate page deltas and copy only changed totals.
- [x] Write compact checkpoints and add a reproducible aggregation benchmark.
- [x] Detect continuation-token cycles within a run.
- [x] Compare completed checkpoints with JSON/CSV/table output.
- [x] Generate realistic synthetic data and independent expected/actual outcome files.
- [x] Add bounded AWS scenario upload and exact-key cleanup helpers with tests.
- [x] Expand prerequisites and commands across root, package, scenario, and contributor docs.
- [x] Add public repository, issue, and homepage links to package metadata.
- [x] Add OS-specific Node installation, source ZIP setup, and common error fixes; include the guide in tarballs and source exports.
- [x] Add inventory file/row cursors to skip parsing completed files on resume; keep legacy cursor support and file-change checks.

## External checks

- [ ] Run the live S3 scenario with a disposable unversioned bucket and credentials.
- [ ] Run the live R2 test with a disposable bucket and credentials.
- [x] Verify the initial GitHub matrix on all six OS/Node combinations (commit 19b5eb4).
- [x] Run full and production dependency audits: zero vulnerabilities on 2026-10-10.
- [x] Verify feature-batch CI on all six OS/Node combinations (commit 211154c, run 38055538771).
- [ ] Confirm npm scope ownership and configure a private security-reporting contact.
- [x] Publish the reviewed source at github.com/geopet85/tenantmeter.
- [ ] Publish the npm package after release checks.

## Later scaling work

- [ ] Replace full-map copies and full checkpoint rewrites when measured tenant counts require it.
- [ ] Stream report output for workloads whose tenant population exceeds available memory.

These scaling items need a storage/checkpoint format design and migration tests; they are not claimed complete. Current bounds and measured improvements are in ../../docs/PERFORMANCE.md. Live cloud checks remain open because this environment has no AWS/R2 credentials.
