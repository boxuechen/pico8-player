# Phase 8 — Expanded Real-cart Qualification

> 状态：Active
> Active work unit：8E — Format / Multicart Qualification
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
| 8B External Corpus Tooling | Complete | 仓库外 discovery、canonical selection、batch manifest、local index 可重复生成 |
| 8C Canonical Chrome Smoke | Complete | 100 个 canonical cart 完成 fixed-tick Chrome production smoke 与失败簇聚合 |
| 8D Fault Triage / Core Fixes | Complete | 48 个 C0 由通用 parser/language/CPU/timing 修复收敛为 100 CU |
| 8E Format / Multicart Qualification | **Active** | 65 组格式配对及 multicart、graphics/audio/input/persistence 风险完成定性 |
| 8F Representative Playability | Pending | 至少 10 个分层代表 case 完成 C2，截图本地人工审阅 |
| 8G Release Regression Requalification | Pending | 所有修复通过 RC、资源回收、确定性和 clean tracked-input 回归 |
| 8H Aggregate Exit | Pending | aggregate-only evidence、兼容口径与机器合同关闭 |

## 4. 已完成：8B External Corpus Tooling

8B 建立仓库外 deterministic discovery、canonical selection、format pairing 和 runner-compatible batching。
干净 checkout 事实为 167 个 `carts/` 输入、101 个 logical identity、100 canonical、65 pairs；两个
canonical batch 为 50/50，三个 pair batch 为 44/44/42。稳定 corpus fingerprint 为
`941bcc486bbf18fa22936d4ff9f6d9a8f3eb00f3eb76b35619687c89cb30e33c`。Phase 6 默认仍严格为 12 cases，
Phase 8 wrapper 才允许 12–64 cases。验证：`pnpm run test:phase-8b`、`pnpm run test:architecture`。

## 5. 已完成：8C Canonical Chrome Smoke

两个 50-case batch 在同一 production Chrome 151、player commit 和 WASM hash 下完成 100/100 observation；
100 张截图保留在仓库外并抽查了 boot、fault 和有帧后 fault 状态。aggregate-only 结果为 52 boots、
48 fails，失败簇为 parse 34、language 11、timing 3；framebuffer 有帧 53、non-black 53，infrastructure
failure 为 0。该结果不含逐-cart事实，也不作为最终兼容率。验证：`pnpm run test:phase-8c`、
`pnpm run test:architecture`、`pnpm run verify`。

## 6. 已完成：8D Fault Triage / Core Fixes

8D 在实现提交 `c9a0d0237b418a711a912cf9bd83a75cd0e5e7c6` 中关闭 parse、language 和 timing
通用缺口。同一 100-case fingerprint 在 Chrome 151 production path 得到 `100/100 CU`：`99 boots`、
`1` 个仓库外 manifest 声明且 fault code 精确匹配的开发者自测终止，所有 failure cluster 为 `0`。
100 张 Canvas screenshot 保留在仓库外，4 个代表状态完成人工抽查；最终 WASM hash 为
`608cb76400a125f975a71ec8ea44c67078d1c9764ef52855fec08a52e21f2700`。

该结果只证明 fixed-tick boot qualification，不是 C2 可玩性或公开第三方兼容率。8D 的原创回归、
caller-authorized include、2M runaway guard、callback `flip()`、统一音频时钟、browser-safe `printh`、
`cursor()` multi-return 和 contiguous RAM fill 由 ADR-024/025 与 `pnpm run test:phase-8d` 维护；完整
`pnpm run verify` 已通过。

## 7. 当前工作：8E Format / Multicart Qualification

### 7.1 Observable behavior

- 对 65 个 logical pair 的 source `.p8` 与 export `.p8.png` 分别使用 production codec、Worker 和 Chrome
  fixed-tick path；不得用 Canvas、`<img>` 或第三方解析器读取 cart payload。
- 每组至少比较 decode success/fault、cart version、规范化 ROM/code identity、boot/fault、完成 tick/frame、
  framebuffer presence 与 expected-termination disposition；逐 pair 原始值只留在仓库外。
- pair aggregate 只允许发布总 pair 数、matched/divergent/not-run、有限 failure cluster 和风险维度计数；禁止
  cart identity、path、cart/screen hash、fault message、截图或可反推单个 cart 的结果进入 tracked 内容。
- 三个既有 pair batch 为 44/44/42 runner cases，aggregate 必须证明 65 个 logical pair exact coverage、无重复、
  同一 source revision/player commit/WASM/Chrome 环境和两侧 screenshot coverage。
- multicart/include/load/reload/cstore 只能使用 caller-authorized Worker-local bundle；不得增加 BBS、URL、
  host filesystem 或 production auto-discovery authority。
- graphics、audio、input、persistence 与 multicart 风险通过本地 observation 定性；发现差异时先构造项目原创
  最小复现，只允许通用修复或 Known Difference，不得按 cart identity 分支。
- 按 `game-playtest` 工作流抽查代表性的 matched、fault 和 divergent Canvas 状态；DOM 断言不能替代截图。

### 7.2 允许修改

机器权威 allowlist 位于当前 phase contract 的 `workUnits.8E.allowedPaths`。Production 修改只允许用于由
pair/multicart 暴露且有原创最小复现的通用缺口；RuntimeCore 保持 browser-neutral，外部 corpus、截图、
trace 和逐 pair 报告继续位于仓库外。

### 7.3 验证与退出

- 65/65 logical pair 具有 deterministic decode/boot parity disposition；所有 not-run 都有结构化基础设施原因。
- multicart、graphics、audio、input、persistence 风险均有 aggregate disposition，开放 P0/P1 为 0。
- 代表 Canvas 状态在本地人工审阅，tracked/release/CI 的第三方 bytes、截图、path、hash 和逐 pair 结果为 0。
- `pnpm run test:phase-8e`、受影响 owner tests、`pnpm run test:architecture` 与 `pnpm run verify` 通过；随后
  8F 成为唯一 active work unit。

## 8. Phase exit gate

- 100/100 canonical case 有 C* disposition；所有 in-profile case 完成 production Chrome fixed smoke。
- 65 个 `.p8`/`.p8.png` pair 均完成 decode/boot parity 定性；差异必须进入 failure cluster 或 Known Difference。
- 至少 10 个覆盖不同游戏类型/API 风险的 case 达到 C2；至少一个 persistence、一个 audio、一个 input、
  一个 multicart/complex-flow case；截图只在本地审阅。
- 所有 P0/P1 为 0；通用修复均有项目原创 regression，无 cart-specific hack。
- tracked repository、release artifact 与 CI 中第三方 cart bytes、截图、路径、hash、逐-cart结果均为 0；
  不发布第三方兼容率。
- `pnpm run test:release`、`pnpm run verify`、Phase 8 aggregate exit test 和最终工作树清洁检查通过。
