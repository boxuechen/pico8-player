# Phase 0C interop benchmark

This suite measures boundary shapes; it does not implement a PICO-8 host API.
Every operation has four paths with the same deterministic inputs and
output/RAM hashes:

1. `js_to_wasm_export`: one exported Wasm call per logical operation.
2. `wasm_to_js_import`: one primitive JS import per operation from a loop in
   Wasm. This is the candidate z8lua host-call direction.
3. `wasm_control`: the same loop and operation stay inside Wasm.
4. `js_shared_memory`: JS operates on the shared RAM after resolving each video
   window once through the Phase 0B canonical mapper.

The JS path does not copy GFX/SCREEN remap rules. It receives physical window
bases from `_p8w0b_map_address`; changing remap registers requires creating a
new case binding.

## Measurement contract

- Production `-O2`, fixed 16 MiB memory artifact; growth remains disabled.
- Deterministic seed `0x12345678` and FNV-1a result/RAM hashes.
- 100 warmup frames per case.
- At least 30 measured samples.
- Each sample repeats a logical frame until its measured interval targets at
  least 100 ms; reported values divide elapsed time by repetitions.
- Report p50/p95/p99, mean/min/max, calls/s and ns/call.
- Absolute budgets are informative unless run on a registered fixed runner.
  Same-machine baseline comparison uses 5% warning and repeated >10% failure.
- Chrome/Chromium is the sole browser gate. A missing Chromium run is
  `not-run` or `unavailable`, never synthesized. Node remains a correctness
  and harness smoke environment, not a supported browser.

The required 1K/16K/64K counts mean 1024/16384/65536 logical operations per
frame. `spr_8x8` additionally measures 4096 calls so the documented sprite
budget can be evaluated without extrapolation. It copies 64 packed pixels per
logical call, answering the coarse host-call question as well as total block
cost. Byte strings use 1024 calls at lengths 0/8/64/1024 and preserve embedded
zero bytes.

Lua parsing, bytecode dispatch, coroutine behavior, Canvas rendering, audio and
frame scheduling are excluded. Direct `@/%/$` correctness remains Phase 0B
evidence; mixing VM instruction cost into this suite would make the interop
delta uninterpretable.

## Commands

```sh
pnpm run test:benchmark
pnpm run benchmark:interop:node
pnpm run benchmark:interop:chromium -- --smoke
pnpm run benchmark:interop:serve
```

The server prints its loopback URL. Open it in Chrome/Chromium; the page runs
the artifact in a dedicated Worker and renders validated JSON. Automated
Chromium capture writes the release-gating machine-readable result. Historical
result schema values for other engines remain readable, but new runs neither
probe nor report them and they are outside the support contract.
