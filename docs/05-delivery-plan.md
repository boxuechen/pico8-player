# 交付状态与下一阶段激活边界

本文件只回答两件事：当前是否存在 active phase，以及下一阶段开始前必须冻结什么。已完成阶段的
过程、测量和结果不在这里重复，统一从 [`docs/evidence/`](./evidence/) 按需追溯。

## 当前状态

- 当前 active phase：**Phase 10**。
- active work unit：**10E — Local RC Assembly**；production Runtime behavior 不在范围。
- 当前入口：[`10-release-readiness.md`](./phases/10-release-readiness.md)。
- 最近完成：[Phase 9 — Supplemental Compatibility Remediation](./evidence/phase-9/101-phase-9-supplemental-compatibility-remediation-exit-evidence.md)。
- 最近关闭的机器合同：
  [`phase-9-supplemental-compatibility-remediation-contract.json`](../spec/phase-9-supplemental-compatibility-remediation-contract.json)。
- 当前发布口径、Known Differences 与默认验证入口由
  [`06-testing-compatibility.md`](./06-testing-compatibility.md) 维护。

## Phase 10 冻结范围

Phase 10 只把当前实现收口为本地 `0.1.0-rc.1` 静态候选：修正公开口径、补全许可与 notices、
生成确定性 archive/checksums，并执行 quick + focused Chrome release gate。它不扩展兼容面、不运行
完整 external corpus/historical matrix，也不创建 remote、tag 或外部发布。

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
