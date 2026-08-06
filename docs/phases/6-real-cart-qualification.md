# Phase 6 — Real-cart Qualification

> 状态：Active；6A complete，6B active  
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
| 6B External Corpus Runner | **Active** | 下节 |
| 6C Twelve-cart Baseline | Pending | 6B exit 后展开 |
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

## Active work unit：6B External Corpus Runner

### Observable behavior

1. 提供一个 Node CLI，显式接受 local manifest/output 参数；默认不扫描目录、不读取 `ref/`、不发起
   网络请求，也不把第三方输入复制进 tracked path。
2. 对 manifest schema、case 数量、唯一 ID、cart path、source revision、SHA-256、permission status、
   deterministic input/trace 与 Chrome execution settings 做 fail-closed 验证。
3. 报告固定记录 player commit、runtime WASM hash、Chrome version、cart hash、执行时长/trace、结果
   `C0`–`C3/CU` 与 failure cluster；路径只保留 caller-approved display label，不泄露本机绝对路径。
4. 输入和报告排序确定；同一输入和 runtime identity 产生可比较的机器结果。中断或部分执行必须显式
   标记 incomplete，不能把未测 case 当 pass。
5. 自动测试只使用项目原创的占位文件/fixture 验证 schema、hash mismatch、路径隔离、redaction、
   deterministic ordering 与分类，不读取真实 external cart。

### Allowed files

精确允许路径由机器合同 `workUnits.6B.allowedPaths` 控制。工具只属于 `tools/compat/`，项目原创
fixture/test 属于 `tests/compat/`；production packages、apps、WASM、真实 third-party corpus 和
`ref/` 不在 6B 范围。

### Tests

- `pnpm run test:phase-6b`
- `pnpm run test:architecture`
- public contract 或生产行为发生变化时最终运行 `pnpm run verify`

### Exit gate

- valid local manifest 可以在无网络、无 `ref/` 依赖下生成 deterministic、path-redacted 报告。
- 缺字段、hash mismatch、重复 ID、越界 case、tracked/ref path 和 incomplete execution 均 fail closed。
- project-authored tests 覆盖报告 schema、C* 分类、failure cluster 和环境 identity。
- 6B 结果折叠入机器合同，6C 成为唯一 active work unit，并独立提交。

## Phase exit gate

6H 必须给至少 12 个本地 real-cart case 完成合法性和环境绑定的 C* 分类，其中至少 3 个完成
Chrome 手工 C2 gate；`stat(20)`、`menuitem()` 与 CPU slicing 均有原创最小 regression 和明确
decision。开放 P0/P1 为 0，`pnpm run verify` 通过，仓库仍不包含第三方 cart、截图或公开成功率。
