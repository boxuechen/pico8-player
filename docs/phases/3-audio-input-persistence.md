# Phase 3 — Audio、Input 与 Persistence

> 状态：Active；当前 work unit：3B
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
| 3B | Music 与 Browser Audio | **Active** | `music()`/P8SCII audio、logical PCM chunks 和真实 AudioWorklet output 闭环 |
| 3C | Controller Input | Planned | player 0..7、keyboard/gamepad/touch 的 deterministic controller snapshots |
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

## Active work unit：3B

### Observable behavior

1. Production VM 追加 binding `32`：`music(n, [fade_len], [channel_mask])`。实现 start/stop、
   millisecond fade、channel mask、pattern start/loop/stop flags 与 live `0x3100..0x31ff` reads。
2. music sequencer 与 3A SFX 共用唯一四声道和 sample clock；明确 SFX interrupt、music
   reservation/resume、pattern duration 和 stop/fade 后状态，不在 bridge/browser 复制规则。
3. P8SCII control `0x07` 的同步 audio side effect 通过窄的 browser-neutral sink 进入同一
   AudioSynth；visual text renderer 不拥有 channel/music state，timed frame-delay controls 仍 deferred。
4. Runtime Worker 将 startup 和每个 committed frame 的 canonical PCM 转成 versioned
   `audioReset/audioChunk`，只走 ADR-010 dedicated `MessagePort`；一般 player protocol 不携带 PCM。
5. load/reset/fault/stop/dispose 与 stale generation 必须 reset/隔离 Worklet queue；audio port
   未 attach、AudioContext suspended 或 queue backpressure 不得改变 simulation clock。
6. production Chrome 在 44.1/48kHz AudioContext 中能听到项目 cart，linear resampler、bounded
   queue 和 stats 保持既有 Phase 0F 契约；不增加 relay、SAB、Firefox/WebKit 或 wall-clock synth。

### 允许修改的范围

- `spec/phase-3-audio-input-persistence-contract.json`、`spec/pico-api-inventory.yaml`、`spec/abi/**`
- `packages/runtime-core/src/{audio,graphics,frame-runtime.ts,pico-api,public.ts}`
- `packages/z8lua-bridge/src/**`、生成 binding/header
- `apps/web-player/src/{transport,worker,main,worklet}/**` 中现有 audio production path
- `tests/{runtime,phase-0f,browser,architecture,golden}/**`、`tools/browser/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `docs/evidence/**`；不得加入 relay/SAB 或 browser audio state 到 RuntimeCore；不得把
`stat/cartdata/reload/cstore` stub 加入 production binding。Phase 0F protocol version/queue 水位若无需
改变必须保持；确需改变时先更新其 owner spec 并提供完整 Chrome 回归。

### Routed contracts

- [WASM import 与 host-call frame](../03-z8lua-wasm-bridge.md#7-wasm-import-与-host-call-frame)
- [AudioSynth/AudioWorklet 与 dedicated port](../04-typescript-runtime.md#8-audiosynth-与-audioworklet)
- [P8SCII 状态边界](../04-typescript-runtime.md#7-graphics)
- [Audio golden](../06-testing-compatibility.md#74-audio) 与 [Chrome device gate](../06-testing-compatibility.md#112-chrome--chromium-集成测试)
- [RuntimeCore/app execution ownership](../08-source-layout-and-boundaries.md#2-package-职责)
- [ADR-008](../adr/008-schema-generated-host-bindings.md)、[ADR-010](../adr/010-dedicated-messageport-audio-transport.md)、
  [ADR registry（ADR-014）](../07-decisions-risks-open-questions.md#1-adr-registry)

### Verification

3B 必须新增 `pnpm run test:phase-3b` 与 `test:phase-3b:chrome`，覆盖：

- real-WASM `music()` optional raw ABI、invalid/stop/fade/mask 和 live 64-pattern RAM decode。
- start/loop/stop flags、pattern length、SFX interrupt/resume、四声道 reservation 与 deterministic replay。
- P8SCII audio controls 的 command/PCM golden；timed control 仍无 device side effect。
- Worker audio sequence/sample continuity、startup chunk、catch-up multi-chunk、reset/fault/stop/dispose、
  unattached port 和 stale generation。
- Chrome production cart 在 44.1/48kHz 的 received chunks、prebuffer/play、steady underrun/overrun/
  discontinuity/stale 全部满足 case manifest；Canvas/input regression 同时通过。
- `pnpm run test:phase-3a`、Phase 0F audio transport、Phase 1/2 和 architecture regression。

最终门禁：

```text
pnpm run test:phase-3b
pnpm run test:phase-3b:chrome
pnpm run verify
git status --short
```

### 3B exit gate

- `music()`、P8SCII audio 和 SFX interaction 有 production source、real-WASM cart 与 project golden。
- canonical PCM 仅通过 dedicated port 到 Worklet；control protocol 无 PCM，RuntimeCore 无 Web API import。
- Node 与 Chrome 44.1/48kHz gates 通过，queue/generation/lifecycle counters 无未解释异常。
- machine contract 保存 binding、music/audio golden、Chrome environment、known differences 和命令。
- 3B 独立提交后 worktree 干净；随后才折叠本节并激活 3C。

## Phase exit gate

- 3A–3H 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned carts 覆盖 SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart
  `reload/cstore`；不依赖 BBS、third-party cart 或 `ref/`。
- canonical PCM、input/RAM/persistence/overlay trace 在 Node real-WASM 与 Chrome production
  path 满足各自 exact/tolerance oracle。
- 44.1/48kHz device output、input lifecycle、storage error/migration、fault/reset/stale generation、
  ordinary performance 与 bounded soak 通过；0 个开放 P0/P1。
- 归档不可变 Phase 3 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
