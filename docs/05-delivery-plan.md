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
| 7 Web Player Release Candidate（7A–7H） | Active — 7B | [phase](./phases/7-web-player-release-candidate.md) / [contract](../spec/phase-7-web-player-release-candidate-contract.json) |

Phase 5 的最后发布口径严格限于 PICO-8 v0.2.7、Chrome/Chromium desktop 和项目原创 local L3
corpus。Known Differences、Deferred BBS 与范围排除以 Phase 5 evidence 和
[`phase-5h-exit.json`](../tests/conformance/manifests/phase-5h-exit.json) 为准，不在 roadmap 重复。

## 3. 当前阶段边界

Phase 7 已由 7A 激活，当前唯一 work unit 为 7B。它把关闭的 Runtime/profile 产品化为可重复构建、
可嵌入的 Chrome/Chromium desktop Release Candidate；不扩大 cart 来源、网络 authority、公开第三方
兼容率或浏览器范围。精确 capability delta、7A–7H 顺序和 exit gate 只由
[active phase](./phases/7-web-player-release-candidate.md) 与
[机器合同](../spec/phase-7-web-player-release-candidate-contract.json) 授权。

Phase 6 的 aggregate qualification、输入 hash 与 privacy boundary 继续只由关闭合同和
[exit evidence](./evidence/phase-6/71-phase-6-real-cart-qualification-exit-evidence.md) 保存；Phase 7 不把
第三方 cart、截图、路径或逐-cart 结果带入 release artifact。

## 4. 当前声明之外

编辑器、命令行、SPLORE 替代、公共 cart 镜像、任意 URL/文件系统访问、非 Chrome 浏览器和
未经授权的第三方内容分发不属于当前声明；如需评估，必须另立产品决策与 phase。
