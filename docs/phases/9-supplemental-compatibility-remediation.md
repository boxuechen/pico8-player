# Phase 9 — Supplemental Compatibility Remediation

> 状态：Active
>
> Active work unit：9C — Timing Compatibility Remediation
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
| 9C Timing Compatibility Remediation | **Active** | 5 个 timing failure 的 scheduler/frame/CPU 根因关闭 |
| 9D Host-feature Compatibility Remediation | Pending | baseline 1 个 host-feature failure 加 1 个 downstream case 在不扩大 authority 的前提下达到 CU |
| 9E Focused Chrome Regression | Pending | 小范围 production Chrome 代表回归覆盖所有修复根因 |
| 9F Single Supplemental Requalification | Pending | 唯一一次 4×50 quick smoke 达到 200 CU |
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

## 6. 当前工作：9C Timing Compatibility Remediation

### 6.1 输入与可观察结果

9C 只处理 root-cause contract 中 `timing-instruction-budget-boundary` 这 1 个 anonymous candidate / 5
cases。现有 observation 只证明它们在首个有效 boundary 前或极早 frame 命中
`E_VM_INSTRUCTION_BUDGET`，不能据此判定是合法有限重计算还是 infinite loop。按以下顺序推进：

- 建立项目原创 deterministic-clock fixture，分别包含可结束的 startup/frame 重计算和明确不 yield 的
  runaway control；记录 instruction count、boundary、committed tick 与 structured fault。
- 先测量 5 个 caller-authorized case 的 deterministic instruction envelope，再决定问题属于 hook
  accounting、startup/frame hard safety cap、implicit-frame boundary 或 scheduler transaction；不得用
  wall-clock、机器性能或 cart identity 改变 guest 结果。
- 若调整 hard cap，必须仍是固定 project profile，且 runaway 在有界 instruction count 内稳定产生
  `E_VM_INSTRUCTION_BUDGET`；不得变成无限执行、adaptive budget 或主线程 watchdog。
- owner tests 通过后只对这 5 个 affected case 各做 120-tick Chrome smoke；不运行 4×50 全量、长
  playability、600 秒 soak 或 historical sweep。

### 6.2 允许修改

机器权威 allowlist 位于当前 phase contract 的 `workUnits.9C.allowedPaths`。deterministic instruction
hook 与 VM safety boundary 属于 z8lua bridge，logical transaction、tick commit 与 diagnostics 属于
RuntimeCore scheduler。Canvas/rAF 只作为短 Chrome adapter 验证，不得成为计时 oracle；AudioContext、
network、任意 URL 和 host filesystem 均不在 9C 范围。

### 6.3 路由 owner

- VM hook、budget 和 structured fault：
  [`03-z8lua-wasm-bridge.md`](../03-z8lua-wasm-bridge.md#4-生命周期与控制流)、
  [`03-z8lua-wasm-bridge.md`](../03-z8lua-wasm-bridge.md#9-yieldhostrequest-与错误)
- scheduler transaction 与 CPU policy：
  [`04-typescript-runtime.md`](../04-typescript-runtime.md#10-scheduler)、
  [`04-typescript-runtime.md`](../04-typescript-runtime.md#103-cpu-budget-与慢帧)
- deterministic conformance 与短 external gate：
  [`06-testing-compatibility.md`](../06-testing-compatibility.md#6-conformance-carts)、
  [`06-testing-compatibility.md`](../06-testing-compatibility.md#35-expanded-local-real-cart-gate)

### 6.4 验证与退出

- finite heavy-work 与 runaway control 都有项目原创 deterministic real-WASM regression，且安全边界不依赖 wall-clock。
- `pnpm run test:phase-9c` 和 `pnpm run verify:phase-9` 通过。
- 5 个 affected external cases 的 120-tick Chrome quick smoke 通过；无全量 supplemental rerun。
- production cart-specific branch 为 0，worktree clean，随后 9D 成为唯一 active work unit。

## 7. Phase exit gate

- supplemental `200/200` 达到 CU，remaining failure 与 failure cluster 均为 `0`。
- 所有 production fix 都有项目原创 regression，cart-specific branch 为 `0`。
- open P0/P1 为 `0`；第三方 tracked artifact 与公开兼容率为 `0`。
- 9F 只进行一次 4×50 quick smoke；9G 不重跑历史阶段全集或 600 秒 soak。
- `pnpm run verify:phase-9`、`pnpm run verify:release`、Phase 9 aggregate exit test 与 clean worktree
  gate 通过。
