# Phase 15 — Lifecycle and Persistence Hardening 完成证据

> Status: Complete · Date: 2026-11-12 · Chrome/Chromium desktop only
>
> Machine contract: [phase-15-lifecycle-persistence-contract.json](../../../spec/phase-15-lifecycle-persistence-contract.json)

## 按 review 1–4 完成

1. Host persistence 换卡先 stop 旧 producer 并 flush 旧 contentId，失败阻止替换；hydrate 与
   record 校验全部成功后才激活新 binding。rejected/malformed hydration 保留旧 identity，并可重试。
2. dispose 立即终止 public event 输出，但保留内部 commit 订阅至 in-flight operation、stop/drain
   和 Worker teardown 完成；最后等待 host write queue/flush 并移除订阅。teardown 失败也执行清理。
3. 首帧 gate 创建时立即观察 rejection，保持等待 command acknowledgement 的顺序；startup
   fault、deadline 或 dispose 不再产生额外 unhandled rejection。
4. IndexedDB flush 返回实际 durability，失败保留 pending snapshots 供 retry；Worker DTO 与
   validator 要求 boolean durable，公开默认 flush 将失败传给 caller。Host profile 仍须等待
   caller adapter 的 write queue 和 flush，Worker acknowledgement 本身不代表 host durable success。

## Verification

最终验证环境：Node 22.22.2、pnpm 10.8.0。每项最小 regression 均先在修复前失败，再在修复后通过。

| Check | Observed result |
| --- | --- |
| `pnpm run test:lifecycle-persistence` | 27/27；含 real-WASM Worker、host adapter、fault/deadline/dispose、quota abort 与 retry |
| `pnpm run verify` | 68/68；architecture/consumer TypeScript、codec、release integrity、轻量 lifecycle/persistence regression |
| Release build | 复用既有锁定 WASM，重建 TypeScript release 与 deterministic package |
| `node tools/release/verify-release.mjs` | 15 release files、6 stable keys、16 package files 通过 |
| Package SHA256 | `1fe1b3edb34a8871e994533cf3002730f567f5d90c4ee47db5d081732866c958` |
| `node tools/browser/run-phase-15.mjs` | 1 focused run，Google Chrome 157.0.8103.51 |
| Chrome persistence | 9 writes，A/B identities 独立；延迟 hydrate 期间旧 producer stopped；dispose 等待延迟 B write |
| Chrome startup | 同 facade A/B + dispose 后 fresh facade 均呈现不同 Canvas 像素 |
| Chrome default profile | IndexedDB flush 返回 durable true |
| Chrome teardown | 2/2 Workers terminated，2/2 AudioContexts closed，active RAF 0 |
| Chrome unhandled rejections | 0 |
| `git diff --check` | 通过 |

此前 Phase 13C 的 fake 未产生 accepted frame，已按 Phase 14 契约补齐。默认 quick gate 增加
embed lifecycle、首帧失败路径和 IndexedDB quota/retry tests，不依赖 WASM 构建。完整 focused Node
入口包含需要既有 production WASM artifact 的测试；`test:phase-15` 提供锁定 WASM 重建后的全流程入口。

## Ownership and worktree

未新增 package、execution domain、public subpath 或 dependency edge。RuntimeCore 仅 persistence
port 的 flush 返回类型增加明确 durability；没有 browser API 移入 core，没有 WASM/guest semantics
改动。Embed API 保持 v2；private Worker DTO 与 app consumer 同步更新。

任务开始时工作区已包含 Phase 14 未提交修改：embed-player、02/05/06、docs README、phase index、
package scripts、7B tests，以及 Phase 14 的 spec/evidence/Node/Chrome runner。上述输入保留，历史
Phase 14 evidence 未改写。本阶段改动的 owner 为 main embed/host persistence、transport、Worker
composer/IndexedDB adapter、core persistence port；新增 regression tests、Phase 15 Chrome runner、
机器合同及本证据。阶段执行文档按仓库规则关闭后撤下。

未执行 Git commit、清理用户改动、外部 corpus、Top 200、historical matrix、long soak、
Firefox/WebKit、mobile project mutation 或任何远程发布。
