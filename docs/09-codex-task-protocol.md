# Codex 后续开发执行协议

源码归属、package 依赖和跨执行域 import 必须同时遵守 [08-source-layout-and-boundaries.md](./08-source-layout-and-boundaries.md)。

本协议用于把本目录的架构文档转化为每次可审查、可验证的小任务。后续 Codex 在此仓库中实现功能时，必须遵守本页。

## 1. 开始任务前

1. 阅读 [README.md](./README.md)。
2. 从 [05-delivery-plan.md](./05-delivery-plan.md) 确认当前 Phase 和 exit gate。
3. 从 [08-source-layout-and-boundaries.md](./08-source-layout-and-boundaries.md) 确认代码 owner、合法 dependency edge、public export 和 composition root。
4. 阅读与任务有关的具体契约文档。
5. 检查工作树，保留用户已有修改，不覆盖无关文件。
6. 搜索现有 API、tests、ADR 和 compatibility entries，避免重复实现。
7. 明确本任务属于：spike、生产实现、兼容修复、测试、文档或构建系统。
8. 在动手前写出不超过 5 步的工作计划，并指出会验证哪些 observable behavior。

如果任务要求改变 Accepted ADR、范围、不变量、公共协议或外部服务权限，必须停止普通实现流程，先提交 ADR/向用户说明，而不是自行扩大范围。

## 2. 任务大小

一个实现任务 SHOULD 是一个 vertical slice，例如：

- `.p8` parser 的 `__gfx__` section + unit tests。
- raw fixed-point `pset` binding + bridge stack tests + microbenchmark。
- Worker `loadCart` transaction + rollback test。
- `btnp` edge/repeat semantics + 30/60 fps conformance cart。

以下任务过大，必须拆分：

- “实现全部 Graphics API”。
- “把 fake-08 移植到 TS”。
- “支持所有 BBS cart”。
- “优化性能”但没有基准和目标。

## 3. 实现规则

- 先定义或确认 public interface，再写实现。
- 跨 package import 只能走 `package.json#exports`；禁止 `/src/`、internal deep import 和 packages→apps 依赖。
- concrete adapter 只能在 08 定义的 composition root 注入；RuntimeCore 不得直接 `new` z8lua、IndexedDB、Canvas/Audio 或 transport adapter。
- 禁止新增顶层 `utils/common/shared/services/managers`；无法明确 state owner/port/adapter 的代码先停下来修正设计。
- 任何 PICO-8 可观察行为都必须由测试固定。
- Runtime module 不得越过 [02-system-architecture.md](./02-system-architecture.md) 的依赖方向。
- 不得为单个第三方 cart 添加 ID/name-specific 分支。
- 不得使用 Canvas 解析 cart payload。
- 不得把 P8 fixed-point 值默默转为 JS float 作为权威值。
- 不得在 Window 主线程执行 Lua 或 Runtime step。
- 不得增加 BBS 自动访问代码，除非用户提供已确认的授权范围且 ADR-007 被替代。
- 新 dependency 必须记录用途、license、bundle/Worker 影响和无依赖替代方案。
- `ref/` 仅供只读检索；禁止从 production/tests import、include、symlink 或运行时读取，也不能把 clone 的存在当成测试前置条件。
- 从参考实现翻译代码必须记录 repository、commit、原路径、license/notice、本地目标和语义改动；测试向量也必须独立登记 provenance。

## 4. 测试先后顺序

按风险最小到最大验证：

1. 静态检查 / typecheck。
2. architecture/dependency boundary tests。
3. 受影响模块 unit tests。
4. 相关 conformance cart。
5. golden framebuffer/RAM/audio。
6. Worker/browser integration。
7. performance 或 long-run gate。
8. 全量验证。

若项目尚未建立某层测试，当前任务应建立最小真实测试设施，不能用“未来补测试”作为完成条件。

## 5. Definition of Done

一个任务只有同时满足以下条件才可报告完成：

- 请求的 observable behavior 已实现。
- 正常、边界和错误路径有测试。
- `test:architecture` 通过，没有新增未记录 dependency edge、deep import、platform leak 或 package cycle。
- 没有新增 silent stub、未说明 fallback 或 cart-specific hack。
- 所有运行过的验证命令真实通过；未运行项明确说明原因。
- 公共接口、ADR、兼容矩阵或阶段状态变化已同步文档。
- 新依赖和移植代码有 license/provenance 记录。
- 性能敏感改动提供 before/after 基准，而不是主观“更快”。
- 最终交付说明列出改动文件、验证证据和剩余限制。

## 6. Spike 特殊规则

Spike 必须从一个可回答的问题开始，并以决策结束。

合格示例：

> 在目标 Chrome stable 中，16K 次/frame 的 z8lua WASM→JS `pset(rawX, rawY, color)` 是否能让 Runtime p95 保持在预算内？

Spike 输出必须包括：

- 环境和版本。
- 可复现命令。
- 原始或汇总数据。
- 结论：Go / Go with constraints / No-Go。
- 对相关 ADR 和文档的更新。
- Spike 代码是删除、保留为 benchmark，还是重写为生产实现。

不得仅展示“能运行”的 demo 就宣布架构验证通过。

## 7. 兼容 bug 工作流

收到某 cart 不工作的报告时：

1. 确认 cart 来源和测试许可；不要自动从 BBS 抓取。
2. 记录 cart version、hash、浏览器、Runtime revision 和最小复现输入。
3. 将故障归类为 parse、language、RAM、graphics、audio、input、timing、persistence 或 unsupported host feature。
4. 尽量写一个不含原 cart 内容的最小 conformance cart。
5. 先让 conformance test 失败，再修复实现。
6. 验证不存在对其他 golden/corpus 的回归。
7. 更新 compatibility entry 和必要的 ADR。

## 8. 任务说明模板

后续可以直接把以下模板交给 Codex：

```md
目标：<一个可观察结果>
当前阶段：Phase <n>
必读文档：<docs links>
范围内：
- ...
范围外：
- ...
必须保持的不变量：
- ...
验收：
- <unit/conformance/browser/benchmark>
交付：
- code
- tests
- docs/ADR update if needed
```

## 9. Codex 最终报告模板

```md
结果：<一句话说明完成状态>

改动：
- <file/module and behavior>

验证：
- `<command>` — passed / failed

兼容与性能：
- <new evidence or no material change>

剩余限制：
- <explicit item, or none>
```

## 10. 当前推荐任务

**Phase 0S–0E 已于 2026-08-05 完成**，证据见
[11-phase-0s-evidence.md](./11-phase-0s-evidence.md) 和
[12-phase-0a-evidence.md](./12-phase-0a-evidence.md)、
[13-phase-0b-evidence.md](./13-phase-0b-evidence.md)、
[14-phase-0c-evidence.md](./14-phase-0c-evidence.md)、
[15-phase-0d-evidence.md](./15-phase-0d-evidence.md) 和
[16-phase-0e-evidence.md](./16-phase-0e-evidence.md)。不得继续向 scaffold、
`p8w0a_*`、`p8w0b_*` 或 `p8w0c_bench_*` spike 填入无验收归属的 placeholder behavior。

下一个独立任务是 **Phase 0F：Browser Render / Audio Transport**。它复用 Phase 0E
的 packed screen/frame DTO、Worker generation/watchdog 和 RuntimeCore port，不得把
renderer、AudioWorklet 或 wall-clock scheduler 反向塞入 VM adapter。Phase 0E 的
custom startup time offset 仍等待合法官方 binary differential；0F 不得自行改变。
