# PICO-8 Web Player

Web-native PICO-8 player project using a z8lua WASM language core and a
TypeScript runtime. Phase 0S–0E are complete, including shared Pico RAM,
interop evidence, a bounded lossless `.p8.png` codec, and a host-driven
callback/custom-loop frame slice with Worker fault containment. Browser support
and release testing target Chrome/Chromium only. Full cart hardware, render/audio
transport, and the player UI are not implemented yet.

Start with [the engineering documentation](./docs/README.md) and the
[current Phase 0F execution brief](./docs/phases/0f-browser-render-audio-transport.md).
Completed Phase 0 records live in the
[evidence archive](./docs/evidence/phase-0/README.md) and are not required reading
for each implementation task.

```sh
pnpm install --frozen-lockfile
export EMSDK="$HOME/.local/share/emsdk"
pnpm run verify
```

The exact emsdk manager commit and Emscripten version are documented in
[`wasm/README.md`](./wasm/README.md); `verify` rejects a mismatched compiler.

Local reference repositories live under the gitignored `ref/` directory and
must never become production or test inputs.
