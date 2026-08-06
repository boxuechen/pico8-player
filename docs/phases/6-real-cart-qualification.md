# Phase 6 — Real-cart Qualification

> 状态：Active；6A–6D complete，6E active
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
的 runtime hack。CPU slicing 在 6F 完成 spike 和 replacement ADR 决定前继续遵守 ADR-017。

## Stable inputs

- [Phase 5 closed contract](../../spec/phase-5-l3-multicart-contract.json)
- [Cart 结果与已知差异](../06-testing-compatibility.md#15-兼容等级已知差异与质量口径)
- [测试数据版权与 BBS 限制](../06-testing-compatibility.md#13-测试数据版权与-bbs-访问限制)
- [Reference source quarantine](../08-source-layout-and-boundaries.md#72-reference-source-quarantine)
- [兼容 bug 工作流](../09-codex-task-protocol.md#7-兼容-bug-工作流)
- [Instruction budget 边界](../03-z8lua-wasm-bridge.md#92-instruction-budget抛错不分帧续跑)
- [ADR-017 coroutine frame slice](../adr/017-coroutine-frame-slice-and-fault-containment.md)
- [Official PICO-8 v0.2.7 `stat()` reference](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#STAT)
- [Official PICO-8 v0.2.7 `menuitem()` reference](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#MENUITEM)

## Work units

| Unit | 状态 | 结果或入口 |
| --- | --- | --- |
| 6A Activation / Corpus Policy | Complete | 12-cart local-only policy、Phase 5 hash baseline、公开分母为 0 |
| 6B External Corpus Runner | Complete | 三份 schema、fail-closed validator、path-redacted report CLI |
| 6C Twelve-cart Baseline | Complete | 12/12 complete；6 boots/CU、6 fails/C0；local-only screenshots |
| 6D `stat(20)` Compatibility | Complete | affected case 恢复；local baseline 变为 7 boots/CU、5 fails/C0 |
| 6E `menuitem()` Boundary | **Active** | 下节 |
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

## Active work unit：6E `menuitem()` Boundary

### Observable behavior

1. 先用 ADR 冻结 ownership：`menuitem()` 的 Lua callback 和注册表留在同一 VM generation；不得把
   Lua function pointer、registry ref 或可执行 closure 传给 TypeScript/DOM。
2. 当前 unit 至少实现 official registration boundary：index `1..5`（保留 `0xff00` button filter
   bits）、P8SCII label 最多 16 bytes、callback 必须为 function；同 index replacement 与省略
   label/callback removal 可确定执行。
3. 当前 web-player 的 host lifecycle pause 不是 PICO-8 pause menu。6E 必须明确决定 UI/callback
   invocation 是本 unit 实现还是 Published Known Difference；不能用一个静默 JS no-op 冒充完整菜单。
4. 若接受 registration-only，注册表必须 VM-local、bounded、GC-safe、fresh generation 自动清空，
   并明确 guest 不能触发 callback；不得新增 Worker/Main transport 或 DOM authority。
5. 原创 real-WASM cart 覆盖 add/update/remove、invalid index/label/callback、GC lifetime 和 fresh reset；
   Chrome production path 与受影响 local case 均不再因 missing global fault。

### Allowed files

精确允许路径由机器合同 `workUnits.6E.allowedPaths` 控制。默认路径只允许 VM-local compat、ADR、
原创 regression 与 inventory/文档；除非 ADR 明确授权 full UI，不得修改 RuntimeCore、Worker/Main
transport、PlayerController、DOM shell 或 host pause lifecycle。external bytes 和 `ref/` 仍不进入
测试或构建。

### Tests

- Proposed：`pnpm run test:phase-6e`
- Proposed：`pnpm run test:phase-6e:chrome`
- `pnpm run test:phase-4c`
- `pnpm run test:architecture`
- VM/runtime contract 改变，最终必须运行 `pnpm run verify`

### Exit gate

- ADR 固定 callback/registry/UI ownership；注册语义不是无界 host handle 或静默假兼容。
- Node real-WASM 精确覆盖 bounded registry、replacement/removal、validation、GC 与 generation cleanup。
- Chrome project cart 与 local affected case 均不再出现 missing-global fault。
- API inventory/Published Known Difference 精确区分 registration 与 UI/invocation 支持。
- `pnpm run verify` 通过；6E 结果折叠入机器合同，6F 成为唯一 active work unit，并独立提交。

## Phase exit gate

6H 必须给至少 12 个本地 real-cart case 完成合法性和环境绑定的 C* 分类，其中至少 3 个完成
Chrome 手工 C2 gate；`stat(20)`、`menuitem()` 与 CPU slicing 均有原创最小 regression 和明确
decision。开放 P0/P1 为 0，`pnpm run verify` 通过，仓库仍不包含第三方 cart、截图或公开成功率。
