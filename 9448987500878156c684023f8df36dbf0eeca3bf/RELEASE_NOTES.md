# Changelog

## 0.2.0-alpha.3 — 2026-11-13

- Standardize the workspace, app directory, distribution and persistence database on Player naming.
- Export `createPico8Player` / `Pico8Player` and their renamed option/event types, without legacy aliases.
- Publish only the current source-commit directory on Pages; Maker must update its pinned build together.
- Old database names are not read or migrated. WASM ABI and third-party source locks are unchanged.

## 0.2.0-alpha.2 — 2026-11-13

- License project-owned source and compiled components under MIT; retain all third-party notices and license files.
- Publish complete static builds on GitHub Pages in immutable source-commit directories. No GitHub Release is required.
- Expose `decodeP8` through the public standalone session facade so hosts need no internal source checkout.
- Keep runtime behavior, session API and WASM ABI unchanged.

## Earlier integration changes — 2026-11-12

- Default execution uses the shared session on the main thread; `execution: "worker"` retains optional isolation.
- Standalone session API v1 and JSON tool adapter support Lua/cart loading, 1–600 exact frames per batch, copied pixels and diagnostics, reset and disposal. No UI/audio device is needed.
- Web API v2 retains hosted controls, external input, host persistence, first-presented-frame startup and serialized lifecycle operations.
- Removed internal codec aliases `cartVersion`/`luaSource`; consumers use `version`/`code`.
- Removed historical phase gates, reports, experimental Worker/memory/benchmark implementations and migration aliases. Current docs and feature-based tests replace them.
- Main-thread WASM calls retain an instruction cap but cannot be preempted by a timer. JSON images are RGBA8 base64, not PNG. Plugin registration and image encoding belong to the caller.

## 0.2.0-alpha.1

Historical local integration package; its published artifacts were marked UNLICENSED. Distribution includes z8lua, Emscripten and font notices. Previous release details and verification records remain in Git history.
