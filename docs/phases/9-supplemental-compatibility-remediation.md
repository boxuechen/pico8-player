# Phase 9 — Supplemental Compatibility Remediation

> 状态：Active
>
> Active work unit：9B — Language Compatibility Remediation
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
| 9B Language Compatibility Remediation | **Active** | 45 个 language failure 的共享根因由通用 real-WASM 修复关闭 |
| 9C Timing Compatibility Remediation | Pending | 5 个 timing failure 的 scheduler/frame/CPU 根因关闭 |
| 9D Host-feature Compatibility Remediation | Pending | 1 个 host-feature failure 在不扩大 authority 的前提下达到 CU |
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

## 5. 当前工作：9B Language Compatibility Remediation

### 5.1 输入与可观察结果

9B 只处理 root-cause contract 中 ownerPhase 为 `9B` 的 13 个 language root-cause candidate / 45 cases。
按先根因、后代表 external case 的顺序推进：

- 每个 candidate 先建立项目原创 `.p8` 最小复现和 real-WASM regression；不得把第三方源码、身份或
  diagnostic 原文复制到 fixture。
- 预期行为必须来自官方 v0.2.7 手册或可审阅的官方 observation；若最小复现不能确认根因，保留
  evidence gap，不通过放宽类型、内存或安全预算假装关闭。
- 修复单位是 parser/dialect、value semantics、library surface、host argument contract、allocator 或
  typed fault translation 的通用行为；production 中 cart identity branch 必须为 0。
- owner tests 全部通过后，只选最多 10 个覆盖已修根因的 external case 做 120-tick Chrome quick smoke；
  不运行 4×50 全量、长 playability 或 historical sweep。

### 5.2 允许修改

机器权威 allowlist 位于当前 phase contract 的 `workUnits.9B.allowedPaths`。Language 行为优先落在
z8lua/prelude/WASM bridge；只有 host API 参数或 browser-neutral persistence contract 确实拥有行为时，
才修改 RuntimeCore。Canvas、DOM、AudioContext、network、任意 URL 和 host filesystem 均不在 9B 范围。

### 5.3 路由 owner

- VM 初始化、库白名单与错误：
  [`03-z8lua-wasm-bridge.md`](../03-z8lua-wasm-bridge.md#3-vm-初始化与库白名单)、
  [`03-z8lua-wasm-bridge.md`](../03-z8lua-wasm-bridge.md#9-yieldhostrequest-与错误)
- host-call/value ABI：
  [`03-z8lua-wasm-bridge.md`](../03-z8lua-wasm-bridge.md#7-wasm-import-与-host-call-frame)、
  [`03-z8lua-wasm-bridge.md`](../03-z8lua-wasm-bridge.md#8-值编解码)
- RuntimeCore API/persistence/error ownership：
  [`04-typescript-runtime.md`](../04-typescript-runtime.md#11-persistence)、
  [`04-typescript-runtime.md`](../04-typescript-runtime.md#15-错误模型)
- 原创 conformance 与短 external gate：
  [`06-testing-compatibility.md`](../06-testing-compatibility.md#6-conformance-carts)、
  [`06-testing-compatibility.md`](../06-testing-compatibility.md#35-expanded-local-real-cart-gate)

### 5.4 验证与退出

- 13 个 candidate 都有项目原创 real-WASM regression；45 cases 对应的共享根因均有明确 disposition。
- `pnpm run test:phase-9b` 和 `pnpm run verify:phase-9` 通过。
- 最多 10 个 external representative cases 的 120-tick Chrome quick smoke 通过；无全量 supplemental rerun。
- production cart-specific branch 为 0，worktree clean，随后 9C 成为唯一 active work unit。

## 6. Phase exit gate

- supplemental `200/200` 达到 CU，remaining failure 与 failure cluster 均为 `0`。
- 所有 production fix 都有项目原创 regression，cart-specific branch 为 `0`。
- open P0/P1 为 `0`；第三方 tracked artifact 与公开兼容率为 `0`。
- 9F 只进行一次 4×50 quick smoke；9G 不重跑历史阶段全集或 600 秒 soak。
- `pnpm run verify:phase-9`、`pnpm run verify:release`、Phase 9 aggregate exit test 与 clean worktree
  gate 通过。
