# PICO-8 Web Player

Web-native PICO-8 player project using a z8lua WASM language core and a
TypeScript runtime. Phase 0S currently provides the workspace and executable
architecture boundaries only; no cart or player behavior is implemented yet.

Start with [the engineering documentation](./docs/README.md) and the
[Phase 0S evidence](./docs/11-phase-0s-evidence.md).

```sh
pnpm install --frozen-lockfile
pnpm run verify
```

Local reference repositories live under the gitignored `ref/` directory and
must never become production or test inputs.
