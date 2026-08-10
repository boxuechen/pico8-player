# Phase 9 — Supplemental Compatibility Remediation

> 状态：Active
>
> Active work unit：9F — Single Supplemental Requalification
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
  duration、完整 C2 或历史阶段全集。整套 4×50 只在 9F 跑一次；9G 只运行 focused release gate。
- 默认 `pnpm test` / `pnpm run verify` 是 quick baseline；`verify:phase-9` 叠加当前 work unit 的 owner tests，
  `verify:release` 只覆盖 release artifact 与短 Chrome 玩家路径。`verify:historical` 与 600 秒 soak 仅供
  相关跨阶段回归的手动诊断，不是 Phase 9 exit gate。
- RuntimeCore 保持 browser-neutral；Canvas、AudioContext、Worker 与 screenshot automation 继续属于
  `apps/web-player` / browser tooling。

## 3. Work units

| Unit | 状态 | 可观察结果 |
| --- | --- | --- |
| 9A Failure-set Freeze / Root-cause Contract | Complete | 51-case failure set 冻结为 15 个匿名候选，exact coverage 51、unclassified 0 |
| 9B Language Compatibility Remediation | Complete | 13 个 language candidate 均有通用 real-WASM fix；1 个 downstream host gap 转交 9D |
| 9C Timing Compatibility Remediation | Complete | 固定 32M safety cap 与 numeric-for boundary 修复使 5 个 timing case 全部达到 CU |
| 9D Host-feature Compatibility Remediation | Complete | 显式 local bundle 与 empty-load no-op 使 2 个 host case 达到 CU，missing/denied 仍失败关闭 |
| 9E Focused Chrome Regression | Complete | 10 个 production Chrome representative 交叉覆盖所有修复机制，10/10 CU |
| 9F Single Supplemental Requalification | **Active** | 唯一一次 4×50 quick smoke 达到 200 CU |
| 9G Release Regression | Pending | release artifact、短 Chrome lifecycle 与 focused release gate 通过 |
| 9H Aggregate Exit | Pending | aggregate-only evidence 归档并关闭阶段 |

## 4. 已完成：9A Failure-set Freeze / Root-cause Contract

Phase 8 仓库外 aggregate 的 SHA-256 已验证为
`54c352ff737973e944a773afe8396e30b012915ac40d5c3a0252932553505a7b`。四个本地 observation batch
exact 覆盖 200 cases / 51 failures，并归并为 15 个候选：9B language 13 个/45 cases、9C timing
1 个/5 cases、9D host-feature 1 个/1 case；unclassified 为 0。

机器结果为
[`phase-9-root-cause-contract-v1.json`](../../spec/compat/phase-9-root-cause-contract-v1.json)，schema、
deterministic grouping、redaction、hash、exact coverage、repository/ref quarantine 与 evidence-gap
fail-closed 由 `pnpm run test:phase-9a` 验证。9A 没有修改 production source、启动 Chrome 或重跑
supplemental corpus。

## 5. 已完成：9B Language Compatibility Remediation

13 个 language candidate / 45 个 baseline cases 都有独立的项目原创 `.p8` real-WASM regression。
通用修复覆盖 P8 Lua parser/lexical environment、VM-local helper、typed `stat()`、host numeric/tostr
coercion、`btnp()` mask、bounded `peek/poke`、cartdata slot 与 protected allocation；默认 Lua heap 固定为
2 MiB，WASM memory 仍固定 16 MiB 且禁止 growth。决定见
[ADR-026](../adr/026-phase-9-language-compatibility-boundary.md)，owner gate 为
`pnpm run test:phase-9b`。

10 个 caller-authorized external representative 各运行 120 ticks：全部越过对应语言根因，其中 9 个
达到 CU；剩余 1 个随后请求不在当前 bundle 的 local `load()` target，故作为 downstream host-feature
case 转交 9D。9B 没有运行 4×50 supplemental sweep、没有引入 cart identity branch，也没有跟踪第三方
身份、路径或逐-cart 结果。

## 6. 已完成：9C Timing Compatibility Remediation

`timing-instruction-budget-boundary` 的 5 个 case 中，有限 transaction 最大测得 `21,623,599`
instructions；默认 hard safety cap 因此固定为 `32,000,000`，仍由 deterministic hook containment
runaway，不使用 adaptive/wall-clock budget。另一个根因是 z8lua numeric `for` 在 Q16.16 上界后依赖
C++ signed overflow 回绕；现在先在 `int64` raw 域计算 next index，越界即结束循环。决定见
[ADR-027](../adr/027-phase-9-timing-safety-boundary.md)，owner gate 为 `pnpm run test:phase-9c`。

finite-heavy 与 explicit-runaway 两个项目原创 real-WASM fixture 均通过；5 个 affected external case
各运行 120 ticks，全部达到 CU。9C 未运行 full supplemental sweep、长 playability、historical gate，
也没有跟踪第三方身份、路径或逐-cart observation。

## 7. 已完成：9D Host-feature Compatibility Remediation

`host-external-cartdata-request` baseline case 与 9B downstream guest-load case 都属于既有 root
HostRequest profile；原始 supplemental manifest 没有携带它们需要的 local dependency。仓库外 manifest
补齐显式 ref/bytes/capability 后，进一步发现空 launch parameter 被 `load(stat(6))` 转交时不应产生
HostRequest。bridge 现在把 `load("")` 处理为同步 no-op；所有非空 missing/denied ref 仍失败关闭。决定见
[ADR-028](../adr/028-phase-9-local-host-feature-boundary.md)，owner gate 为 `pnpm run test:phase-9d`。

两个项目原创 fixture 锁定 accepted `cstore→reload`、missing/denied fail-closed 与 empty-load no-op；
2 个 affected external case 各运行 120 ticks，全部达到 CU。9D 没有网络/filesystem authority expansion、
cart-specific branch、full sweep 或 tracked third-party dependency。

## 8. 已完成：9E Focused Chrome Regression

从仓库外 failure set 选择了 6 个 language、2 个 timing、2 个 host representative，在同一 clean player
commit、WASM hash、Chrome build 和 production Worker path 下均配置 120 logical-tick 上限。10 个 case 全部
按各自 lifecycle oracle complete、全部达到 CU，remaining failure 与 failure cluster 均为 0；显式 local bundle 覆盖 external
data/guest load，其他代表覆盖 parser/VM helper、typed host/coercion、bounded memory/persistence、finite-heavy
safety headroom 与 Q16.16 numeric-for termination。

9E 没有 production 修改、full supplemental rerun、long playability、historical/soak，也没有跟踪第三方
身份、路径、hash、截图或逐-case result。聚合结果与隐私约束由 `pnpm run test:phase-9e` 锁定。

## 9. 当前工作：9F Single Supplemental Requalification

### 9.1 输入与可观察结果

9F 是 Phase 9 唯一获准的 supplemental full requalification，也是 verification-only work unit：在一个
clean player commit 上按 4 个固定 batch 顺序各运行 50 个 case，每个仅 120 logical ticks，总计恰好
200 个。所有 batch 必须锁定同一 player commit、WASM hash、Chrome build 和 production Worker path；已知
external data/guest load 依赖只能通过 caller-authorized 仓库外 manifest 中的显式 local bundle 注入。

输出只记录 aggregate：batch/case/complete/CU/failure cluster、运行环境一致性、bundle capability 与 full-run
计数。第三方 identity、path、hash、bytes、截图和逐-case observation 保留在仓库外；不得发布兼容率。
若出现 failure，停止全量执行并只做 bounded focused triage，把根因重新归给 9B–9D owner；不得为了获得
绿色结果重复整套 4×50、放宽 oracle 或在 9F 修改 production source。

### 9.2 允许修改

机器权威 allowlist 位于 `workUnits.9F.allowedPaths`，仅包含 compat/browser tooling、contract tests、phase
route 与 package scripts；`packages/**`、`wasm/**`、production app source 和 `ref/**` 均不授权。

### 9.3 路由 owner

- bounded external gate 与 aggregate privacy：
  [`06-testing-compatibility.md`](../06-testing-compatibility.md#35-expanded-local-real-cart-gate)
- Chrome-only matrix 与 production path：
  [`06-testing-compatibility.md`](../06-testing-compatibility.md#11-chromechromium-支持矩阵)

### 9.4 验证与退出

- `pnpm run test:phase-9f` 通过。
- 恰好一次 4×50 production Chrome requalification 完成，200/200 CU、remaining failure cluster 为 0。
- 同一 player/WASM/Chrome/production path 约束通过；production changes、额外 full rerun、长 playability、
  historical/soak 均为 0。
- tracked third-party detail 为 0，worktree clean，随后 9G 成为唯一 active work unit。

## 10. Phase exit gate

- supplemental `200/200` 达到 CU，remaining failure 与 failure cluster 均为 `0`。
- 所有 production fix 都有项目原创 regression，cart-specific branch 为 `0`。
- open P0/P1 为 `0`；第三方 tracked artifact 与公开兼容率为 `0`。
- 9F 只进行一次 4×50 quick smoke；9G 不重跑历史阶段全集或 600 秒 soak。
- `pnpm run verify:phase-9`、`pnpm run verify:release`、Phase 9 aggregate exit test 与 clean worktree
  gate 通过。
