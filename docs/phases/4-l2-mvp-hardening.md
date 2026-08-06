# Phase 4 — L2 / MVP Compatibility Hardening

> 状态：Active；4A complete，4B active
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
| 4B Compatibility Runner & Baseline Triage | **Active** | Node/Chrome 可重复 baseline；每个失败有首个差异与 owner |
| 4C P8 Lua & Core Library Compatibility | Planned | 常用 P8 Lua/core library gap 关闭，sandbox 不扩大 |
| 4D Graphics / Memory / Text Hardening | Planned | corpus 驱动的视觉、RAM、文本差异关闭 |
| 4E System / Audio / Input / Persistence / Player | Planned | 剩余 player 集成 P0/P1 关闭 |
| 4F CPU / Slow-frame / Scheduler Calibration | Planned | 4M VM inst/s 成本模型与慢帧策略可复现 |
| 4G Resource Sizing & Chrome Long-run | Planned | fixed memory、30 分钟 soak、多 cart lifecycle 通过 |
| 4H Phase 4 / L2 Exit | Planned | L2 兼容报告、Known Differences、release gate 与证据归档 |

## 已完成：4A

4A 没有改变 production behavior。完成事实由机器合同的 `workUnits.4A.result` 和
`pnpm run test:phase-4a` 锁定；`reload/cstore` 已从旧清单的 stale `unimplemented` 修正为
current-cart-only `partial`，`sspr` 与 VM/library/system surfaces 也进入统一清单。

## Active work unit：4B Compatibility Runner & Baseline Triage

### Observable behavior

- 同一个 versioned runner 读取 frozen corpus，在 Node real-WASM 和 Chrome production
  Worker/Canvas/AudioWorklet/IndexedDB 路径执行；不得直接调用内部实现绕过 composition root。
- 每次结果绑定 build/commit、cart/source SHA-256、Chrome 版本、固定 input trace、frame/time
  范围和环境；缺少任一项时保持 `CU`。
- 每个 case 记录 boot、first fault/first divergent frame、screen/palette/RAM、canonical/device
  audio、input、persistence、Worker/resource lifecycle；不靠放宽 tolerance 把失败改绿。
- 生成 C0–C3/CU baseline 与 playable rate。每个 C0/C1 必须映射到一个 P0–P3 issue record，
  并有不包含第三方内容的最小原创复现或明确的后续最小化状态。
- 普通测试只写 gitignored smoke artifact；reviewed result 只在 evidence 命令中显式更新。

### 允许修改

- `tests/conformance/` 的 Phase 4 runner、manifest result schema、原创 repro 和 tests。
- `tests/browser/phase-4b*`、`tools/browser/run-phase-4b.mjs`、`benchmarks/phase-4/results/`。
- `package.json` 的真实 Phase 4B test/evidence scripts。
- 本 phase 文档、Phase 4 machine contract，以及 baseline 产生的兼容矩阵条目。

4B 默认不允许改 `packages/`、`apps/web-player/src/`、`wasm/` 或 ABI；发现生产 gap 时先记录
并路由到 4C–4F，不在 runner 单元中顺手修复。

### 精确 contract routing

- [06 §4 确定性执行模型](../06-testing-compatibility.md#4-确定性执行模型)
- [06 §6 Conformance carts](../06-testing-compatibility.md#6-conformance-carts)
- [06 §7 Golden](../06-testing-compatibility.md#7-goldenframebufferram-与-audio)
- [06 §12 Worker hang/crash/recovery](../06-testing-compatibility.md#12-worker-hangcrash-与恢复)
- [06 §13 测试数据版权](../06-testing-compatibility.md#13-测试数据版权与-bbs-访问限制)
- [06 §15.1–15.3 兼容口径](../06-testing-compatibility.md#15-兼容等级已知差异与质量口径)
- [08 §8 测试布局与机器门禁](../08-source-layout-and-boundaries.md#8-测试布局与机器门禁)

### Verification / exit

- `pnpm run test:phase-4b`：Node real-WASM baseline、manifest/result schema 和 failure triage。
- `pnpm run test:phase-4b:chrome`：production Worker/browser path cross-oracle。
- `pnpm run verify`：全量回归。
- 所有 7 个 frozen case 都从 `CU` 得到当前 build 的 C0–C3 分类；环境、trace/hash 与观测完整。
- 所有 C0/C1 都有 severity、owner 和原创最小复现路由；repo 以独立提交结束且干净。

## Phase exit gate

以 [machine contract `phaseExit`](../../spec/phase-4-l2-mvp-contract.json) 为准。核心门槛是：
项目原创 corpus 的 C2+C3 至少 95%（同时报告总数）、开放 P0/P1 为 0、所有 P2 进入
Known Differences、CPU/resource/30-minute Chrome/multi-cart lifecycle 和全量验证全部通过。
