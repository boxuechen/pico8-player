# Phase 5 — L3 Local / Multicart

> 状态：Active；5A–5G complete，5H active
> 机器合同：[`spec/phase-5-l3-multicart-contract.json`](../../spec/phase-5-l3-multicart-contract.json)
> 浏览器门禁：Google Chrome / Chromium desktop only
> 前置证据：[Phase 4 L2/MVP exit](../evidence/phase-4/51-phase-4-l2-mvp-exit-evidence.md)
> 目标声明：PICO-8 v0.2.7 L3 local/multicart project profile

## Goal 与 non-goals

Phase 5 完成 caller-authorized local bundle、root recoverable HostRequest、guest `load()`、external
`reload/cstore` 和 atomic cart swap。RuntimeCore 继续 browser-neutral，cart code 不获得任意 URL、
宿主文件系统或自动 BBS 访问能力。

本阶段不实现编辑器、SPLORE、公共 cart 镜像、crawler、`save/folder/ls/resume/reboot/info/serial`
或非 Chrome 浏览器。BBS adapter 是条件 work unit，不是 core exit gate；nested suspension 在 5F
作独立决定，在此之前继续遵守 ADR-017。

## Stable inputs

- [ADR-018 caller-authorized resolution](../adr/018-caller-authorized-cart-resolution.md)
- [Runtime CartLoader / resource boundary](../04-typescript-runtime.md#54-cartloader-与资源边界)
- [Runtime load / reload / cstore transaction](../04-typescript-runtime.md#13-loadreloadcstore-与-cart-swap)
- [Bridge nested coroutine boundary](../03-z8lua-wasm-bridge.md#44-nested-coroutine-陷阱)
- [Package ownership](../08-source-layout-and-boundaries.md#2-package-职责)
- [Composition roots](../08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期)
- [Compatibility DoD](../06-testing-compatibility.md#16-definition-of-done)
- [Phase 5 project corpus](../../tests/conformance/manifests/phase-5-l3-corpus.json)

## Work units

| Unit | 状态 | 结果或入口 |
| --- | --- | --- |
| 5A Activation / Capability / Corpus | Complete | ADR-018、机器合同、6-case 原创 corpus、BBS Deferred |
| 5B CartLoader / Resolver / Repository | Complete | browser-neutral ports、local bundle resolver、identity repository |
| 5C Root HostRequest Pipeline | Complete | bounded async root suspension、generation/request race gate |
| 5D Guest `load()` / Atomic Cart Swap | Complete | versioned guest request、staged session、replacement handshake |
| 5E External `reload/cstore` | Complete | versioned request、调用点 snapshot、resume-before-RAM |
| 5F Coroutine / L3 Compatibility | Complete | ADR-019、28-case matrix、accepted root-only |
| 5G Optional BBS Adapter | Complete | ADR-020；Deferred，无 production network capability |
| 5H L3 Exit / Resource Gate | **Active** | 下节；aggregate exit |

## 5A closure

5A 已冻结 caller-authorized local bundle、四个 access bits、资源上限、原创 corpus、Terms 复核和
Phase 4 hash baseline。BBS 自动访问明确 Deferred；nested HostRequest 保持 root-only。验证入口是
`pnpm run test:phase-5a`。

## 5B closure

5B 已发布 browser-neutral `CartResolverPort`/`CartRepositoryPort`、runtime-neutral cancellation、
防御式 `CartLoader`、caller-owned local bundle adapter，以及保持 Phase 3 COW 兼容的 parsed-cart
identity cache。ref/capability/input 上限在 adapter 与 loader 双重检查，stale completion、copy
ownership、64-entry limit、disposed 和无网络能力均由 `pnpm run test:phase-5b` 覆盖。

## 5C closure

5C 已发布 4096-byte `RootHostRequestHandlerPort`、production `waiting-host` 状态和非阻塞 Worker
background completion sink。root boot/step continuation 保留 instruction accounting；generation、request
ID、oversize、error、cancel/late result 与 nested policy 由 real-WASM Node tests 和 Chrome module Worker
共同覆盖。Phase 4 evidence 字节保持 immutable；其历史源码/artifact 哈希不再与持续演进的 Phase 5
工作树做 live 比较。验证入口是 `pnpm run test:phase-5c` 与 `pnpm run test:phase-5c:chrome`。

## 5D closure

5D 已把 z8lua `load(ref,breadcrumb?,param?)` 注册为 `P8WL` version 1、最大 4096-byte 的
root-only copied request。Worker 只通过 caller-authorized bundle 和 `CartLoader` staging fresh
`CartSession`；target boot 成功后先发布严格 old→next replacement handshake，再开放新 generation
的 state/frame/audio/input。Main 拒绝 stale/missing target handshake，并同步重置 presenter、audio、input
和 pending request ownership。callback/custom、`stat(6)`、breadcrumb、missing/denied/nested/cancel 与
old-continuation non-return 已由 real-WASM Node 和 Chrome 门禁覆盖。验证入口是
`pnpm run test:phase-5d` 与 `pnpm run test:phase-5d:chrome`。

## 5E closure

5E 已把显式 external ref 编码为 `P8WD` version 1 copied request；无 ref 的 current-cart
`reload/cstore` 继续同步执行。Worker 通过 `CartLoader` 的 `reloadData/cstoreData` capability
解析 target，`reload` 在 continuation 前写 suspended logical RAM，`cstore` 在 API 调用点 snapshot
RAM 后只提交 identity-scoped Worker COW overlay。generation 不变、无 replacement handshake；range、
denied、nested、cancel/late completion 与 current-cart 回归由 Node real-WASM 和 Chrome production
Worker 覆盖。历史 Phase 3/4 current-cart tests 只移除“external 永久 unsupported”的 live 假设，原同步
行为与 evidence 不改写。验证入口是 `pnpm run test:phase-5e` 与
`pnpm run test:phase-5e:chrome`。

## 5F closure

5F 的 real-WASM spike 证明 plain guest yield/continuation 只返回直接 `coresume()`，没有自然 root
bubbling。Node 与 Chrome production Worker 的 28-case matrix 覆盖 7 个 suspension surface、
callback/custom 与 single/multi-level nesting，全部统一得到不可被 `pcall/coresume` 吞掉的
`E_FEATURE_UNSUPPORTED` / `nested-host-suspend`。host handler、waiting-host、external overlay、
session replacement、frame、runtime control、audio 和 persistence side effect 均为 0；instruction
budget 继续跨 guest coroutine 继承，fault 后 fresh session 可恢复。ADR-019 因此接受
`accepted-root-only`，不修改 production WASM；project corpus lane 在 Node/Chrome 均为 C3。验证入口是
`pnpm run test:phase-5f` 与 `pnpm run test:phase-5f:chrome`。

## 5G closure

5G 于 2026-08-06 复核更新于 2026-06-22 的 Lexaloffle Terms、PICO-8 v0.2.7 手册和官方
resources 页面。Terms 要求自动第三方访问取得 Lexaloffle 与相关作者许可；官方材料没有提供稳定、
有文档的第三方 cart-download API。ADR-020 因此选择唯一结论 `deferred`：不新增 adapter、endpoint、
transport 或第三方 bytes，production network capability 不变，BBS 仍不是 L3 exit gate。验证入口是
`pnpm run test:phase-5g`。

## Active work unit：5H L3 Exit / Resource Gate

### Observable behavior

1. 用同一份 6-lane 项目原创 corpus 在 Node real-WASM 与 Chrome production Worker 路径运行；逐 case
   固化 C0–C3 分类、关键 observable 和 cross-path agreement。CU 不得进入最终 denominator。
2. 运行 100 次连续 guest cart swap，交替 callback/custom launch，并穿插 local external
   `reload/cstore`；每次 old→next generation、replacement handshake 和 target identity 必须精确一次。
3. Chrome 执行至少 1800 秒 mixed soak，覆盖 callback/custom、load、reload、cstore、resolver failure、
   cancellation、late completion、staged boot failure 与 fresh recovery。测试只使用逻辑时间驱动的原创
   cart，不访问网络或第三方资源。
4. 全程 stale frame/audio/input/request/persistence commit 为 0；pending request、Worker、RAF、DOM
   listener、audio source 和 overlay/session ownership 在 replace/fault/dispose 后全部释放。
5. WASM 固定 16 MiB 且不增长，Lua heap 使用已冻结的 1 MiB 默认值；soak 后 heap/resource delta 必须
   满足既有 Phase 4 resource gate，不得通过扩大上限关闭问题。
6. 生成 hash-locked aggregate exit manifest 和 immutable Phase 5 evidence；发布声明只覆盖
   `PICO-8 v0.2.7 L3 local/multicart project profile on Chrome/Chromium desktop`，BBS/第三方兼容率、
   official bit-exact 和非 Chrome 浏览器均不在声明中。

### Allowed files

精确允许路径由机器合同 `workUnits.5H.allowedPaths` 控制。5H 是 aggregate/evidence work unit，不得修改
RuntimeCore、WASM、production Worker、cart codec、persistence schema 或 network boundary。若 exit runner
发现 production defect，停止 5H、记录问题，并先激活独立修复 work unit；不得把功能修复混入退出证据。

### Proposed tests（5H 实现时加入 package scripts）

- `pnpm run test:phase-5h`
- `pnpm run test:phase-5h:chrome`
- `pnpm run evidence:phase-5h`（唯一允许写入 tracked result/evidence 的显式入口）
- `pnpm run verify`

### Exit gate

- 6/6 project lanes 都有最终分类，playable rate ≥ 95%，Node/Chrome 分类与 cross-oracle 一致。
- 100 cart swaps 和 1800 秒 Chrome mixed soak 达标，stale commits、steady faults、开放 P0/P1 均为 0。
- cancellation/fault/recovery 后资源释放；固定 WASM/Lua 上限和 Phase 4 heap/resource budget 不回退。
- aggregate manifest 锁定 input/result/runtime hashes；evidence 记录环境、命令、时长、限制与已知差异。
- 全量 `pnpm run verify` 通过；机器合同关闭 5H/Phase 5，active/next unit 均为 null，并独立提交。

## Phase exit gate

Phase 5H 必须证明项目原创 L3 corpus 在 Node real-WASM 与 Chrome production path 一致；完成
100 次 cart swap、1800 秒 mixed soak、request race/fault recovery 和资源释放；stale frame/audio/
input/request/persistence commit 为 0，开放 P0/P1 为 0。公开声明不包含 BBS/第三方成功率。
