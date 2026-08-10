# Phase 8 — Expanded Real-cart Qualification

> 状态：Active
> Active work unit：8D — Fault Triage / Core Fixes
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
| 8D Fault Triage / Core Fixes | **Active** | 高频 parser/language/CPU/timing 问题由原创复现关闭或登记 Known Difference |
| 8E Format / Multicart Qualification | Pending | 65 组格式配对及 multicart、graphics/audio/input/persistence 风险完成定性 |
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

## 6. 当前工作：8D Fault Triage / Core Fixes

### 6.1 Observable behavior

- 只在本地逐项检查 34/11/3 三个失败簇，先区分无效/内部资源 cart、multicart dependency、已知 profile
  limitation 和可复用的 Runtime 缺口；tracked issue/repro 只使用匿名 aggregate 与项目原创最小代码。
- 每个通用缺口必须由项目原创最小 `.p8` 或直接 WASM/Runtime contract test 复现，再按官方手册或已审阅
  official observation 定义预期；不得复制第三方源码、字符串、资源或按 cart identity 分支。
- parser、language、instruction-budget/timing 按共同根因合并；一个修复要证明覆盖整个语义簇，并重新运行
  受影响的本地 case。只对单个 cart 有效的行为不得进入 production。
- Runtime 的 4M VM instructions/s 帧级 soft budget 保持不变；默认 2M transaction hard guard 只负责终止
  无法返回安全边界的失控 boot/callback，不作为正常 cart 的每帧限额。
- v0.2.7 语言兼容包含函数实参空位按 `nil`、替换 `_ENV` 后缺失全局回退到原始 cart environment；显式
  `flip()` 可在 root、`_init`、`_update`/`_update60` 与 `_draw` 建立可恢复帧边界，guest coroutine 内仍禁止。
- 音频 sample clock 使用统一 60 Hz timebase，因此运行中新增或移除 `_update60` 不重置时钟、不丢样本，
  同时保持 22050 Hz 的累计精确性。
- `printh` 提供无文件系统权限的 diagnostic-only 子集：保留 `tostr` 转换，输出进入有界 null sink；cart
  指定的 filename/overwrite/desktop/clipboard 副作用继续明确不可用。
- `cursor(x,y[,col])` 仍由 host binding 修改 draw-state RAM，VM-local wrapper 额外返回修改前的
  `(x,y)`；`cursor()` 将位置重置为 `(0,0)` 并返回之前的位置。
- Chrome smoke 的 `boots` 表示 cart 已成功启动且无 fault；没有注册持续循环而自然进入 `stopped` 的工具型
  cart 也属于成功终态，并保留其真实 `completedTicks`/`frameCount`，不伪造 120 帧。
- 开发者工具/self-test cart 的预期 fault 只能由仓库外 manifest 显式声明 fault code 与人工 basis；Chrome
  必须精确匹配后才可记为 CU，observation 仍保留 `fails`、fault 和 matched 标志。未声明或不匹配仍为 C0，
  production Runtime 不读取该标注。
- 无法安全通用修复或超出 v0.2.7 RC profile 的项登记 Known Difference/unsupported disposition；所有 P0/P1
  必须关闭或有明确退出裁决，随后才可进入 8E format/multicart lane。

### 6.2 当前 candidate 结果

通用修复后，同一 100-case fingerprint 在 Chrome 151 production path 完成两个 50-case batch：
`100/100 CU`、`99 boots`、`1` 个由仓库外 manifest 显式声明且精确匹配的开发者自测 fault；
parse/language/timing 及其他 failure cluster 全部为 `0`。这仍是 fixed-tick CU 故障资格验证，不是
C2 可玩性或公开第三方兼容率。

100 张 Canvas screenshot 保留在仓库外，已抽查 4 个代表状态：正常游戏画面、交互工具完成画面、
合法黑屏 custom loop 和保留 fault diagnostic 的自测画面。最终 artifact hash 为
`608cb76400a125f975a71ec8ea44c67078d1c9764ef52855fec08a52e21f2700`。
在 8D 独立提交与全量 `pnpm run verify` 完成前，本 unit 仍保持 Active，不提前激活 8E。

### 6.3 允许修改

- `packages/cart-codec/src/`、`packages/runtime-core/src/`、`packages/z8lua-bridge/src/`
- `packages/contracts/src/`、`apps/web-player/src/worker/`
- `wasm/bridge/`、`wasm/patches/`、`wasm/z8lua/` 及对应 source/runtime/Phase 0C manifest lock
- `tools/compat/`、`tools/wasm/`、`spec/abi/`、`spec/compat/`、cart-codec/API inventory 与当前 phase contract
- `tests/cart-codec/`、`tests/contract/`、`tests/runtime/`、`tests/wasm/`、`tests/compat/`、
  `tests/browser/` 与项目原创 `tests/fixtures/phase-8/`
- `docs/adr/`（只允许追加 superseding decision，不改写历史 ADR）
- `docs/02-system-architecture.md`
- `docs/03-z8lua-wasm-bridge.md`
- `docs/04-typescript-runtime.md`
- `docs/06-testing-compatibility.md`
- `docs/07-decisions-risks-open-questions.md`
- `docs/08-source-layout-and-boundaries.md`
- `docs/README.md`
- `docs/phases/8-expanded-real-cart-qualification.md`
- `spec/phase-8-expanded-real-cart-qualification-contract.json`
- `package.json`

RuntimeCore 仍不得获得浏览器依赖；codec、RuntimeCore、z8lua bridge 与 WASM 的职责按
[`08-source-layout-and-boundaries.md`](../08-source-layout-and-boundaries.md) 第 2、7 节保持不变。

### 6.4 验证与退出

- 三个初始失败簇都有 aggregate disposition、项目原创最小复现和相应 owner test，或明确 Known Difference；
  compile-time include 只可读取 caller 显式提供且授予 `include` capability 的 Worker-local bundle。
- 通用修复后的受影响本地 case 重跑；tracked 内容只记录簇级变化，不记录 cart identity/path/hash/message。
- `pnpm run test:cart-codec`、`pnpm run test:wasm`、受影响 Runtime/Chrome 测试、
  `pnpm run test:architecture` 与 `pnpm run verify` 通过。
- production 无 cart-specific branch，P0/P1 为 0；8D 独立提交后 8E 成为唯一 active work unit。

## 7. Phase exit gate

- 100/100 canonical case 有 C* disposition；所有 in-profile case 完成 production Chrome fixed smoke。
- 65 个 `.p8`/`.p8.png` pair 均完成 decode/boot parity 定性；差异必须进入 failure cluster 或 Known Difference。
- 至少 10 个覆盖不同游戏类型/API 风险的 case 达到 C2；至少一个 persistence、一个 audio、一个 input、
  一个 multicart/complex-flow case；截图只在本地审阅。
- 所有 P0/P1 为 0；通用修复均有项目原创 regression，无 cart-specific hack。
- tracked repository、release artifact 与 CI 中第三方 cart bytes、截图、路径、hash、逐-cart结果均为 0；
  不发布第三方兼容率。
- `pnpm run test:release`、`pnpm run verify`、Phase 8 aggregate exit test 和最终工作树清洁检查通过。
