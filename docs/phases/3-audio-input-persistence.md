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
| 3E | Cartdata Core | **Active** | 同步 `cartdata/dget/dset` 与 256-byte browser-neutral mirror |
| 3F | IndexedDB Persistence | Planned | preboot hydrate、durable commit、migration 与 failure-visible fallback |
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

## Active work unit：3E

### Observable behavior

1. append-only 分配 operations `34..36`：`cartdata(id)` 接收 byte string 并返回是否加载到既有
   seed；`dget(index)` 返回 raw Q16.16 number；`dset(index,value)` 写 raw Q16.16。三者均为同步
   `PicoApiHost` 调用，不引入 HostRequest、Promise 或浏览器 API。
2. `cartdata` id 必须是 `1..64` bytes，只允许 `a..z`、`0..9`、`_`，每次 cart execution 最多调用
   一次。重复调用、非法 id、未选择 slot 时调用 `dget/dset`、或 index 不在 `0..63`，统一成为
   deterministic `E_HOST_API` fault；不做静默 clamp。
3. RuntimeCore 可在构造时接收 browser-neutral prehydrated seed map；`cartdata(id)` 命中时把对应
   256 bytes 复制到 `0x5e00..0x5eff` 并返回 `true`，未命中时清零该区并返回 `false`。完成选择后
   live Pico RAM 是唯一权威值，`dget/dset` 与直接 `peek/poke/memcpy` 必须完全一致。
4. 每个成功提交的 boot/frame transaction 比较 cartdata RAM 与上次已发布 snapshot。发生变化时
   发布 immutable `{id, bytes, revision}` commit DTO；未激活或未变化时不发布。fault/stopped
   transaction 不得发布未提交写；reset/new generation 清 selection/revision，再由新 runtime 从 seed
   重新 hydrate。
5. 3E 只建立同步 core 与 persistence port seam：seed/commit DTO 不包含 IndexedDB、DOM、时间戳或
   storage object。3F 才负责在 boot 前异步读取 seed、在 committed snapshot 后 durable write、
   migration 和 failure-visible fallback。

### 允许修改的范围

- `spec/{abi/pico-host-api-v1.json,phase-3-audio-input-persistence-contract.json,pico-api-inventory.yaml}`
  与对应 generated bindings/runtime manifest
- `packages/contracts/src/**` 的 cartdata seed/commit DTO
- `packages/runtime-core/src/{persistence,frame-runtime.ts,pico-api,session,public.ts}` 的 selection、
  live-RAM access、dirty snapshot 与 lifecycle
- `packages/z8lua-bridge/src/**`、`wasm/bridge/**` 的 operations `34..36` lowering
- `tests/{runtime,architecture,golden}/**`、`package.json` 和本 work unit 的文档/兼容矩阵

不得修改 `docs/evidence/**`；不得加入 IndexedDB、localStorage、browser storage adapter、异步 boot、
guest `reload/cstore/load` 或 external filename/ref。不得把 cartdata 复制成与 `0x5e00..0x5eff`
并行的运行时权威状态。3D input、Phase 0F/3B audio 和 Phase 2 graphics 回归必须保持。

### Routed contracts

- [RuntimeCore state ownership 与 RAM authority](../04-typescript-runtime.md#72-memory-ownership)
- [Persistence target boundary](../04-typescript-runtime.md#11-persistence)
- [RuntimeCore/app package ownership](../08-source-layout-and-boundaries.md#2-package-职责)
- [官方 Cartridge Data](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#Cartridge_Data)

### Verification

3E 必须新增 `pnpm run test:phase-3e`，覆盖：

- generated operations `34..36`、real-WASM cartdata boolean、signed/fractional Q16 round-trip、all 64
  indices、little-endian bytes 和 direct RAM write coherence。
- id length/charset、single-call、pre-activation/out-of-range errors 都稳定映射为 `E_HOST_API`，且 fault
  transaction 不发布 commit。
- seed hit/miss、exact 256-byte copy isolation、boot/frame dirty detection、no-change suppression、revision、
  immutable copy、reset rehydrate 和 multi-session isolation。
- deterministic golden、3D/3B/Phase 2/architecture regressions；3E 不新增 Chrome 行为门禁。

最终门禁：

```text
pnpm run test:phase-3e
pnpm run test:phase-3d:chrome
pnpm run verify
git status --short
```

### 3E exit gate

- cartdata 的唯一运行时权威值是 live `0x5e00..0x5eff`，API 与直接 RAM access 无分叉。
- seed 输入和 commit 输出都是 browser-neutral immutable DTO，3F 可接 IndexedDB 而无需反向依赖 core。
- real-WASM 正常、边界、fault、reset、isolation 和 golden 通过；无 storage API 越界进入 3E。
- machine contract 保存 ABI/RAM/seed/commit policy、golden、known differences 和命令。
- 3E 独立提交后 worktree 干净；随后才折叠本节并激活 3F。

## Phase exit gate

- 3A–3H 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned carts 覆盖 SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart
  `reload/cstore`；不依赖 BBS、third-party cart 或 `ref/`。
- canonical PCM、input/RAM/persistence/overlay trace 在 Node real-WASM 与 Chrome production
  path 满足各自 exact/tolerance oracle。
- 44.1/48kHz device output、input lifecycle、storage error/migration、fault/reset/stale generation、
  ordinary performance 与 bounded soak 通过；0 个开放 P0/P1。
- 归档不可变 Phase 3 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
