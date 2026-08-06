# Phase 4 — L2 / MVP Compatibility Hardening

> 状态：Active；4A–4G complete，4H active
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
| 4G Resource Sizing & Chrome Long-run | Complete | fixed memory、1800 秒 Chrome soak、多 cart lifecycle 与资源释放通过 |
| 4H Phase 4 / L2 Exit | **Active** | L2 兼容报告、Known Differences、release gate 与证据归档 |

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

## 已完成：4G

production WASM 保持 fixed `16 MiB`、Pico RAM `64 KiB`、默认 Lua heap `1 MiB`；最低
`32 KiB` diagnostic profile 以带 `liveLuaBytes/luaHeapLimit` 的 `E_VM_OOM` fail closed，恢复 cart
可在 fresh VM 正常运行。AudioWorklet queue 和 cartdata hydration 上限由各自 owner 导出并由机器
manifest 锁定。受审 Chrome 150/macOS arm64 evidence 连续运行 `1800.4173s`：30/60 Hz 分别提交
`54,013`/`108,026` 帧，dropped tick、steady audio fault、long task、Worker error 均为 `0`；20 次
sequential load、24 个 generation 的 stale frame/PCM/input probe 全部通过，Worker、AudioContext、
listener、RAF 和 queue 均释放。主页面 isolate 在强制 GC 后 retained heap 增量为 `2,776 bytes`。
机器结果由 `workUnits.4G.result`、
[`phase-4g-resource-long-run.json`](../../tests/conformance/manifests/phase-4g-resource-long-run.json) 和
[`reviewed long-run artifact`](../../benchmarks/phase-4/results/chromium-macos-arm64-phase-4g-long-run.json)
锁定。

## Active work unit：4H Phase 4 / L2 Exit

### Observable behavior

- 建立一个 machine-checked Phase 4 exit manifest/test，聚合 4A–4G 的 inventory、corpus、Node/Chrome
  oracle、CPU/resource budget、受审 artifact hash 和命令事实；不得靠手工摘要宣告通过。
- 发布 L2/MVP compatibility report：明确 PICO-8 版本、项目原创 corpus 分母和 playable-rate 公式，报告
  C0–C3/CU、112 项 inventory 实现/兼容计数、开放 P0/P1/P2，以及 Chrome-only 支持边界。
- 把所有 MVP partial/unimplemented/unsupported 项逐条对到账面上的 accepted scope decision 或
  Known Difference；Known Differences 必须说明用户可见影响和 workaround/排除范围，不得只保留内部标签。
- 复核 4B 的 7-case corpus 与 4C–4G vertical evidence，运行全量 Node real-WASM 和 Chrome
  production-path gate；普通 exit 不重新生成 30 分钟 artifact，但必须 hash-lock 并验证它。
- 归档唯一 Phase 4 exit evidence，更新机器合同/roadmap/status owner，删除本 active phase 执行文档；
  Phase 4 完成后不得仍有 active work unit，也不得把 Phase 5 的 guest `load`/BBS scope 混入。

### 允许修改

- `tests/conformance/` 下的 Phase 4 exit manifest/test、`package.json` 的 exit/aggregate scripts，以及
  `spec/phase-4-l2-mvp-contract.json` 的最终结果。
- `docs/06-testing-compatibility.md` 的 publishable compatibility/Known Differences 矩阵、
  `docs/evidence/phase-4/` 的单一 exit evidence、README/roadmap/status owner 的收口更新。
- 只允许修复 exit audit 揭示的文档、contract 或测试事实不一致；如发现 production behavior 缺口，
  4H 必须先记录未通过并回到有边界的实现 work unit，不得在 exit 任务中暗改运行时。

4H 不授权新 guest API、guest `load`、external resolver/BBS/network、multicart、writable filesystem、
mobile release 或非 Chromium browser；不重新解释 4A–4G 已锁定的 runtime policy。

### 精确 contract routing

- [01 §3 兼容等级](../01-scope-and-success-criteria.md#3-兼容等级)
- [01 §6 成功标准](../01-scope-and-success-criteria.md#6-成功标准)
- [05 Phase 4 roadmap headline](../05-delivery-plan.md#phase-4-activation-baseline)
- [06 §11 Chrome/Chromium 支持矩阵](../06-testing-compatibility.md#11-chromechromium-支持矩阵)
- [06 §15 当前兼容矩阵](../06-testing-compatibility.md#15-当前兼容矩阵)
- [Evidence archive rules](../evidence/README.md)

### Verification / exit

- Proposed `pnpm run test:phase-4h`：创建后验证 exit manifest、所有阶段 artifact/hash、兼容统计、
  Known Differences coverage、phase contract 和 evidence 文档互相一致。
- `pnpm run verify`：必须包含 `test:phase-4h`，并完整通过既有 Chrome smoke gates；已受审 4G long-run
  由哈希和 schema 复核，不重复执行 `evidence:phase-4g`。
- Phase contract 最终为 `status=complete`、`completedWorkUnits=4A..4H`、active/next work unit 均为 null；
  exit evidence 记录精确验证结果、Chrome/机器、artifact hash 和未扩大的 scope。
- 完成后把 Phase 4 roadmap 压缩为一行并删除本执行文档；repo 以独立提交结束且干净。

## Phase exit gate

以 [machine contract `phaseExit`](../../spec/phase-4-l2-mvp-contract.json) 为准。核心门槛是：
项目原创 corpus 的 C2+C3 至少 95%（同时报告总数）、开放 P0/P1 为 0、所有 P2 进入
Known Differences、CPU/resource/30-minute Chrome/multi-cart lifecycle 和全量验证全部通过。
