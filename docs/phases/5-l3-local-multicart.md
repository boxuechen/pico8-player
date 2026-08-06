# Phase 5 — L3 Local / Multicart

> 状态：Active；5A–5D complete，5E active
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
| 5E External `reload/cstore` | **Active** | 下节 |
| 5F Coroutine / L3 Compatibility | Pending | 5E exit 后展开 |
| 5G Optional BBS Adapter | Pending | 条件 work unit；允许 Rejected/Deferred 结论 |
| 5H L3 Exit / Resource Gate | Pending | aggregate exit |

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

## Active work unit：5E External `reload/cstore`

### Observable behavior

1. 无 external ref 的 `reload/cstore` 继续走现有同步 current-cart path；显式非当前 ref 产生独立
   versioned copied request，并保持同一 Worker/session/runtime generation，不触发 cart swap handshake。
2. z8lua 在 root active coroutine 的 API 调用点 suspension；request 只携带 operation、presence/range 与
   canonical ref，最大 4096 bytes。nested call 仍按 5F 前 policy fail closed。
3. Worker 通过现有 `CartLoader` 解析 bundle target：`reload` 必须检查 `access.reloadData`，`cstore`
   必须检查 `access.cstoreData`；不得回退到 URL、文件系统、BBS 或按扩展名推断权限。
4. `reload` 的 target data/overlay bytes 必须在 guest continuation 前写入 suspended VM RAM；不能用
   下一帧延迟 copy 模拟同步 API。范围是 Base RAM 64 KiB 与 cart data ROM `0..0x42ff` 的交集规则。
5. `cstore` 在调用边界 snapshot Base RAM source，resolution 完成后只写 target identity 的 Worker-local
   copy-on-write overlay；不覆写调用方原始 cart bytes，不进入 5F/5G/持久化扩展。
6. resolve/decode/capability/range/cancel/generation 失败不得 partial write；late completion 不恢复 stale
   coroutine。每 execution 最多写 64 个 external target identities。
7. project corpus 的 external reload 与 cstore→reload lanes 在 Node real-WASM 和 Chrome production
   Worker 一致；logical time、frame/audio/input ownership 在 waiting-host 期间不前进。

### Allowed files

精确允许路径由机器合同 `workUnits.5E.allowedPaths` 控制。production owner 限于 external cart-data
request、suspended RAM access、identity overlay 与 Worker continuation orchestration；不得修改
graphics/audio/input algorithms、Main transport generation、IndexedDB schema 或 BBS scope。

### Proposed tests（5E 实现时加入 package scripts）

- `pnpm run test:phase-5e`
- `pnpm run test:phase-5e:chrome`
- `pnpm run test:architecture`
- production/public contract 发生变化时最终运行 `pnpm run verify`

### Exit gate

- current-cart synchronous regression 与 external root suspension 同时通过。
- external reload 先 apply RAM、external cstore 使用调用点 snapshot，并遵守 target capability/range/64-target limit。
- failure/cancel/late result 无 partial overlay、stale resume、generation change 或 hidden I/O。
- Node/Chrome corpus oracle 一致；5E 结果折叠入机器合同，5F 成为唯一 active work unit并独立提交。

## Phase exit gate

Phase 5H 必须证明项目原创 L3 corpus 在 Node real-WASM 与 Chrome production path 一致；完成
100 次 cart swap、1800 秒 mixed soak、request race/fault recovery 和资源释放；stale frame/audio/
input/request/persistence commit 为 0，开放 P0/P1 为 0。公开声明不包含 BBS/第三方成功率。
