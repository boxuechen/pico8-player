# C/C++ ABI bridge

The project-owned `p8w0a_*` ABI is a Phase 0A experiment for VM lifecycle,
source execution, raw Q16.16 results, bounded errors, instruction budgets, and
leak counters. It owns no cart hardware, shared Pico RAM, graphics, audio,
input, storage, scheduler, browser API, or TypeScript Runtime behavior.

Pointers returned for result strings and errors remain valid only until the
next run or context destruction. Handles are opaque and generation-checked.
The `p8w0a_*` prefix keeps this experiment separate from the proposed
production `p8w_*` ABI in `docs/03-z8lua-wasm-bridge.md`.
