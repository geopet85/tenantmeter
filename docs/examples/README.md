# Examples

All data is fake.

Prerequisites: [Node.js 22+ and npm setup](../../packages/cli/INSTALL.md), and this source checkout. Run `npm ci` in `packages/cli` first; the initial install needs npm registry access. These files and their offline commands need no cloud credentials, database, or hosted application.

| File | Purpose |
| --- | --- |
| `demo.txt`, `demo.json`, `demo.csv` | 2,505 demo objects; 5,501,000,000 bytes |
| `inventory.csv` | URL-encoded keys with a header; 33 bytes |
| `manifest/` | Headerless gzip inventory, manifest, and matching checksums |
| `counters.csv` | acme counter differs by one byte; 東京 matches |
| `inventory-report.json` | Expected inventory output |
| `inventory-after.csv`, `diff.json` | Changed inventory and expected checkpoint diff; total delta -6 bytes |
| `comparison.json` | Expected comparison output; exit code 3 |
| `schedule.json` | Credential-free scheduled demo config |
| `scenario/` | Known fake quantities, actual offline output, verification result, and cloud test instructions |

Run from `packages/cli`:

```sh
npm run examples:generate
```

This builds the CLI, runs the commands, checks totals, and overwrites these named examples. Report timestamps change on regeneration. No customer data or credentials are used. See [CLI instructions](../../packages/cli/README.md) for runnable inventory, comparison, and scheduling commands.

To run the small inventory and counter comparison yourself, from `packages/cli`:

```sh
npm run build
node dist/tenantmeter.js inventory --input ../../docs/examples/inventory.csv \
  --bucket example-bucket --pattern 'customers/{tenant_id}/*' \
  --state example-inventory.state.json --yes --format json
node dist/tenantmeter.js compare --state example-inventory.state.json \
  --counters ../../docs/examples/counters.csv --format json
```

The inventory has 33 bytes: acme 10, 東京 20, unmatched 3. Comparison exits 3 because acme's counter is 9 bytes. Checkpoint paths must be new; choose another name when rerunning. JSON byte quantities are strings. Sample timestamps do not describe a live bucket.

The [larger scenario](scenario/README.md) plans fake objects, verifies quantities offline, and documents optional AWS upload, actual verification, and cleanup. Cloud steps require an existing disposable bucket, AWS credentials, write/delete permission, and explicit opt-in. No cloud scenario has been run in this workspace.
