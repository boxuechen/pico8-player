# PICO-8 Web Player

Web-native PICO-8 player project using a z8lua WASM language core and a
TypeScript runtime. Phase 0S–0F are complete, including shared Pico RAM,
interop evidence, a bounded lossless `.p8.png` codec, a host-driven
callback/custom-loop frame slice, Worker fault containment, a Canvas2D frame
presenter, and a bounded Worker→AudioWorklet PCM transport. Browser support and
release testing target Chrome/Chromium only. Phase 1A–1F also include the host
API boundary, text `.p8` decoding, generation-owned CartSession cold reset, L1
graphics/input, a bounded Worker scheduler, keyboard mapping and a minimal DOM
player shell. The Phase 1 L1 bounded profile passed project-owned 30/60/custom-loop
conformance and the production Chrome Worker gate. Full cart hardware, Graphics,
AudioSynth, device/multiplayer input, persistence, resolver support and general
third-party cart compatibility are not implemented yet.

Start with [the engineering documentation](./docs/README.md). Phase 0F's decision
and browser evidence live in the
[completed execution record](./docs/evidence/phase-0/17-phase-0f-evidence.md);
all completed Phase 0 records live in the
[evidence archive](./docs/evidence/phase-0/README.md) and are not required reading
for each implementation task. Phase 1's bounded compatibility conclusion is in
the [Phase 1 exit evidence](./docs/evidence/phase-1/21-phase-1-l1-exit-evidence.md).

```sh
pnpm install --frozen-lockfile
export EMSDK="$HOME/.local/share/emsdk"
pnpm run verify
```

The exact emsdk manager commit and Emscripten version are documented in
[`wasm/README.md`](./wasm/README.md); `verify` rejects a mismatched compiler.

Local reference repositories live under the gitignored `ref/` directory and
must never become production or test inputs.
