# Phase 2 — Graphics、Memory 与 Text

> 状态：Active；当前 work unit：2D
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
| 2D | Map、Flags 与 `tline` | **Active** | map remap、layer flags 和 fixed-point texture sampling 可复现 |
| 2E | P8SCII 与 Custom Font | Planned | byte-oriented `print/cursor`、内建字体和 custom font 可复现 |
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

## Active work unit：2D

### Observable behavior

1. 注册并实现 `mget/mset/fget/fset/map/tline`；binding id 只 append，不重排 1–22。`fget`
   的 bitfield/boolean result 与 `fset` 的 optional boolean 必须保持 Lua 类型和 presence 精确。
2. RuntimeCore 新增唯一 map address resolver：即时读取 `0x5f56` base 与 `0x5f57` width
   （0 表示 256），只允许 `0x1000..0x2fff`、`0x8000..0xffff`，并从剩余连续区域推导 height。
   map remap 不得被塞入通用 `PicoRam.mapAddress()`，也不得缓存第二份 map。
3. `mget/mset` 锁定 fractional/negative/out-of-bounds、custom return `0x5f5a`、width/height 和
   direct physical RAM equality；base `0x30..0x3f` 按共享区 alias 到 `0x10..0x1f`。
4. `fget/fset` 以 `0x3000..0x30ff` 为唯一 flag storage，覆盖整 byte 与单 bit read/write、
   flag index 边界、boolean lowering 和 direct poke 双向可见。
5. `map` 支持默认/显式 source/destination/size、camera/clip、sprite 0 skip override、layer-mask
   filtering，并复用 2C sprite raster path；不得复制 palette、transparency 或 fillp 语义。
6. `tline` 使用 signed Q16.16 `mx/my/mdx/mdy`，默认 delta `(0.125,0)`，按整数 line raster 每
   pixel 采样 map tile 与 sprite texel；实现 `0x5f38..0x5f39` mask、`0x5f3a..0x5f3b` offset、
   layer filter、palette/transparency/fillp 和 camera/clip 的确定顺序。
7. map/GFX/screen upper-memory 冲突必须由一个经过测试的 resolver/arbitration 规则处理；
   standard packed 4bpp 仍是声明边界，Canvas/Worker 不接触 map/tile state。

### 允许修改的范围

- `spec/phase-2-graphics-memory-text-contract.json`
- `spec/pico-api-inventory.yaml`、production host binding schema/generated files
- `tools/wasm/generate-host-bindings.mjs`
- `wasm/bridge/p8w_frame_runtime.*` 与 generated header
- `packages/runtime-core/src/{graphics,memory,frame-runtime.ts,pico-api,public.ts}`
- `packages/z8lua-bridge/src/**`
- `tests/{runtime,browser,architecture}/**`、`tools/browser/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `docs/evidence/**`；不得实现 text/audio/persistence；不得让 Canvas 知道 map、tile 或 tline。

### Routed contracts

- [Shared Pico RAM 与 raw fixed encoding](../03-z8lua-wasm-bridge.md#5-shared-pico-ram)
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

2D 必须新增 `pnpm run test:phase-2d`，覆盖：

- map default/shared/custom/upper base、width `128/256/other`、derived height、invalid/OOB 和 direct RAM vectors。
- `fget/fset` byte/bit/boolean/direct-poke 与 invalid sprite/flag boundaries。
- `map` defaults、tile 0 override、layer combinations、remapped source、camera/clip 与 2C draw-state regression。
- `tline` horizontal/diagonal/reversed line、default/explicit deltas、mask/offset wrap、layer filter 和 fixed-point golden。
- GFX/screen/map upper-memory conflict arbitration，不读取或构建 `ref/`。
- real Chrome production Worker/Canvas map+tline smoke、bounded visible work、Phase 0C/1/2B/2C regressions。

最终门禁：

```text
pnpm run test:phase-2d
pnpm run test:phase-2d:chrome
pnpm run verify
git status --short
```

### 2D exit gate

- map resolver、flag storage、layer selection 与 tline sampler 有 deterministic RAM/frame evidence。
- `map/tline` 复用 shared `PicoRam` 与 sprite raster，presenter/transport 没有新增 tile dependency。
- API inventory/compatibility matrix 不把 bitplane/advanced screen mode 标为 compatible。
- 2D 独立提交后 worktree 干净；随后才折叠本节并激活 2E。

## Phase exit gate

- 2A–2F 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned conformance carts 覆盖 memory/draw state、sprite/map/tline 和 P8SCII/custom font。
- framebuffer、相关 RAM、draw state 和 display palette golden 在 Node real-WASM 与 Chrome
  production Worker 路径一致。
- 性能优化遵守 ADR-006，0 个开放 P0/P1；Known Differences 与兼容矩阵已同步。
- 归档不可变 Phase 2 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
