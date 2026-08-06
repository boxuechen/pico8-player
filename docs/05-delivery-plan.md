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
| 5 L3 local/multicart | Complete | [Phase 5 exit](./evidence/phase-5/61-phase-5-l3-local-multicart-exit-evidence.md) / [contract](../spec/phase-5-l3-multicart-contract.json) |
| 6 Real-cart Qualification（6A–6H） | Complete | [Phase 6 exit](./evidence/phase-6/71-phase-6-real-cart-qualification-exit-evidence.md) / [contract](../spec/phase-6-real-cart-qualification-contract.json) |

Phase 5 的最后发布口径严格限于 PICO-8 v0.2.7、Chrome/Chromium desktop 和项目原创 local L3
corpus。Known Differences、Deferred BBS 与范围排除以 Phase 5 evidence 和
[`phase-5h-exit.json`](../tests/conformance/manifests/phase-5h-exit.json) 为准，不在 roadmap 重复。

## 3. 下一阶段激活边界

Phase 6 已关闭，当前没有 active phase。任何下一阶段必须先创建 phase 文档与机器合同，并重新冻结：

1. 相对关闭 L3 profile 的明确 capability delta、合法 corpus 和可计算发布分母。
2. 新资源来源、缓存、分享或网络 surface 的 caller authority 与 fail-closed 边界。
3. 新生命周期行为的 transaction、rollback、generation、cancellation 和 stale-output 语义。
4. 是否改变 ADR-019 root-only coroutine policy；如改变，先提交 replacement ADR 和独立 spike。
5. 网络、持久化、版权、Terms、隐私和资源上限；默认不得自动访问 BBS 或跟踪第三方 cart bytes。

Phase 6 的 aggregate qualification、输入 hash 与 privacy boundary 只由关闭合同和
[exit evidence](./evidence/phase-6/71-phase-6-real-cart-qualification-exit-evidence.md) 保存。后续阶段
方向继续 Deferred，不得从本 roadmap 直接开工。

## 4. 当前声明之外

编辑器、命令行、SPLORE 替代、公共 cart 镜像、任意 URL/文件系统访问、非 Chrome 浏览器和
未经授权的第三方内容分发不属于当前声明；如需评估，必须另立产品决策与 phase。
