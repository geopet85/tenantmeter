# Changelog

## 0.1.0 — unreleased

- Local S3/R2 metadata scans with customer-pattern mapping.
- Synthetic demo requiring no credentials.
- Mapping preview, scan cap, progress, retries, and interruption handling.
- Atomic checkpoints with locking and resumable totals.
- Table, CSV, and JSON reports; offline checkpoint export.
- Exact large byte totals and unmatched usage reporting.
- Streaming local CSV/gzip inventory, verified manifests, and unchanged-file checks on resume.
- Exact comparison against customer counters with explicit difference exit codes.
- Request/runtime limits, output preflight, and strict per-command options.
- Scheduled-run wrapper with overlap locking and retained failure codes.
- Generated fixtures, tarball installation checks, and opt-in live tests.
- Linux/macOS/Windows CI configuration for Node 22 and 24.

Live provider verification and public publication are still pending.
