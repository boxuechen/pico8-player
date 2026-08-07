# PICO-8 Web Player

Chrome/Chromium-only PICO-8 v0.2.7 web player built with a z8lua WASM language core and a
browser-neutral TypeScript RuntimeCore. The player supports `.p8` and `.p8.png`, shared Pico RAM,
graphics, audio, keyboard/gamepad/touch input, cartdata persistence, bounded Worker execution and
caller-authorized local multicart `load/reload/cstore`.

Phase 6 real-cart qualification is complete. Phase 7 Web Player Release Candidate is active and is
turning the validated runtime into a reproducible static artifact with a stable bytes-first embed API,
production DOM shell, VM-safe pause menu, conformance closure and Chrome release gates. It does not
add automated BBS access, arbitrary URL loading, public cart mirroring or non-Chrome support.

Start with [the engineering documentation](./docs/README.md). The current executable work unit is
routed from that page; target architecture examples and historical evidence do not authorize future
work units.

```sh
pnpm install --frozen-lockfile
export EMSDK="$HOME/.local/share/emsdk"
pnpm run verify
```

The exact emsdk manager commit and Emscripten version are documented in
[`wasm/README.md`](./wasm/README.md); verification rejects a mismatched compiler. Local reference
repositories and third-party playtest carts remain under gitignored paths and never become build,
test or release inputs.
