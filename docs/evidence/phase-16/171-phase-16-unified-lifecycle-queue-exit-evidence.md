# Phase 16 — Unified lifecycle queue 完成证据

> Status: Complete · Date: 2026-11-12 · Chrome/Chromium desktop only
>
> Machine contract: [phase-16-unified-lifecycle-queue-contract.json](../../../spec/phase-16-unified-lifecycle-queue-contract.json)
>
> Prerequisite commit: `a93a0f0`（包含 Phase 14 与 Phase 15）

## 实现与边界

每个 `PlayerController` 持有唯一 `PlayerLifecycleQueue`，Embed facade 移除独立 Promise tail。
API、Controller、DOM buttons/menu、文件读取、环境 pause/resume/pagehide 共享 FIFO；失败后允许
后续操作继续，不同 player 互不等待。复合操作接收内部 `PlayerLifecycleActions`，直接执行当前
transaction 的动作，避免嵌套 enqueue 自锁。host hydration/flush 与 facade 首帧 barrier 均保留在
transaction 内；frame pump、input、runtime event delivery 和 trusted audio unlock probe 不进入队列。

文件选择在读取 bytes 前占据顺序位置；环境事件在执行时检查状态，修复 start 尚未完成时 blur
丢失的问题。runtime stopped notification 的 audio suspend 副作用也通过队列，并再次检查状态。
`dispose` 立即关闭 admission，跳过尚未开始的操作，等待 in-flight transaction 后执行 stop/drain、
Worker teardown、host flush 与订阅清理；teardown 失败仍清理 view 与 host 订阅。

公开 API 仍为 v2；没有新增 public subpath、package 或 dependency edge。修改限于 main lifecycle、
对应测试与 owner docs；Worker protocol、RuntimeCore、WASM/ABI 和 guest semantics 未改动。

## 验证

环境：Node 22.22.2、pnpm 10.8.0、Google Chrome 157.0.8103.51。
最初三个真实 Controller + facade regression 在改动前复现 API/UI 交错、首帧期间 reset 越序、
start 期间 blur 丢失；修复后通过。新增 tests 使用真实 queue/controller，composition 与 DOM 可控。

| Check | Observed result |
| --- | --- |
| `pnpm run test:lifecycle-queue` | 43/43：既有 persistence/startup 27 + queue 9 + shell/input 7 |
| `pnpm run verify` | 最终 77/77，含 architecture、public consumer TypeScript、codec 与新增 queue regression |
| Release rebuild | 复用既有锁定 WASM，重建 TypeScript release 与 deterministic package |
| `node tools/release/verify-release.mjs` | 15 release files、6 stable keys、16 package files 通过 |
| Package SHA256 | `d54b1ea8e41bee7cb90b4b20c7cb67c6e6afe6f059e12fa3d1bb60acd0befc4e` |
| `node tools/browser/run-phase-16.mjs` | 延迟 B hydrate 期间无 UI/environment 越序；随后 loading → ready → reset ready → running → paused → running |
| Phase 16 Chrome menu | 页面打开菜单、Escape 关闭，均在 API flush barrier 前完成，无嵌套等待死锁 |
| Phase 16 Chrome dispose | 3 个 API 调用拒绝，terminal state 后无 public events；1 Worker terminated、1 AudioContext closed、RAF 0 |
| `node tools/browser/run-phase-15.mjs` | A/B delayed hydration/write + fresh facade；4 writes 归属正确，default IndexedDB durable true |
| Phase 15 Chrome teardown | 2 Workers terminated、2 AudioContexts closed、RAF 0 |
| 两项 Chrome unhandled rejections | 0 |
| `git diff --check` | 通过 |

Phase 16 Chrome fixture 首次把同步 terminal disposed event 误计作 late event；按既有 API contract
改为在 dispose 调用后记录计数，重跑通过。首次 quick gate 仅因 phase index 的关闭表述不符合
既有 exit integrity 检查失败；修正文档后最终 77/77。两次修正均未改变生产实现或放宽契约。

新增 9 项 queue regression 已加入默认 quick gate。`test:lifecycle-queue` 是 focused Node 入口；
Chrome runners 使用已构建 release。两个成功 Chrome run 共释放 3 个 Workers 与 3 个 AudioContexts。
未运行 historical matrix、long soak、external corpus、Top 200 或 Firefox/WebKit；未修改 mobile
project，未执行远程发布。既有 Phase 14/15 evidence 保持不变。Phase 16 的 16A 已完成，执行文档
按仓库规则撤下，owner 文档更新，当前 active phase 为 None。
