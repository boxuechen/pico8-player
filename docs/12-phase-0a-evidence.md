# Phase 0A 完成证据

日期：2026-08-05

范围：可复现 z8lua WASM baseline

ADR：[ADR-012](./adr/012-z8lua-source-and-phase-0a-wasm.md)

> 历史记录：本页 hash 对应 Phase 0A commit `df6159376ab59792743f87387a2a48e1f37da3f4`。
> 当前 `wasm/source.lock.json`、artifact 名称与 manifest 已由 Phase 0B 的 ordered
> patch/artifact 取代；Phase 0A 的 14 项 regression 仍在统一 suite 中执行。

## 1. 结论

Phase 0A 已完成。仓库现在能从 tracked vendored source 构建 Worker-loadable ES
module + WASM，并通过真实 z8lua state 的语言、沙箱、budget、生命周期和可复现
测试。实现有意停在 `p8w0a_*` spike ABI，没有进入 Shared Pico RAM、host API、
cart codec、graphics/audio/input、Player UI 或 BBS 行为。

## 2. 锁定输入

| 输入 | 锁定值 | 机器事实源 |
| --- | --- | --- |
| z8lua | `pico8@8575dfbc524003c869c0aa05e109819302c576f9` | `wasm/source.lock.json` |
| upstream tree | `76d6bede9c178d7a7128d9a56106e10e1c342eaa` | `wasm/source.lock.json` |
| patched inventory SHA-256 | `96ae88282b8c0a76b21533c0ee8743b2117be2f935d814fcdc2f77b9f74448e9` | `wasm/source.lock.json` |
| local patch SHA-256 | `944c7e2b6e2b8d45efd65b3c1b0574a1cdaf6f9c3fc5af3429f47353fe3388ec` | `wasm/patches/manifest.json` |
| emsdk manager | `17a714fde0f1aaac53d282efcc6093b377addc8d` | `wasm/toolchain.lock.json` |
| Emscripten | `6.0.5` / `1db513782be24469589d7cb8a1f1834e9a33f271` | `wasm/toolchain.lock.json` |

`pico8` 到对照 `zepto8@4a7089e` 的审计差异为 11 个文件、约 3004 行；其中
`eris.c` 单文件约 2714 行。该差异支持选择更小的 `pico8` branch，而不是把
Eris/Oua 作为隐式 guest surface。

## 3. ABI 与 sandbox 证据

- opaque generation-checked handle；stale/double destroy 受控失败。
- source 以 pointer + byte length 进入；load、runtime、budget error 可区分。
- raw fixed result 直接通过 `lua_Number::bits()` 读取，不经 JS float round-trip。
- 只打开 sandboxed base、PICO pure、coroutine、table、string。
- debug、Eris、io、os、package、require、dofile/loadfile/load、math、bit32 和
  collectgarbage 对 guest 均为 `nil`。
- `.wasm` import 精确为 `_abort_js`、`emscripten_date_now`、
  `emscripten_resize_heap`；无 filesystem、WASI、stdout 或 host API import。
- count hook 对直接 infinite loop、guest `pcall` 捕获和 nested coroutine 捕获均
  返回受控 budget error。

`p8w0a_*` 是 bounded spike ABI，不改变 Proposed production `p8w_*` lifecycle。
后续阶段不能直接把它当公共 adapter contract 扩展；Phase 0B 已使用独立
`p8w0b_*` bounded ABI。

## 4. 语言与生命周期结果

| Fixture | 结果 |
| --- | --- |
| short-if + `+=` + `?` | raw `0x00030000` |
| `0x7fff.ffff + 0x0.0001` | raw `0x80000000` |
| `1/0`, `-1/0`, `0/0` | `0x7fffffff`, `0x80000001`, `0x7fffffff` |
| `sin(0)`, `sin(0.25)`, `cos(0)` | `0x00000000`, `0xffff0000`, `0x00010000` |
| coroutine yield/return | `0x00018000` / `0x00024000`, status `suspended` / `dead` |
| `chr(65,0,66)` byte string | ABI result bytes `41 00 42`，内嵌 NUL 保留 |
| `2^0.5` z8lua baseline | raw `92681`；Known Difference，不是官方 oracle |
| 100 create/run/destroy | 每轮 live context = 0、tracked Lua bytes = 0、linear memory size 不变 |

这些结果锁定本项目的 z8lua baseline。除有官方依据的项目外，不把“上游值稳定”
自动升级成 PICO-8 0.2.7 official golden；`^` 明确保持 known difference。

## 5. Artifact 与 NOTICE

`pnpm run build:wasm` 生成 6 个文件。完整 byte length 和 SHA-256 由
`wasm/manifest.lock.json` 机器核验；核心产物为：

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `z8lua-phase-0a.mjs` | 6710 | `584957d21b8a2c0b730a96408b94651062f8bae127feb389216335b45c4c7990` |
| `z8lua-phase-0a.wasm` | 172757 | `522928ee2ae73e77bde0d77391a80b0e9ba0eca6d1bd06ab473e69b3ae5c9823` |

同一产物目录包含第三方 NOTICE、Emscripten dual-license notice、Lua license 和
WTFPL v2 license。NOTICE 审计是 provenance/redistribution 记录，不代替项目的
法律审阅。

## 6. 执行过的验证

```text
node tools/wasm/verify-source.mjs
node tools/wasm/build.mjs
node --test tests/wasm/phase-0a.test.mjs
node tools/wasm/reproducibility.mjs
node tools/wasm/verify-manifest.mjs
pnpm run verify
```

- WASM suite：14/14 passed。
- reproducibility：两个全新 output directory 的 `.mjs`、`.wasm`、NOTICE 和三份
  license 全部 byte-identical。
- unified `verify` 同时运行 Phase 0S architecture gates 和 Phase 0A gates。
- clean checkout：从 `df6159376ab59792743f87387a2a48e1f37da3f4` 执行
  `git clone --no-local`，使用 Node 22.22.2、pnpm 10.8.0 运行
  `pnpm install --frozen-lockfile` 与 `pnpm run verify`；16/16 architecture、
  14/14 WASM、reproducibility 和 6-file manifest 全部通过，验证后 checkout 的
  `git status --short` 为空。

## 7. 未覆盖与下一阶段

- Node `worker_threads` 已验证 ES module Worker load；真实 Chromium/Firefox/Safari
  浏览器矩阵尚未运行，不得据此宣称浏览器全面兼容。
- 未运行正版 PICO-8 differential capture；`^` 仍是 Known Difference，其他
  baseline fixture 也继续接受后续 official golden 校准。
- Lua heap cap/OOM 与 Phase 0B fixed artifact 参数已由
  [ADR-013](./adr/013-shared-pico-ram-boundary.md) 回答；production corpus sizing 仍后续校准。
- `@/%/$`、upper RAM、地址 wrap、64 KiB alias 和 GFX/SCREEN remap 已由
  [Phase 0B](./13-phase-0b-evidence.md) 完成。
- production `p8w_*` ABI、frame lifecycle、host requests、graphics/audio/input 和
  Player 均未实现。
