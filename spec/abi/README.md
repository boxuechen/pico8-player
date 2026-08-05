# ABI specifications

This directory owns machine-readable schemas for the z8lua/WASM boundary. The
production `p8w` ABI is currently v1.2 (`0x00010002`): Phase 2A added the
schema-generated 80-byte host call frame while retaining the v1 major; Phase 2B–2D
reuse that layout for boolean scalar lowering, raw Q16.16 results and graphics/map bindings.

Generation flows from `spec/` and the pinned WASM ABI into generated bindings.
Existing TypeScript implementation must never be scraped to redefine the schema.
