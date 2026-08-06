# Phase 4 — L2 / MVP Compatibility Hardening

> 状态：Active；4A–4E complete，4F active
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
| 4C P8 Lua & Core Library Compatibility | Complete | 13 项 VM/core API、确定性 PRNG 与 nested budget containment 关闭 |
| 4D Graphics / Memory / Text Hardening | Complete | 9 项 API、386-byte Node/Chrome oracle 与两项 MVP scope decision 关闭 |
| 4E System / Audio / Input / Persistence / Player | Complete | root runtime control、跨域组合流与恢复门禁关闭 |
| 4F CPU / Slow-frame / Scheduler Calibration | **Active** | 4M VM inst/s 成本模型、慢帧策略与 safety cap 可复现 |
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

## 已完成：4C

项目自有 WASM compatibility library 实现 `add/del/deli/count/all/foreach`、`rnd/srand` 和
P8 `sub`；四个 coroutine global aliases 保持 guest-only。Node real-WASM 与 Chrome production
Worker 对 60-byte RAM/screen oracle、cold reset、nested instruction-budget fault 和 fault 后恢复
一致；38-entry host ABI 未改变。机器结果由 `workUnits.4C.result` 和
[`phase-4c-core-library.json`](../../tests/conformance/manifests/phase-4c-core-library.json) 锁定。

## 已完成：4D

`rrect/rrectfill` 以 append-only host binding `39..40` 落在 browser-neutral RuntimeCore，
`tline(bits)` 覆盖 13/16-bit source-coordinate profile；`tostr/tonum/chr/ord/split/type` 保持
VM-local。项目原创 cart 在 Node real-WASM 与 Chrome production Worker/Canvas 得到一致的
386-byte RAM/screen oracle、cold reset 与 fault recovery。timed P8SCII controls 作为 accepted
partial Known Difference，advanced screen/bitplane modes 明确排除在 MVP 外。精确 hash、inventory
计数与验证命令由 `workUnits.4D.result` 和
[`phase-4d-graphics-memory-text.json`](../../tests/conformance/manifests/phase-4d-graphics-memory-text.json)
锁定。

## 已完成：4E

root guest `run/stop` 现在通过 VM control outcome 进入 RuntimeCore/Worker；guest `reset` 以
append-only host binding `41` 只恢复 system/graphics defaults，`assert` 保持 structured VM fault，
`stat(6)` 返回 copy-owned run parameter。项目原创组合 flow 在 Node real-WASM 与 Chrome production
Worker/Canvas/AudioWorklet/IndexedDB 路径锁定 audio、input、cartdata/current-cart、run/stop、fault/
recovery、stale generation 与 dispose 行为；同一外部 generation 的 guest `run` 创建 fresh runtime
graph 并重置 audio timeline。精确 hash、Chrome 版本、inventory counts 与 MVP scope decisions 由
`workUnits.4E.result` 和
[`phase-4e-system-integration.json`](../../tests/conformance/manifests/phase-4e-system-integration.json)
锁定。

## Active work unit：4F CPU / Slow-frame / Scheduler Calibration

### Observable behavior

- 校准 z8lua 已消费 instruction count 与 PICO-8 `4,000,000 VM instructions/s` 参考预算的换算，
  明确 30 Hz、60 Hz 和 custom-loop slice 的精确预算公式、取整方向与测试容差；不能用 host
  wall-clock 或机器速度代替 guest cost。
- 用项目原创 cart 覆盖低于、恰好达到和超过单 slice 预算的 30 Hz/60 Hz 路径；Node real-WASM 与
  Chrome production Worker 必须对 instruction count、logical tick、frame/audio/input/persistence
  transaction 得到相同分类和可重复 trace。
- 把 compatibility soft budget 与 safety hard cap 分成两个命名清楚的策略：普通 over-budget frame
  按已受审 slow-frame policy 继续或降频，不得被误报为 VM fault；无限循环或长期不 yield 仍必须由
  bounded hard cap/watchdog 终止并产生 structured fault。
- 实现并校准 `stat(1)`（自上次 flip 的 CPU 使用率）和 `stat(7)`（当前目标 FPS）；只有官方证据和
  本单元 oracle 足以锁定时才加入 `stat(0)`，不得顺便扩大其他 selector。数值必须 deterministic、
  bounded，并与 logical scheduler 而非浏览器刷新率绑定。
- 保持现有 30/60 Hz cadence、custom-loop `flip()` boundary、logical `time()`、canonical audio、input
  edge 和 cartdata commit 的 transaction 语义；4F 不改变 Window/Worker/Worklet ownership，也不引入
  adaptive host-CPU heuristic。

### 允许修改

- z8lua bridge 的 instruction accounting/status getter，以及 `packages/runtime-core/src/` 中既有
  frame-cost、scheduler 和 `stat` owner；若需跨 Worker 观察，只能扩展既有 versioned diagnostic/
  state routing，不能把 policy 移到 main thread。
- `tests/conformance/` 的 Phase 4F 原创 carts、budget trace/oracles、`tests/browser/phase-4f*`、对应
  Chrome runner，以及 inventory/runtime manifest、本 phase 文档、机器合同、兼容矩阵和脚本。
- 允许新增只读 calibration/benchmark 工具；结果必须可复现，且 production policy 不得依赖运行
  benchmark 的当前机器、Chrome wall-clock 或开发环境阈值。

4F 不授权 4G 的 fixed-resource/30-minute/multi-cart gate，不授权 guest `load`、external resolver、
BBS/network、writable cart filesystem 或 browser 扩展；不改变 presenter、AudioWorklet、IndexedDB、
input adapter 的 ownership。

### 精确 contract routing

- [02 §4 Session 状态机](../02-system-architecture.md#4-session-状态机)
- [04 §10 FrameScheduler](../04-typescript-runtime.md#10-framescheduler)
- [04 §10.2 帧语义](../04-typescript-runtime.md#102-帧语义)
- [04 §10.3 CPU budget 与慢帧](../04-typescript-runtime.md#103-cpu-budget-与慢帧)
- [06 §4 确定性执行模型](../06-testing-compatibility.md#4-确定性执行模型)
- [06 §6 Conformance carts](../06-testing-compatibility.md#6-conformance-carts)
- [06 §12 Worker hang、crash 与恢复](../06-testing-compatibility.md#12-worker-hangcrash-与恢复)
- [08 §2 Package 职责](../08-source-layout-and-boundaries.md#2-package-职责)
- [08 §4 Composition roots 与实例生命周期](../08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期)

### Verification / exit

- Proposed `pnpm run test:phase-4f`：本单元创建 instruction-cost、30/60/custom cadence、soft-budget/
  hard-cap 与 `stat(1/7)` real-WASM regression 后启用。
- Proposed `pnpm run test:phase-4f:chrome`：本单元创建 production Worker calibration cross-oracle 与
  watchdog recovery gate 后启用。
- `pnpm run verify`：全量回归。
- 机器合同锁定每 slice budget 公式、instruction-accounting 单位、取整/容差和 30/60/custom 的 exact
  oracles；Node/Chrome 分类一致。
- `stat(1)` 与 `stat(7)` 在已支持路径有 deterministic bounded 结果；inventory 不再把它们留作
  unknown。若 `stat(0)` 未获得足够证据，必须保持 false/unknown 并记录原因。
- ordinary slow frame 与 infinite-loop safety fault 有独立、可重现的测试；fault 后可加载有效 cart，
  scheduler/audio/input/persistence transaction 与 Worker lifecycle 无回归。
- full verify 通过；4G 获得明确的 resource/soak 输入，repo 以独立提交结束且干净。

## Phase exit gate

以 [machine contract `phaseExit`](../../spec/phase-4-l2-mvp-contract.json) 为准。核心门槛是：
项目原创 corpus 的 C2+C3 至少 95%（同时报告总数）、开放 P0/P1 为 0、所有 P2 进入
Known Differences、CPU/resource/30-minute Chrome/multi-cart lifecycle 和全量验证全部通过。
