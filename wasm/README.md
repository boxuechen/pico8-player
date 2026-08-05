# WASM source ownership

`wasm/` contains production build inputs only. It must never import, include, or
symlink local repositories from `ref/`. Phase 0A will choose and record the
z8lua supply strategy, Emscripten toolchain, patch set, and artifact policy.
