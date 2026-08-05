# PICO-8 Web Player 开发文档

本目录是项目工程事实入口。目标是以 z8lua WASM + TypeScript Runtime 实现
Chrome/Chromium-only 的 PICO-8 player；不实现编辑器、命令行、SPLORE 或导出工具。

## 当前开发入口

当前没有 active phase。**Phase 0F：Browser Render / Audio Transport** 已完成，
Phase 1 尚未激活。开始下一阶段实现前，先在 [`docs/phases/`](./phases/)
创建唯一的 active phase 执行文档。

查看当前实现基线时按顺序阅读：

1. [Phase 0F 完成证据](./evidence/phase-0/17-phase-0f-evidence.md)：浏览器边界、
   唯一默认路径和 Phase 0 exit gate。
2. [源码目录与边界契约](./08-source-layout-and-boundaries.md)：package DAG、execution
   domains、composition roots 和 import 门禁。
3. 未来 active phase 文档明确路由的 owner 章节；不要默认通读所有历史
   evidence。

根目录 [`AGENTS.md`](../AGENTS.md) 只保留这条入口和不可破坏的仓库规则。阶段任务
细节不得复制回 AGENTS、README、roadmap 和 Codex 协议。

## 文档权威边界

| 内容 | 唯一权威位置 |
| --- | --- |
| 当前阶段范围、任务和验收 | [`docs/phases/`](./phases/) |
| 产品范围与兼容等级 | [`01-scope-and-success-criteria.md`](./01-scope-and-success-criteria.md) |
| 运行拓扑、状态和 transaction 语义 | [`02-system-architecture.md`](./02-system-architecture.md) |
| z8lua/WASM bridge 契约 | [`03-z8lua-wasm-bridge.md`](./03-z8lua-wasm-bridge.md) |
| TypeScript Runtime 模块目标契约 | [`04-typescript-runtime.md`](./04-typescript-runtime.md) |
| 跨阶段 roadmap | [`05-delivery-plan.md`](./05-delivery-plan.md) |
| 测试策略、兼容矩阵和发布门禁 | [`06-testing-compatibility.md`](./06-testing-compatibility.md) |
| ADR 索引、风险和真正未决问题 | [`07-decisions-risks-open-questions.md`](./07-decisions-risks-open-questions.md) |
| 源码目录、依赖和 composition roots | [`08-source-layout-and-boundaries.md`](./08-source-layout-and-boundaries.md) |
| 通用 Codex 工作协议 | [`09-codex-task-protocol.md`](./09-codex-task-protocol.md) |
| 本地参考源码与许可隔离 | [`10-reference-sources.md`](./10-reference-sources.md) |
| 已完成阶段和 differential 记录 | [`evidence/`](./evidence/) |
| Accepted/Rejected 设计决定 | [`adr/`](./adr/) |
| ABI、Runtime、codec/API 机器契约 | [`../spec/`](../spec/) |

边界规则：

- `spec/` 优先于文档中的示例字段；示例不得成为第二份协议。
- `docs/adr/` 决定默认路径；普通任务不能静默改变 Accepted ADR。
- `docs/evidence/` 是历史审计资料，不是当前实现状态入口。
- 02 只定义运行时行为，08 只定义代码放置和依赖；不得互相复制目录树或协议。
- 05 只维护 roadmap 状态，09 只维护通用工作流；当前任务只属于 phase 文档。

## 实现状态标签

大型 living contract 使用以下标签，阅读示例代码前先确认状态：

- **Implemented**：当前源码与自动化证据已经支持。
- **Accepted**：架构决定已锁定，但可能尚未完整实现。
- **Proposed**：必须由当前/未来 phase 用 spike 和 ADR 决定。
- **Deferred**：明确不在当前 phase 范围。
- **Evidence**：完成时记录；不随当前实现细节反复改写。

找不到状态时，以当前源码、机器 contract 和测试为准，不把目标架构描述当成已实现。

## 已锁定方向

- 兼容目标是 [PICO-8 v0.2.7 手册](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)
  所描述的 cart Runtime。
- z8lua WASM 负责 P8 Lua parser、VM、coroutine、GC 和 Q16.16 语言语义。
- TypeScript Runtime 负责 cart hardware、Pico RAM、graphics、audio、input、
  persistence、scheduler 和 player orchestration。
- Runtime 在 Web Worker；Canvas/WebGL 和 AudioContext/AudioWorklet 是 app adapters。
- Chrome/Chromium 是唯一浏览器支持和发布门禁；Firefox/WebKit 不在范围。
- `.p8.png` 从 bytes 无损解析，禁止用 Canvas 读取 cart payload。
- 首版只接受 caller-provided/local cart bytes；未经授权不实现 BBS 自动访问。
- `ref/` 只用于隔离的本地阅读，不进入 workspace、production、tests 或 build。

## 规范优先级

1. 官方手册明确的运行时行为。
2. 合法、可复现的官方 capture 和已完成 conformance evidence。
3. `spec/` 与 Accepted ADR。
4. 更具体的模块契约。
5. fake-08、zepto8 等带 provenance 的参考实现。

参考实现不是规范。外部来源和固定 checkout 见
[`10-reference-sources.md`](./10-reference-sources.md)，站点访问还必须遵守
[Lexaloffle Terms of Use](https://www.lexaloffle.com/info.php?page=tos)。

## 文档维护规则

- 公共接口、状态机、ownership 或兼容承诺改变时，同一任务更新唯一 owner 文档。
- package、execution domain、exports 或 dependency edge 改变时，更新 08 和
  architecture tests；其他文档只链接。
- 一个 Proposed 项只有获得测试、benchmark 或官方依据后才能改为 Accepted/Rejected。
- 阶段开始时创建/启用 phase 文档；阶段结束后把证据归档到 `docs/evidence/`，并把
  roadmap 状态压缩为一行。
- 已知差异进入 06 的兼容矩阵，不只留在聊天或代码注释。
- 文档中的命令必须真实存在；目标命令必须显式标为 Proposed，不能伪造已通过。
