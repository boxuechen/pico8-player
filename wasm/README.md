# z8lua WebAssembly

The production outputs are `dist/z8lua-runtime-v1.mjs` and `dist/z8lua-runtime-v1.wasm`. Main-thread, Worker and Node sessions share the loader. The earlier benchmark/probe ABI is not built.

## Set up the compiler

Use the exact emsdk revision and Emscripten version recorded in [toolchain.lock.json](toolchain.lock.json). The build checks both the version and compiler revision.

```sh
git clone https://github.com/emscripten-core/emsdk.git ~/.local/share/emsdk
git -C ~/.local/share/emsdk checkout --detach 17a714fde0f1aaac53d282efcc6093b377addc8d
~/.local/share/emsdk/emsdk install 6.0.5
~/.local/share/emsdk/emsdk activate 6.0.5
export EMSDK="$HOME/.local/share/emsdk"
```

If emsdk is already installed, use that checkout at the pinned revision rather than cloning into an occupied directory. `EMXX` or an exact `em++` on `PATH` can be used instead; see [compiler resolution](../tools/wasm/config.mjs).

From the repository root:

```sh
pnpm run build:wasm
pnpm run verify:wasm
pnpm run test:runtime
```

## Source and build records

| Path | Purpose |
| --- | --- |
| [source.lock.json](source.lock.json) | Vendored upstream revision and source inventory |
| [patches/manifest.json](patches/manifest.json) | Local patches, intent and hashes |
| [toolchain.lock.json](toolchain.lock.json) | Pinned compiler and emsdk |
| [runtime-v1.manifest.lock.json](runtime-v1.manifest.lock.json) | Production ABI, flags, fixed memory and output hashes |
| `bridge/` | Project-owned C/C++ bridge |
| `z8lua/` | Pinned third-party source |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/` | Upstream notices copied into distributions |

Build flags live in [`tools/wasm/config.mjs`](../tools/wasm/config.mjs). Neither bridge nor vendored source depends on ignored `ref/` checkouts. Manifest checks verify byte-level output integrity; investigate a mismatch rather than refreshing hashes to bypass it.

For intentional compiler/bridge changes, run `pnpm run test:wasm:repro` and explain any resulting lock updates. Chrome verification covers the default main-thread integration.
