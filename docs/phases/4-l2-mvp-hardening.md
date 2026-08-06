# Phase 4 — L2 / MVP Compatibility Hardening

> 状态：Active；4A–4B complete，4C active
> 机器合同：[`spec/phase-4-l2-mvp-contract.json`](../../spec/phase-4-l2-mvp-contract.json)
> 浏览器门禁：Google Chrome / Chromium desktop only
> 前置证据：[Phase 3 exit](../evidence/phase-3/41-phase-3-audio-input-persistence-exit-evidence.md)

## 目标与边界

用合法、可重复的项目原创 corpus 驱动 L2/MVP 兼容加固，并把 API 事实、失败归因、CPU/
资源预算和 Chrome 长稳门禁固化为可发布证据。

稳定输入：

- [Phase 4 machine contract](../../spec/phase-4-l2-mvp-contract.json)
- [API inventory](../../spec/pico-api-inventory.yaml)
- [frozen project corpus](../../tests/conformance/manifests/phase-4-l2-corpus.json)
- [local-only external corpus schema](../../tests/conformance/local-corpus.example.json)

Non-goals：guest `load`、外部 cart resolver、BBS/network、multicart、可写 cart 文件、GPIO/
serial、Firefox/WebKit 和移动 release。外部合法 cart 可以本地研究，但 bytes、运行结果和名称
不提交，也不进入公开 playable-rate 分母。

## Work units

| Unit | 状态 | 退出结果 |
| --- | --- | --- |
| 4A Capability Inventory & Corpus Contract | Complete | 112 项四维 API 事实、38 ABI 对账、7-case 原创 corpus 与本地外部隔离合同 |
| 4B Compatibility Runner & Baseline Triage | Complete | Node/Chrome 可重复 baseline；7/7 C3，无开放 issue |
| 4C P8 Lua & Core Library Compatibility | **Active** | 常用 P8 Lua/core library gap 关闭，sandbox 不扩大 |
| 4D Graphics / Memory / Text Hardening | Planned | corpus 驱动的视觉、RAM、文本差异关闭 |
| 4E System / Audio / Input / Persistence / Player | Planned | 剩余 player 集成 P0/P1 关闭 |
| 4F CPU / Slow-frame / Scheduler Calibration | Planned | 4M VM inst/s 成本模型与慢帧策略可复现 |
| 4G Resource Sizing & Chrome Long-run | Planned | fixed memory、30 分钟 soak、多 cart lifecycle 通过 |
| 4H Phase 4 / L2 Exit | Planned | L2 兼容报告、Known Differences、release gate 与证据归档 |

## 已完成：4A

4A 没有改变 production behavior。完成事实由机器合同的 `workUnits.4A.result` 和
`pnpm run test:phase-4a` 锁定；`reload/cstore` 已从旧清单的 stale `unimplemented` 修正为
current-cart-only `partial`，`sspr` 与 VM/library/system surfaces 也进入统一清单。

## 已完成：4B

`phase4-l2-runner@1` 在 Node real-WASM 与 Chrome production Worker/Canvas/AudioWorklet/
IndexedDB 路径得到一致的 7-case cross-oracle；分类为 `C3=7`、其余为 `0`，playable rate
`7/7 = 100%`，开放 P0/P1 为 `0`。受审结果、hash 与 runner/schema 路径由机器合同
`workUnits.4B.result` 锁定；普通测试只生成 gitignored smoke artifact。

## Active work unit：4C P8 Lua & Core Library Compatibility

### Observable behavior

- 在 z8lua/WASM 内提供 PICO-8 必需的 table helpers：`add/del/deli/count/all/foreach`；
  明确 1-based sequence、hole、删除中迭代、identity 与 multi-return 行为。
- 提供 deterministic `rnd/srand`，fresh load/reset/replay 得到一致序列；种子和 table/string/
  fixed-point 参数行为由项目原创 conformance cart 锁定，不把宿主随机源引入 VM。
- 提供 P8 string `sub` 与 guest coroutine helpers：`cocreate/coresume/costatus/yield`；nested
  coroutine 不得接管 root frame-slice coroutine，也不得绕开 instruction budget/fault containment。
- 新能力属于 VM/library surface，不新增 JS↔WASM host binding，不把 table/function handle 或
  guest library 语义移到 TypeScript Runtime。
- 对正常、invalid argument、reset 和 instruction-budget 路径建立 real-WASM/Chrome regression，
  随实现同步 API inventory 的 implementation/conformance 状态；不把未测 edge 标成 exact。

### 允许修改

- `wasm/z8lua/`、WASM build/patch manifest 中与 P8 Lua library/bootstrap 直接相关的源文件。
- `tests/wasm/`、`tests/conformance/` 的 Phase 4C 原创 carts/oracles，以及
  `tests/browser/phase-4c*`、对应 browser runner。
- `spec/pico-api-inventory.yaml`、本 phase 文档、Phase 4 machine contract、兼容矩阵与脚本。

4C 默认不改 `packages/runtime-core`、`apps/web-player`、transport schema 或 38-entry host ABI。
如果实现需要新增 host binding 或改变 root coroutine/ABI，先停下并新增 ADR，不在本单元隐式扩边界。

### 精确 contract routing

- [03 §3 VM 初始化与库白名单](../03-z8lua-wasm-bridge.md#3-vm-初始化与库白名单)
- [03 §4 生命周期与控制流](../03-z8lua-wasm-bridge.md#4-生命周期与控制流)
- [03 §8 值编解码](../03-z8lua-wasm-bridge.md#8-值编解码)
- [03 §9 Yield、HostRequest 与错误](../03-z8lua-wasm-bridge.md#9-yieldhostrequest-与错误)
- [06 §4 确定性执行模型](../06-testing-compatibility.md#4-确定性执行模型)
- [06 §6 Conformance carts](../06-testing-compatibility.md#6-conformance-carts)
- [08 §2 z8lua-bridge](../08-source-layout-and-boundaries.md#pico8-webz8lua-bridge)
- [08 §7 WASM、spec 与生成物](../08-source-layout-and-boundaries.md#7-wasmspec-与生成物)

### Verification / exit

- `pnpm run test:phase-4c`：real-WASM library semantics、reset/replay、invalid/fault regression。
- `pnpm run test:phase-4c:chrome`：production Worker 的原创 cart cross-oracle。
- `pnpm run verify`：全量回归。
- 13 个 required VM builtins 不再是 `unimplemented/unknown`；正常路径为 compatible，未覆盖 edge
  仍显式登记，不以 label 替代测试。
- guest nested coroutine 不破坏 root frame scheduling、structured fault、fixed memory 或 sandbox。
- Node/Chrome oracle 一致，38-entry host ABI/hash 不变；repo 以独立提交结束且干净。

## Phase exit gate

以 [machine contract `phaseExit`](../../spec/phase-4-l2-mvp-contract.json) 为准。核心门槛是：
项目原创 corpus 的 C2+C3 至少 95%（同时报告总数）、开放 P0/P1 为 0、所有 P2 进入
Known Differences、CPU/resource/30-minute Chrome/multi-cart lifecycle 和全量验证全部通过。
