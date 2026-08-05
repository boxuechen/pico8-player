# Phase 1 — L1 bounded profile 完成证据

> 状态：Complete
> 阶段输入基线：Phase 1E，commit `844aa36`
> 目标：PICO-8 v0.2.7 L1 bounded profile
> 浏览器门禁：Google Chrome / Chromium desktop only
> 资产策略：project-authored only；无 BBS、第三方或 `ref/` test dependency

## 0. 完成结论

Phase 1A–1F 已形成第一个可重复的视觉交互闭环：bytes-only `.p8`/`.p8.png` ingestion、
z8lua/WASM session、RAM-backed L1 raster/input、30/60/custom scheduling、production Worker
protocol、Canvas/keyboard shell、cold reset 和 fault recovery。Phase 1 exit 通过。

本结论只覆盖机器契约中声明的 **L1 bounded profile**。它不表示完整 PICO-8 API、官方
bit-exact、第三方/BBS cart compatibility 或 L2 Playable 已完成；Phase 2/3/4 的
graphics/memory/text、audio、persistence、完整 device input 和代表 corpus 仍未实现。

## 1. Project-owned conformance matrix

三个 cart 均为本仓库原创源码，固定 input trace 在 Node real-WASM 和 Chrome production Worker
中产生相同的 frame/slice/time、完整 packed screen 和 cold-reset hash。每个 fresh replay 的
trace digest 相同。

| Case | Format / mode | Cart SHA-256 | Trace SHA-256 | Final / reset screen SHA-256 | Result |
| --- | --- | --- | --- | --- | --- |
| `l1/callback-30-input` | text `.p8` / callback 30Hz | `16f4de7a…f3f6c7f` | `e10f38e3…b4570a` | `030f0432…eda8581` / `11ee2230…52a7a` | Pass；bounded flow C2 |
| `l1/callback-60-p8png` | generated `.p8.png` / callback 60Hz | `cf9948e2…bf26fd` | `b659562c…6b1987` | `1ff020f6…7ed48` / `ff1ec783…4fe47` | Pass；bounded flow C2 |
| `l1/custom-flip-30` | text `.p8` / custom 30Hz | `77215794…b197d57` | `6a1bc79a…43e0e` | `b546e65b…1bcb1` / `4d89c332…b1ced` | Pass；bounded flow C2 |

这里的 C2 只表示每个原创微型 cart 的完整关键输入/画面流程通过，不进入 MVP 代表游戏
corpus，也不能外推为第三方 cart playable rate。未运行本地官方 PICO-8 全量 differential，
因此不授予 C3/official-exact。

逐帧 oracle、完整 hash 和 provenance 位于
[`phase-1f-l1-exit.json`](../../../tests/conformance/manifests/phase-1f-l1-exit.json)。
60Hz `.p8.png` 由 tracked source 确定生成，source SHA-256 为
`cdfaeaa5…b73ff`，生成 cart 为 7,257 bytes；没有提交第三方二进制 cart。

## 2. Chrome device gate

Reviewed run 环境：

- Google Chrome `150.0.7871.189`，HeadlessChrome production Module Worker。
- macOS `darwin 25.5.0`，Apple M4 Pro，arm64，14 logical CPUs。
- Raw result：[`chromium-macos-arm64-l1-exit.json`](../../../benchmarks/phase-1/results/chromium-macos-arm64-l1-exit.json)
  （SHA-256 `6445da0c97254c147df6eef3b4fbb9071d9f4214d72225474ba5add2d6974821`）。

| Gate | Reviewed result |
| --- | --- |
| Deterministic Worker matrix | 3/3 cart/trace/final/reset hashes exact against reviewed project oracle |
| Real rAF callback 30Hz | 16 frames；median `33.40ms`；continuous frame/slice sequence |
| Real rAF callback 60Hz | 16 frames；median `16.00ms`；continuous frame/slice sequence |
| Real rAF custom 30Hz | 16 frames；median `33.20ms`；continuous frame/slice sequence |
| Keyboard/`btnp` | `ArrowRight` visible position `8→11`；O edge counter color `9` visible |
| Fault/recovery | `E_VM_INSTRUCTION_BUDGET` contained；main responsive；session generation `4→5`；valid cart reloaded |
| Ordinary 60Hz round-trip | 20 warm-up + 120 measured；p95 `0.1001ms`；`>16.67ms` `0/120` |
| Resource/lifecycle | no Worker error；controller/client dispose completed；hard-hang generation recovery remains covered by Phase 0F/1E gates |

round-trip metric 包含 main↔Worker message、真实 z8lua tick 和 heartbeat，低于当前 ordinary-cart
`8ms` p95 gate。它不是 Phase 2 graphics stress、Phase 4 CPU cost 或 release soak 的替代品。

## 3. Compatibility conclusion 与 Known Differences

- 30Hz `_update/_draw`、60Hz `_update60/_draw` 和 30Hz custom `flip()` 在本 profile 为
  `compatible`；startup logical clock 继续引用 Phase 0E official Web Player capture。
- Player 0 six-button held/edge、Chrome keyboard mapping、cold reset、generation 和 fault UI 在
  当前 profile 为 `compatible`。
- `cls/pset/line/rect/rectfill/circ/circfill` 仍是完整 Graphics 的 `partial` 子集；palette、
  clip/camera、sprite/map/text 等属于 Phase 2。
- AudioSynth、persistence、gamepad/touch/multiplayer 和 host cart resolver 为 `unsupported` 或
  deferred；它们不构成 Phase 1 P0/P1 blocker。
- 未做完整官方 executable differential 的 P8 Lua/graphics edge behavior 继续 `unknown`；
  project hash exact 不改写为 official exact。

Phase 1 exit 时没有开放 P0/P1。以上缺口是公开的后续阶段范围，不通过 stub、cart-ID hack、
宽 tolerance 或第三方 fixture 掩盖。

## 4. 可复现命令

```text
pnpm run test:phase-1f
pnpm run test:browser:chromium
pnpm run evidence:phase-1f
pnpm run verify
```

`evidence:phase-1f` 显式更新 reviewed raw result；普通 `test:phase-1f` 只写 gitignored smoke
artifact。Phase 1 关闭后，本文件和 reviewed raw result 不随普通功能任务重写。
