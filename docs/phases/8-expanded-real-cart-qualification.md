# Phase 8 — Expanded Real-cart Qualification

> 状态：Active
> Active work unit：8B — External Corpus Tooling
> 机器合同：[`spec/phase-8-expanded-real-cart-qualification-contract.json`](../../spec/phase-8-expanded-real-cart-qualification-contract.json)
> 基线：Phase 7 exit commit `49b24ad32b54d14d4678ebd5b7225d3a9bec668e`

## 1. 阶段目标

以用户明确授权用于本地研究的 `MiniMechMedia/pico8-games` checkout 为外部输入，把 Phase 6 的
12-case qualification 扩展为 100 个 canonical logical cart、65 组 `.p8`/`.p8.png` 格式配对和至少
10 个代表性 C2 playability case。所有自动运行都使用 production Chrome/Chromium desktop path，目标
Runtime 为官方当前 PICO-8 v0.2.7。

本阶段只扩展兼容性证据和修复由真实 cart 暴露的通用 Runtime 问题；不为单个 cart 加 hack，不引入
BBS/URL/host-filesystem authority，不发布第三方 cart、截图、路径、hash、逐-cart 结果或兼容率。

## 2. 不可破坏边界

- `ref/**` 仍是只读研究区，不是 production、workspace、build 或 test input。实际 qualification 必须从
  仓库外的 caller-authorized local corpus 读取；tracked test 只能使用项目原创 fixture。
- 外部 cart bytes、manifest、observation、截图、trace 和逐-cart报告只能位于仓库外或既有 gitignored
  local-corpus 路径；release artifact、CI 与 `pnpm run verify` 不依赖它们。
- RuntimeCore 保持 browser-neutral；Canvas、AudioContext、Worker 和 screenshot automation 仍属于
  `apps/web-player` / browser tooling。
- 修复必须来自项目原创最小复现并按官方手册或可审阅的官方 observation 定义预期；禁止复制第三方
  cart 代码或按 cart 名称分支。
- Chrome/Chromium desktop 是唯一 gate。Firefox/WebKit、移动端、BBS crawler、网络 cart fetch 和第三方
  内容再分发不进入本阶段。
- Canvas smoke 后必须对代表状态做本地 screenshot review；DOM/事件断言不能代替实际 playfield 检查。

## 3. Work units

| Unit | 状态 | 可观察结果 |
| --- | --- | --- |
| 8A Activation / Corpus Contract | Complete | Phase 7 baseline、100-cart/65-pair 口径、许可/隐私边界和退出门禁锁定 |
| 8B External Corpus Tooling | **Active** | 仓库外 discovery、canonical selection、batch manifest、aggregate validator 可重复生成 |
| 8C Canonical Chrome Smoke | Pending | 100 个 canonical cart 完成 fixed-tick Chrome production smoke 与失败簇聚合 |
| 8D Fault Triage / Core Fixes | Pending | 高频 parser/language/CPU/timing 问题由原创复现关闭或登记 Known Difference |
| 8E Format / Multicart Qualification | Pending | 65 组格式配对及 multicart、graphics/audio/input/persistence 风险完成定性 |
| 8F Representative Playability | Pending | 至少 10 个分层代表 case 完成 C2，截图本地人工审阅 |
| 8G Release Regression Requalification | Pending | 所有修复通过 RC、资源回收、确定性和 clean tracked-input 回归 |
| 8H Aggregate Exit | Pending | aggregate-only evidence、兼容口径与机器合同关闭 |

## 4. 当前工作：8B External Corpus Tooling

### 4.1 Observable behavior

- 新建 Phase 8 external-corpus discovery/aggregation 工具；输入必须是仓库外的本地目录，`ref/**`、URL、
  symlink escape 和 tracked third-party corpus 必须 fail closed。
- 按 `top-level project + cart basename` 建立 logical identity，优先选择 `export/*.p8.png`，否则选择
  `.p8.png` 或 `.p8`；排除 byte-identical duplicate，并保留 65 个双格式 pair 的独立 parity lane。
- 100 个 canonical cart 分成不超过 v1 runner 上限的 deterministic batches；manifest 记录 source revision、
  caller authorization、cart hash、target Runtime、固定 trace，但输出保持本地且 gitignored。
- aggregate index 只在本地包含逐-cart路径/identity；tracked contract/test 只断言 schema、limits、去重、
  determinism、path quarantine 和 aggregate counts。

### 4.2 允许修改

- `tools/compat/`
- `spec/compat/`
- `tests/compat/` 下项目原创 fixture/test
- `tests/external-corpus.example.json`
- `.gitignore`
- `package.json`
- `docs/06-testing-compatibility.md`
- `docs/10-reference-sources.md`
- `docs/README.md`
- `docs/phases/8-expanded-real-cart-qualification.md`
- `spec/phase-8-expanded-real-cart-qualification-contract.json`

不得在 8B 修改 Runtime、WASM、Worker、renderer、audio 或 release artifact 行为。

### 4.3 路由合同

- External corpus、C* 与隐私：[06 §15.2、§15.6](../06-testing-compatibility.md#152-cart-结果)
- Reference quarantine：[08 §1](../08-source-layout-and-boundaries.md#1-canonical-workspace)
- Reference provenance：[10 §边界规则](../10-reference-sources.md#边界规则)
- Phase 6 runner baseline：[Phase 6 evidence](../evidence/phase-6/71-phase-6-real-cart-qualification-exit-evidence.md)

### 4.4 验证与退出

- `pnpm run test:phase-8b`（建立后）覆盖 deterministic selection、format pair、duplicate、bounds、URL、
  `ref/`、symlink escape、hash 与 aggregate redaction。
- 使用仓库外临时 clone 在当前锁定 checkout 生成两个 deterministic batch 和一个 local aggregate index；
  canonical=`100`、format pairs=`65`、tracked cart/screenshot=`0`。
- `pnpm run test:architecture` 继续证明没有 `ref/` 或 external corpus dependency。
- 8B 独立提交且工作树干净后，8C 成为唯一 active work unit。

## 5. Phase exit gate

- 100/100 canonical case 有 C* disposition；所有 in-profile case 完成 production Chrome fixed smoke。
- 65 个 `.p8`/`.p8.png` pair 均完成 decode/boot parity 定性；差异必须进入 failure cluster 或 Known Difference。
- 至少 10 个覆盖不同游戏类型/API 风险的 case 达到 C2；至少一个 persistence、一个 audio、一个 input、
  一个 multicart/complex-flow case；截图只在本地审阅。
- 所有 P0/P1 为 0；通用修复均有项目原创 regression，无 cart-specific hack。
- tracked repository、release artifact 与 CI 中第三方 cart bytes、截图、路径、hash、逐-cart结果均为 0；
  不发布第三方兼容率。
- `pnpm run test:release`、`pnpm run verify`、Phase 8 aggregate exit test 和最终工作树清洁检查通过。
