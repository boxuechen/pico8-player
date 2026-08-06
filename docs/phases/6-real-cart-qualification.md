# Phase 6 — Real-cart Qualification

> 状态：Active；6A–6B complete，6C active
> 机器合同：[`spec/phase-6-real-cart-qualification-contract.json`](../../spec/phase-6-real-cart-qualification-contract.json)
> 浏览器门禁：Google Chrome / Chromium desktop only
> 前置证据：[Phase 5 L3 local/multicart exit](../evidence/phase-5/61-phase-5-l3-local-multicart-exit-evidence.md)
> 目标声明：在不分发第三方内容的前提下，以本地真实卡带验证并收敛当前 L3 project profile

## Goal 与 non-goals

Phase 6 建立可重复的本地真实卡带 qualification 流程，用至少 12 个 caller-supplied cart 发现并
分类兼容缺口；优先关闭已观察到的 `stat(20)`、`menuitem()` 与 CPU slicing 三个 cluster，最后在
Chrome/Chromium production path 完成可玩性验证。

本阶段不自动访问 BBS、不跟踪或发布第三方 cart bytes、截图、音频和公开成功率，不把本地
external corpus 变成 CI 依赖；不扩大到 Firefox/WebKit、任意 URL、公共 cart 镜像或针对单个 cart
的 runtime hack。CPU slicing 在 6F 完成 spike 和 replacement ADR 决定前继续遵守 ADR-017。

## Stable inputs

- [Phase 5 closed contract](../../spec/phase-5-l3-multicart-contract.json)
- [Cart 结果与已知差异](../06-testing-compatibility.md#15-兼容等级已知差异与质量口径)
- [测试数据版权与 BBS 限制](../06-testing-compatibility.md#13-测试数据版权与-bbs-访问限制)
- [Reference source quarantine](../08-source-layout-and-boundaries.md#72-reference-source-quarantine)
- [兼容 bug 工作流](../09-codex-task-protocol.md#7-兼容-bug-工作流)
- [Instruction budget 边界](../03-z8lua-wasm-bridge.md#92-instruction-budget抛错不分帧续跑)
- [ADR-017 coroutine frame slice](../adr/017-coroutine-frame-slice-and-fault-containment.md)

## Work units

| Unit | 状态 | 结果或入口 |
| --- | --- | --- |
| 6A Activation / Corpus Policy | Complete | 12-cart local-only policy、Phase 5 hash baseline、公开分母为 0 |
| 6B External Corpus Runner | Complete | 三份 schema、fail-closed validator、path-redacted report CLI |
| 6C Twelve-cart Baseline | **Active** | 下节 |
| 6D `stat(20)` Compatibility | Pending | 6C exit 后展开 |
| 6E `menuitem()` Boundary | Pending | 6D exit 后展开 |
| 6F CPU Slicing Spike / Decision | Pending | 6E exit 后展开；必须尊重/替换 ADR-017 |
| 6G Chrome Playability Pass | Pending | 6F exit 后展开 |
| 6H Qualification Exit / Report | Pending | aggregate exit |

## 6A closure

6A 已冻结 Phase 5 contract/evidence/exit/runtime hash baseline，并规定 external corpus 至少 12 个
case、只由开发者在本地显式提供、必须记录 source revision、cart SHA-256 与 permission status。
实际 cart、第三方截图和音频均保持 gitignored；CI、公开兼容分母和 production network surface
贡献均为 0。验证入口是 `pnpm run test:phase-6a`。

## 6B closure

6B 已提供 versioned local corpus、Chrome observation 与 redacted report schema，以及无网络的
`phase-6-local-qualification-v1` validator/CLI。它限制 12–64 个、单个最多 1 MiB 的 local cart，
验证 realpath、hash、source revision 和 permission status；`ref/`、tracked source path、重复 ID、
矛盾 C* 分类及泄漏本机路径均 fail closed。缺失 observation 保持 `CU` 且整份 qualification 标为
incomplete。验证入口是 `pnpm run test:phase-6b`。

## Active work unit：6C Twelve-cart Baseline

### Observable behavior

1. 从 caller 已合法取得的本地副本建立恰好 12-case ignored manifest；每个 case 锁定 source label、
   immutable revision、SHA-256、permission status 和 fixed-tick trace。runner 不接受 `ref/` 路径。
2. 增加独立 local Chrome harness，复用现有 production build、WASM 和 Worker composition；对每个 cart
   验证 codec/load、boot、固定 120 tick、first fault、frame publication 与 screen digest。
3. harness 只输出 ignored observations JSON，不保存截图、音频或 cart bytes；environment 必须绑定当前
   player commit、runtime WASM SHA-256 和实际 Google Chrome/Chromium version。
4. 所有 12 case 必须完成 `boots/fails` smoke outcome；失败项标为 `C0` 并落入 bounded failure
   cluster，启动项保持 `CU`，不能用 120-tick smoke 直接声称 C1/C2/C3。
5. 6C 只建立 baseline，不修 production。失败 cluster 在后续 unit 先转成项目原创最小 reproduction，
   再决定通用修复；不得加入 cart-specific 分支。
6. local report 保持 ignored。机器合同只记录“12 case 已完整分类”、环境 identity 和 cluster 名称，
   不能把该 corpus 计入发布 denominator 或宣传为真实游戏兼容率。

### Allowed files

精确允许路径由机器合同 `workUnits.6C.allowedPaths` 控制。tracked 变更只限 compat tooling、原创
fixture/test、schema、phase contract 和命令；真实 cart、manifest、observations、report 与任何截图
保持 ignored。production packages、apps、WASM 和 `ref/` runtime dependency 不在 6C 范围。

### Tests

- Proposed：`pnpm run test:phase-6c`
- Proposed：`pnpm run test:phase-6c:chrome`
- `pnpm run test:phase-6b`
- `pnpm run test:architecture`

### Exit gate

- 12/12 case 在 production Chrome path 完成 fixed trace，environment/cart/source hashes 完整。
- observation 中 12/12 均 complete；启动项为 `boots/CU`，失败项为 `fails/C0` 且有 failure cluster；
  不存在自动网络访问。
- local report 不包含绝对路径、source URL、截图、音频和原 cart bytes，且仍被 Git 忽略。
- 6C aggregate/cluster 结果折叠入机器合同，6D 成为唯一 active work unit，并独立提交。

## Phase exit gate

6H 必须给至少 12 个本地 real-cart case 完成合法性和环境绑定的 C* 分类，其中至少 3 个完成
Chrome 手工 C2 gate；`stat(20)`、`menuitem()` 与 CPU slicing 均有原创最小 regression 和明确
decision。开放 P0/P1 为 0，`pnpm run verify` 通过，仓库仍不包含第三方 cart、截图或公开成功率。
