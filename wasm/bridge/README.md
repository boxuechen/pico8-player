# C/C++ ABI bridge

The project-owned `p8w0a_*` ABI is a Phase 0A experiment for VM lifecycle,
source execution, raw Q16.16 results, bounded errors, instruction budgets, and
leak counters. It owns no cart hardware, shared Pico RAM, graphics, audio,
input, storage, scheduler, browser API, or TypeScript Runtime behavior.

Pointers returned for result strings and errors remain valid only until the
next run or context destruction. Handles are opaque and generation-checked.
The `p8w0a_*` prefix keeps this experiment separate from the proposed
production `p8w_*` ABI in `docs/03-z8lua-wasm-bridge.md`.

Phase 0B adds a separate `p8w0b_*` bounded experiment. Each Phase 0B context
owns a stable 64 KiB RAM block, binds it with `lua_setpico8memory()`, exposes
pointer/size/reset probes, and routes logical memory through
`p8w_pico_memory.*`. The same mapper is compiled into z8lua direct operators,
memory probes, and the TypeScript `Phase0BMemoryBinding`; no frame copy or
second JS remap table exists.

Phase 0C adds only `p8w0c_bench_*` exports and generated primitive JS imports.
Its no-op/raw/string/pset/peek-poke/sprite probes compare per-operation
JS→WASM, WASM→JS, pure-WASM, and shared-memory paths. RAM-bearing probes reuse
`p8w0b_*` handles and the canonical mapper; no remap policy is duplicated.

Phase 0E adds the separate production-named `p8w_*` v1 ABI in
`p8w_frame_runtime.*`. It implements only compile/boot/manual step, callback and
top-level `flip()` continuations, minimal `cls/pset/btn/time`, shared RAM,
instruction poisoning, structured errors and the bounded HostRequest control-flow
probe. It is built into `z8lua-runtime-v1`, which excludes all `p8w0*` symbols.
Complete graphics/audio/input/persistence and Player behavior remain outside it.
