# Phase 3 — Audio、Input 与 Persistence

> 状态：Active；当前 work unit：3C
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
| 3C | Controller Input | **Active** | player 0..7、keyboard/gamepad/touch 的 deterministic controller snapshots |
| 3D | Devkit Input | Planned | input-only `stat()`、mouse/keyboard queue 和 pointer-lock lifecycle |
| 3E | Cartdata Core | Planned | 同步 `cartdata/dget/dset` 与 256-byte browser-neutral mirror |
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

## Active work unit：3C

### Observable behavior

1. 把 `PicoInputSnapshot` 从 player-0 单 mask 扩展为固定 8-player、每人 6-bit 的 normalized
   snapshot。Worker 在每个 simulation slice 开始锁存一次；同一 slice、HostRequest resume 和
   deterministic replay 都复用该 snapshot，不把 DOM timestamp 或 device object 传入 RuntimeCore。
2. `btn(b, [pl])` 与 `btnp(b, [pl])` 支持 player `0..7`；缺省 player 为 0。`btn()` 无参数返回
   player 0/1 的组合 bitfield（P0 bits `0..5`、P1 bits `8..13`），invalid button/player 保持既有
   no-op/false profile。`0x5f4c..0x5f53` 是八名玩家 held mask 的 RAM 权威值。
3. 每名玩家独立维护 held、edge、duration 与 `0x5f5c/0x5f5d` repeat；30/60Hz 换算沿用
   Phase 1D 规则。load/reset/stop/fault/dispose 和 stale generation 清除所有玩家状态。
4. main thread 的 input hub 以来源为单位维护 keyboard、Gamepad 与 touch mask，再按 player
   做 bitwise OR；释放一个 alias/source 不得清除其他仍 held 的同一按钮。Worker 只接收合并后的
   normalized snapshot，device connect/disconnect 不改变 simulation clock。
5. keyboard 保留 player 0 aliases，并实现手册的 player 1 默认映射；Gamepad 在 rAF pulse 前
   poll `navigator.getGamepads()`，使用稳定 browser slot `0..7`、standard mapping、d-pad/axes
   hysteresis 和 O/X button mapping；disconnect 立即清除该 source。
6. player shell 提供可隐藏的六键 multitouch controls。Pointer capture、multi-pointer、
   `pointerup/cancel/lostpointercapture`、blur 与 visibility 必须成对清理；touch UI 只产生 controller
   masks，不写 RAM、不实现 devkit mouse/pointer-lock，也不改变 Canvas renderer。

### 允许修改的范围

- `spec/phase-3-audio-input-persistence-contract.json`、`spec/pico-api-inventory.yaml` 与 input DTO owner
- `packages/contracts/src/**` 的 normalized input contract
- `packages/runtime-core/src/{input,frame-runtime.ts,pico-api,session,public.ts}`
- `apps/web-player/src/{transport,worker,main}/**` 的 input protocol、hub 与 shell controls
- `tests/{runtime,browser,architecture,conformance,golden}/**`、`tools/browser/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `docs/evidence/**`；不得把 KeyboardEvent、Gamepad、PointerEvent、DOM 或 clock source
带入 RuntimeCore；不得实现 3D/4D 的 `stat()`、devkit mouse/keyboard queue、pointer lock，或把
controller state 写入 audio/graphics adapter。Phase 0F audio protocol 与 queue 水位必须保持。

### Routed contracts

- [Input ownership 与逐 slice latch](../04-typescript-runtime.md#9-input)
- [Chrome integration gate](../06-testing-compatibility.md#112-chrome--chromium-集成测试)
- [RuntimeCore/app execution ownership](../08-source-layout-and-boundaries.md#2-package-职责)
- [官方 BTN/BTNP 与默认 keyboard mapping](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)

### Verification

3C 必须新增 `pnpm run test:phase-3c` 与 `test:phase-3c:chrome`，覆盖：

- real-WASM `btn/btnp` 的 player 0..7、no-arg P0/P1 bitfield、RAM registers、independent
  edge/repeat、30/60Hz 与 invalid arguments。
- fixed snapshot validator、Worker latest-sequence/stale-generation、catch-up slice latch、cold reset、
  fault/stop/dispose clear 与 deterministic eight-player replay golden。
- keyboard aliases/player 1、simultaneous multi-source merge、Gamepad axis hysteresis/button/disconnect、
  touch multi-pointer/cancel/capture 和 focus/visibility clear 的 unit tests。
- Chrome production cart 同时观察 keyboard、injected deterministic Gamepad source 与真实 PointerEvent
  touch controls；Canvas、audio、rAF responsiveness 与 generation recovery 不回归。
- `pnpm run test:phase-3b`、Phase 1D/1E input/scheduler、Phase 2/architecture regression。

最终门禁：

```text
pnpm run test:phase-3c
pnpm run test:phase-3c:chrome
pnpm run verify
git status --short
```

### 3C exit gate

- RuntimeCore 只接收固定、browser-neutral 的八玩家 snapshot，所有 device policy 留在 app。
- `btn/btnp`、RAM 和 repeat state 对八名玩家可独立验证，reset/fault/stale generation 不泄漏输入。
- keyboard、standard Gamepad 与 multitouch production adapters 在 Chrome gate 中驱动同一 cart，
  disconnect/cancel/blur 后没有 stuck buttons。
- machine contract 保存 snapshot shape、mapping policy、golden、Chrome environment、known differences 和命令。
- 3C 独立提交后 worktree 干净；随后才折叠本节并激活 3D。

## Phase exit gate

- 3A–3H 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned carts 覆盖 SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart
  `reload/cstore`；不依赖 BBS、third-party cart 或 `ref/`。
- canonical PCM、input/RAM/persistence/overlay trace 在 Node real-WASM 与 Chrome production
  path 满足各自 exact/tolerance oracle。
- 44.1/48kHz device output、input lifecycle、storage error/migration、fault/reset/stale generation、
  ordinary performance 与 bounded soak 通过；0 个开放 P0/P1。
- 归档不可变 Phase 3 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
