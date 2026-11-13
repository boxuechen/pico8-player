# Repository guidance

Read [docs/README.md](docs/README.md) and [docs/architecture.md](docs/architecture.md) before changing production code. Work within the user's current task; completed phases are preserved in Git rather than separate approval documents.

- RuntimeCore is browser-neutral. Canvas, AudioContext, AudioWorklet, storage and Worker adapters belong to `apps/player`.
- Keep the default main-thread session and optional Worker on the same execution implementation.
- `spec/` owns ABI, codec, release and API inventory contracts. Update the relevant current docs when public behavior or ownership changes.
- Never import, build or test against ignored `ref/` or local external cart libraries.
- Chrome/Chromium is the only browser gate. Do not add Firefox/WebKit scope.
- Preserve third-party notices, source/patch provenance and reproducible WASM locks.
- Run focused behavioral tests first. Expand to `test:runtime` for shared VM execution changes and to `pnpm test` when failures have unclear scope. Use `pnpm run verify:release` and `pnpm run test:browser` for component/transport changes. Build WASM first on a fresh checkout; see [development](docs/development.md).
- Keep behavioral regressions. Do not restore historical phase gates, duplicate compatibility shims or archived validation output.
