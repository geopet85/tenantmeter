# Disk checkpoints

Use `--storage sqlite` when customer totals are too large for an in-memory map or rewriting the full JSON checkpoint becomes expensive. JSON remains the default. Disk storage changes only local files; cloud scans still list metadata without writing to the bucket.

## Prerequisites

- Node.js **22.13 or newer**, or Node.js 24. Use the latest patch in either LTS line. Follow [installation instructions](INSTALL.md).
- A standard Node build with [node:sqlite](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html). No SQLite CLI, database server, extra npm dependency, or native addon is needed. Node 22 may print an experimental-module warning on stderr.
- A local writable filesystem with enough free space for the checkpoint, rollback journal, reports, and comparison scratch data. Use local files rather than network shares or a directory being synchronized while the scan runs.
- Existing cloud credentials for S3/R2, or local inventory files for offline imports. The demo needs neither.

Run `npm ci` and `npm run build` in `packages/cli` first. Commands below run from that directory. Choose new checkpoint and output paths when repeating examples.

## Try, stop, and resume

```sh
node dist/tenantmeter.js demo --storage sqlite --state demo.sqlite --max-objects 1001 --format json
```

This exits **2** after 1,001 objects. Resume without `--storage`; the CLI detects the file format:

```sh
node dist/tenantmeter.js analyze --resume demo.sqlite --all --yes --format json
node dist/tenantmeter.js report --state demo.sqlite --format csv --output demo-usage.csv
```

The completed demo contains **2,505 objects and 5,501,000,000 bytes**. A SQLite checkpoint is a binary database; use `report` to export JSON/CSV. Its extension does not determine its format.

For S3, add `--storage sqlite` to a new bounded scan:

```sh
node dist/tenantmeter.js analyze --provider s3 --bucket YOUR_BUCKET --region eu-west-1 \
  --prefix 'customers/' --pattern 'customers/{tenant_id}/*' --storage sqlite \
  --state storage.sqlite --max-objects 100000 --max-requests 100 --max-seconds 600 --yes
```

Check the mapping first using the [cloud scan instructions](README.md#limits-progress-and-resume). Listing charges and existing scan limits still apply. `--storage` is accepted for new `demo`, `analyze`, and `inventory` scans; it is rejected on resume because the saved format is authoritative.

## Import and compare inventory

```sh
node dist/tenantmeter.js inventory --input ../../docs/examples/inventory.csv \
  --bucket example-bucket --pattern 'customers/{tenant_id}/*' \
  --storage sqlite --state inventory.sqlite --yes --format json
node dist/tenantmeter.js compare --state inventory.sqlite \
  --counters ../../docs/examples/counters.csv --format json --output comparison.json
```

The inventory contains **33 bytes**. Comparison exits **3**: acme's measured usage is one byte above the sample counter. Disk comparisons stream counter CSV rows into private scratch storage rather than an in-memory customer map. Scratch files are removed after output, errors, and interruption.

## Migrate an existing JSON checkpoint

```sh
node dist/tenantmeter.js migrate --state existing.json --output migrated.sqlite
node dist/tenantmeter.js report --state migrated.sqlite --format json
```

Migration preserves the source JSON file and refuses to replace any destination. It supports partial and complete checkpoints. Resume a partial migration with the usual `analyze --resume migrated.sqlite --yes` or `inventory --resume migrated.sqlite --yes`, increasing any reached limit.

Migration retains the current cursor; earlier JSON cursor history was never stored and cannot be recovered. Migration loads the existing JSON file into memory once. For a dataset that cannot fit as JSON, start a new disk scan. The new database is published only after all rows and metadata commit. An interrupt before publication removes temporary files; publication is the commit boundary. Malformed Unicode customer IDs/cursors are rejected rather than changed during conversion.

## Compare measurements

`diff` accepts two disk checkpoints or a mixture of JSON and disk checkpoints. Both measurements must be complete and have matching source, bucket, prefix, mapping, account, and jurisdiction.

```sh
node dist/tenantmeter.js diff --before previous.sqlite --after current.sqlite --format csv --output changes.csv
node dist/tenantmeter.js diff --before previous.json --after current.sqlite --format json
```

Exit **0** means equal usage; **3** means differences, including unmatched-only changes and added/removed customers with zero bytes. A JSON input still needs memory to load; disk inputs remain on disk. Disk diffs store joined results and sort scratch data through SQLite before streaming output.

## Ordering and exact numbers

Disk reports sort by exact byte totals descending. Equal totals use binary UTF-8 customer-ID order. Disk comparisons use that ID order; disk diffs sort absolute byte deltas descending, then IDs. This can differ from the existing JSON path's ordering for non-ASCII IDs. Totals, statuses, schemas, and exit codes have the same meaning.

Bytes remain canonical decimal strings and use BigInt arithmetic. SQL sorting compares digit lengths and decimal text; it never converts bytes to floating-point or signed 64-bit integers. Counts remain safe JavaScript integers.

## Durability and recovery

Each page transaction updates only its affected customers, aggregate totals, cursor, and cursor history. A failed transaction advances none of them. A limit or failure updates only small metadata. Resume checks the schema, sums stored rows with exact arithmetic, and validates saved cursor history without building a customer map.

Checkpoints use SQLite rollback journals and full synchronization. Reports hold a consistent read transaction until output finishes. A report can delay a concurrent writer; export after the scan stops. Conflicting writes fail rather than bypassing the checkpoint lock.

After a crash, retain the database and any `-journal` file so SQLite can recover the last committed page. If a stale `.lock` remains, confirm that its process has stopped before removing **only that lock**. Do not delete journal files to fix a lock. Reports recover a hot journal under the checkpoint lock before opening their read snapshot.

Copy or back up a checkpoint only after its process closes it. Do not move a live database, edit its SQL tables, or use older CLI builds to resume it. Unsupported schemas and inconsistent totals are rejected. See [SQLite's locking and recovery documentation](https://www.sqlite.org/lockingv3.html).

## Scheduling and measurement

Add `"--storage", "sqlite"` to a scheduled configuration's `args`. The wrapper writes `.state.sqlite` and `.report.json` files. Scheduling, overlap locks, limits, and failure handling otherwise use the [existing instructions](README.md#scheduled-runs).

```sh
npm run bench:storage
npm run bench:storage -- --objects 200000 --storage sqlite --heap-mib 64
```

See [measured results and remaining limits](https://github.com/geopet85/tenantmeter/blob/main/docs/PERFORMANCE.md). Disk mode keeps page-sized tenant maps in JavaScript, while SQLite owns caches and sorting memory. A Node heap limit does not limit total process memory. Opening a checkpoint still reads every stored customer and cursor for validation; comparison/diff need scratch disk space proportional to their results. These commands are sequential, not parallel cloud listings.
