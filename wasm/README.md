# WASM source ownership

`wasm/` contains the independently reproducible Phase 0A/0B/0C z8lua build. It never
imports, includes, or symlinks local repositories from `ref/`.

- `source.lock.json` pins the vendored upstream snapshot and its inventory.
- `patches/manifest.json` owns the ordered local patch provenance.
- `toolchain.lock.json` pins emsdk and Emscripten.
- `manifest.lock.json` records the exact source set, flags, guest allowlist,
  notices, imports, and expected artifact hashes.
- `bridge/` owns the bounded `p8w0a_*` language baseline, `p8w0b_*` Shared RAM
  experiment, and isolated `p8w0c_bench_*` interop probes. Their phase prefixes
  deliberately separate all three from the proposed production `p8w_*` ABI.
- `dist/` is generated and ignored; every build also emits the third-party
  notice and license files.

Install the exact toolchain using the official emsdk manager:

```sh
git clone https://github.com/emscripten-core/emsdk.git ~/.local/share/emsdk
git -C ~/.local/share/emsdk checkout --detach 17a714fde0f1aaac53d282efcc6093b377addc8d
~/.local/share/emsdk/emsdk install 6.0.5
~/.local/share/emsdk/emsdk activate 6.0.5
export EMSDK="$HOME/.local/share/emsdk"
```

`EMXX` or an exact `em++` on `PATH` can be used instead. The build rejects a
version or version-commit mismatch.

```sh
pnpm run build:wasm
pnpm run verify:wasm
```
