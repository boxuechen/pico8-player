# 可执行交付计划

本文件只维护跨阶段 roadmap、状态和 exit gate。当前阶段的任务拆解、文件归属和测试
命令由 [`docs/phases/`](./phases/) 唯一定义；已完成阶段的详细记录只存在于
[`docs/evidence/`](./evidence/)。

## 1. 执行原则

- 按可观察 vertical slice 推进，不按“先实现全部 API”推进。
- 一个阶段只有在自动验证、可审阅 artifact、ADR/兼容矩阵同步后才能完成。
- 新模块先确定 public contract，再实现；跨模块临时 import 不能成为完成状态。
- fake-08/zepto8 只作为带 commit/license provenance 的参考，不是规范。
- Phase 任务展开后进入独立 phase 文档，不在 roadmap、README、09 中复制。

源码布局只由 [`08-source-layout-and-boundaries.md`](./08-source-layout-and-boundaries.md)
定义；本文件不维护第二份目录树。

## 2. 当前状态

| Phase | 状态 | 结论或入口 |
| --- | --- | --- |
| 0S Workspace Scaffold | Complete | [Evidence](./evidence/phase-0/11-phase-0s-evidence.md) |
| 0A z8lua WASM baseline | Complete | [Evidence](./evidence/phase-0/12-phase-0a-evidence.md) / [ADR-012](./adr/012-z8lua-source-and-phase-0a-wasm.md) |
| 0B Shared Pico RAM | Complete | [Evidence](./evidence/phase-0/13-phase-0b-evidence.md) / [ADR-013](./adr/013-shared-pico-ram-boundary.md) |
| 0C Interop Microbenchmark | Complete | [Evidence](./evidence/phase-0/14-phase-0c-evidence.md) / [ADR-006](./adr/006-interop-hot-path-boundary.md) |
| 0D Lossless `.p8.png` | Complete | [Evidence](./evidence/phase-0/15-phase-0d-evidence.md) / [ADR-005](./adr/005-lossless-p8png.md) |
| 0E Coroutine Frame Slice | Complete | [Evidence](./evidence/phase-0/16-phase-0e-evidence.md) / [ADR-017](./adr/017-coroutine-frame-slice-and-fault-containment.md) |
| 0F Browser Render / Audio Transport | Complete | [Evidence](./evidence/phase-0/17-phase-0f-evidence.md) / [ADR-009](./adr/009-canvas2d-frame-presenter.md) / [ADR-010](./adr/010-dedicated-messageport-audio-transport.md) |
| 1 L1 最小可玩闭环 | **Active；1A–1E complete** | [Phase document](./phases/1-l1-minimal-playable-loop.md)；next 1F |
| 2 Graphics、Memory、Text | Not started | Phase 1 exit 后激活 |
| 3 Audio、完整 Input、Persistence | Not started | Phase 2 exit 后激活 |
| 4 L2 / MVP 兼容加固 | Not started | Phase 3 exit 后激活 |
| 5 L3 与可选 BBS 集成 | Deferred | 需要独立授权和产品决定 |

## 3. Phase 0 — 架构验证

Phase 0 用最小、可丢弃或可重写的 spike 证明混合架构、ABI、memory、codec、frame
control 和浏览器设备边界成立。0S–0F 已完成；不要继续向旧 spike ABI 添加新产品
行为。

### Phase 0F 完成结论

- Canvas2D 是唯一默认 presenter；pixel/DPR/resize/performance 门禁已通过。
- dedicated Worker → `MessagePort` → AudioWorklet 是唯一默认 PCM transport；
  44.1/48 kHz 并发 10 分钟 soak 中 steady underrun/overrun/drop 均为 0。
- composition 已覆盖 trusted gesture、watchdog/recreate、generation reattach 和 dispose。

详细数据与历史执行契约见
[`17-phase-0f-evidence.md`](./evidence/phase-0/17-phase-0f-evidence.md)。

### Phase 0 Exit Gate

**Status: Passed by Phase 0F.** 以下进入 Phase 1 前的条件已全部由自动测试、
Chrome device-run、Accepted ADR 和归档 evidence 覆盖：

- 0S–0F 自动测试通过；真实 Chrome 手势/音频 evidence 可作为版本化 device-run。
- z8lua pin、patch、license、fixed memory、interop hot-path 和 HostRequest 限制已有
  Accepted ADR/evidence。
- ADR-009 已选择唯一默认 presenter；pixel/resize/context/performance gate 通过。
- ADR-010 已选择唯一默认 PCM transport；prebuffer 后 10 分钟 underrun=0，queue
  有界，SAB 是否需要已有明确结论。
- ADR-014 的 canonical PCM event/sample 与 44.1/48 kHz device resampling 证据已记录。
- custom-loop startup clock、Worker watchdog/recreate 和 stale generation 不变量保持。
- 02/04 的状态、06 的兼容矩阵和 08 的实际边界与源码一致。
- 失败 fallback 没有未决阻断项，`pnpm run verify` 通过。

## 4. Future roadmap

未来阶段在激活前只保留目标和 exit headline；激活时必须创建独立 phase 文档，从当前
源码重新确认输入，不得直接照 roadmap 实现。

### Phase 1 — L1 最小可玩闭环

目标：让项目原创单 cart 具备输入、逻辑、像素输出和基本故障恢复。

主要范围：`.p8` parser、CartSession/reset、callback/custom loop、基础
`cls/pset/line/rect/circ`、keyboard `btn/btnp`、Phase 0F presenter 和最小 Player shell。

Exit headline：30/60/custom-loop carts 可逐帧复现；reset/fault 后 session、RAM、input
和 placeholder audio 状态正确；UI 能重新加载。

### Phase 2 — Graphics、Memory 与 Text

目标：完成大多数可视 cart 所需 graphics/memory/text 行为。

主要范围：palette/clip/camera/fillp、sprite/map/tline、P8SCII/custom font、完整
memory API 和对应 framebuffer/RAM golden。

Exit headline：图形与 remap conformance 覆盖关键交互，优化仍服从 ADR-006 ladder。

### Phase 3 — Audio、完整 Input 与 Persistence

目标：完成可听、可控制、可保存的 player runtime。

主要范围：SFX/music synth、keyboard/gamepad/touch、repeat、cartdata、IndexedDB 和
reload/cstore 的已授权同步-cache 路径。

Exit headline：canonical audio golden、device output、input traces、persistence
transaction/error/recovery 全部通过。

### Phase 4 — L2 / MVP 兼容加固

目标：以获准的代表 cart corpus 驱动剩余 API、CPU budget、性能和长稳测试。

Exit headline：兼容矩阵和 Known Differences 可发布；Chrome release gate、资源上限、
30-minute soak 与多 cart lifecycle 通过。

### Phase 5 — L3 与可选 BBS 集成

目标：在独立授权、服务条款和安全评审后评估 multi-cart、BBS resolver 与分享能力。

该阶段默认 Deferred。不得把 BBS 自动访问、第三方 cart 缓存或通用 nested async
suspension 混入 Phase 1–4。
