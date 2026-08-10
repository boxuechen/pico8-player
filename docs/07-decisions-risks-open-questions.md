# 架构决定、风险与未决问题

本文件是 ADR/risk/question 的索引，不重复 ADR 正文、阶段任务、阶段状态或完成证据。当前
activation 状态由 [`docs/README.md`](./README.md) 与 [`docs/phases/`](./phases/) 唯一维护；
active phase 如何回答 Proposed 项由其 phase 文档定义。

## 1. ADR registry

`Accepted` 不能由普通实现任务改变；`Proposed` 必须在依赖它的 production path 合并
前转为 Accepted 或 Rejected。

| ID | 状态 | 决定或待决方向 |
| --- | --- | --- |
| ADR-001 | Accepted | z8lua WASM + TypeScript Runtime |
| ADR-002 | Accepted | 不用普通 Lua/Fengari 替代 P8 VM |
| ADR-003 | Accepted | Pico RAM 位于 WASM memory，TS 使用 zero-copy lease |
| ADR-004 | Accepted | Runtime 在 Worker，Window 只拥有 host/UI |
| ADR-005 | [Accepted](./adr/005-lossless-p8png.md) | bounded、bytes-only `.p8.png` codec |
| ADR-006 | [Accepted](./adr/006-interop-hot-path-boundary.md) | raw primitive/pointer-length hybrid ABI 与 profile-driven fallback |
| ADR-007 | Superseded by ADR-018 | 首版只接受 caller-provided/local cart bytes |
| ADR-008 | [Accepted](./adr/008-schema-generated-host-bindings.md) | production schema 单向生成 C/TS host bindings；prototype 不暴露未实现 API |
| ADR-009 | [Accepted](./adr/009-canvas2d-frame-presenter.md) | Canvas2D 是唯一默认 presenter；WebGL fallback 未实现 |
| ADR-010 | [Accepted](./adr/010-dedicated-messageport-audio-transport.md) | dedicated MessagePort 是唯一默认 PCM transport；不实现 relay/SAB |
| ADR-011 | [Accepted](./adr/011-hidden-tab-pause.md) | hidden/blur 默认 pause、清输入并重建 scheduler anchor，不追墙钟 backlog |
| ADR-012 | [Accepted](./adr/012-z8lua-source-and-phase-0a-wasm.md) | z8lua pin、patch manifest 与 reproducible WASM |
| ADR-013 | [Accepted](./adr/013-shared-pico-ram-boundary.md) | context-owned 64 KiB RAM、canonical mapper、fixed memory |
| ADR-014 | Accepted | canonical test PCM 为 22050 Hz mono signed PCM16LE |
| ADR-015 | Accepted | 四 package DAG + main/worker/worklet execution domains |
| ADR-016 | Accepted | pnpm workspace 和精确 tool versions |
| ADR-017 | Partially superseded by ADR-022 | hard budget/watchdog 与 nested suspension 降级继续有效；blanket hook-yield rejection 已替换 |
| ADR-018 | [Accepted](./adr/018-caller-authorized-cart-resolution.md) | caller-authorized local bundle resolver；BBS 自动访问保持 Deferred |
| ADR-019 | [Accepted](./adr/019-phase-5-coroutine-compatibility.md) | L3 host suspension 保持 root-only；nested surface 统一 structured fault |
| ADR-020 | [Deferred](./adr/020-phase-5-bbs-adapter.md) | 不新增自动 BBS adapter、endpoint 或 production network capability |
| ADR-021 | [Partially superseded by ADR-023/030](./adr/021-menuitem-registration-boundary.md) | 五槽 registry/callback VM ownership 继续有效；UI 与 label admission 已替代 |
| ADR-022 | [Accepted](./adr/022-cpu-slicing-decision.md) | top-level custom loop 使用 root-safe 30 Hz implicit frame；hard cap 继续 poison |
| ADR-023 | [Partially superseded by ADR-030](./adr/023-menuitem-invocation-boundary.md) | VM-local callback + copied snapshot + generation-bound root-safe pause-menu invocation；label admission 由 ADR-030 修正 |
| ADR-024 | [Accepted](./adr/024-pico8-v027-cart-version-and-text-include.md) | v0.2.7 cart version 43、bounded compact text rows 与 caller-authorized non-recursive include |
| ADR-025 | [Accepted](./adr/025-phase-8d-real-cart-compatibility-boundaries.md) | parser/VM/callback/API/performance 修复和 expected-fault qualification 边界 |
| ADR-026 | [Accepted](./adr/026-phase-9-language-compatibility-boundary.md) | P8 Lua/host coercion/typed selector、safe helper 与固定 2 MiB Lua heap 边界 |
| ADR-027 | [Accepted](./adr/027-phase-9-timing-safety-boundary.md) | fixed 32M hard safety cap 与 Q16.16 numeric-for termination |
| ADR-028 | [Accepted](./adr/028-phase-9-local-host-feature-boundary.md) | explicit local bundle、empty `load("")` no-op 与 missing/denied fail-closed |
| ADR-029 | [Accepted](./adr/029-phase-9-requalification-remediation-boundary.md) | `camera()` previous return、absent `all()`、bounded large `chr()` 与 local multicart composition |
| ADR-030 | [Accepted](./adr/030-menuitem-display-label-boundary.md) | 16-character display prefix 保持有界，超长 label 不得使 cart fault |

## 2. 当前未决问题

### Active blockers

当前没有已登记 blocker。发布边界、Known Differences 与未验证覆盖面见
[`06-testing-compatibility.md`](./06-testing-compatibility.md)；未激活阶段的想法不登记为 blocker。

### Deferred open questions

当前没有已经分配给 active phase 的 deferred question；新增问题必须同时写明触发条件和 owner。

已关闭问题不在 living index 重复；其决定由 ADR、machine contract 和 immutable evidence 保存。

## 3. Risk register

这里只保留活跃风险与 owner；详细触发案例进入对应 ADR、compatibility entry 或 phase
evidence，不在本表复制测试步骤。

| ID | 风险 | 当前控制 / 下一 owner |
| --- | --- | --- |
| R-01 | WASM↔JS 高频调用耗尽预算 | ADR-006 fallback ladder + benchmark gate |
| R-02 | z8lua 与 PICO-8 0.2.7 语义差异 | pinned patches + conformance |
| R-03 | memory growth 使 typed views stale | ADR-013 fixed memory + lease/view identity tests |
| R-04 | PNG low-bit corruption / decompression bomb | ADR-005 limits、property/malformed tests |
| R-05 | AudioWorklet underrun 或 queue 增长 | ADR-010 bounded queue + affected Chrome/resource gate |
| R-06 | fixed-point 被 JS float 改写 | raw ABI + boundary tests |
| R-07 | P8SCII/Unicode 破坏 byte string | byte-oriented renderer + pointer/length conformance |
| R-08 | hard budget、soft CPU 与 implicit frame 混淆 | ADR-022/027 分离 compatibility cost、implicit quantum 与 fixed 32M safety cap |
| R-09 | multi-cart 同步 API 需要 async host data | caller-authorized repository + root HostRequest + atomic swap |
| R-10 | 参考算法混合许可证 | provenance + NOTICE audit |
| R-11 | BBS 自动访问侵犯条款/作者权利 | ADR-020 Deferred；无 production adapter、endpoint、network access 或 corpus bytes |
| R-12 | refresh/hidden policy 改变 simulation | logical scheduler；ADR-011 hidden/blur pause + re-anchor |
| R-13 | fault/reload 后 stale frame/audio | generation + sequence + queue reset/recovery gates |
| R-14 | API 广而不准、stub 堆积 | vertical slice + conformance gate |
| R-15 | upper RAM/remap 语义回归 | ADR-013 canonical mapper tests |
| R-16 | nested coroutine 吞掉 host suspension | ADR-019 root-only + uncatchable structured fault |
| R-17 | package/execution-domain 边界退化 | ADR-015 + architecture negative fixtures |

## 4. Fallback ladder

遇到性能或兼容阻塞时按顺序升级；每一级必须有 benchmark/profile 或明确
`not-applicable` 证据：

1. 去除 boundary allocation 和 object conversion。
2. 使用 raw numeric/string buffer ABI。
3. 批量处理 frame/audio 等只读输出。
4. 下沉 `peek/poke/memcpy/pset/pget` 热 primitive。
5. 下沉 `spr/sspr/map/line` block operations。
6. 下沉 audio inner loop，仍由 TS authoritative orchestration。
7. 只有完整证据证明必要时，另立 ADR 评估 full-core WASM。

## 5. 来源与许可

- z8lua pin 必须记录 commit、license、patch 和 artifact hash。
- 从 fake-08/zepto8 翻译算法时记录原 repository/commit/path/license 和语义改动。
- 不从仓库顶层 license 推断内嵌算法许可。
- 测试 cart/capture 记录作者、来源、许可和是否允许再分发。
- 发布产物生成 NOTICE / third-party license 清单。

本地 reference checkout 与隔离规则见
[`10-reference-sources.md`](./10-reference-sources.md)。

## 6. ADR minimum template

新 ADR 至少包含：状态和日期、Context、Decision、Evidence、Consequences、Rejected
alternatives。证据必须链接到可复现命令/raw artifact；不能只写主观判断。
