# PICO-8 Web Player 开发文档

本目录是项目工程事实入口。目标是以 z8lua WASM + TypeScript Runtime 实现
Chrome/Chromium-only 的 PICO-8 player；不实现编辑器、命令行、SPLORE 或导出工具。

## 当前开发入口

| 项目状态 | 唯一入口 |
| --- | --- |
| 最近完成 | Phase 8；[Expanded Real-cart Qualification exit evidence](./evidence/phase-8/91-phase-8-expanded-real-cart-qualification-exit-evidence.md) |
| 当前阶段 | Phase 9；[Supplemental Compatibility Remediation](./phases/9-supplemental-compatibility-remediation.md) |
| Active work unit | 9R — Requalification Failure Remediation |
| 当前机器合同 | [`spec/phase-9-supplemental-compatibility-remediation-contract.json`](../spec/phase-9-supplemental-compatibility-remediation-contract.json) |

Phase 8A–8H 已关闭：100 个 canonical cart 完成 fixed smoke，65 个格式 pair 完成定性，10 个代表
case 达到 C2；supplemental 200-cart quick smoke 暴露的 51 个失败已进入 Phase 9：language 45、timing 5、
unsupported-host-feature 1，目标是用通用修复收敛到 200 CU。
第三方 bytes、截图、路径、hash 与逐-cart 结果保持本地，不成为 CI、release artifact 或公开兼容率。
9A 已把 51 个失败冻结为 15 个匿名 root-cause candidate，exact coverage 为 45/5/1 且无未分类项。
9B 已用 13 个项目原创 real-WASM 最小复现关闭全部 language candidate；10 个 external
representative 的短 Chrome gate 全部越过对应语言根因，其中 9 个达到 CU，另 1 个继续暴露为既有
local `load()` host-feature 边界并转交 9D。9C 已用固定 32M deterministic safety cap 和 Q16.16
numeric-for termination 修复关闭 5 个 timing failure；5 个 affected case 的 120-tick Chrome smoke 全部达到
CU。9D 已在显式 local bundle 内关闭 external cart-data 与 guest load 缺口：空 `load("")` 是 no-op，
missing/denied ref 仍失败关闭；2 个 affected case 均达到 CU。9E 的 10 个 representative 已在同一
production Chrome 环境达到 10/10 CU、0 failure cluster。9F 的首次 requalification attempt 在 175 cases
后停止，聚合为 171 CU、3 个 language failure、1 个 host-feature failure，完整 run 仍为 0。当前唯一
授权工作是 9R：用项目原创复现关闭 `camera()` previous-state return、absent-value `all()` 与 bounded
large-`chr()`，并在仓库外为 host case 补齐显式 local bundle；不授权其他 production 修改或 full sweep。

日常实现入口：本页 → active phase → 它明确链接的 contract 小节。不要把
03/04/06/08 或历史 evidence 当作每个任务的整本必读集合。

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
- 当前 profile 只接受 caller-provided/caller-authorized local cart bytes；未经授权不实现 BBS
  自动访问。
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
  roadmap 状态压缩为一行，再删除已完成的 phase 执行文档。
- phase 文档只展开当前 work unit；完成 unit 折叠为结果、机器合同和 evidence 链接，禁止
  累积复制稳定 owner 文档的历史正文。
- 已知差异进入 06 的兼容矩阵，不只留在聊天或代码注释。
- 文档中的命令必须真实存在；目标命令必须显式标为 Proposed，不能伪造已通过。
