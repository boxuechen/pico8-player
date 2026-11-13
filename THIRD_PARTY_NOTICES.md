# Third-party notices

The root [MIT License](LICENSE) applies to original project code. Upstream code, data and generated toolchain components retain their own licenses. This index points to the authoritative component notices and pinned provenance.

| Component | Use | License and provenance |
| --- | --- | --- |
| z8lua / Lua 5.2 | Lua VM and PICO-8 language behavior | [WASM notices](wasm/THIRD_PARTY_NOTICES.md), [source lock](wasm/source.lock.json), [Lua license](wasm/licenses/Lua-5.2.txt), [WTFPL 2](wasm/licenses/WTFPL-2.txt) |
| Emscripten | Generated JavaScript/WASM glue | [Toolchain notices](wasm/licenses/Emscripten.txt), [toolchain lock](wasm/toolchain.lock.json) |
| P8SCII font data | Built-in glyphs, derived through fake-08 from tac08 | [RuntimeCore notices](packages/runtime-core/THIRD_PARTY_NOTICES.md#p8scii-built-in-font-data) — MIT |
| Audio synthesis/filter formulas | TypeScript implementation informed by fake-08 / zepto8 | [RuntimeCore notices](packages/runtime-core/THIRD_PARTY_NOTICES.md#sfx-synthesis-and-filter-formulae) — WTFPL 2 for the cited upstream work |

The static component carries the project `LICENSE`, combined `THIRD_PARTY_NOTICES.md`, and the required `licenses/` files. Manifest and package verification check the shipped inventory. `pnpm test` verifies vendored source and artifact locks.

Development dependencies are recorded in `pnpm-lock.yaml` and retain their own licenses. User-supplied cartridges are separate works; loading them does not relicense their code, art or audio under the project license.
