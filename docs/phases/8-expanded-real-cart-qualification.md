# Phase 8 — Expanded Real-cart Qualification

> 状态：Active
> Active work unit：8G — Release Regression Requalification
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
| 8E Format / Multicart Qualification | Complete | 65 组格式配对及 multicart、graphics/audio/input/persistence 风险完成定性 |
| 8F Representative Playability | Complete | 10 个分层代表 case 完成 C2，截图、真实音频和持久化重载均在本地审阅 |
| 8G Release Regression Requalification | **Active** | 所有修复通过 RC、资源回收、确定性和 clean tracked-input 回归 |
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

## 7. 已完成：8E Format / Multicart Qualification

8E 实现提交 `bfc83d6f4f245318876177e3a02c9eac08fb6009` 修正了文本 cart 空 SFX/Music 槽位的
规范 ROM 默认值，并建立 aggregate-only format-pair runner。三个 44/44/42 case batch 在同一 clean commit、
Chrome 151 和 WASM hash 下完成 130/130 decode、CU boot、120 ticks/frames 和本地截图。

aggregate 结果为 9 matched、56 source/export content-divergent、0 not-run；65/65 两侧均成功 decode，
version/normalized-ROM/normalized-code 分别为 25/37/56 matched。boot 与 framebuffer 均为 64 matched、
1 divergent；该 pair 的输入内容本身不同，因此 same-content runtime defect 为 0。所有 failure cluster 为 0。
风险信号覆盖 multicart 4、graphics 65、audio 36、input 51、persistence 3，全部完成 production Chrome
观测。matched 与 divergent Canvas 在仓库外完成人工审阅，fault 样本不存在并标记不适用，P0–P3 均为 0。

逐 pair 详情、第三方 bytes/path/hash、截图和 review 原始证据继续只位于仓库外；tracked 内容只记录不可反推
单个 cart 的 aggregate。最终本地 aggregate SHA-256 为
`87add5b7f2588e07402f4b5f98856346fb1a1901327d36f2edc5267973ac0763`，WASM SHA-256 为
`608cb76400a125f975a71ec8ea44c67078d1c9764ef52855fec08a52e21f2700`。验证：
`pnpm run test:phase-8e`、`pnpm run test:cart-codec`、`pnpm run test:architecture`。

## 8. 已完成：8F Representative Playability

supplemental Top200 snapshot 已按 4×50 batch 在 production Chrome 151 中完成 200/200 个 120-tick quick
smoke：149 boots、51 fails、0 not-run，失败簇聚合为 language 45、timing 5、unsupported-host-feature 1；
200 张截图保留在仓库外，infrastructure failure 为 0。该结果只用于缺口发现，不改变正式 100-cart denominator，
也不是公开兼容率。

正式 C2 从既有 100 canonical corpus 中选择 10 个 case：8 个完成明确 critical flow，2 个完成 27000 logical
frame（900 logical seconds）duration gate。风险覆盖 graphics 10、audio 4、input 8、persistence 1、
complex-flow 2；10 张 Canvas 均人工审阅，4 个 audio case 走真实 AudioContext/AudioWorklet，实时探针的
underrun、overrun、drop 和 discontinuity 均为 0；持久化 case 完成写入后新实例重载验证。10/10 均为 C2，
crash/soft-lock 与 open P0–P3 均为 0。

8F 只修复一个通用 player 生命周期问题：cart 在 load 期间执行 `stop()` 时，controller 不再把 Worker 的
`stopped` 状态覆盖成 `ready`；项目原创 Chrome regression 维护该行为。逐-cart identity、bytes、path、hash、
截图和 review 原始记录继续只在仓库外。两个本地 aggregate SHA-256 与环境事实记录在机器合同
`workUnits.8F.result` 中。

## 9. 当前工作：8G Release Regression Requalification

### 9.1 工作范围

- 冻结 8F 的外部 qualification 结果；默认不重跑 Top200、100-case corpus、两条 duration case 或整套 C2。
  只有 release regression 指向真实 cart 路径时，才挑 1–3 个代表 case 做短回归。
- 运行 8F 的项目原创 contract/tooling/PlayerController 定向回归，确认 clean tracked input 下不依赖 `ref/`、
  外部 corpus、截图或本地 observation。
- 运行一次 `pnpm run test:release`，覆盖 release artifact、production Worker、Chrome lifecycle 和资源回收；
  Firefox/WebKit 仍不进入 gate。
- 在所有修改提交、工作树清洁后只运行一次完整 `pnpm run verify`。失败只重跑对应 owner test；不为获得绿灯
  重复耗时的真实 cart 全量验证。
- 审核 tracked/release/CI 输入，确保第三方 cart bytes、路径、hash、截图和逐-cart结果仍为 0，open P0/P1 为 0。

### 9.2 允许修改

机器权威 allowlist 位于当前 phase contract 的 `workUnits.8G.allowedPaths`。8G 是 requalification unit，不授权
新增兼容特性或扩大网络/文件系统/浏览器能力；若发现 production defect，必须先更新机器合同重新授权，而不是
在回归阶段静默修改 RuntimeCore 或 browser adapter。

### 9.3 验证与退出

- `pnpm run test:phase-8f` 与受影响 owner tests 通过。
- `pnpm run test:release` 和一次最终 `pnpm run verify` 在不读取外部 corpus 或 `ref/` 的前提下通过。
- release artifact、Chrome lifecycle、determinism、resource cleanup 和 tracked-input privacy 无回归。
- open P0/P1 为 0，工作树清洁，随后 8H 成为唯一 active work unit。

## 10. Phase exit gate

- 100/100 canonical case 有 C* disposition；所有 in-profile case 完成 production Chrome fixed smoke。
- 65 个 `.p8`/`.p8.png` pair 均完成 decode/boot parity 定性；差异必须进入 failure cluster 或 Known Difference。
- 至少 10 个覆盖不同游戏类型/API 风险的 case 达到 C2；至少一个 persistence、一个 audio、一个 input、
  一个 multicart/complex-flow case；截图只在本地审阅。
- 所有 P0/P1 为 0；通用修复均有项目原创 regression，无 cart-specific hack。
- tracked repository、release artifact 与 CI 中第三方 cart bytes、截图、路径、hash、逐-cart结果均为 0；
  不发布第三方兼容率。
- `pnpm run test:release`、`pnpm run verify`、Phase 8 aggregate exit test 和最终工作树清洁检查通过。
