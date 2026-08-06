# Phase 3 — Audio、Input 与 Persistence

> 状态：Active；当前 work unit：3H
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
| 3F | IndexedDB Persistence | Complete | preboot hydrate、durable commit、migration 与 failure-visible fallback |
| 3G | Current-cart `reload/cstore` | Complete | 无 resolver 的 current-cart ROM/overlay 同步路径 |
| 3H | Conformance 与 Phase Exit | **Active** | Node real-WASM 与 Chrome 通过 audio/input/persistence、性能和恢复门禁 |

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
return、deterministic golden 与 Chrome 150 trusted pointer-lock 结果由机器合同的
`workUnits.3D.result` 保存；可执行回归为 `pnpm run test:phase-3d`，兼容矩阵见
[15.15](../06-testing-compatibility.md#1515-phase-3d-devkit-input-矩阵)。

## Completed work unit：3E

operations `34..36`、package-private `CartDataCore`、live `0x5e00..0x5eff` authority、
browser-neutral seed/commit DTO 与 committed-transaction dirty observation 已完成。real-WASM
边界、fault、reset、multi-session、direct poke 和 deterministic golden 由机器合同的
`workUnits.3E.result` 保存；可执行回归为 `pnpm run test:phase-3e`，兼容矩阵见
[15.16](../06-testing-compatibility.md#1516-phase-3e-cartdata-core-矩阵)。IndexedDB、异步 hydrate
和 durable write 不在 RuntimeCore 内；3F 已在 Worker-owned IndexedDB adapter 完成。

## Completed work unit：3F

browser-neutral `CartDataPersistencePort`、Worker-owned IndexedDB schema/adapter、preboot hydrate、
latest-per-ID commit coalescing、lifecycle flush、legacy migration 和 recoverable diagnostics 已完成。
Node fake-port 与 Chrome production 结果由机器合同的 `workUnits.3F.result` 保存；可执行回归为
`pnpm run test:phase-3f`，兼容矩阵见
[15.17](../06-testing-compatibility.md#1517-phase-3f-indexeddb-persistence-矩阵)。

## Completed work unit：3G

append-only operations `37..38`、browser-neutral `CurrentCartDataRepositoryPort`、Worker-local
`CartRepositoryAdapter` 与同步 `reload/cstore` 已完成。data ROM 严格限制为 `0x0000..0x42ff`；
overlay 按 cart SHA-256 隔离并限制为每 Worker 64 个 identity，reset/同 identity load 保留，dispose
清空。real-WASM range/ref/mutation-before-fault 与 Chrome production trace 由机器合同的
`workUnits.3G.result` 保存；可执行回归为 `pnpm run test:phase-3g`，兼容矩阵见
[15.18](../06-testing-compatibility.md#1518-phase-3g-current-cart-reloadcstore-矩阵)。

## Active work unit：3H

### Observable behavior

1. 新增至少两个 project-owned Phase 3 conformance flows 和 hash manifest，联合覆盖 SFX/music、
   controller/devkit input、cartdata/IndexedDB 与 current-cart overlay；不得下载或提交 BBS/第三方 cart。
2. Node real-WASM 对 fresh/reset/fault recovery 生成 canonical PCM、input/live-RAM、cartdata/overlay、
   packed-screen/display-palette 与 generation trace；同一输入重复执行必须 exact。
3. Chrome production path 必须运行真实 Worker、AudioWorklet、Canvas 与 IndexedDB；代表 workload 至少
   120 ticks，frame handling p95 不超过 8ms；另跑 60 秒 bounded soak，要求 0 Worker error、0 stale
   generation、0 audio discontinuity，并证明资源可 dispose。
4. recovery gate 必须覆盖 structured host-api fault、audio queue reset、stale input/work rejection、fault 后
   fresh valid cart 恢复，以及 persistence failure 可见但不使有效 simulation fault。
5. 退出时归档 immutable Phase 3 evidence、关闭机器合同、更新 roadmap/README 路由并删除本 active
   phase 文档；开放 P0/P1 必须为 0。

### 允许修改的范围

- `tests/conformance/{carts,manifests}/phase-3*`、对应 Node/Chrome runner、project-owned fixtures/golden
- `benchmarks/phase-3/**`、`tools/browser/**` 与 `package.json` 中 Phase 3H 门禁命令
- `spec/phase-3-audio-input-persistence-contract.json`、`docs/{README,06-testing-compatibility,07-roadmap}.md`、
  新建 `docs/evidence/phase-3/**`，并在 exit commit 删除本 active 文档
- 只有 conformance 暴露 P0/P1 时才允许最小生产修复；修复必须保留独立 regression，不得扩大 Phase 3 scope

不得新增 API、guest `load`、external ref/resolver、BBS/network、Firefox/WebKit、移动 release gate、
SharedArrayBuffer、save-state 或 console/editor。不得修改既有 `docs/evidence/phase-0..2/**`。

### Routed contracts

- [测试分层、性能与 recovery](../06-testing-compatibility.md)
- [Phase 3 路线与 Phase 4 handoff](../07-roadmap.md)
- [package/runtime/app 边界](../08-source-layout-and-boundaries.md#2-package-职责)
- [Phase 3 machine contract](../../spec/phase-3-audio-input-persistence-contract.json)

### Verification

```text
pnpm run test:phase-3h
pnpm run test:phase-3h:chrome
pnpm run verify
git status --short
```

### 3H exit gate

- project-owned corpus、manifest hashes 和 Node/Chrome cross-subsystem oracle 全部通过。
- performance p95、60 秒 soak、fault/generation/persistence recovery 与 dispose 门禁通过。
- 0 个开放 P0/P1；known differences 和 Chrome-only 支持范围明确。
- Phase 3 evidence 不可变归档，machine contract/roadmap/README 关闭，active 文档删除。
- 3H 独立提交后 worktree 干净，Phase 3 才算完成。

## Phase exit gate

- 3A–3H 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned carts 覆盖 SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart
  `reload/cstore`；不依赖 BBS、third-party cart 或 `ref/`。
- canonical PCM、input/RAM/persistence/overlay trace 在 Node real-WASM 与 Chrome production
  path 满足各自 exact/tolerance oracle。
- 44.1/48kHz device output、input lifecycle、storage error/migration、fault/reset/stale generation、
  ordinary performance 与 bounded soak 通过；0 个开放 P0/P1。
- 归档不可变 Phase 3 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
