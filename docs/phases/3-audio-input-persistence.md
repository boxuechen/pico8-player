# Phase 3 — Audio、Input 与 Persistence

> 状态：Active；当前 work unit：3A
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
| 3A | Deterministic SFX Core | **Active** | `sfx()` 驱动 4-channel browser-neutral synth，产生 deterministic 22050Hz PCM |
| 3B | Music 与 Browser Audio | Planned | `music()`/P8SCII audio、logical PCM chunks 和真实 AudioWorklet output 闭环 |
| 3C | Controller Input | Planned | player 0..7、keyboard/gamepad/touch 的 deterministic controller snapshots |
| 3D | Devkit Input | Planned | input-only `stat()`、mouse/keyboard queue 和 pointer-lock lifecycle |
| 3E | Cartdata Core | Planned | 同步 `cartdata/dget/dset` 与 256-byte browser-neutral mirror |
| 3F | IndexedDB Persistence | Planned | preboot hydrate、durable commit、migration 与 failure-visible fallback |
| 3G | Current-cart `reload/cstore` | Planned | 无 resolver 的 current-cart ROM/overlay 同步路径 |
| 3H | Conformance 与 Phase Exit | Planned | Node real-WASM 与 Chrome 通过 audio/input/persistence、性能和恢复门禁 |

## Active work unit：3A

### Observable behavior

1. Production VM 注册 `sfx(n, [channel], [offset], [length])`；支持 channel `0..3`、默认
   自动选择、channel `-2` 按 SFX 停止，以及 `n=-1/-2` 的 stop/release commands。
2. RuntimeCore `AudioSynth` 从当前 Pico RAM `0x3200..0x42ff` live-read 64 个 SFX：32 notes、
   speed、loop/length、built-in/custom waveform、volume、pitch、effect 和 v0.2.7 filter state
   不在 bridge 或 browser layer 复制语义。
3. synth 拥有四个 channel、noise/custom-instrument deterministic state 和 monotonic sample index；
   reset/destroy/fault/new generation 清空所有 channel，不让旧声音泄漏。
4. canonical output 固定为 22050Hz mono signed PCM16LE。30Hz 每 committed slice 生成 735
   samples；60Hz 使用整数 remainder 交替生成 367/368，禁止读取 wall clock 或使用累计浮点时间。
5. 相同 RAM、API sequence、logical slice 和 reset trace 产生 bit-exact PCM/event/channel trace；
   设备 resampling、`music()`、AudioContext 和 MessagePort 不进入 3A。
6. malformed/unsupported 参数必须在 side effect 前得到手册兼容的 no-op/structured behavior；
   render request 和 custom-instrument recursion 有明确上限，不能 hang Worker 或无界分配。

### 允许修改的范围

- `spec/phase-3-audio-input-persistence-contract.json`
- `spec/pico-api-inventory.yaml`、`spec/abi/**`
- `tools/wasm/generate-host-bindings.mjs`
- `wasm/bridge/p8w_frame_runtime.*` 与生成 header
- `packages/runtime-core/src/{audio,frame-runtime.ts,pico-api,public.ts}`
- `packages/z8lua-bridge/src/**`
- `tests/{runtime,wasm,architecture,golden}/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `apps/web-player/src/{main,transport,worker,worklet}` 的既有 Phase 0F transport；
不得修改 `docs/evidence/**`；不得把 `music/stat/cartdata/reload/cstore` stub 加入 production binding。

### Routed contracts

- [WASM import 与 host-call frame](../03-z8lua-wasm-bridge.md#7-wasm-import-与-host-call-frame)
- [Fixed-point 值编码](../03-z8lua-wasm-bridge.md#81-fixed-point)
- [AudioSynth 与 AudioWorklet 责任边界](../04-typescript-runtime.md#8-audiosynth-与-audioworklet)
- [确定性契约](../04-typescript-runtime.md#14-确定性契约)
- [Audio golden](../06-testing-compatibility.md#74-audio)
- [性能场景预算](../06-testing-compatibility.md#102-场景预算)
- [RuntimeCore/z8lua ownership](../08-source-layout-and-boundaries.md#2-package-职责)
- [WASM/spec/generated ownership](../08-source-layout-and-boundaries.md#7-wasmspec-与生成物)
- [ADR-006](../adr/006-interop-hot-path-boundary.md)、[ADR-008](../adr/008-schema-generated-host-bindings.md)、
  [ADR registry（ADR-014）](../07-decisions-risks-open-questions.md#1-adr-registry)

### Verification

3A 必须新增 `pnpm run test:phase-3a`，覆盖：

- `sfx()` default/explicit/stop/release/offset/length 与 channel stealing/reservation-independent rules。
- 64 SFX RAM decode、note speed/loop/length、built-in/custom waveform、effect/filter vectors。
- 30/60Hz exact sample counts、PCM16LE byte order、sample/event/channel golden hash。
- live RAM mutation boundary、fresh session、cold reset、destroy/stale generation 和 deterministic replay。
- invalid inputs、zero-volume/speed edge、custom-instrument recursion/resource cap 与 no-hang behavior。
- Phase 0F audio transport、Phase 1/2 frame/RAM/graphics 和 architecture regression。

最终门禁：

```text
pnpm run test:phase-3a
pnpm run verify
git status --short
```

### 3A exit gate

- 上述 observable behavior 全部有 production source、real-WASM cart 和 PCM golden 证据。
- `AudioSynth` public surface 最小且 browser-neutral；z8lua bridge 只包含 append-only typed binding。
- `pico-api-inventory.yaml` 将 `sfx` 标为本 unit 实际达到的 compatibility status。
- machine contract 保存 binding id、format、golden hash、known differences 和 verification commands。
- 3A 独立提交后 worktree 干净；随后才折叠本节并激活 3B。

## Phase exit gate

- 3A–3H 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned carts 覆盖 SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart
  `reload/cstore`；不依赖 BBS、third-party cart 或 `ref/`。
- canonical PCM、input/RAM/persistence/overlay trace 在 Node real-WASM 与 Chrome production
  path 满足各自 exact/tolerance oracle。
- 44.1/48kHz device output、input lifecycle、storage error/migration、fault/reset/stale generation、
  ordinary performance 与 bounded soak 通过；0 个开放 P0/P1。
- 归档不可变 Phase 3 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
