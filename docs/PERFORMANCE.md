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
