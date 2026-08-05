# Phase 2 — Graphics、Memory 与 Text

> 状态：Active；当前 work unit：2C
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
| 2C | Sprite Sheet 与 Blitter | **Active** | `sget/sset/spr/sspr` 产生确定 framebuffer |
| 2D | Map、Flags 与 `tline` | Planned | map remap、layer flags 和 fixed-point texture sampling 可复现 |
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

## Active work unit：2C

### Observable behavior

1. 注册并实现 `sget/sset/spr/sspr`；binding id 只 append，不重排 1–18，boolean flip 参数继续
   使用 2B 已验证的 fixed call frame lowering。
2. sprite sheet 的 logical `0x0000..0x1fff` 通过 `PicoRam` 和 adapter canonical mapper 访问；
   GFX remap 到 screen/upper RAM 后，API、direct memory 与 blitter 必须看到同一像素。
3. `sget/sset` 锁定 negative/fractional/out-of-bounds、packed nibble、default/explicit color 与 draw
   palette 行为；不得缓存一份独立 sprite sheet。
4. `spr` 支持 sprite id、fractional `w/h`、camera、clip、flip、draw palette 与 `palt`；sprite
   source rectangle 跨 16-column row 的行为由 project vector 锁定。
5. `sspr` 支持 source rectangle、default/explicit destination size、positive/negative scaling 与
   flip；source sampling 和 destination raster 均为 deterministic integer/fixed-point 规则。
6. 当 fillp 的 apply-to-sprites flag 生效时，sprite pixel 先应用 draw palette，再以 secondary
   palette 取得 pattern pair；global-secondary primitive 行为不得回归。
7. standard 128×128 packed 4bpp 是本 unit 的兼容声明；bitplane/screen mode 不随 sprite API
   偷渡进入 scope，Canvas/Worker frame boundary 不变。

### 允许修改的范围

- `spec/phase-2-graphics-memory-text-contract.json`
- `spec/pico-api-inventory.yaml`、production host binding schema/generated files
- `tools/wasm/generate-host-bindings.mjs`
- `wasm/bridge/p8w_frame_runtime.*` 与 generated header
- `packages/runtime-core/src/{graphics,memory,frame-runtime.ts,pico-api,public.ts}`
- `packages/z8lua-bridge/src/**`
- `tests/{runtime,browser,architecture}/**`、`tools/browser/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `docs/evidence/**`；不得实现 map/tline/text；不得让 Canvas 知道 sprite sheet 或 blit。

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

2C 必须新增 `pnpm run test:phase-2c`，覆盖：

- `sget/sset` logical GFX、nibble order、boundary、fractional coordinate 与 draw-palette vectors。
- direct poke/API/blitter equality；GFX↔SCREEN 与 upper-RAM remap/alias，不读取 `ref/`。
- `spr` multi-sprite row crossing、fractional size、flip、camera/clip、palette/transparency golden。
- `sspr` up/down scale、negative destination dimensions、source clipping 与 deterministic sampling。
- fillp apply-to-sprites、secondary palette pair 和 global-secondary primitive regression。
- real Chrome production Worker/Canvas sprite smoke、ordinary performance 与 Phase 0C/1/2B regressions。

最终门禁：

```text
pnpm run test:phase-2c
pnpm run test:phase-2c:chrome
pnpm run verify
git status --short
```

### 2C exit gate

- standard 4bpp 下的 sprite source、blit result 与 remap alias 有 deterministic evidence。
- `spr/sspr` 只消费 shared `PicoRam`，presenter/transport 没有新增 sprite-specific dependency。
- API inventory/compatibility matrix 不把 bitplane/advanced screen mode 标为 compatible。
- 2C 独立提交后 worktree 干净；随后才折叠本节并激活 2D。

## Phase exit gate

- 2A–2F 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned conformance carts 覆盖 memory/draw state、sprite/map/tline 和 P8SCII/custom font。
- framebuffer、相关 RAM、draw state 和 display palette golden 在 Node real-WASM 与 Chrome
  production Worker 路径一致。
- 性能优化遵守 ADR-006，0 个开放 P0/P1；Known Differences 与兼容矩阵已同步。
- 归档不可变 Phase 2 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
