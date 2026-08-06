# Phase 6 — Real-cart Qualification

> 状态：Active；6A–6G complete，6H active
> 机器合同：[`spec/phase-6-real-cart-qualification-contract.json`](../../spec/phase-6-real-cart-qualification-contract.json)
> 浏览器门禁：Google Chrome / Chromium desktop only
> 前置证据：[Phase 5 L3 local/multicart exit](../evidence/phase-5/61-phase-5-l3-local-multicart-exit-evidence.md)
> 目标声明：在不分发第三方内容的前提下，以本地真实卡带验证并收敛当前 L3 project profile

## Goal 与 non-goals

Phase 6 建立可重复的本地真实卡带 qualification 流程，用至少 12 个 caller-supplied cart 发现并
分类兼容缺口；先关闭 `stat(20)`、`menuitem()` 与 CPU slicing 三个已知 cluster，再在 6G 对 6C
新发现的 residual surface 作通用修复或明确 disposition，最后完成 Chrome 可玩性验证。

本阶段不自动访问 BBS、不跟踪或发布第三方 cart bytes、截图、音频和公开成功率，不把本地
external corpus 变成 CI 依赖；不扩大到 Firefox/WebKit、任意 URL、公共 cart 镜像或针对单个 cart
的 runtime hack。CPU slicing 的已接受边界由 ADR-022 与 `P6-KD-02` 锁定，6G 不再扩张它。

## Stable inputs

- [Phase 5 closed contract](../../spec/phase-5-l3-multicart-contract.json)
- [Cart 结果与已知差异](../06-testing-compatibility.md#15-兼容等级已知差异与质量口径)
- [测试数据版权与 BBS 限制](../06-testing-compatibility.md#13-测试数据版权与-bbs-访问限制)
- [Reference source quarantine](../08-source-layout-and-boundaries.md#72-reference-source-quarantine)
- [兼容 bug 工作流](../09-codex-task-protocol.md#7-兼容-bug-工作流)
- [Hard budget 与 implicit quantum](../03-z8lua-wasm-bridge.md#92-hard-safety-budget-与-implicit-frame-quantum)
- [ADR-022 CPU slicing](../adr/022-cpu-slicing-decision.md)
- [Official PICO-8 v0.2.7 `stat()` reference](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#STAT)
- [Official PICO-8 v0.2.7 `menuitem()` reference](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#MENUITEM)

## Work units

| Unit | 状态 | 结果或入口 |
| --- | --- | --- |
| 6A Activation / Corpus Policy | Complete | 12-cart local-only policy、Phase 5 hash baseline、公开分母为 0 |
| 6B External Corpus Runner | Complete | 三份 schema、fail-closed validator、path-redacted report CLI |
| 6C Twelve-cart Baseline | Complete | 12/12 complete；6 boots/CU、6 fails/C0；local-only screenshots |
| 6D `stat(20)` Compatibility | Complete | affected case 恢复；local baseline 变为 7 boots/CU、5 fails/C0 |
| 6E `menuitem()` Boundary | Complete | VM-local 五槽 registration；UI/invocation 为 `P6-KD-01` |
| 6F CPU Slicing Spike / Decision | Complete | root-safe implicit frame；ADR-022；affected case 恢复 |
| 6G Chrome Playability Pass | Complete | `unpack`、26 个 raw P8SCII globals、11/11 in-profile boots、3 个 C2 |
| 6H Qualification Exit / Report | **Active** | aggregate-only exit、evidence 与文档关闭 |

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

## 6C closure

6C 已在 Chrome 150 production Worker/WASM path 对 12 个 local-only `.p8.png` 各执行 120 fixed
ticks。12/12 observation complete：6 个启动并保持 `CU`，6 个为 `C0`；自动 cluster 为 parse 1、
language 4、timing 1。5 个代表 case 的本地截图完成视觉复核，启动画面和 fault UI 均可观察。
baseline 同时暴露 legacy `stat(20)`、`unpack` global、`menuitem()`、implicit CPU slicing 与 P8SCII
source token surface；future-version rejection 保持 v0.2.7 scope boundary。所有 cart、manifest、
observations、report 和截图均被 Git 忽略，公开 denominator 贡献为 0。验证入口是
`pnpm run test:phase-6c` 与 `pnpm run test:phase-6c:chrome`；external 结果不是 CI 依赖。

## 6D closure

6D 将 legacy `stat(20)` 精确接到 RuntimeCore authoritative `PicoSfxSynth` channel 0 note state，
inactive 返回 P8 number `-1`；C++ bridge 只新增 selector 20 的 Q16 numeric decode，其他 selector
保持原类型。原创 real-WASM/Chrome regression 覆盖 idle、active、note `1→2→3`、stop/reset，
项目 Chrome 12/12 通过。受影响 local case 从 boolean arithmetic fault 恢复为 `boots/CU`；完整
ignored corpus 变为 7 boots/CU、5 fails/C0，公开 denominator 仍为 0。production WASM SHA-256 为
`b5944f31d6fabdcb0eb79f8f3c764751e1962d39a5488a49d09f4b800b8bbc7f`。验证入口是
`pnpm run test:phase-6d`、`pnpm run test:phase-6d:chrome` 与 `pnpm run verify`。

## 6E closure

6E 由 [ADR-021](../adr/021-menuitem-registration-boundary.md) 接受 VM-local registration-only：
`menuitem()` 支持槽位 `1..5`、`0xff00` filter、16-byte label、callback strong reference、replacement
和 removal；registry 随 `lua_State` generation 销毁，没有 Lua handle、transport 或 DOM authority 越过
WASM 边界。Node real-WASM 覆盖 validation、weak-reference GC 与 20-generation cleanup，Chrome 项目
卡带 12/12 通过。受影响 local case 不再 missing-global，ignored aggregate 变为 8 boots/CU、4
fails/C0；pause-menu UI/callback invocation 作为 `P6-KD-01`，不能由启动成功推断为可玩。production
WASM SHA-256 为 `50e5c6019622342a4e7e099af8f2194c431f9740c5438ce1f31561debd8294e6`。
验证入口是 `pnpm run test:phase-6e`、`pnpm run test:phase-6e:chrome` 与 `pnpm run verify`。

## 6F closure

6F 由 [ADR-022](../adr/022-cpu-slicing-decision.md) 接受 root-safe implicit frame slicing：
top-level custom loop 每 `133333` 条 guest instruction 产生一个 30Hz `FRAME_END`，同时保留
`1000000` 条 hard safety cap、fault poison、fresh-generation recovery、一次 `step()` 至多一帧和
HostRequest transaction。nested coroutine 的工作计入同一 quantum，但只在控制返回 Runtime-owned
root 时提交帧；该差异记录为 `P6-KD-02`。Node real-WASM 6 个 continuation/control case 与 Chrome
12×120 帧项目烟测通过；affected local case 恢复，ignored aggregate 变为 9 boots/CU、3 fails/C0。
production WASM SHA-256 为
`4e2bd6f80f7e94d23e5e82dbc6133536028db8e40991e6b0ece82e80acbc24b3`。验证入口是
`pnpm run test:phase-6f`、`pnpm run test:phase-6f:chrome` 与 `pnpm run verify`。

## 6G closure

6G 在 VM compatibility boundary 注册全局 `unpack` 和 26 个单字节 P8SCII source globals；值按
官方 Q16.16 raw bit pattern 写入，不经 UTF-8。原创 Node 4-case 与 Chrome 12×120 帧回归通过，
production WASM SHA-256 为
`747bb6ae2d4fbe9bfff14ec90e5193826f181ff0068c2d00c34859f89bd341b9`。完整 ignored corpus 中
11/11 个 v0.2.7 in-profile case 启动，唯一 future-version case 保持 C0 scope disposition；两条完整
关键流程和一条 900 秒/27000 帧 duration gate 形成 3 个 C2，本地 evidence SHA-256 为
`55f5f8cbf6a53516f3f4c5e810b0cda2c1102812a3fa49565c10a5499a31da1`。最终本地分类为
`C0=1, C2=3, CU=8`，开放 P0/P1 为 0；第三方 bytes、截图和逐-cart 结果未跟踪，公开分母仍为 0。
验证入口是 `pnpm run test:phase-6g`、`pnpm run test:phase-6g:chrome` 与 `pnpm run verify`。

## Active work unit：6H Qualification Exit / Report

### Observable behavior

1. 建立 project-owned exit manifest，只写 aggregate qualification、project artifact hash 与本地 evidence
   hash；不得写入第三方 cart ID、hash、路径、截图、逐-cart 结果或成功率。
2. 自动化证明 12 个 case 均有 C* disposition、至少 3 个 C2、唯一 future-version case 明确 out-of-profile，
   且开放 P0/P1 为 0；fixed smoke coverage 与 manual playability 必须分开表达。
3. 归档 Phase 6 不可变 evidence，关闭机器合同与 roadmap；完成后删除本 phase 执行文档并从默认
   开工入口移除，不擅自激活下一 phase。

### Allowed files

精确允许路径由机器合同 `workUnits.6H.allowedPaths` 控制。本单元只允许 exit contract、测试、
evidence 与 living documentation，不再修改 production runtime。external bytes、逐-cart observation
和 `ref/` 仍不进入测试、构建或 tracked evidence。

### Tests

- Proposed：`pnpm run test:phase-6h`
- `pnpm run test:phase-6a`
- `pnpm run test:architecture`
- 最终必须运行 `pnpm run verify`

### Exit gate

- exit manifest/test 锁定 aggregate、project hashes、C2 数量、scope disposition 与零 P0/P1。
- repository 不跟踪第三方 cart/screenshot/逐-cart 结果，也不发布第三方兼容率。
- evidence、机器合同、roadmap 和默认文档路由一致关闭；没有 active phase 被隐式创建。
- `pnpm run verify` 通过；Phase 6H 独立提交且 repository clean。

## Phase exit gate

6H 必须给至少 12 个本地 real-cart case 完成合法性和环境绑定的 C* 分类，其中至少 3 个完成
Chrome 手工 C2 gate；`stat(20)`、`menuitem()` 与 CPU slicing 均有原创最小 regression 和明确
decision。开放 P0/P1 为 0，`pnpm run verify` 通过，仓库仍不包含第三方 cart、截图或公开成功率。
