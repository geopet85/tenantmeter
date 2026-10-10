# Contributing

1. Follow [Node.js and npm setup](INSTALL.md) (22 LTS; CI also tests 24 LTS). Check `node --version` and `npm --version`.
2. Run `npm ci` inside `packages/cli`.
3. Run `npm run check` before proposing a change.
4. Include a fake-data reproduction for bugs.
5. Add focused tests for changes affecting totals, cursor handling, credentials, exports, or exit codes.
6. Preserve the read-only listing model and zero telemetry.
7. Keep stdout machine-readable and progress on stderr.
8. Keep individual object sizes safe integers and accumulated bytes exact.
9. Never save credentials or raw object lists in checkpoints.
10. Explain changes to the checkpoint or report schema; reject incompatible checkpoints explicitly.

Source lives in `src/`. `build.mjs` bundles the shared tenant parser. `dist/` is generated and not committed. The published package includes the build, README, license, contribution notes, security notes, technical checklist, and scheduling wrapper. Do not commit local reports, checkpoints, `.env` files, or tarballs.

The first `npm ci` needs npm registry access. Offline checks need no AWS account, R2 account, database, Docker, or hosted application. Git is needed only for checkout and contribution workflows.

Report reproducible bugs at [GitHub issues](https://github.com/geopet85/tenantmeter/issues). Include your OS, Node version, command with fake values, expected output, actual output, and exit code. Public reports must use fake bucket names, customer IDs, and object paths. Follow [SECURITY.md](SECURITY.md) for vulnerabilities; a private security contact is still a release prerequisite.

Run `npm run package:check` for packaging changes and `npm run examples:generate` when changing report fields or examples. `npm run test:live` skips without explicit opt-in flags. See `../../docs/CLI_NEXT_STEPS.md` for fixture permissions and commands.

For performance changes, run `npm run bench` and describe workload size, Node version, OS, and results. The benchmark is offline; it does not measure provider latency or disk performance. See [performance checks](../../docs/PERFORMANCE.md).

Use the [fake-data scenario](../../docs/examples/scenario/README.md) to check known quantities offline or against a disposable AWS bucket. Cloud fixture writes require separate permissions and explicit opt-in. Never run fixture helpers against a customer bucket.
