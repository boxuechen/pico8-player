# Phase 2 — Graphics、Memory 与 Text

> 状态：Active；当前 work unit：2B
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
| 2B | Draw State 与基础图元 | **Active** | camera/clip/palette/fillp 与现有图元、display palette 端到端一致 |
| 2C | Sprite Sheet 与 Blitter | Planned | `sget/sset/spr/sspr` 产生确定 framebuffer |
| 2D | Map、Flags 与 `tline` | Planned | map remap、layer flags 和 fixed-point texture sampling 可复现 |
| 2E | P8SCII 与 Custom Font | Planned | byte-oriented `print/cursor`、内建字体和 custom font 可复现 |
| 2F | Conformance 与 Phase Exit | Planned | Node real-WASM 和 Chrome production 路径通过 golden、性能与恢复门禁 |

## Completed work unit：2A

结果由 [`spec/phase-2-graphics-memory-text-contract.json`](../../spec/phase-2-graphics-memory-text-contract.json)
的 2A record、`tests/runtime/phase-2a-memory-abi.test.mjs`、generated binding manifest 和
`wasm/runtime-v1.manifest.lock.json` 锁定。`pnpm run test:phase-2a` 与 aggregate verify 通过；
后续阶段不得重新引入 TypeScript video-base switch 或固定六参数 import。

## Active work unit：2B

### Observable behavior

1. 注册并实现 `color/camera/clip/pal/palt/fillp/pget/oval/ovalfill`；production schema 只在
   typed host method 与 conformance test 同时存在时加入对应 binding。
2. `cls/pset/line/rect/rectfill/circ/circfill/oval/ovalfill` 统一应用 RAM-backed camera、clip、
   draw palette 和 fill pattern；explicit/default color 继续正确更新 pen state。
3. draw/display palette、transparency、clip、camera、fill pattern 与 secondary-palette state
   可以由 API 和 direct RAM writes 双向观察；cold reset 恢复官方标准模式默认值。
4. `pget` 返回 logical screen pixel index，不应用 draw/display palette；out-of-bounds 行为由
   project conformance vector 锁定。
5. `RuntimeFrame` 与 production Player frame DTO 携带 16-entry display-palette snapshot；main
   Canvas presenter 只执行 index→RGBA 映射，不读取 RAM、camera、clip 或其他 draw state。
6. standard 128×128 packed 4bpp mode 是本 unit 的兼容声明；advanced bitplane/screen modes
   未经独立激活不得以不完整实现混入。

### 允许修改的范围

- `spec/phase-2-graphics-memory-text-contract.json`
- `spec/pico-api-inventory.yaml`、production host binding schema/generated files
- `tools/wasm/generate-host-bindings.mjs`
- `wasm/bridge/p8w_frame_runtime.*` 与 generated header
- `packages/runtime-core/src/{graphics,memory,frame-runtime.ts,pico-api,public.ts}`
- `packages/z8lua-bridge/src/**`
- `apps/web-player/src/{transport,worker,main/render}/**`
- `tests/{runtime,phase-0f,browser,architecture}/**`、`tools/browser/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `docs/evidence/**`；不得实现 sprite/map/text；不得让 Canvas 成为 draw-state owner。

### Routed contracts

- [Shared Pico RAM 与 raw fixed encoding](../03-z8lua-wasm-bridge.md#5-shared-pico-ram)
- [Graphics layering 与必须保持的行为](../04-typescript-runtime.md#7-graphics)
- [所有权与 frame transaction](../02-system-architecture.md#2-所有权与共享内存)
- [Composition roots 与 render ownership](../08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期)
- [确定性模型](../04-typescript-runtime.md#14-确定性契约)
- [Framebuffer/RAM golden](../06-testing-compatibility.md#7-goldenframebufferram-与-audio)
- [Chrome/Chromium gate](../06-testing-compatibility.md#11-chromechromium-支持矩阵)
- [interop 性能门禁](../06-testing-compatibility.md#10-jswasm-microbench-与性能门禁)
- [ADR-006](../adr/006-interop-hot-path-boundary.md)、[ADR-008](../adr/008-schema-generated-host-bindings.md)、[ADR-009](../adr/009-canvas2d-frame-presenter.md)、[ADR-013](../adr/013-shared-pico-ram-boundary.md)

### Verification

2B 必须新增 `pnpm run test:phase-2b`，覆盖：

- API/default/direct-poke 的 draw-state RAM readback 与 cold reset。
- camera→clip→palette/fillp ordering、fractional/reversed/off-screen shape vectors。
- `pal/palt` reset、draw/display palette distinction、secondary palette 与 pattern inversion。
- existing primitives 与 `oval/ovalfill` framebuffer/RAM golden；`pget` boundaries。
- Worker frame DTO palette snapshot、validator/transfer ownership 和 Canvas pixel result。
- real Chrome production Worker/Canvas smoke、ordinary tick/present performance 与 Phase 1 regressions。

最终门禁：

```text
pnpm run test:phase-2b
pnpm run test:browser:chromium
pnpm run verify
git status --short
```

### 2B exit gate

- standard 4bpp 下的 draw state、基础图元和 display palette 全链路有 deterministic evidence。
- presenter 仍无 RuntimeCore/WASM/RAM dependency，transport validator 拒绝 malformed palette。
- API inventory/compatibility matrix 不把未覆盖 advanced modes 标为 compatible。
- 2B 独立提交后 worktree 干净；随后才折叠本节并激活 2C。

## Phase exit gate

- 2A–2F 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned conformance carts 覆盖 memory/draw state、sprite/map/tline 和 P8SCII/custom font。
- framebuffer、相关 RAM、draw state 和 display palette golden 在 Node real-WASM 与 Chrome
  production Worker 路径一致。
- 性能优化遵守 ADR-006，0 个开放 P0/P1；Known Differences 与兼容矩阵已同步。
- 归档不可变 Phase 2 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
