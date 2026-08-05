# Phase 2 — Graphics、Memory 与 Text 完成证据

> 状态：Complete
> 阶段输入基线：Phase 1 exit，contract baseline commit `916de2a`
> 目标：PICO-8 v0.2.7 standard packed-4bpp project profile
> 浏览器门禁：Google Chrome / Chromium desktop only
> 资产策略：project-authored only；无 BBS、第三方或 `ref/` test dependency

## 0. 完成结论

Phase 2A–2F 已完成并关闭机器合同。RuntimeCore 与 z8lua bridge 现在通过单一 canonical
Pico RAM/mapping boundary 支持 Base RAM API、RAM-backed draw state、基础图元、sprite blitter、
map/flags/tile-precision `tline`、同步 visual P8SCII 和 custom font；production Worker 只传递
packed screen/display palette，主线程 Canvas presenter 不读取 guest RAM 或实现 guest raster。

两个项目原创 60Hz cart 在 Node real-WASM fresh/cold-reset 与 Chrome production Worker/Canvas
路径得到相同 oracle。资源限制故障被结构化隔离，旧 generation 被拒绝，随后加载有效 cart
可以恢复。Phase 2 exit 通过，开放 P0/P1 为 `0`。

本结论不表示完整官方 bit-exact、第三方/BBS cart compatibility、advanced screen/bitplane、
P8SCII audio/timed side effects、AudioSynth、完整 device input 或 persistence 已完成。

## 1. Work-unit closure

| Unit | 完成结果 | 主要 gate |
| --- | --- | --- |
| 2A Canonical Memory / Host ABI | 唯一 C++ mapper、`PicoLogicalMemoryPort`、80-byte/12-slot generated call frame、Base RAM widths/block API | real-WASM mapper/API/ABI/reset regression |
| 2B Draw State / Primitives | camera/clip/palette/fillp、补齐 oval、统一既有 raster、16-byte display palette DTO | RAM/frame golden + Chrome Canvas |
| 2C Sprite Sheet / Blitter | mapped `sget/sset/spr/sspr`、scale/flip/clip/palette/transparency、bounded visible work | sprite golden + Chrome production path |
| 2D Map / Flags / `tline` | live MAP base/width resolver、flags/layers、upper arbitration、Q16.16 texture sampling | map/tline RAM/frame golden + Chrome |
| 2E P8SCII / Custom Font | byte-string `print/cursor`、内建/custom/one-off glyph、visual controls、cursor/scroll/remap | font provenance/hash、fuzz/bounds、Chrome |
| 2F Conformance / Exit | 两个组合 flow、Node fresh/reset、Worker/Canvas exact、性能与 fault/recovery | aggregate exit gate + immutable evidence |

稳定接口与完整数值由
[`phase-2-graphics-memory-text-contract.json`](../../../spec/phase-2-graphics-memory-text-contract.json)、
[`p8w-v1.json`](../../../spec/abi/p8w-v1.json) 和 generated/runtime manifests 锁定。

## 2. Project-owned conformance matrix

两个正常 cart 和一个 fault cart 均为仓库原创源码。正常 case 各执行 4 帧；同一 trace 在两个
fresh Node WASM session、各自 cold reset replay 和 Chrome production Worker initial/reset 中
精确一致。完整 RAM region bytes/hash、display palette bytes 与 semantic pixels 位于
[`phase-2f-exit.json`](../../../tests/conformance/manifests/phase-2f-exit.json)。

| Case | 组合覆盖 | Cart / trace SHA-256 | Final screen / RGBA SHA-256 | Result |
| --- | --- | --- | --- | --- |
| `phase-2/graphics-memory` | memory、draw state/primitives、sprite、map/flags/tline、draw/display palette | `79e73289…5bc51` / `b21c556b…9409` | `2730014d…70c` / `17614085…a0ae` | Pass |
| `phase-2/text-remap` | built-in/custom/one-off P8SCII、cursor/default attrs、GFX/SCREEN remap、extended palette | `24ee2fe4…efa` / `74dd4271…0762` | `2f72bc98…27bf` / `0db0886d…45f6` | Pass |
| `phase-2/resource-limit-fault` | 65,537-byte synchronous print resource limit | `de131882…f47` | structured `E_HOST_API` | Pass |

这里的 exact 只描述 project oracle 的 byte/hash equality，不授予 official-exact/C3，也不进入
第三方 playable rate。没有下载或提交 BBS cart，没有从 `ref/`、fake-08 或被测实现动态导入 oracle。

## 3. Chrome device gate

Reviewed run 环境：

- Google Chrome `150.0.7871.189`，HeadlessChrome production Module Worker。
- macOS `darwin 25.5.0`，Apple M4 Pro，arm64，14 logical CPUs。
- Raw result：[`chromium-macos-arm64-phase-2-exit.json`](../../../benchmarks/phase-2/results/chromium-macos-arm64-phase-2-exit.json)
  （SHA-256 `67411167468a28dbc2d11ec22ba90eb22574287d55bcf07c7203b14877e773c5`）。

| Gate | Reviewed result |
| --- | --- |
| Deterministic Worker | 2/2 initial + cold-reset 4-frame trace/screen/palette exact against manifest and Node |
| Canvas presenter | 2/2 128×128 RGBA hashes exact；frame id `3` after four frames |
| Graphics performance | 20 warm-up + 120 measured；p50 `0.3001ms`；p95 `0.4001ms`；max `1.1000ms`；`>16.67ms` `0/120` |
| Text performance | 20 warm-up + 120 measured；p50 `0.3000ms`；p95 `0.4001ms`；max `0.4001ms`；`>16.67ms` `0/120` |
| Resource fault/recovery | `E_HOST_API` contained；main responsive；generation `3→4`；valid graphics cart rendered |
| Resource/lifecycle | stale generation rejection passed in production controller test；no Chrome Worker error；clients/controller disposed |

两条代表性 Worker round-trip p95 都低于 `8ms` Phase 2 gate。该数值包含主线程↔Worker
message、真实 z8lua tick、graphics/text work、frame transfer 和 heartbeat；它不是 Phase 4
stress corpus、长稳 soak 或移动浏览器性能声明。

## 4. Compatibility conclusion 与 Known Differences

- Base RAM widths/block API、standard-4bpp draw state/primitives、sprite/map/flags/tile-precision
  `tline` 和同步 visual P8SCII/custom font 在本 project profile 为 `compatible`。
- GFX/SCREEN remap、MAP resolver、draw/display palette 与 software text/sprite/map raster 继续由
  Worker/RuntimeCore 拥有；Canvas path 只做 palette-to-RGBA presentation。
- `tline(bits)` precision-setting overload、advanced screen/bitplane modes 仍为 `partial`/deferred。
- P8SCII audio control 没有 AudioSynth side effect，timed delay/frame-skip 不 suspend；它们属于
  后续明确激活的范围，不计为本 profile 的 P0/P1。
- 未记录的 invalid/overflow edge、未运行的官方 executable differential 和第三方/BBS carts
  保持 `unknown`；project exact hash 不改写为 official bit-exact 或 playable-rate 声明。

## 5. 可复现命令

```text
pnpm run test:phase-2f
pnpm run test:phase-2f:chrome
pnpm run test:browser:chromium
pnpm run evidence:phase-2f
pnpm run verify
```

`evidence:phase-2f` 显式更新 reviewed raw result；普通 `test:phase-2f` 只写 gitignored smoke
artifact。Phase 2 关闭后，本文件和 reviewed raw result 不随普通功能任务重写。
