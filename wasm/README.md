# z8lua WASM

唯一生产产物为 `dist/z8lua-runtime-v1.mjs` 与 `.wasm`。早期 benchmark/probe ABI 不再构建。

- `source.lock.json`：vendored upstream revision 与源文件 inventory。
- `patches/manifest.json`：本地补丁来源、目的和 hash。
- `toolchain.lock.json`：固定 emsdk/Emscripten。
- `runtime-v1.manifest.lock.json`：生产 ABI、flags、固定内存及产物 hash。
- `bridge/`：项目 bridge；`z8lua/`：固定第三方源码；均不依赖 `ref/`。
- `THIRD_PARTY_NOTICES.md` / `licenses/`：来源和分发 notices，随构建复制。

编译参数在 `tools/wasm/config.mjs`；只构建 production runtime。主线程、Worker 和 Node 共用 loader；主线程路径由 Chrome 门禁验证。构建后用 manifest 检查字节一致性；不要为了绕过失败而刷新 hash。

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
pnpm run test:runtime
```
