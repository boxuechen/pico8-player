# PICO-8 Web Player 开发文档

本目录是本项目的工程事实来源（source of truth），用于指导 Codex 和人工开发者实现一个以 **z8lua WASM + TypeScript Runtime** 为核心的 Web-native PICO-8 player。

当前仓库已完成 Phase 0S 工程骨架、Phase 0A z8lua WASM baseline、Phase 0B
Shared Pico RAM 与 Phase 0C interop microbenchmark；下一阶段是 Phase 0D
lossless `.p8.png`。尚未实现 cart、完整 PICO-8 Runtime 或 Player UI 行为。任何实现任务开始前，
必须先阅读本页、当前阶段文档、[源码目录与边界契约](./08-source-layout-and-boundaries.md)，
以及与该任务直接相关的模块契约。

## 已锁定的方向

- 目标是 player，不实现 PICO-8 编辑器、命令行环境、SPLORE 浏览器或导出工具。
- 兼容目标以当前 [PICO-8 v0.2.7 手册](https://www.lexaloffle.com/dl/docs/pico-8_manual.html) 记载的 cart 运行时为准。
- P8 Lua parser、VM、coroutine、GC 和 16:16 fixed-point 语义使用 [z8lua](https://github.com/samhocevar/z8lua) 编译到 WASM。
- cart hardware、64 KiB Base RAM 的宿主视图、graphics、audio、input、persistence、调度器和 player UI 使用 TypeScript 实现。
- Runtime 必须在 Web Worker 中运行；任意 cart 不得直接占用浏览器主线程。
- `.p8.png` 必须按二进制无损解码，禁止通过 Canvas 取像素来解析 cart 数据。
- 第一阶段只接受用户本地提供的 `.p8` / `.p8.png`。未经明确授权，不实现自动访问、抓取或镜像 Lexaloffle BBS。

## 文档索引与阅读顺序

| 顺序 | 文档 | 用途 |
| --- | --- | --- |
| 1 | [01-scope-and-success-criteria.md](./01-scope-and-success-criteria.md) | 产品边界、兼容等级、成功指标和禁止捷径 |
| 2 | [02-system-architecture.md](./02-system-architecture.md) | 进程拓扑、状态机、数据流、所有权和错误模型 |
| 3 | [03-z8lua-wasm-bridge.md](./03-z8lua-wasm-bridge.md) | z8lua 构建、WASM ABI、Lua/JS bridge 和性能边界 |
| 4 | [04-typescript-runtime.md](./04-typescript-runtime.md) | Cart、RAM、Graphics、Audio、Input、Storage 等 TS 模块契约 |
| 5 | [05-delivery-plan.md](./05-delivery-plan.md) | 从技术 spike 到兼容版本的可执行阶段计划 |
| 6 | [06-testing-compatibility.md](./06-testing-compatibility.md) | 单元、conformance、golden、性能和浏览器测试门禁 |
| 7 | [07-decisions-risks-open-questions.md](./07-decisions-risks-open-questions.md) | ADR 摘要、风险登记和必须用实验回答的问题 |
| 8 | [08-source-layout-and-boundaries.md](./08-source-layout-and-boundaries.md) | canonical workspace、package DAG、composition roots 和 import 门禁 |
| 9 | [09-codex-task-protocol.md](./09-codex-task-protocol.md) | 后续 Codex 每次执行开发任务时必须遵守的协议 |
| 10 | [10-reference-sources.md](./10-reference-sources.md) | 本地参考 clone 的精确 commit、用途、许可提醒与隔离规则 |
| 11 | [11-phase-0s-evidence.md](./11-phase-0s-evidence.md) | Phase 0S 工具选择、边界覆盖和可复现验证证据 |
| 12 | [12-phase-0a-evidence.md](./12-phase-0a-evidence.md) | z8lua pin、sandbox ABI、语言 fixture、NOTICE 与 artifact 可复现证据 |
| 13 | [13-phase-0b-evidence.md](./13-phase-0b-evidence.md) | 64 KiB shared RAM、canonical mapper、zero-copy lease、fixed memory/OOM 证据 |
| 14 | [14-phase-0c-evidence.md](./14-phase-0c-evidence.md) | interop contract、真实 Chromium p50/p95/p99、fallback 与 ADR-006 go/no-go |

如果文档之间出现冲突，按以下优先级处理：

1. PICO-8 官方手册中明确记载的运行时行为。
2. 已完成并有测试证据的 ADR / conformance 结果。
3. 本目录中更具体的模块契约。
4. `docs/README.md` 中的概括性描述。
5. fake-08、zepto8 等参考实现的现有行为。

参考实现不是规范。采用其算法前，必须确认其行为、版本覆盖和许可证来源。

## 规范用语

本文档集使用以下关键词：

- **MUST / 必须**：违反即视为实现错误。
- **MUST NOT / 禁止**：不可作为临时捷径提交。
- **SHOULD / 应当**：默认执行；偏离时必须记录理由和测试证据。
- **MAY / 可以**：不影响兼容契约的实现选择。
- **Spike**：为回答一个明确技术问题而写的最小实验代码，不等同于生产实现。
- **Conformance cart**：只验证一个或一组明确 PICO-8 行为的测试 cart。
- **Logical frame**：callback 模式下一次 `_update60()`，或 30 fps 模式下一次 `_update()` 对应的模拟步；custom-loop 模式下从 startup/上一个受控 `flip()` continuation 推进到下一个 `flip()` 的模拟步。首次用于识别 lifecycle 的 startup `flip()` 不单独计作 logical frame。

## 外部事实来源

- [PICO-8 User Manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)
- [z8lua](https://github.com/samhocevar/z8lua)
- [fake-08](https://github.com/jtothebell/fake-08)
- [zepto8](https://github.com/samhocevar/zepto8)
- [Lexaloffle Terms of Use](https://www.lexaloffle.com/info.php?page=tos)

以上三份开源参考的本地固定 checkout 与隔离规则见 [10-reference-sources.md](./10-reference-sources.md)。`ref/` 只用于离线阅读和 provenance 查找，不是 production dependency 或测试输入。

## 文档维护规则

- 实现改变公共接口、状态机、内存所有权或兼容承诺时，必须在同一任务中更新相关文档。
- 源码 package、执行域、公共 exports 或 production dependency edge 变化时，必须同步 [08-source-layout-and-boundaries.md](./08-source-layout-and-boundaries.md) 和 architecture tests；其他文档不得维护第二套目录树。
- 一个未决问题只有在附带可复现测试、基准或官方依据后才能改为“已决定”。
- z8lua 不能只记录仓库或 branch 名；构建必须记录精确 commit、本地 patch manifest、工具链版本和产物 hash。
- `ref/` 中的本地 clone 不得进入 workspace、production/test import graph 或构建；新增/更新 clone 时必须同步 [10-reference-sources.md](./10-reference-sources.md) 的 commit、用途与许可提醒。
- 阶段完成时，必须更新 [05-delivery-plan.md](./05-delivery-plan.md) 的状态与证据链接。
- 已知兼容差异必须进入测试兼容矩阵，不得只留在代码注释或聊天记录中。
- 文档中的命令在项目脚手架创建后必须变成真实、可执行的 package scripts；在此之前不得伪造“已通过”的命令。
