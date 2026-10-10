# Performance

## Run the benchmark

Prerequisites: Node.js 22+, npm, and the source checkout. From `packages/cli`:

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

## Changes

- Sum page deltas with BigInt; convert totals to strings once per touched tenant.
- Copy only changed tenant totals; share unchanged values without mutating prior checkpoints.
- Compile the tenant pattern once per scan.
- Use deterministic wildcard matching rather than a regex with exponential backtracking.
- Avoid hashing a freshly prepared inventory twice before parsing it. Resumed files still get a preflight hash check.
- Resolve inventory column indices once per file.
- Save compact JSON checkpoints to reduce written bytes.

## Limits

Tenant totals remain in memory. Each page still copies the tenant map and serializes the complete checkpoint; high tenant counts make later pages more expensive. A billion-object scan or millions of distinct tenants needs a different storage design.

Inventory files are streamed, but resume rehashes the files and rereads earlier rows to reach its offset. Gzip cannot seek directly to an arbitrary row. JSON/CSV output and sorting also require memory proportional to the tenant count.

Use a literal `--prefix` to reduce cloud scope. Use inventory exports for large AWS buckets. Use object, request, and runtime limits for an initial trial. More concurrent LIST calls are not enabled: continuation-token ordering and page-level checkpoints remain sequential.
