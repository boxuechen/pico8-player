# ABI specifications

This directory owns machine-readable schemas for the z8lua/WASM boundary. Phase
0S defines ownership only; Phase 0A will add the first reviewed ABI schema.

Generation flows from `spec/` and the pinned WASM ABI into generated bindings.
Existing TypeScript implementation must never be scraped to redefine the schema.
