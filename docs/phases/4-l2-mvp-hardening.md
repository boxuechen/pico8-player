# Phase 4 — L2 / MVP Compatibility Hardening

> 状态：Active；4A–4F complete，4G active
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
| 4F CPU / Slow-frame / Scheduler Calibration | Complete | 4M VM inst/s 成本模型、慢帧策略与 safety cap 可复现 |
| 4G Resource Sizing & Chrome Long-run | **Active** | fixed memory、30 分钟 soak、多 cart lifecycle 通过 |
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

## 已完成：4F

deterministic z8lua instruction count 现在按
`floor(instructions * accountingFps * 65536 / 4,000,000)` 转为 signed Q16.16 CPU fraction；普通
frame 使用 target FPS，固定 `1/30s` startup 使用 30；raw
`0x00010000` 仍属预算内，只有更大值标记 `slowFrame`。ordinary slow frame 完成一个原子 logical
frame，不降频、不跳 draw；默认 `1,000,000` instruction safety cap 独立 containment 非 yield cart。
`stat(1)` 返回 transaction 到调用点的累计 CPU fraction（包括 HostRequest continuation），`stat(7)`
返回 logical FPS；`stat(0)` 因无稳定 oracle 保持 false。30/60/custom、input/audio/draw/cartdata、
hard-cap/recovery 的 Node real-WASM 与 Chrome production Worker exact trace 由
[`phase-4f-cpu-scheduler.json`](../../tests/conformance/manifests/phase-4f-cpu-scheduler.json) 和机器合同
`workUnits.4F.result` 锁定。

## Active work unit：4G Resource Sizing & Chrome Long-run

### Observable behavior

- 审计并锁定 production runtime 的 fixed 16 MiB WASM memory、64 KiB Pico RAM、默认/最低 Lua heap
  与 transport queue 上限；每项上限必须有 owner、机器 manifest 和可观测故障，不得通过开启
  `ALLOW_MEMORY_GROWTH` 或 host 自适应策略绕过。
- 用项目原创 allocation/resource carts 覆盖默认 heap 正常运行、低 heap/持续分配的 bounded
  `E_VM_OUT_OF_MEMORY`、fault 后 fresh cart recovery。Node real-WASM 与 Chrome production Worker
  对 fault class、session generation、RAM/frame/audio/persistence commit 边界一致。
- 运行至少 `1800s` 的 Chrome/Chromium production-path soak；计量期必须在 AudioWorklet prebuffer 后
  开始，持续驱动 30/60 Hz logical scheduler，并报告 logical ticks、frames、dropped ticks、steady
  audio underrun/overrun/discontinuity/stale chunks、Worker errors、main-thread long task 与 heap trend。
- 在同一 player 实例中顺序执行至少 20 次 host-driven cart load/start/pause-or-stop/reset/fault-recover
  lifecycle，混合 30/60/custom 与 persistence cart；每代 stale frame/PCM/input 必须被拒绝，最终活动
  Worker/AudioContext/listener/queue 回到明确基线。
- 长稳结果不得依赖 Firefox/WebKit，不扩大 guest API；4G 只校准资源和 host-driven lifecycle，不修改
  4F 的 CPU formula、logical cadence 或 slow-frame transaction policy。

### 允许修改

- `wasm/runtime-v1.manifest.lock.json` 与已有 Lua allocator/fixed-memory diagnostics；只有 evidence 证明
  当前上限不足时才可调整常量，WASM memory 仍必须 fixed。
- `apps/web-player` 既有只读 stats/diagnostic 路由与 resource lifecycle cleanup；允许增加 bounded
  measurement 字段，不允许把 RuntimeCore policy 移到 Window/AudioWorklet。
- `tests/conformance/` 的原创 resource carts/manifests、`tests/browser/phase-4g*`、Chrome runner、
  `benchmarks/phase-4/results/` 的受审 long-run artifact、脚本、inventory/phase contract 和 owner 文档。
- 默认 `test:phase-4g:chrome` 可使用短 smoke 参数；受审 1800s gate 必须有独立、显式 evidence 命令，
  两者复用同一 runner/schema，不能用短跑结果冒充 phase exit。

4G 不授权 guest `load`、external resolver/BBS/network、multicart cart format、writable filesystem、
mobile release 或非 Chromium browser；不改变 Canvas/AudioContext/IndexedDB/input adapter ownership。

### 精确 contract routing

- [02 §3 Execution domains](../02-system-architecture.md#3-execution-domains)
- [02 §9 Error 模型](../02-system-architecture.md#9-error-模型)
- [04 §12 Worker、watchdog 与消息协议](../04-typescript-runtime.md#12-workerwatchdog-与消息协议)
- [06 §9 Fuzz、恶意输入与资源上限](../06-testing-compatibility.md#9-fuzz恶意输入与资源上限)
- [06 §10 JS↔WASM microbench 与性能门禁](../06-testing-compatibility.md#10-jswasm-microbench-与性能门禁)
- [06 §11 Chrome/Chromium 支持矩阵](../06-testing-compatibility.md#11-chromechromium-支持矩阵)
- [06 §12 Worker hang、crash 与恢复](../06-testing-compatibility.md#12-worker-hangcrash-与恢复)
- [08 §4 Composition roots 与实例生命周期](../08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期)

### Verification / exit

- Proposed `pnpm run test:phase-4g`：本单元创建 fixed-memory/Lua-heap/OOM、multi-cart lifecycle 与
  manifest regression 后启用。
- Proposed `pnpm run test:phase-4g:chrome`：本单元创建短时 production-path resource smoke 后启用。
- Proposed `pnpm run evidence:phase-4g`：同一 Chrome runner 以 `1800s` 受审配置写入固定 evidence；
  输出必须包含 exact Chrome/OS/CPU、build/cart hashes、计量窗口和全部 gate counters。
- `pnpm run verify`：全量回归；普通 verify 不重复 30-minute evidence，但必须校验受审 artifact/schema/hash。
- fixed sizing 与 OOM failure/recovery 通过，20 次 sequential lifecycle 无 stale event、资源泄漏或
  persistence/audio ownership 回归；30-minute steady counters 达到 06 的 Chrome gate。
- 完成后机器合同和兼容矩阵记录 exact limits/results，4H 获得唯一 exit baseline，repo 以独立提交结束且干净。

## Phase exit gate

以 [machine contract `phaseExit`](../../spec/phase-4-l2-mvp-contract.json) 为准。核心门槛是：
项目原创 corpus 的 C2+C3 至少 95%（同时报告总数）、开放 P0/P1 为 0、所有 P2 进入
Known Differences、CPU/resource/30-minute Chrome/multi-cart lifecycle 和全量验证全部通过。
