# 可执行交付计划

本文件只维护跨阶段 roadmap 状态和下一阶段的激活边界。当前 work unit、允许文件和精确验收只由
[`docs/phases/`](./phases/) 定义；完成细节只存在于 [`docs/evidence/`](./evidence/) 和关闭的机器合同。

## 1. Roadmap 规则

- 按可观察 vertical slice 推进，不按 API 清单顺序填 stub。
- 新阶段必须先冻结输入、范围、non-goals、owner 章节、机器合同和单一 active work unit。
- roadmap headline、Target interface 和历史 evidence 都不是 production implementation 授权。
- 完成阶段只在本页保留一行状态；环境、测量、hash 和执行过程进入 immutable evidence。
- 源码布局只由 [`08-source-layout-and-boundaries.md`](./08-source-layout-and-boundaries.md) 定义。

## 2. 当前状态

| Phase | 状态 | 关闭证据或入口 |
| --- | --- | --- |
| 0 Architecture Validation（0S–0F） | Complete | [`evidence/phase-0/`](./evidence/phase-0/) |
| 1 L1 最小可玩闭环（1A–1F） | Complete | [Phase 1 exit](./evidence/phase-1/21-phase-1-l1-exit-evidence.md) |
| 2 Graphics / Memory / Text（2A–2F） | Complete | [Phase 2 exit](./evidence/phase-2/31-phase-2-graphics-memory-text-exit-evidence.md) |
| 3 Audio / Input / Persistence（3A–3H） | Complete | [Phase 3 exit](./evidence/phase-3/41-phase-3-audio-input-persistence-exit-evidence.md) |
| 4 L2 / MVP Compatibility（4A–4H） | Complete | [Phase 4 exit](./evidence/phase-4/51-phase-4-l2-mvp-exit-evidence.md) / [contract](../spec/phase-4-l2-mvp-contract.json) |
| 5 L3 local/multicart / optional BBS | **Active；5A complete，5B active** | [phase](./phases/5-l3-local-multicart.md) / [contract](../spec/phase-5-l3-multicart-contract.json) |

Phase 4 的最后发布口径严格限于 PICO-8 v0.2.7、Chrome/Chromium desktop 和项目原创 corpus。
Known Differences、coverage limitation 与范围排除以 Phase 4 evidence 和
[`phase-4h-exit.json`](../tests/conformance/manifests/phase-4h-exit.json) 为准，不在 roadmap 重复。

## 3. Phase 5 激活边界

Phase 5 的候选方向是 L3、guest cart switching 与可选 BBS integration，但默认全部 Deferred。
激活前必须显式决定并机器化以下边界：

1. 目标 capability profile 和合法 corpus；不得用“支持 BBS cart”作为无分母承诺。
2. caller-provided/local bytes、guest `load`、external resolver、BBS access、缓存和分享各自的授权范围。
3. current-cart、host-driven sequential load、guest cart swap 和 multicart 的 transaction/rollback 语义。
4. root HostRequest 与 nested coroutine suspension 的支持级别；若改变 ADR-017，先提交替代 ADR。
5. 网络、持久化、版权、Terms、隐私和资源上限；默认不得自动访问 BBS 或跟踪第三方 cart bytes。

激活产物至少包括：Accepted/Rejected 决策、版本化 `spec/` 机器合同、一个 active phase 文档、
唯一 active work unit、精确 Chrome gate 和前置 Phase 4 evidence hash。条件未满足时只允许调研、
只读审计或独立 spike，不允许把 Target 代码路径接入 production。

## 4. Phase 5 之外

编辑器、命令行、SPLORE 替代、公共 cart 镜像、任意 URL/文件系统访问、非 Chrome 浏览器和
未经授权的第三方内容分发不因 Phase 5 名称自动进入范围；如需评估，必须另立产品决策与 phase。
