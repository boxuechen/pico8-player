# Phase 9 — Supplemental Compatibility Remediation

> 状态：Active
>
> Active work unit：9A — Failure-set Freeze / Root-cause Contract
>
> 机器合同：[`spec/phase-9-supplemental-compatibility-remediation-contract.json`](../../spec/phase-9-supplemental-compatibility-remediation-contract.json)
>
> 基线：Phase 8 exit commit `6d61ba3a40d34ee06da915a2b2033ec5660d54fe`

## 1. 阶段目标

把 supplemental Top200 local snapshot 的 51 个 120-tick Chrome quick-smoke failure 按共享根因修复，
最终让 200 个 case 全部达到 CU。基线 failure cluster 为 language `45`、timing `5`、
unsupported-host-feature `1`。

修复目标是 PICO-8 v0.2.7 通用 Runtime 行为，不是对 Top200 cart 做特判。第三方 bytes、身份、路径、
hash、截图和逐-cart observation 继续只位于仓库外；tracked evidence 只保留 aggregate，不发布第三方
兼容率。

## 2. 不可破坏边界

- Chrome/Chromium desktop 是唯一浏览器 gate；Firefox/WebKit 与移动端不进入本阶段。
- `ref/**` 不是 build/test input。外部失败集和逐-cart triage 只能从 caller-authorized ignored path 读取。
- 每个 production fix 必须先有项目原创最小复现，并以官方 v0.2.7 手册或可审阅的官方 observation
  定义预期；禁止复制第三方代码或按 cart identity 分支。
- 不新增 BBS crawler、网络 cart fetch、任意 URL 或 host-filesystem authority。
- 日常 external regression 最多选 10 个代表 case，每个 120 logical ticks；不重复 200-cart 全量、900 秒
  duration 或完整 C2。整套 4×50 只在 9F 跑一次，完整 `pnpm run verify` 只在 9G 跑一次。
- RuntimeCore 保持 browser-neutral；Canvas、AudioContext、Worker 与 screenshot automation 继续属于
  `apps/web-player` / browser tooling。

## 3. Work units

| Unit | 状态 | 可观察结果 |
| --- | --- | --- |
| 9A Failure-set Freeze / Root-cause Contract | **Active** | 51-case ignored failure set 可复现、聚类为共享根因候选并生成原创最小复现计划 |
| 9B Language Compatibility Remediation | Pending | 45 个 language failure 的共享根因由通用 real-WASM 修复关闭 |
| 9C Timing Compatibility Remediation | Pending | 5 个 timing failure 的 scheduler/frame/CPU 根因关闭 |
| 9D Host-feature Compatibility Remediation | Pending | 1 个 host-feature failure 在不扩大 authority 的前提下达到 CU |
| 9E Focused Chrome Regression | Pending | 小范围 production Chrome 代表回归覆盖所有修复根因 |
| 9F Single Supplemental Requalification | Pending | 唯一一次 4×50 quick smoke 达到 200 CU |
| 9G Release Regression | Pending | release artifact、Chrome lifecycle 与一次最终 verify 通过 |
| 9H Aggregate Exit | Pending | aggregate-only evidence 归档并关闭阶段 |

## 4. 当前工作：9A Failure-set Freeze / Root-cause Contract

### 4.1 输入与输出

9A 只使用 Phase 8 已生成的仓库外 supplemental observation。它必须校验 200-case aggregate SHA-256
`54c352ff737973e944a773afe8396e30b012915ac40d5c3a0252932553505a7b`，再从本地 51 个失败生成：

- exact `45 / 5 / 1` 的匿名 cluster inventory；
- 按相同 error signature、parser/VM stage、frame/lifecycle signal 合并的 root-cause candidates；
- 每个 candidate 的项目原创最小复现计划、owner boundary 和短验证命令；
- 明确的 evidence gap。未知原因不能通过改标签假装关闭。

tracked 输出不得包含 identity、源路径、cart/screen hash、fault message 原文、截图或第三方代码。

### 4.2 允许修改

机器权威 allowlist 位于当前 phase contract 的 `workUnits.9A.allowedPaths`。9A 不授权修改 production
source；若 triage 需要实现兼容行为，必须先完成 9A 并激活对应的 9B/9C/9D。

### 4.3 路由 owner

- 外部 corpus、聚类、redaction 与 deterministic runner：
  [`06-testing-compatibility.md`](../06-testing-compatibility.md#35-expanded-local-real-cart-gate)
- package、execution-domain 与 `ref/` quarantine：
  [`08-source-layout-and-boundaries.md`](../08-source-layout-and-boundaries.md#1-canonical-workspace)
- z8lua/WASM ownership：
  [`03-z8lua-wasm-bridge.md`](../03-z8lua-wasm-bridge.md)
- scheduler、frame 与 host API ownership：
  [`04-typescript-runtime.md`](../04-typescript-runtime.md)

### 4.4 验证与退出

- 项目原创 schema/tool tests 证明 51-case exact coverage、aggregate hash、redaction、repository/ref
  quarantine 和 root-cause grouping determinism。
- 9A 不启动 Chrome、不修改 production、不重跑 200 carts。
- worktree clean，随后 9B 成为唯一 active work unit。

## 5. Phase exit gate

- supplemental `200/200` 达到 CU，remaining failure 与 failure cluster 均为 `0`。
- 所有 production fix 都有项目原创 regression，cart-specific branch 为 `0`。
- open P0/P1 为 `0`；第三方 tracked artifact 与公开兼容率为 `0`。
- 9F 只进行一次 4×50 quick smoke；9G 只进行一次最终 `pnpm run verify`。
- `pnpm run test:release`、Phase 9 aggregate exit test 与 clean worktree gate 通过。
