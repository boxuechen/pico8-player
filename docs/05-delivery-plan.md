# 交付状态与下一阶段激活边界

本文件只回答两件事：当前是否存在 active phase，以及下一阶段开始前必须冻结什么。已完成阶段的
过程、测量和结果不在这里重复，统一从 [`docs/evidence/`](./evidence/) 按需追溯。

## 当前状态

- 当前 active phase：**None**。
- 当前 work unit：**None**；后续 production implementation 须先激活新 phase。
- 最近完成：[Phase 17 — Standalone player session](./evidence/phase-17/181-phase-17-standalone-session-exit-evidence.md)。
- 最近关闭的机器合同：
  [`phase-17-player-session-contract.json`](../spec/phase-17-player-session-contract.json)。
- 当前发布口径、Known Differences 与默认验证入口由
  [`06-testing-compatibility.md`](./06-testing-compatibility.md) 维护。

## 当前本地候选

`0.2.0-alpha.1` 是当前本地 mobile-integration candidate；它在 `0.1.0-rc.1` 已完成的静态目录、
deterministic archive/checksum 与 standalone verification 上增加 Embed API v2 host ports。项目仍为
`UNLICENSED`，且没有 remote、tag、npm、网站或外部 publication。
后续若要公开发布，必须先独立决定许可与发布通道并激活新 phase。

## 已交付本地体验工具

Phase 11 已交付 `tools/local-gallery/`：本地 developer tool 在启动时读取调用者通过 CLI 显式授权的
cart root，并通过 `127.0.0.1` 提供 ephemeral catalog。稳定边界由 08 维护，完成结果只在
[exit evidence](./evidence/phase-11/121-phase-11-local-cart-gallery-exit-evidence.md) 中保存。第三方 cart
不是 build/test/release input；自动化只使用 project-owned fixture。

## 后续阶段激活条件

新阶段必须同时提交 phase 文档和机器合同，并冻结：

1. 可观察目标、non-goals 与 Chrome-only 浏览器范围。
2. 单一 active work unit、允许文件和 owner contract 链接。
3. 测试预算：默认 quick gate、必要的 focused Chrome case，以及明确禁止的全量/长时验证。
4. 外部 cart 的 caller authorization、仓库隔离和 aggregate-only evidence 规则。
5. production、网络、文件系统、发布或第三方内容权限是否发生变化。
6. work-unit exit、phase exit 和 clean-worktree gate。

激活和完成格式见 [`docs/phases/README.md`](./phases/README.md)。roadmap 想法、历史 evidence 和目标
架构示例都不构成 production implementation 授权。

## 当前声明之外

编辑器、命令行、SPLORE 替代、公共 cart 镜像、任意 URL/宿主文件系统访问、非 Chrome 浏览器、
未经授权的第三方内容分发，以及 official bit-exact 声明均不属于当前产品口径。扩展这些范围必须
先形成产品决定和独立 phase。
