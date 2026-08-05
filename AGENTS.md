# Repository guidance

This repository is implementing a Chrome/Chromium-only PICO-8 web player with
z8lua WASM and a TypeScript runtime.

Before changing production code:

1. Read [`docs/README.md`](docs/README.md).
2. Read the active Phase 1 entry linked there. Phase 1C is complete; use that
   document to activate and route the next work unit.
3. Read [`docs/08-source-layout-and-boundaries.md`](docs/08-source-layout-and-boundaries.md)
   and only the contract sections routed by the current phase document.

Repository rules:

- `spec/` owns machine-readable contracts; `docs/adr/` owns accepted decisions;
  `docs/evidence/` is immutable historical evidence.
- RuntimeCore remains browser-neutral. Canvas/WebGL, AudioContext and
  AudioWorklet belong to `apps/web-player`.
- Do not import, build or test against `ref/`; it is ignored reference material.
- Do not infer implementation status from a target architecture example. Check
  the status labels and current source first.
- Chrome/Chromium is the only browser gate. Do not add Firefox/WebKit scope.
- Run verification proportional to the change and finish with `pnpm run verify`
  when production behavior or a public contract changes.

Keep this file short. Detailed task requirements belong in the active phase
document, not here.
