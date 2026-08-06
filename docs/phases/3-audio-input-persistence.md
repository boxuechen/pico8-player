# Phase 3 — Audio、Input 与 Persistence

> 状态：Active；当前 work unit：3D
> 机器合同：[`spec/phase-3-audio-input-persistence-contract.json`](../../spec/phase-3-audio-input-persistence-contract.json)
> 前置证据：[`Phase 2 Graphics/Memory/Text exit`](../evidence/phase-2/31-phase-2-graphics-memory-text-exit-evidence.md)
> 浏览器门禁：Google Chrome / Chromium desktop only

## 目标与边界

Phase 3 使当前可视 player 获得确定性音频、完整 controller/devkit input 和浏览器持久化，
同时保持 RuntimeCore、z8lua adapter 与 browser adapters 的既有边界。官方 PICO-8 v0.2.7
手册是行为规范；机器合同和本文件决定本阶段实际授权范围。

稳定输入：

- Phase 2 的 real-WASM CartSession、logical frame、canonical RAM、graphics/text 和 Chrome
  Worker/Canvas production path。
- Phase 0F 的 versioned PCM DTO、dedicated Worker→AudioWorklet `MessagePort`、bounded queue、
  44.1/48kHz resampler 和 generation reset。
- Phase 1D/1E 的 player 0 six-button latch、`btnp` repeat、keyboard/blur/visibility lifecycle。
- ADR-008 的 `spec -> generated C/TS bindings` 单向生成规则；ADR-014 的 22050Hz mono
  signed PCM16LE canonical format。

Non-goals：

- guest `load()`、external filename/ref、multi-cart、BBS 或 network resolver。
- Firefox、WebKit、Safari、Android device release gate 或 SharedArrayBuffer baseline。
- PICO-8 console/editor、save-state/rewind、完整 `stat()`、GPIO/serial/file/drop input。
- Phase 4 的第三方 playable rate、CPU-cost calibration 或 official full/bit-exact 声明。

## Work units

| Unit | 名称 | 状态 | 主要可观察结果 |
| --- | --- | --- | --- |
| 3A | Deterministic SFX Core | Complete | `sfx()` 驱动 4-channel browser-neutral synth，产生 deterministic 22050Hz PCM |
| 3B | Music 与 Browser Audio | Complete | `music()`/P8SCII audio、logical PCM chunks 和真实 AudioWorklet output 闭环 |
| 3C | Controller Input | Complete | player 0..7、keyboard/gamepad/touch 的 deterministic controller snapshots |
| 3D | Devkit Input | Complete | input-only `stat()`、mouse/keyboard queue 和 pointer-lock lifecycle |
| 3E | Cartdata Core | Complete | 同步 `cartdata/dget/dset` 与 256-byte browser-neutral mirror |
| 3F | IndexedDB Persistence | **Active** | preboot hydrate、durable commit、migration 与 failure-visible fallback |
| 3G | Current-cart `reload/cstore` | Planned | 无 resolver 的 current-cart ROM/overlay 同步路径 |
| 3H | Conformance 与 Phase Exit | Planned | Node real-WASM 与 Chrome 通过 audio/input/persistence、性能和恢复门禁 |

## Completed work unit：3A

`PicoSfxSynth`、binding `31`、64-slot live SFX RAM、四声道调度、精确 30/60Hz canonical
PCM 和 lifecycle reset 已完成。机器结果、golden hash 与 known differences 由
[`spec/phase-3-audio-input-persistence-contract.json`](../../spec/phase-3-audio-input-persistence-contract.json)
的 `workUnits.3A.result` 保存；可执行回归为 `pnpm run test:phase-3a`，兼容矩阵见
[15.12](../06-testing-compatibility.md#1512-phase-3a-deterministic-sfx-core-矩阵)。

## Completed work unit：3B

binding `32`、64-pattern live music sequencer、SFX arbitration、fade 与 P8SCII audio 已进入
唯一 `PicoSfxSynth`；startup/frame PCM 只经 dedicated port 到 production Worklet。Node golden
与 Chrome 44.1/48kHz 结果由机器合同的 `workUnits.3B.result` 保存；可执行回归为
`pnpm run test:phase-3b`，兼容矩阵见
[15.13](../06-testing-compatibility.md#1513-phase-3b-music-与-browser-audio-矩阵)。

## Completed work unit：3C

固定八玩家 `PicoInputSnapshot.controllers`、逐 slice `btn/btnp` latch、`0x5f4c..0x5f53`、
keyboard P0/P1、standard Gamepad 和 multitouch 已完成。snapshot shape、replay golden、Chrome
150 production 结果与 known differences 由机器合同的 `workUnits.3C.result` 保存；可执行回归为
`pnpm run test:phase-3c`，兼容矩阵见
[15.14](../06-testing-compatibility.md#1514-phase-3c-controller-input-矩阵)。

## Completed work unit：3D

operation `33` 的 input-only `stat()`、`0x5f2d` flags、64-byte FIFO、mouse button overlay、
Worker accept-once event accumulator 和 app-owned `DevkitInputFrontend` 已完成。real-WASM mixed
return、deterministic golden 与 Chrome 150 headful trusted pointer-lock 结果由机器合同的
`workUnits.3D.result` 保存；可执行回归为 `pnpm run test:phase-3d`，兼容矩阵见
[15.15](../06-testing-compatibility.md#1515-phase-3d-devkit-input-矩阵)。

## Completed work unit：3E

operations `34..36`、package-private `CartDataCore`、live `0x5e00..0x5eff` authority、
browser-neutral seed/commit DTO 与 committed-transaction dirty observation 已完成。real-WASM
边界、fault、reset、multi-session、direct poke 和 deterministic golden 由机器合同的
`workUnits.3E.result` 保存；可执行回归为 `pnpm run test:phase-3e`，兼容矩阵见
[15.16](../06-testing-compatibility.md#1516-phase-3e-cartdata-core-矩阵)。IndexedDB、异步 hydrate
和 durable write 不在 RuntimeCore 内，继续由 active 3F 拥有。

## Active work unit：3F

### Observable behavior

1. production Runtime Worker 在 `loadCart/reset` 创建新 generation 前，先从 IndexedDB 按固定
   profile/runtime namespace 读取所有可用 cartdata records，验证 id/schema/256-byte payload 并复制成
   `PicoCartDataSeed[]`。hydrate 完成前不得启动 guest；storage key 不包含 cart hash。
2. 数据库固定为 `pico8-web-player` version `1`、object store `cartdata`；current record schema 为
   `{schemaVersion:1, namespace, id, bytes}`，key 由 namespace + id 组成。每 namespace 最多 hydrate
   `4096` records / `1 MiB`，禁止 malformed storage 导致无界增长。
3. 兼容 project-owned legacy schema `0`：读取时验证并规范化，随后 lazy rewrite 为 schema `1`；未知
   future schema 或损坏 record 跳过并产生 `E_PERSISTENCE_READ` diagnostic，不把脏 bytes 交给 core。
4. 每个 successful boot/frame 的 `PicoCartDataCommit` 由 Worker adapter copy 后按 id 合并，只保留最新
   snapshot；steady simulation 不等待 IndexedDB。`load/reset/pause/stop/dispose/pagehide` 必须触发
   best-effort durable flush，其中 generation replacement 必须先 await 旧 generation flush，再 hydrate
   新 generation，防止 stale commit 穿透。
5. open/read/upgrade 失败使用空 seed fallback，cart 仍可运行，并向现有 main diagnostic aria-live surface
   发送 recoverable `E_PERSISTENCE_READ`。write/quota/transaction 失败发送
   `E_PERSISTENCE_WRITE`，游戏继续且最新 dirty snapshot 保留供后续 flush retry；不得报告为已保存。
6. Worker command queue 扩展为 await controller 的 sync-or-async result；无 persistence adapter 的 Node
   路径保持同步 test-double 兼容。3F 不改变 RuntimeCore RAM authority、guest API ABI、Canvas/audio/input
   transport，也不实现 `reload/cstore/load`。

### 允许修改的范围

- `packages/contracts/src/**` 的 persistence error codes；3E seed/commit DTO 只能兼容扩展；
  `packages/runtime-core/src/ports/**` 只允许加入 browser-neutral persistence port contract
- `apps/web-player/src/worker/{adapters,compose-runtime.ts,runtime-worker.ts,player-worker-entry.mjs}` 的
  IndexedDB adapter、async command ordering、hydrate/commit/flush 与 diagnostics
- `apps/web-player/src/{transport,main}/**` 中最小的 flush command、`pagehide` lifecycle 和现有 diagnostic
  展示路径；不得把 storage state 搬到 Window
- `tests/{runtime,browser,architecture,fixtures}/**`、`tools/browser/**`、`package.json`、机器合同、兼容矩阵
  和本 active 文档

不得修改 `docs/evidence/**`；不得使用 localStorage、Service Worker、cart hash key、任意 URL、BBS、
guest `reload/cstore/load` 或通用 save-state。不得让 IDB transaction 位于 WASM import 或逐帧阻塞
simulation；不得因持久化失败把 otherwise-valid cart 转为 VM fault。

### Routed contracts

- [Persistence owner 与 failure policy](../04-typescript-runtime.md#11-persistence)
- [Worker serialization 与 lifecycle](../04-typescript-runtime.md#12-workerwatchdog-与消息协议)
- [RuntimeCore/app package ownership](../08-source-layout-and-boundaries.md#2-package-职责)
- [官方 Cartridge Data](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#Cartridge_Data)

### Verification

3F 必须新增 `pnpm run test:phase-3f`，覆盖：

- fake port 的 preboot ordering、seed copy、latest-per-id coalescing、flush/retry、load/reset/fault/stop/dispose
  generation isolation，以及 read/write diagnostic 不改变 simulation state。
- IndexedDB adapter 的 fresh schema、namespace/key no-cart-hash、exact 256-byte round-trip、record bounds、
  legacy-0 migration、future/corrupt record rejection、transaction abort 和 copy ownership。
- production Worker + real IndexedDB Chrome gate：首次 `cartdata=false` 写入，flush/restart 后
  `cartdata=true` 且 256 bytes exact；reset/pagehide lifecycle、migration 和 zero Worker errors。
- 3E real-WASM golden、3D input、3B audio、Phase 2 graphics 和 architecture 回归。

最终门禁：

```text
pnpm run test:phase-3f
pnpm run test:phase-3d:chrome
pnpm run verify
git status --short
```

### 3F exit gate

- guest 同步 API 从 preboot seed 工作，IndexedDB 不进入 RuntimeCore/WASM synchronous path。
- committed snapshots durable、copy-owned、namespace-scoped 且 generation-safe；key 不含 cart hash。
- storage read/write/migration/corruption 失败可见但不谎报、不破坏 otherwise-valid simulation。
- Node failure/lifecycle tests 与 Chrome production persistence/restart gate 通过，机器合同记录 schema、
  limits、golden/known differences 和命令。
- 3F 独立提交后 worktree 干净；随后才折叠本节并激活 3G。

## Phase exit gate

- 3A–3H 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned carts 覆盖 SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart
  `reload/cstore`；不依赖 BBS、third-party cart 或 `ref/`。
- canonical PCM、input/RAM/persistence/overlay trace 在 Node real-WASM 与 Chrome production
  path 满足各自 exact/tolerance oracle。
- 44.1/48kHz device output、input lifecycle、storage error/migration、fault/reset/stale generation、
  ordinary performance 与 bounded soak 通过；0 个开放 P0/P1。
- 归档不可变 Phase 3 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
