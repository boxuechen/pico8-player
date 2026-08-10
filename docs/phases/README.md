# Phase documents

本目录只保存 **当前 active phase 的可执行入口**，不保存已完成阶段全文，也不为 future
phase 预建愿望清单。阶段总状态只由 [`docs/README.md`](../README.md) 路由。当前没有 active phase，
production implementation 尚未授权。最近完成结果见
[Phase 12 evidence](../evidence/phase-12/131-phase-12-pal-table-compatibility-exit-evidence.md)。

## Activation contract

激活阶段时创建一个 phase 文档和对应的 `spec/` 机器合同，并同时满足：

1. 顶部声明状态、浏览器范围、机器合同、前置 evidence 和明确 non-goals。
2. 用一张表列出阶段 work units，但只展开 **当前 work unit** 的 observable behavior、允许
   文件、精确 owner 章节、测试和 exit gate。
3. 链接 03/04/06/08 的具体 heading；不得复制它们的 API、目录树、兼容矩阵或通用 DoD。
4. roadmap headline 只用于选择和排序，不是 production implementation 授权。
5. 一个 work unit 完成后，把正文折叠为结果、机器合同路径和 evidence/test 链接，再展开
   下一个 unit；不要让 phase 文档成长为历史日志。
6. 同一时间只能存在一个 active phase。

最小结构：

```text
status / machine contract / browser gate
goal + non-goals + stable inputs
work-unit table
active work unit: observable / files / routed contracts / tests / exit
phase exit gate
```

## Completion contract

阶段完成时先归档不可变 evidence，关闭机器合同并更新 roadmap；随后删除完成态 phase 文档。
稳定架构事实回到各自 owner 文档，历史测量只存在于 evidence，Git 历史保留执行过程。完成态
phase 文档不得继续出现在 `docs/README.md` 的默认开工路径中。
