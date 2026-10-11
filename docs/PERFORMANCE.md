# Performance

## Run the benchmark

Prerequisites: [Node.js 22+ and npm setup](../packages/cli/INSTALL.md) and the source checkout. From `packages/cli`:

```sh
npm ci
npm run bench
npm run bench -- --objects 40000 --tenants 40000 --repeats 3
```

The default uses 20,000 objects, 20,000 tenants, 1,000 objects per page, and three runs. It checks that both aggregation strategies produce identical totals. It compares the original full-state deep copy with the current page-delta aggregation and copy of touched tenant totals. Both use the same matcher.

It excludes cloud calls, CSV parsing, checkpoint writes, fsync, and report sorting. It measures aggregation, not end-to-end throughput. Results depend on the machine and workload. Keep the JSON output with Node version and platform when comparing changes.

## Recorded local result

macOS x64, Node 22.23.3; 20,000 objects and distinct tenants; three runs:

| Measurement | Original strategy | Current strategy |
| --- | ---: | ---: |
| Median aggregation time | 906.94 ms | 296.65 ms |
| Checkpoint serialization size | 1,298,326 bytes, indented | 758,214 bytes, compact |

The aggregation benchmark was 3.06 times faster. Compact checkpoint JSON was about 42% smaller for this fixture. This does not imply the same improvement for an actual bucket scan.

## Report export benchmark

From `packages/cli`, after `npm ci`:

```sh
npm run bench:reports
npm run bench:reports -- --tenants 200000
```

Each format and strategy runs in a separate process. The baseline builds the tenant row array and complete output string. The current strategy renders rows into 64 KiB output batches. Equal output byte counts and SHA-256 hashes are required. Peak RSS includes Node, synthetic tenant totals, sorting, rendering, UTF-8 encoding, and hashing; it excludes checkpoint loading, disk writes, fsync, and cloud calls. This is one run per combination, not a throughput guarantee.

Recorded on macOS x64, Node 22.23.3, with 100,000 customers:

| Format | Baseline peak RSS, KiB | Stream peak RSS, KiB | Baseline time, ms | Stream time, ms |
| --- | ---: | ---: | ---: | ---: |
| JSON | 143,600 | 116,040 | 242.28 | 355.74 |
| CSV | 183,520 | 115,560 | 478.83 | 465.71 |

JSON used less peak memory but took longer to render. CSV used less peak memory with similar timing. Both strategies produced identical bytes. Actual disk or pipe performance depends on the destination.

## Durable storage benchmark

```sh
npm run bench:storage
npm run bench:storage -- --objects 200000 --storage sqlite --heap-mib 64
```

The default compares JSON and SQLite in separate processes, with 20,000 distinct customers and 1,000 objects per page. It includes aggregation, durable page commits, and a streamed JSON export hash. Export timestamps are normalized; byte counts and hashes must match. It excludes cloud requests and inventory parsing. Final database size excludes transient journals and is not a disk-write count.

Recorded on macOS x64, Node 22.23.3:

| Storage | Commit time, ms | Total including export, ms | Peak RSS, KiB | Final checkpoint bytes |
| --- | ---: | ---: | ---: | ---: |
| JSON | 715.56 | 791.08 | 103,856 | 989,326 |
| SQLite | 291.93 | 438.25 | 86,016 | 1,847,296 |

These are individual local runs. SQLite reduced rewrite work and memory in this fixture but used more checkpoint disk space. Filesystem and workload differences affect timings.

A separate SQLite-only run processed **200,000 distinct customers** with `--heap-mib 64`: 3,054.65 ms for page commits, 4,553.78 ms including export, peak RSS 133,828 KiB, and a 14,671,872-byte final checkpoint. It exported 18,963,045 JSON bytes. The 64 MiB limit applies only to the V8 heap; native SQLite caches, buffers, and runtime memory are additional. This is a local synthetic workload, not a live S3/R2 measurement.

## Million-customer disk workflow

From `packages/cli`, run this separate workflow benchmark with Node 22.13+ after `npm ci`:

```sh
node --import tsx scripts/storage-workflow-benchmark.mjs --tenants 1000000 --heap-mib 64 > workflow.json
```

The parent launches a child with a 64 MiB V8 old-space limit and polls its private temporary directory every 50 ms. The child scans one object per customer in pages of at most 1,000, closes halfway, validates and resumes, then opens the complete checkpoint for reporting. It writes and syncs full JSON and CSV reports, compares a million-row counter CSV, builds a second changed snapshot, and exports a sorted diff. Each comparison and diff contains every customer. It verifies the full CSV outputs, statuses, row counts and ordering against the synthetic input without loading them into memory. Output SHA-256 hashes use fixed report timestamps.

Stages run sequentially in the same child. RSS is its lifetime high-water mark; per-stage RSS values are cumulative. Heap measurements are sampled and can miss brief peaks. The heap flag does not cap SQLite or other native allocations. Disk samples measure named files and include journals when observed; they deduplicate hard links during atomic publication. They **exclude unlinked SQLite sorting spill files**, can miss brief peaks, and do not measure total disk I/O. Scratch database sizes are also measured directly before cleanup. All fixtures, scratch files and outputs are removed afterward; the JSON measurements remain on stdout.

Recorded on **2026-10-11**, macOS x64, Node **22.23.3**, with **1,000,000 distinct customers** in each snapshot and a **64 MiB V8 old-space limit**. This is one run on a development machine with warm filesystem caches, not a provider throughput or worst-case storage estimate. [Raw measurements, output sizes and SHA-256 hashes](benchmarks/storage-workflow-million-20261011.json) are retained.

These measurements precede the Node 22.13 iterator-lifetime compatibility fix. That fix retains each prepared statement for its iterator lifetime; it does not change SQL queries, ordering, or output. Node 22.23.3 completed the measured workload before the fix.

| Stage | Time, seconds |
| --- | ---: |
| First 500,000 customers and durable commits | 12.94 |
| Close/reopen validation at 500,000 customers | 1.79 |
| Remaining 500,000 customers and durable commits | 11.39 |
| Full million-customer report open/validation | 4.31 |
| JSON report export, including file sync | 11.93 |
| CSV report export, including file sync | 16.62 |
| Counter comparison scratch build | 51.26 |
| Comparison CSV export | 10.09 |
| Changed million-customer snapshot scan | 25.52 |
| Changed checkpoint open/validation | 4.30 |
| Snapshot diff scratch build | 50.05 |
| Diff sorting and CSV export | 35.35 |
| Whole workflow, including fixture generation and CSV verification | 256.37 |

Peak child RSS was **145,932 KiB (142.51 MiB)**. The sampled JavaScript heap peak was **30.61 MiB**. The full workflow completed without lifting the old-space limit. Its two checkpoints contain 1,000,000 objects each; independently calculated totals were 32,356,304,280 and 32,405,303,335 bytes. Verification found the expected 100,000 counter differences, 1,000,000 snapshot differences and 48,999,055-byte total delta.

| Disk measurement | Bytes |
| --- | ---: |
| Original checkpoint | 67,878,912 |
| Changed checkpoint | 67,149,824 |
| Counter CSV input | 23,822,264 |
| Report JSON export | 94,823,121 |
| Report CSV export | 116,822,536 |
| Comparison CSV export | 48,244,556 |
| Diff CSV export | 71,554,450 |
| Comparison scratch database before cleanup | 147,320,832 |
| Diff scratch database before cleanup | 174,366,720 |
| Sampled peak allocated bytes for named scratch files | 185,577,472 |
| Sampled peak logical bytes across all named benchmark files | 664,743,396 |

Scratch cleanup passed. The named-file peak is a measured lower bound, **not** a free-space recommendation: SQLite can unlink sorter spill files while still using their disk blocks. The result confirms this workload fits the tested JavaScript heap limit; resume validation, scratch storage, and run time still scale with customer count. Scratch construction was the largest measured cost. A possible future optimization is importing tenants into scratch in customer-ID order instead of report-usage order, avoiding unnecessary index traversal and random primary-key inserts. That optimization was not applied to these measurements.

## Changes

- Sum page deltas with BigInt; convert totals to strings once per touched tenant.
- Copy only changed tenant totals; share unchanged values without mutating prior checkpoints.
- Compile the tenant pattern once per scan.
- Use deterministic wildcard matching rather than a regex with exponential backtracking.
- Avoid hashing a freshly prepared inventory twice before parsing it. Resumed files still get a preflight hash check.
- Resolve inventory column indices once per file.
- Save compact JSON checkpoints to reduce written bytes.
- Render scan JSON/CSV incrementally and batch output into at most 64 KiB per write. Slow destinations apply backpressure.
- Format only displayed terminal rows rather than copying all tenant totals into report rows.

## Limits

Default JSON storage keeps tenant totals in memory, copies the map per page, and serializes the complete checkpoint. Opt-in [SQLite storage](SCALING.md) keeps totals and cursor history on disk and commits only touched tenants plus metadata per page. Reports use an exact-decimal index; comparisons/diffs use private disk scratch storage and SQLite sorting. SQLite page caches are configured at 4 MiB per connection and temporary sorting uses file-backed storage; this is not a total process-memory cap.

Opening a disk checkpoint still validates every customer and cursor. JSON-to-SQLite migration loads the source JSON once. Disk mode removes the full-map/checkpoint rewrite requirement, but scan time, validation time, free disk space, and provider listing limits still grow with the dataset.

Inventory files are streamed. Resume rehashes every file, skips CSV parsing for completed files, and rereads earlier rows only in the active file. Legacy numeric cursors still reread all earlier rows once; the next saved page uses a file/row cursor. Gzip cannot seek directly to an arbitrary row. JSON-mode CSV/JSON scan exports avoid complete row arrays and output strings, but the tenant map and sorted customer IDs remain proportional to the tenant count. Checkpoint loading still parses the full file into memory. JSON-only counter comparison and snapshot diff still build their result rows and complete output strings; disk paths stream from scratch databases.

Use a literal `--prefix` to reduce cloud scope. Use inventory exports for large AWS buckets. Use object, request, and runtime limits for an initial trial. More concurrent LIST calls are not enabled: continuation-token ordering and page-level checkpoints remain sequential.
