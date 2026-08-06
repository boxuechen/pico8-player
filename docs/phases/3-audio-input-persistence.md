# Phase 3 — Audio、Input 与 Persistence

> 状态：Active；当前 work unit：3G
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
| 3G | Current-cart `reload/cstore` | **Active** | 无 resolver 的 current-cart ROM/overlay 同步路径 |
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
和 durable write 不在 RuntimeCore 内；3F 已在 Worker-owned IndexedDB adapter 完成。

## Completed work unit：3F

browser-neutral `CartDataPersistencePort`、Worker-owned IndexedDB schema/adapter、preboot hydrate、
latest-per-ID commit coalescing、lifecycle flush、legacy migration 和 recoverable diagnostics 已完成。
Node fake-port 与 Chrome production 结果由机器合同的 `workUnits.3F.result` 保存；可执行回归为
`pnpm run test:phase-3f`，兼容矩阵见
[15.17](../06-testing-compatibility.md#1517-phase-3f-indexeddb-persistence-矩阵)。

## Active work unit：3G

### Observable behavior

1. 激活 guest `reload(dest?,src?,len?)` 与 `cstore(dest?,src?,len?)`，使用 append-only operations
   `37..38` 和既有 Q16.16 raw/presence-mask ABI；默认值固定为 `0,0,0x4300`，返回 `nil`。
2. 当前 cart 的规范化 ROM `0x0000..0x42ff` 是唯一初始 data source。Worker repository 按
   `CartIdentity.contentSha256` 保存 original snapshot 与 copy-on-write overlay；不得把 mutable ROM view
   暴露给 RuntimeCore。`0x4300..0x7fff` code container 永远不可由这两个 API 读写。
3. `reload` 必须在 guest 调用返回前，把 effective ROM（overlay 优先、否则 original）指定区间复制到
   live Base RAM；`cstore` 必须先从 live Base RAM 复制稳定 snapshot，再同步更新当前 cart overlay。
   同一调用栈内 `cstore` 后紧接 `reload` 必须看到新 bytes；重叠区间使用 snapshot-copy 语义。
4. destination/source/length 使用现有 `raw >> 16` integer conversion 后完整验证：RAM 端必须位于
   `0..0xffff`，ROM 端必须位于 `0..0x42ff`；负值、overflow/out-of-range 在任何 mutation 前产生
   `E_HOST_API`。
5. overlay 在一个 production Worker lifetime 内按 identity 隔离；reset 与再次 load 相同 bytes/identity
   必须保留，切换到不同 identity 不得泄漏。Worker dispose 后丢弃；3G 不把 overlay 写入 cartdata
   IndexedDB，也不覆写用户本地 cart 文件。
6. filename/ref 参数、guest `load()`、external cart、resolver、BBS、network 与 multicart 不激活；只要
   调用了带 ref 的 overload，就在 mutation 前返回 `E_FEATURE_UNSUPPORTED`。current-cart path 必须纯同步，
   不产生 HostRequest、不进入 waiting state，也不改变 frame/audio/cartdata transaction 顺序。

### 允许修改的范围

- `spec/abi/pico-host-api-v1.json`、generated bindings、WASM bridge 及其 manifest，只允许 append
  `reload/cstore` 两个同步 binding；不得改写既有 operation ID
- `packages/runtime-core/src/{ports,memory,pico-api,frame-runtime,session,public}.ts` 中 browser-neutral
  current-cart repository contract、range/copy logic 和 generation wiring
- `apps/web-player/src/worker/{adapters/cart-repository-adapter.ts,compose-runtime.ts}` 的 Worker-local
  original/overlay repository 与 identity composition；不得把 ROM/overlay authority搬到 Window
- `tests/{runtime,browser,architecture,fixtures,golden}/**`、`tools/browser/**`、`package.json`、WASM/phase
  machine contract、兼容矩阵和本 active 文档

不得修改 `docs/evidence/**`；不得实现 guest `load`、HostRequest suspension、任意 ref/filename、URL/BBS、
multicart、overlay IndexedDB schema、local file overwrite、export UI 或通用 save-state。不得把 32 KiB cart
container 当成全部可读写 data ROM，也不得让 cartdata namespace 与 per-cart overlay 共用 key space。

### Routed contracts

- [CartLoader/repository capability 与 data ROM 范围](../04-typescript-runtime.md#54-cartloader-与资源边界)
- [`load/reload/cstore` bounded target](../04-typescript-runtime.md#13-loadreloadcstore-与-cart-swap)
- [RuntimeCore/app package ownership](../08-source-layout-and-boundaries.md#2-package-职责)
- [官方 Memory `reload/cstore`](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#Memory)

### Verification

3G 必须新增 `pnpm run test:phase-3g`，覆盖：

- real-WASM default/explicit `reload/cstore`、same-stack visibility、Q16 integer/range/code protection、
  source/destination overlap、zero length 和 mutation-before-fault assertions。
- repository original/overlay copy ownership、different identity isolation、reset/same-identity load preservation、
  dispose clear，以及 ref overload `E_FEATURE_UNSUPPORTED` 无副作用。
- Chrome production cart 通过 screen/RAM trace 证明 cstore→reload、reset/same-identity 与不同 identity；
  0 Worker errors，且既有 IndexedDB cartdata 仍通过。
- 3F persistence、3E cartdata、Phase 2 memory/graphics、audio/input 与 architecture 回归。

最终门禁：

```text
pnpm run test:phase-3g
pnpm run test:phase-3f:chrome
pnpm run verify
git status --short
```

### 3G exit gate

- current-cart reload/cstore 在 WASM import 内同步完成且只访问 `0x0000..0x42ff`；code/container 受保护。
- overlay copy-owned、identity-scoped、reset-safe、Worker-lifetime bounded；不冒充 local-file/IndexedDB durability。
- ref/external/multicart fail closed，invalid range 在 mutation 前失败；不新增 HostRequest 状态。
- Node real-WASM 与 Chrome production gate 通过，机器合同记录 golden/known differences/命令。
- 3G 独立提交后 worktree 干净；随后才折叠本节并激活 3H。

## Phase exit gate

- 3A–3H 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned carts 覆盖 SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart
  `reload/cstore`；不依赖 BBS、third-party cart 或 `ref/`。
- canonical PCM、input/RAM/persistence/overlay trace 在 Node real-WASM 与 Chrome production
  path 满足各自 exact/tolerance oracle。
- 44.1/48kHz device output、input lifecycle、storage error/migration、fault/reset/stale generation、
  ordinary performance 与 bounded soak 通过；0 个开放 P0/P1。
- 归档不可变 Phase 3 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
