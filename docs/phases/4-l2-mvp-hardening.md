# Phase 4 — L2 / MVP Compatibility Hardening

> 状态：Active；4A–4D complete，4E active
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
| 4E System / Audio / Input / Persistence / Player | **Active** | 剩余 system/player 集成与跨域恢复门禁关闭 |
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

## Active work unit：4E System / Audio / Input / Persistence / Player Integration

### Observable behavior

- 为 required `run/stop/assert/reset/flip/time/stat` 建立最小、可观察的 guest contract；区分 guest
  runtime-control、host `CartSession.reset()` 与 browser player controls，不能用同名函数偷换边界。
- 建立一个项目原创组合 flow，在固定 input trace 下同时观察 framebuffer/RAM、canonical audio、
  input edge、cartdata/current-cart overlay 和 runtime-control event；Node real-WASM 与 Chrome production
  Worker/Canvas/AudioWorklet/IndexedDB 必须交叉一致。
- `run/stop/reset` 必须经现有 VM/RuntimeCore control result 与 Worker state machine 表达；不得让
  guest 直接操作 Window、Worker、storage 或 audio device。`assert` 保持 VM-local structured fault。
- 复验 `sfx/music/btn/btnp/cartdata/dget/dset/reload/cstore` 的跨域组合、reset/fault 后恢复、stale
  generation 拒绝与资源释放；Phase 3 单项通过不能替代本单元的组合生命周期证据。
- 对 external `reload/cstore`、nested `flip` suspension、未支持 `stat()` selectors，以及 conditional
  `printh/extcmd` 分别做 MVP decision；未实现项必须进入明确 Known Difference 或 excluded scope。
- `time/stat` 的逻辑时钟与已实现 selectors 本单元只锁定正确路由；4M instructions/s 数值、慢帧
  策略和 host CPU calibration 保留给 4F，不在 4E 隐式改 scheduler policy。

### 允许修改

- `packages/runtime-core/src/` 中 system control、audio/input/persistence 的既有 owner；必要时修改
  z8lua bridge 的 VM-control lowering，但不得把 browser adapter 引入 package。
- `apps/web-player/src/worker` 的 composition/state routing，以及仅为验证 lifecycle 所需的 main/
  worklet adapter；任何 public transport schema 变化必须同步其 owner contract 和 validators。
- `tests/conformance/` 的 Phase 4E 原创 carts/oracles、`tests/browser/phase-4e*`、对应 Chrome runner，
  以及 inventory/runtime manifest、本 phase 文档、机器合同、兼容矩阵与脚本。

4E 不授权 guest `load`、external resolver、BBS/network、multicart 或 writable cart filesystem；
不改变 Canvas presenter ownership、AudioWorklet device-queue ownership、IndexedDB adapter ownership
或 4F 的 scheduler/CPU cost policy。

### 精确 contract routing

- [02 §4 Session 状态机](../02-system-architecture.md#4-session-状态机)
- [04 §8 AudioSynth 与 AudioWorklet](../04-typescript-runtime.md#8-audiosynth-与-audioworklet)
- [04 §9 Input](../04-typescript-runtime.md#9-input)
- [04 §11 Persistence](../04-typescript-runtime.md#11-persistence)
- [06 §4 确定性执行模型](../06-testing-compatibility.md#4-确定性执行模型)
- [06 §6 Conformance carts](../06-testing-compatibility.md#6-conformance-carts)
- [06 §12 Worker hang、crash 与恢复](../06-testing-compatibility.md#12-worker-hangcrash-与恢复)
- [08 §2 Package 职责](../08-source-layout-and-boundaries.md#2-package-职责)
- [08 §4 Composition roots 与实例生命周期](../08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期)

### Verification / exit

- Proposed `pnpm run test:phase-4e`：本单元创建 system control 与组合 flow 的 real-WASM/
  RuntimeCore regression 后启用。
- Proposed `pnpm run test:phase-4e:chrome`：本单元创建 production Worker/Canvas/AudioWorklet/
  IndexedDB cross-oracle 与 lifecycle gate 后启用。
- `pnpm run verify`：全量回归。
- 七个 required system API 获得 bounded conformance 或明确 accepted scope；conditional 与 partial
  surfaces 不再保留含糊 deferred 标签。
- Node/Chrome 组合 oracle 一致；guest stop/run/reset、fault、stale generation、storage/audio lifecycle
  后有效 cart 可恢复，且 Worker/AudioContext/IndexedDB ownership 不变。
- 4F 的 CPU/scheduler 输入数据可由本单元 flow 复用，但本单元不提前改其预算；repo 以独立提交
  结束且干净。

## Phase exit gate

以 [machine contract `phaseExit`](../../spec/phase-4-l2-mvp-contract.json) 为准。核心门槛是：
项目原创 corpus 的 C2+C3 至少 95%（同时报告总数）、开放 P0/P1 为 0、所有 P2 进入
Known Differences、CPU/resource/30-minute Chrome/multi-cart lifecycle 和全量验证全部通过。
