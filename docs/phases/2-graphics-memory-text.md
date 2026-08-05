# Phase 2 — Graphics、Memory 与 Text

> 状态：Active；当前 work unit：2E
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
| 2E | P8SCII 与 Custom Font | **Active** | byte-oriented `print/cursor`、内建字体和 custom font 可复现 |
| 2F | Conformance 与 Phase Exit | Planned | Node real-WASM 和 Chrome production 路径通过 golden、性能与恢复门禁 |

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

## Active work unit：2E

### Observable behavior

1. 注册 `print` 与 `cursor`，append binding id `29..30`，不重排 1–28。`print` 首次把 production
   byte-string slot 用于 guest Lua string，embedded NUL、非 UTF-8 byte、empty string 与同步 view
   lifetime 必须精确；不得先解码为 JS Unicode。
2. 删除 quiet `print` placeholder；`print(str,x,y,[col])`、`print(str,[col])` overload、返回最右
   x、implicit newline、explicit NUL termination、cursor RAM `0x5f26/27` 与 pen side effect 必须可测。
3. RuntimeCore 新增唯一 byte-oriented text renderer。内建 256 glyph font 数据必须有仓库内
   provenance/license，按 packed bit rows software raster；不得调用 Canvas `fillText/measureText`。
4. 实现同步 visual P8SCII parser：printable bytes、terminate/repeat/background、cursor shift、
   backspace/tab/newline/decorate/foreground/carriage-return、default/custom font switch，以及视觉
   special commands、render modes、one-off glyph/outline/raw-memory-write。每次 `print` 重置临时属性，
   只保留手册规定的 cursor/foreground side effect；malformed/truncated sequence 必须 bounded。
5. 实现 `0x5600..0x5dff` custom font 8×8 rows、font-wide attributes、per-character width/y adjustment、
   custom tab，以及 `0x5f58..0x5f5b` default attributes；所有读取即时来自 shared Pico RAM。
6. implicit cursor output 超过 y=122 时滚动 mapped screen；`0x5f36 & 0x40` 禁用 scroll。
   camera/clip、foreground/background palette 与 text raster ordering 必须确定并留 framebuffer/RAM golden。
7. P8SCII audio command 与 timed delay/frame-skip command 不得在 Phase 2 偷渡 AudioSynth 或新的
   suspension path；登记为 partial/known difference。Canvas/Worker DTO 不增加 glyph/text state。

### 允许修改的范围

- `spec/phase-2-graphics-memory-text-contract.json`
- `spec/pico-api-inventory.yaml`、production host binding schema/generated files
- `tools/wasm/generate-host-bindings.mjs`
- `wasm/bridge/p8w_frame_runtime.*` 与 generated header
- `packages/runtime-core/src/{graphics,memory,frame-runtime.ts,pico-api,public.ts}`
- `packages/z8lua-bridge/src/**`
- `tests/{runtime,browser,architecture}/**`、`tools/browser/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `docs/evidence/**`；不得实现 AudioSynth/persistence；不得让 Canvas 知道 glyph、font 或 P8SCII。

### Routed contracts

- [Shared Pico RAM 与 raw fixed encoding](../03-z8lua-wasm-bridge.md#5-shared-pico-ram)
- [Byte string / P8SCII ABI](../03-z8lua-wasm-bridge.md#82-byte-string--p8scii)
- [Graphics layering 与必须保持的行为](../04-typescript-runtime.md#7-graphics)
- [PicoRam layout 与 remap](../04-typescript-runtime.md#6-picoram64kib-共享地址空间)
- [所有权与 frame transaction](../02-system-architecture.md#2-所有权与共享内存)
- [Composition roots 与 render ownership](../08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期)
- [确定性模型](../04-typescript-runtime.md#14-确定性契约)
- [Framebuffer/RAM golden](../06-testing-compatibility.md#7-goldenframebufferram-与-audio)
- [Chrome/Chromium gate](../06-testing-compatibility.md#11-chromechromium-支持矩阵)
- [interop 性能门禁](../06-testing-compatibility.md#10-jswasm-microbench-与性能门禁)
- [ADR-006](../adr/006-interop-hot-path-boundary.md)、[ADR-008](../adr/008-schema-generated-host-bindings.md)、[ADR-009](../adr/009-canvas2d-frame-presenter.md)、[ADR-013](../adr/013-shared-pico-ram-boundary.md)

### Verification

2E 必须新增 `pnpm run test:phase-2e`，覆盖：

- binding ids、byte-string `0/embedded-NUL/non-UTF8/1024` 与 malformed type/arity/lifetime。
- explicit/implicit `print` overload、return value、cursor/pen RAM、newline/NUL termination、scroll enable/disable。
- built-in ASCII/high P8SCII glyph bitmap、camera/clip/palette/background 和 deterministic framebuffer golden。
- visual control parser 的每类 opcode、nested repeat/decorate/one-off/outline/raw write 与 truncated-input bounds。
- custom font rows/attributes/adjustments/default registers/direct poke equality 和 custom/default switch。
- 至少 10,000 个 deterministic byte arrays 不 crash/hang/OOB；repeat/outline/work 与 input length 有硬上限。
- real Chrome production Worker/Canvas text smoke、无 Canvas text API、Phase 0C/1/2B/2C/2D regressions。

最终门禁：

```text
pnpm run test:phase-2e
pnpm run test:phase-2e:chrome
pnpm run verify
git status --short
```

### 2E exit gate

- byte-string ABI、built-in/custom glyph raster、cursor/scroll 与 visual controls 有 deterministic RAM/frame evidence。
- renderer 全程使用 shared `PicoRam` 和 existing pixel path，presenter/transport 没有新增 text dependency。
- compatibility matrix 明确 audio/timed controls、bitplane/advanced screen 与 `tline(bits)` 的 partial 状态。
- 2E 独立提交后 worktree 干净；随后才折叠本节并激活 2F。

## Phase exit gate

- 2A–2F 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned conformance carts 覆盖 memory/draw state、sprite/map/tline 和 P8SCII/custom font。
- framebuffer、相关 RAM、draw state 和 display palette golden 在 Node real-WASM 与 Chrome
  production Worker 路径一致。
- 性能优化遵守 ADR-006，0 个开放 P0/P1；Known Differences 与兼容矩阵已同步。
- 归档不可变 Phase 2 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
