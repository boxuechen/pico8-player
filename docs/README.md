# 文档入口

只维护当前实现与可执行验证。已完成阶段、旧评估和历史结果由 Git 保存。

| 需求 | 文档 |
| --- | --- |
| 了解模块归属、线程和生命周期 | [架构](architecture.md) |
| 加载 Lua、手动执行、观察、接入 agent tools | [独立会话](standalone-session.md) |
| 嵌入实时播放器、输入和存档 | [Web Player](player.md) |
| 构建、测试、打包、本地预览 | [开发与验证](development.md) |
| 支持范围和已知差异 | [兼容范围](compatibility.md) |
| z8lua 来源、工具链与 ABI | [WASM](../wasm/README.md) |

源码和行为测试描述实际实现；`spec/` 锁定机器契约。没有当前源码与测试支持的能力，不应因旧文档中的目标设计而视为已完成。
