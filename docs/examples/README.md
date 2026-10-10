# Examples

All data is fake.

| File | Purpose |
| --- | --- |
| `demo.txt`, `demo.json`, `demo.csv` | 2,505 demo objects; 5,501,000,000 bytes |
| `inventory.csv` | URL-encoded keys with a header; 33 bytes |
| `manifest/` | Headerless gzip inventory, manifest, and matching checksums |
| `counters.csv` | acme counter differs by one byte; 東京 matches |
| `inventory-report.json` | Expected inventory output |
| `comparison.json` | Expected comparison output; exit code 3 |
| `schedule.json` | Credential-free scheduled demo config |

Run from `packages/cli`:

```sh
npm run examples:generate
```

This builds the CLI, runs the commands, checks totals, and overwrites these named examples. Report timestamps change on regeneration. No customer data or credentials are used. See [CLI instructions](../../packages/cli/README.md) for runnable inventory, comparison, and scheduling commands.
