# Phase 2 — Graphics、Memory 与 Text

> 状态：Active；当前 work unit：2F
> 机器合同：[`spec/phase-2-graphics-memory-text-contract.json`](../../spec/phase-2-graphics-memory-text-contract.json)
> 前置证据：[`Phase 1 L1 exit`](../evidence/phase-1/21-phase-1-l1-exit-evidence.md)
> 浏览器门禁：Google Chrome / Chromium desktop only

## 目标与边界

Phase 2 完成大多数可视 cart 所需的 Base RAM、绘图和文本行为，同时保持 RuntimeCore、
z8lua adapter 与浏览器 presenter 的既有边界。官方 PICO-8 v0.2.7 手册是行为规范；机器
合同与本文件决定本阶段实际授权范围。

稳定输入：

- Phase 1 的 callback/custom-loop、session、input、Worker protocol 和 Canvas presenter。
- ADR-013 的唯一 C++ canonical address mapper 与固定 WASM memory。
- ADR-008 的 `spec -> generated C/TS bindings` 单向生成规则。
- ADR-006 的 primitive/pointer ABI 与 profile-first 优化阶梯。

Non-goals：

- AudioSynth、完整设备 input、persistence、`cartdata`、`reload`、`cstore`。
- BBS、网络 resolver、第三方 cart corpus、编辑器或 PICO-8 console。
- Firefox、WebKit、Safari 和官方全量/bit-exact 兼容声明。
- 通过 Canvas drawing/text API 实现 guest graphics 或 P8SCII 语义。

## Work units

| Unit | 名称 | 状态 | 主要可观察结果 |
| --- | --- | --- | --- |
| 2A | Canonical Memory 与 Host ABI | Complete | Base RAM API 与所有 runtime access 共用唯一 mapper；ABI 可承载 Phase 2 参数和 byte strings |
| 2B | Draw State 与基础图元 | Complete | camera/clip/palette/fillp 与现有图元、display palette 端到端一致 |
| 2C | Sprite Sheet 与 Blitter | Complete | `sget/sset/spr/sspr` 产生确定 framebuffer |
| 2D | Map、Flags 与 `tline` | Complete | map remap、layer flags 和 fixed-point texture sampling 可复现 |
| 2E | P8SCII 与 Custom Font | Complete | byte-oriented `print/cursor`、内建字体和 custom font 可复现 |
| 2F | Conformance 与 Phase Exit | **Active** | Node real-WASM 和 Chrome production 路径通过 golden、性能与恢复门禁 |

## Completed work unit：2A

结果由 [`spec/phase-2-graphics-memory-text-contract.json`](../../spec/phase-2-graphics-memory-text-contract.json)
的 2A record、`tests/runtime/phase-2a-memory-abi.test.mjs`、generated binding manifest 和
`wasm/runtime-v1.manifest.lock.json` 锁定。`pnpm run test:phase-2a` 与 aggregate verify 通过；
后续阶段不得重新引入 TypeScript video-base switch 或固定六参数 import。

## Completed work unit：2B

结果由 [`spec/phase-2-graphics-memory-text-contract.json`](../../spec/phase-2-graphics-memory-text-contract.json)
的 2B record、`tests/runtime/phase-2b-draw-state.test.mjs`、`tests/browser/phase-2b.*`、generated
binding manifest 和 runtime manifest 锁定。standard packed-4bpp 下的 RAM-backed draw state、基础
图元、display palette Worker DTO 与 Chrome Canvas 路径均已通过；advanced screen/bitplane mode
仍不在兼容声明内。

## Completed work unit：2C

结果由 [`spec/phase-2-graphics-memory-text-contract.json`](../../spec/phase-2-graphics-memory-text-contract.json)
的 2C record、`tests/runtime/phase-2c-sprites.test.mjs`、`tests/browser/phase-2c.*`、generated
binding manifest 和 runtime manifest 锁定。`sget/sset/spr/sspr` 共用 canonical mapped GFX，
standard-4bpp scaling/flip/palette/transparency/fill-pattern 与 Chrome production path 均已通过；
presenter 和 Worker frame DTO 未增加 sprite-specific dependency。

## Completed work unit：2D

结果由 [`spec/phase-2-graphics-memory-text-contract.json`](../../spec/phase-2-graphics-memory-text-contract.json)
的 2D record、`tests/runtime/phase-2d-map-tline.test.mjs`、`tests/browser/phase-2d.*`、generated
binding manifest 和两个 WASM artifact manifest 锁定。独立 `PicoMapMemory` 解释 lower ring/
upper region，canonical C++ mapper 只增加 upper-map/video arbitration；`map/tline` 复用 2C
sprite raster，Chrome frame DTO 未增加 tile state。`tline(bits)` precision overload 不在 2D claim。

## Completed work unit：2E

结果由 [`spec/phase-2-graphics-memory-text-contract.json`](../../spec/phase-2-graphics-memory-text-contract.json)
的 2E record、`tests/runtime/phase-2e-p8scii.test.mjs`、`tests/browser/phase-2e.*`、字体 provenance
与两个 WASM artifact manifest 锁定。append-only binding id `29..30` 已承载同步 byte string；
RuntimeCore software renderer 支持内建/custom font、visual controls、cursor/scroll 与 mapped screen，
Chrome frame DTO 没有新增 text state。P8SCII audio/timed controls、advanced screen/bitplane mode 与
`tline(bits)` 继续作为已声明差异。

## Active work unit：2F

### Observable behavior

1. 在 `tests/conformance/carts/phase-2/` 建立至少两个项目自有、可审阅 cart。合并覆盖 Base RAM、
   draw state/primitives、sprite、map/flags/tline、P8SCII/custom font 与 remap；不得下载 BBS cart、
   引入第三方 corpus 或依赖 `ref/`。
2. 用 machine-readable manifest 锁定 cart bytes/source、期望 packed screen、相关 RAM、draw state、
   display palette 与 frame trace hash。oracle 必须来自项目可审阅预期，不从被测实现运行结果
   无审查地自举。
3. Node real-WASM 对每个 cart 执行 fresh session、确定帧数、cold reset/replay，并证明同一 oracle
   可重复；Chrome production Worker/Canvas 路径必须得到相同最终 screen/palette 和可见像素。
4. 添加代表 Phase 2 graphics/text frame 的 Chrome 性能采样，发布门禁为 p95 ≤ 8 ms。若未触发
   门禁不得进行大范围优化；若触发，只能沿 ADR-006 profile-first ladder 修改且保持全部 golden。
5. 覆盖 malformed/resource fault、structured error、stale generation rejection 与随后加载有效 cart
   的恢复路径；资源限制不得造成 Worker hang、跨 session 状态泄漏或部分提交。
6. 汇总 2A–2F compatibility matrix，开放 P0/P1 必须为 0。只关闭 project-owned Phase 2 profile，
   不宣称官方 bit-exact、第三方 playable rate 或 Firefox/WebKit 支持。
7. 通过全部门禁后创建不可变 `docs/evidence/phase-2/` 退出证据，关闭机器合同、压缩 roadmap，
   删除本 active phase 文档，并以独立 commit 保持 worktree 干净。

### 允许修改的范围

- `tests/conformance/carts/phase-2/**`、对应 machine manifest/oracle
- `tests/{runtime,browser,architecture}/**`、`tools/browser/**`、`package.json`
- 仅为 conformance 暴露所需的既有 package public contract；语义缺陷修复必须附 regression
- `spec/phase-2-graphics-memory-text-contract.json`、`spec/pico-api-inventory.yaml`
- Phase 2 直接拥有的状态、compatibility matrix 与最终 `docs/evidence/phase-2/**`

不得扩展 AudioSynth/input/persistence/BBS；不得为了 benchmark 复制 graphics 实现或改变
Canvas/Worker ownership；`ref/` 始终不进入 build/test/import。

### Routed contracts

- [Runtime ownership 与 frame transaction](../02-system-architecture.md#2-所有权与共享内存)
- [Host ABI 与 byte lifetime](../03-z8lua-wasm-bridge.md#7-wasm--ts-host-api-abi)
- [Graphics behavior](../04-typescript-runtime.md#7-graphics)
- [确定性模型](../04-typescript-runtime.md#14-确定性契约)
- [Conformance 分层](../06-testing-compatibility.md#4-conformance-测试分层)
- [Golden contract](../06-testing-compatibility.md#7-goldenframebufferram-与-audio)
- [性能门禁](../06-testing-compatibility.md#10-jswasm-microbench-与性能门禁)
- [Chrome support matrix](../06-testing-compatibility.md#11-chromechromium-支持矩阵)
- [Composition roots](../08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期)
- [ADR-006](../adr/006-interop-hot-path-boundary.md)、[ADR-009](../adr/009-canvas2d-frame-presenter.md)、[ADR-013](../adr/013-shared-pico-ram-boundary.md)

### Verification

2F 必须新增独立 aggregate gate，至少覆盖：

- corpus manifest/source/oracle hash 与 license/ownership；禁止 `ref/` dependency。
- 所有 cart 的 Node real-WASM fresh/reset replay、RAM/screen/draw-state/palette exact match。
- Chrome production Worker/Canvas cart replay、同一最终 oracle、p95 ≤ 8 ms。
- fault → generation reset → valid cart recovery 与 stale response rejection。
- Phase 0C、Phase 1 exit、Phase 2A–2E regressions 及 architecture boundary。

最终门禁：

```text
pnpm run test:phase-2f
pnpm run test:phase-2f:chrome
pnpm run verify
git status --short
```

### 2F exit gate

- project-owned corpus 的 Node/Chrome oracle、reset deterministic、performance 与 recovery 全通过。
- compatibility matrix 没有开放 P0/P1，known differences 与实际范围一致。
- Phase 2 immutable evidence 与关闭后的 machine contract 可独立复核。
- 2F 独立提交后 worktree 干净，Phase 3 仍保持未激活。

## Phase exit gate

- 2A–2F 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned conformance carts 覆盖 memory/draw state、sprite/map/tline 和 P8SCII/custom font。
- framebuffer、相关 RAM、draw state 和 display palette golden 在 Node real-WASM 与 Chrome
  production Worker 路径一致。
- 性能优化遵守 ADR-006，0 个开放 P0/P1；Known Differences 与兼容矩阵已同步。
- 归档不可变 Phase 2 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
