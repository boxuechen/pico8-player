# Phase 6 — Real-cart Qualification

> 状态：Active；6A–6C complete，6D active
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

## Work units

| Unit | 状态 | 结果或入口 |
| --- | --- | --- |
| 6A Activation / Corpus Policy | Complete | 12-cart local-only policy、Phase 5 hash baseline、公开分母为 0 |
| 6B External Corpus Runner | Complete | 三份 schema、fail-closed validator、path-redacted report CLI |
| 6C Twelve-cart Baseline | Complete | 12/12 complete；6 boots/CU、6 fails/C0；local-only screenshots |
| 6D `stat(20)` Compatibility | **Active** | 下节 |
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

## 6C closure

6C 已在 Chrome 150 production Worker/WASM path 对 12 个 local-only `.p8.png` 各执行 120 fixed
ticks。12/12 observation complete：6 个启动并保持 `CU`，6 个为 `C0`；自动 cluster 为 parse 1、
language 4、timing 1。5 个代表 case 的本地截图完成视觉复核，启动画面和 fault UI 均可观察。
baseline 同时暴露 legacy `stat(20)`、`unpack` global、`menuitem()`、implicit CPU slicing 与 P8SCII
source token surface；future-version rejection 保持 v0.2.7 scope boundary。所有 cart、manifest、
observations、report 和截图均被 Git 忽略，公开 denominator 贡献为 0。验证入口是
`pnpm run test:phase-6c` 与 `pnpm run test:phase-6c:chrome`；external 结果不是 CI 依赖。

## Active work unit：6D `stat(20)` Compatibility

### Observable behavior

1. 按官方 v0.2.7 manual 的 legacy audio status mapping，`stat(20)` 返回 channel 0 当前 note number；
   无 active SFX 时返回 P8 number `-1`，不能返回 boolean `false`。
2. value 只来自 RuntimeCore authoritative `PicoSfxSynth` state；不得读取 AudioContext、device mixer、
   output queue 或 host wall clock。现有 deterministic frame/audio transaction 顺序不变。
3. C++ `stat-input-selector` bridge 只为 selector 20 增加 numeric decode；30/31/34 的 boolean/string/
   integer 特例、32/33/36/38/39 Q16 与 unknown-selector false 均保持不变。
4. 用项目原创最小 cart 覆盖 idle `-1`、active note、note progression、stop/reset；Node real-WASM 与
   Chrome production path 必须一致。
5. 修复后重新运行受影响 local case 的 120-tick trace，必须从 boolean arithmetic fault 变为
   `boots/CU`；这只是 local regression，不形成第三方成功率声明。

### Allowed files

精确允许路径由机器合同 `workUnits.6D.allowedPaths` 控制。ownership 只跨 AudioSynth state、
PicoApiHost selector routing 与 bridge return decoding；不得修改 scheduler、AudioWorklet、device
transport、cart codec 或其他 stat selector。external bytes 和 `ref/` 仍不进入测试或构建。

### Tests

- Proposed：`pnpm run test:phase-6d`
- Proposed：`pnpm run test:phase-6d:chrome`
- `pnpm run test:phase-3b`
- `pnpm run test:phase-3d`
- `pnpm run test:architecture`
- public/runtime contract 改变，最终必须运行 `pnpm run verify`

### Exit gate

- Node real-WASM 精确覆盖 inactive/active/progression/stop/reset 和 stat selector regression。
- Chrome project cart 与 local affected case 均不再出现 boolean arithmetic fault。
- API inventory 和 `P4-KD-02` 只增加 selector 20，不暗示 16–26 或 46–56 全量支持。
- `pnpm run verify` 通过；6D 结果折叠入机器合同，6E 成为唯一 active work unit，并独立提交。

## Phase exit gate

6H 必须给至少 12 个本地 real-cart case 完成合法性和环境绑定的 C* 分类，其中至少 3 个完成
Chrome 手工 C2 gate；`stat(20)`、`menuitem()` 与 CPU slicing 均有原创最小 regression 和明确
decision。开放 P0/P1 为 0，`pnpm run verify` 通过，仓库仍不包含第三方 cart、截图或公开成功率。
