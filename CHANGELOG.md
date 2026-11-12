# Changelog

## Unreleased — 2026-11-12

- Default execution uses the shared session on the main thread; `execution: "worker"` retains optional isolation.
- Standalone session API v1 and JSON tool adapter support Lua/cart loading, 1–600 exact frames per batch, copied pixels and diagnostics, reset and disposal. No UI/audio device is needed.
- Web API v2 retains hosted controls, external input, host persistence, first-presented-frame startup and serialized lifecycle operations.
- Removed internal codec aliases `cartVersion`/`luaSource`; consumers use `version`/`code`.
- Removed historical phase gates, reports, experimental Worker/memory/benchmark implementations and migration aliases. Current docs and feature-based tests replace them.
- Main-thread WASM calls retain an instruction cap but cannot be preempted by a timer. JSON images are RGBA8 base64, not PNG. Plugin registration and image encoding belong to the caller.

## 0.2.0-alpha.1

Local integration package; project license remains UNLICENSED. Distribution includes z8lua, Emscripten and font notices. Previous release details and verification records remain in Git history.
