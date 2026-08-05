# Phase 2 — Graphics、Memory 与 Text

> 状态：Active；当前 work unit：2A
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
| 2A | Canonical Memory 与 Host ABI | **Active** | Base RAM API 与所有 runtime access 共用唯一 mapper；ABI 可承载 Phase 2 参数和 byte strings |
| 2B | Draw State 与基础图元 | Planned | camera/clip/palette/fillp 与现有图元、display palette 端到端一致 |
| 2C | Sprite Sheet 与 Blitter | Planned | `sget/sset/spr/sspr` 产生确定 framebuffer |
| 2D | Map、Flags 与 `tline` | Planned | map remap、layer flags 和 fixed-point texture sampling 可复现 |
| 2E | P8SCII 与 Custom Font | Planned | byte-oriented `print/cursor`、内建字体和 custom font 可复现 |
| 2F | Conformance 与 Phase Exit | Planned | Node real-WASM 和 Chrome production 路径通过 golden、性能与恢复门禁 |

## Active work unit：2A

### Observable behavior

1. Production VM 注册 `peek/peek2/peek4`、`poke/poke2/poke4`、`memcpy/memset`；
   `peek/poke` 的 bounded variadic 形式不静默截断，`memcpy` 支持重叠区域。
2. direct `@/%/$`、Lua memory API 和 RuntimeCore logical access 对同一地址得到相同结果；
   GFX/SCREEN remap、16-bit wrap 与 multi-byte 逐 byte mapping 只由
   `wasm/bridge/p8w_pico_memory.*` 定义。
3. `FrameVmPort` 只暴露 runtime-neutral logical-memory capability，不暴露 Emscripten module、
   `WebAssembly.Memory` 或 raw handle；stale lease/已销毁 session 访问被拒绝。
4. Host binding schema/generator/import 使用固定 layout call frame，至少支持 12 个 scalar slots
   和 byte-string pointer/length；已有 binding 的 Q16.16、presence、result、host-failure 和
   exactly-once lifecycle 保持不变。
5. steady-state scalar host call 不创建逐调用对象，不从 import 重入 export，也不调用 malloc。

### 允许修改的范围

- `spec/phase-2-graphics-memory-text-contract.json`
- `spec/pico-api-inventory.yaml`、`spec/abi/**`
- `tools/wasm/generate-host-bindings.mjs`
- `wasm/bridge/p8w_frame_runtime.*`、`wasm/bridge/p8w_pico_memory.*` 与生成 header
- `packages/runtime-core/src/{memory,frame-runtime.ts,pico-api,public.ts}`
- `packages/z8lua-bridge/src/**`
- `tests/{wasm,runtime,architecture}/**`、`package.json`
- 本 work unit 直接拥有的文档状态和 compatibility matrix

不得修改 `docs/evidence/**`；不得添加未来 Phase 2 API stub 到 production schema。

### Routed contracts

- [Shared Pico RAM、host-call frame 与值编码](../03-z8lua-wasm-bridge.md#5-shared-pico-ram)
- [PicoRam layout、生命周期与地址语义](../04-typescript-runtime.md#6-picoram64kib-共享地址空间)
- [确定性模型](../04-typescript-runtime.md#14-确定性契约)
- [WASM/spec/generated ownership](../08-source-layout-and-boundaries.md#7-wasmspec-与生成物)
- [测试执行模型、WASM 专项与 golden](../06-testing-compatibility.md#4-确定性执行模型)
- [interop 性能门禁](../06-testing-compatibility.md#10-jswasm-microbench-与性能门禁)
- [ADR-006](../adr/006-interop-hot-path-boundary.md)、[ADR-008](../adr/008-schema-generated-host-bindings.md)、[ADR-013](../adr/013-shared-pico-ram-boundary.md)

### Verification

2A 必须新增 `pnpm run test:phase-2a`，覆盖：

- negative/fractional/16-bit wrap、unaligned width、remap crossing 和 upper RAM。
- direct/API/RuntimeCore logical-memory path equality。
- variadic 上限、Lua stack capacity、重叠 `memcpy` 与 bounded `memset`。
- 12 scalar slots、embedded NUL byte string、pointer lifetime、host throw 与 stack balance。
- fixed-memory buffer identity、cold reset、destroy/stale capability 与 64 KiB RAM hash。
- Phase 1 host bindings、frame runtime、architecture 和 interop benchmark regression。

最终门禁：

```text
pnpm run test:phase-2a
pnpm run verify
git status --short
```

### 2A exit gate

- 上述 observable behavior 全部有 production source 和 real-WASM 测试证据。
- `pico-api-inventory.yaml` 不再把单参数 memory wrapper 误报为完整实现。
- generator manifest、WASM runtime manifest 和 reproducibility gate 已更新并通过。
- 2A 独立提交后 worktree 干净；随后才折叠本节并激活 2B。

## Phase exit gate

- 2A–2F 全部 complete，机器合同关闭且 `activeWorkUnit=null`。
- project-owned conformance carts 覆盖 memory/draw state、sprite/map/tline 和 P8SCII/custom font。
- framebuffer、相关 RAM、draw state 和 display palette golden 在 Node real-WASM 与 Chrome
  production Worker 路径一致。
- 性能优化遵守 ADR-006，0 个开放 P0/P1；Known Differences 与兼容矩阵已同步。
- 归档不可变 Phase 2 evidence、更新 roadmap、删除本 active phase 文档并保持 worktree 干净。
