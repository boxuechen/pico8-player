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
| 3D | Devkit Input | **Active** | input-only `stat()`、mouse/keyboard queue 和 pointer-lock lifecycle |
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

## Completed work unit：3C

固定八玩家 `PicoInputSnapshot.controllers`、逐 slice `btn/btnp` latch、`0x5f4c..0x5f53`、
keyboard P0/P1、standard Gamepad 和 multitouch 已完成。snapshot shape、replay golden、Chrome
150 production 结果与 known differences 由机器合同的 `workUnits.3C.result` 保存；可执行回归为
`pnpm run test:phase-3c`，兼容矩阵见
[15.14](../06-testing-compatibility.md#1514-phase-3c-controller-input-矩阵)。

## Active work unit：3D

### Observable behavior

1. 追加 operation `33` 的同步 `stat(x)` binding，但只实现手册 devkit input selectors：
   `30` key available、`31` consume next character、`32/33` logical mouse x/y、`34` mouse buttons、
   `36` wheel event、`38/39` pointer-lock relative movement。其他 `stat()` selectors 返回 `false`，
   完整 system/audio/memory/clipboard/network `stat()` 保持 Deferred。
2. `0x5f2d` 是 enable flags 的 RAM 权威值：bit `0` 启用 devkit input；bit `1` 将 left/right/middle
   mouse buttons 叠加为 player 0 的 `btn(4)..btn(6)`；bit `2` 请求 pointer-lock relative mode。
   controller DTO 仍保持 3C 的 8×6-bit shape；button 6 只由 RuntimeCore 的 devkit overlay 产生，
   并在启用期间进入 `btn/btnp` 与 `0x5f4c` 的有效 held mask。
3. `PicoInputSnapshot` 增加固定 browser-neutral `devkit` batch：Q16.16 raw logical x/y、3-bit
   mouse buttons、signed wheel/relative x/y 和最多 64 个 P8SCII bytes。Worker 对 state 使用 latest
   snapshot，对 delta/event 使用 accept-once accumulator；catch-up 的第一个 simulation slice 消费
   pending batch，后续 slice 不重复 key/wheel/movement。
4. RuntimeCore 持有最大 64-byte FIFO。`stat(30)` 只观察，`stat(31)` 每次消费一个单-byte string，
   空队列返回空 string；同 slice mouse position/buttons 稳定，wheel/relative movement 是该 slice
   累积值并在下一 slice 归零。queue 满时 deterministic drop newest；reset/load/stop/fault/dispose
   和 generation change 清空 queue、delta、buttons 与 devkit flag presentation state。
5. main thread 新增 `DevkitInputFrontend`：canvas client coordinates 映射并 clamp 到 logical
   `0..127`；mouse bitfield 为 left/right/middle；wheel 只按方向归一到 `-1/0/1`；keyboard 使用
   `KeyboardEvent.key` 的 Latin-1/P8SCII single byte，并显式映射 Backspace、Tab、Enter、Escape、
   Delete。IME composition、extended Unicode/P8SCII 和 clipboard 不在 3D。
6. Worker state/frame event 携带 `devkitFlags` 供 app adapter 使用，但 RuntimeCore 不接收 DOM object。
   bit `2` 只在下一次 trusted canvas primary-button gesture 调用 `requestPointerLock()`；
   `pointerlockchange/error`、context menu、blur、visibility、pause/stop/reset/fault/dispose 必须成对
   退出 lock 并清事件。pointer-lock movement 保留 host desktop pixel 口径，不缩放为 canvas pixel。

### 允许修改的范围

- `spec/{abi/pico-host-api-v1.json,phase-3-audio-input-persistence-contract.json,pico-api-inventory.yaml}`
  与对应 generated binding manifest/artifacts
- `packages/contracts/src/**` 的 normalized devkit input batch contract
- `packages/runtime-core/src/{input,frame-runtime.ts,pico-api,session,public.ts}` 的 devkit latch/FIFO/stat
- `packages/z8lua-bridge/src/**`、`wasm/bridge/**` 中 operation 33 的 selector-tagged return
- `apps/web-player/src/{transport,worker,main}/**` 的 event accumulator、DOM adapter 与 pointer-lock lifecycle
- `tests/{runtime,browser,architecture,conformance,golden}/**`、`tools/browser/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `docs/evidence/**`；不得把 `KeyboardEvent`、`MouseEvent`、`WheelEvent`、DOM 或 pointer-lock
API 带入 RuntimeCore；不得实现未列出的 `stat()` selectors、clipboard/IME、mobile touch-as-mouse、
GPIO/file/drop input 或 3E persistence。不得让 pointer lock、event arrival 或 browser repeat 改变
simulation clock。Phase 0F audio 和 Phase 3C controller protocol 回归必须保持。

### Routed contracts

- [Input ownership、逐 slice latch 与 devkit boundary](../04-typescript-runtime.md#9-input)
- [Chrome integration gate](../06-testing-compatibility.md#112-chrome--chromium-集成测试)
- [RuntimeCore/app execution ownership](../08-source-layout-and-boundaries.md#2-package-职责)
- [官方 Mouse and Keyboard Input](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#Mouse_and_Keyboard_Input)

### Verification

3D 必须新增 `pnpm run test:phase-3d` 与 `test:phase-3d:chrome`，覆盖：

- generated operation 33、real-WASM selector return types、unsupported selector false、queue order/consume/
  empty/full、Q16 coordinates、wheel/relative per-slice latch 和 bit `1` 的 `btn(4)..btn(6)` edge/repeat。
- fixed devkit DTO validator、Worker accept-once event/delta accumulator、catch-up no-duplicate、latest pointer
  state、stale sequence/generation、load/reset/fault/stop/dispose clear 与 deterministic replay golden。
- main adapter 的 canvas coordinate/DPR-independent transform、mouse bitfield、wheel normalization、Latin-1/
  control-key mapping、queue bound、focus/visibility 和 pointer-lock change/error/exit unit tests。
- Chrome production cart 观察真实 mouse move/buttons/wheel/keyboard queue；trusted CDP canvas gesture 进入
  pointer lock，relative movement可见；blur/reset/fault 后 lock 与 state 清除，Worker/Canvas/rAF/audio 不回归。
- `pnpm run test:phase-3c`、`test:phase-3b:chrome`、Phase 1D/1E、Phase 2 和 architecture regression。

最终门禁：

```text
pnpm run test:phase-3d
pnpm run test:phase-3d:chrome
pnpm run verify
git status --short
```

### 3D exit gate

- `stat()` 只暴露列出的 input selectors，mixed string/numeric/boolean result 不破坏既有 call-frame ABI。
- RuntimeCore 只消费 browser-neutral state/event batch；event 在 catch-up 与 replay 中 exactly once。
- production Chrome 的 mouse、wheel、keyboard FIFO 与 trusted pointer lock 驱动同一 cart，所有 lifecycle
  路径无 stuck lock、button、delta 或 keypress。
- machine contract 保存 DTO/queue/ABI policy、golden、Chrome environment、known differences 和命令。
- 3D 独立提交后 worktree 干净；随后才折叠本节并激活 3E。

## Phase exit gate

- 3A–3H 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned carts 覆盖 SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart
  `reload/cstore`；不依赖 BBS、third-party cart 或 `ref/`。
- canonical PCM、input/RAM/persistence/overlay trace 在 Node real-WASM 与 Chrome production
  path 满足各自 exact/tolerance oracle。
- 44.1/48kHz device output、input lifecycle、storage error/migration、fault/reset/stale generation、
  ordinary performance 与 bounded soak 通过；0 个开放 P0/P1。
- 归档不可变 Phase 3 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
