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

- Snapshot comparison with exact byte/object deltas and scope checks.
- Deterministic wildcard matching, encoded S3 keys, and lock alias protection.
- Faster page aggregation, compact checkpoints, and fewer inventory hash passes.
- Reproducible performance benchmark and realistic synthetic AWS scenario.
- Expanded prerequisites, credentials, commands, and expected outcomes.

- File/row inventory cursors skip parsing completed files on resume, with legacy checkpoint support.
- Node installation and troubleshooting guide for macOS, Windows, Linux, and WSL.

- Streamed scan report exports with backpressure, bounded write batches, and interrupt cleanup.
- Report memory benchmark with byte-identical JSON/CSV checks.

Source is public. Live provider verification and npm publication remain pending.
