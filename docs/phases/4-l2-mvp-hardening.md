# Phase 4 — L2 / MVP Compatibility Hardening

> 状态：Active；4A–4C complete，4D active
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
| 4D Graphics / Memory / Text Hardening | **Active** | corpus 驱动的视觉、RAM、文本差异关闭 |
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

## 已完成：4C

项目自有 WASM compatibility library 实现 `add/del/deli/count/all/foreach`、`rnd/srand` 和
P8 `sub`；四个 coroutine global aliases 保持 guest-only。Node real-WASM 与 Chrome production
Worker 对 60-byte RAM/screen oracle、cold reset、nested instruction-budget fault 和 fault 后恢复
一致；38-entry host ABI 未改变。机器结果由 `workUnits.4C.result` 和
[`phase-4c-core-library.json`](../../tests/conformance/manifests/phase-4c-core-library.json) 锁定。

## Active work unit：4D Graphics / Memory / Text Hardening

### Observable behavior

- 建立项目原创 graphics/memory/text edge cart，先锁定 Node real-WASM 的 framebuffer、display
  palette、相关 RAM 和返回值，再由 Chrome production Worker/Canvas 交叉验证；不得从 4B
  组合 flow 推断未测 overload 已兼容。
- 补齐 required `rrect/rrectfill`，并关闭 `tline` one-argument precision overload；新增 host
  binding 必须 append 到 v1 ABI、走 generated wrappers，既有 `1..38` id 不变。
- 为 `tostr/tonum/chr/ord/split/type` 建立 P8 fixed-point/P8SCII、nil/default、byte-length 和
  multi-return conformance；pure VM string 值不得为了测试或实现跨到 TypeScript。
- 对 memory wrap、overlapping block copy、GFX/SCREEN remap、palette/clip/camera/fillp、sprite/map/
  text interaction 做差异回归；修复必须落在 canonical mapper/RuntimeCore graphics owner，不在
  Canvas presenter 复制 hardware 语义。
- 对 timed P8SCII controls、advanced screen/bitplane modes 做本单元 MVP 决策：实现并锁定，或
  以明确 Known Difference/accepted scope 留在 partial；不得继续用含糊的 deferred 标签替代结论。
- invalid/overflow behavior 若没有官方依据，只锁定 fail-safe、无越界和 structured recovery，
  不把项目自身输出升级为 official exact。

### 允许修改

- `packages/runtime-core/src/graphics/` 及其同 owner 的 browser-neutral tests；必要时修改
  `packages/z8lua-bridge`、`wasm/bridge/generated/` 和 append-only host API spec/generator input。
- `tests/conformance/` 的 Phase 4D 原创 carts/oracles、`tests/browser/phase-4d*`、对应 Chrome runner。
- `spec/pico-api-inventory.yaml`、ABI/runtime manifest、本 phase 文档、机器合同、兼容矩阵与脚本。

4D 不改 Canvas presenter ownership、Worker transport、AudioContext/AudioWorklet、persistence 或
scheduler policy。若 advanced video mode 需要改变 `RuntimeFrame`/presenter schema 或 renderer
ownership，先停下并新增 ADR，不在本单元隐式扩边界。

### 精确 contract routing

- [04 §6 PicoRam](../04-typescript-runtime.md#6-picoram64kib-共享地址空间)
- [04 §7 Graphics](../04-typescript-runtime.md#7-graphics)
- [06 §4 确定性执行模型](../06-testing-compatibility.md#4-确定性执行模型)
- [06 §6 Conformance carts](../06-testing-compatibility.md#6-conformance-carts)
- [06 §7 framebuffer/RAM golden](../06-testing-compatibility.md#7-goldenframebufferram-与-audio)
- [08 §2 RuntimeCore / z8lua-bridge](../08-source-layout-and-boundaries.md#2-package-职责)
- [08 §7 WASM、spec 与生成物](../08-source-layout-and-boundaries.md#7-wasmspec-与生成物)

### Verification / exit

- Proposed `pnpm run test:phase-4d`：本单元创建 real-WASM/RuntimeCore graphics、memory、string
  semantics 与 fault regression 后启用。
- Proposed `pnpm run test:phase-4d:chrome`：本单元创建 production Worker/Canvas 原创 cart
  cross-oracle 后启用。
- `pnpm run verify`：全量回归。
- `rrect/rrectfill` 不再 unimplemented，`tline` 与六个 string globals 的已测 bounded profile 有
  明确 conformance 状态；未关闭 overload/edge 进入 Known Differences。
- canonical mapper、fixed WASM memory、browser-neutral RuntimeCore 和 presenter ownership 不变；
  append ABI 通过 4A inventory reconciliation 与旧 id regression。
- Node/Chrome framebuffer/palette/RAM oracle 一致，structured fault 后有效 cart 可恢复；repo 以
  独立提交结束且干净。

## Phase exit gate

以 [machine contract `phaseExit`](../../spec/phase-4-l2-mvp-contract.json) 为准。核心门槛是：
项目原创 corpus 的 C2+C3 至少 95%（同时报告总数）、开放 P0/P1 为 0、所有 P2 进入
Known Differences、CPU/resource/30-minute Chrome/multi-cart lifecycle 和全量验证全部通过。
