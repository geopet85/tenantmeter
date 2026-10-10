# Contributing

1. Use Node.js 22 or newer.
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

Before opening a public repository, fill in its real issue tracker and private security contact. Public bug reports must use fake bucket names, customer IDs, and object paths.

Run `npm run package:check` for packaging changes and `npm run examples:generate` when changing report fields or examples. `npm run test:live` skips without explicit opt-in flags. See `../../docs/CLI_NEXT_STEPS.md` for fixture permissions and commands.
