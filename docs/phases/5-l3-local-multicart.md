# Phase 5 — L3 Local / Multicart

> 状态：Active；5A–5B complete，5C active
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
| 5C Root HostRequest Pipeline | **Active** | 下节 |
| 5D Guest `load()` / Atomic Cart Swap | Pending | 5C exit 后展开 |
| 5E External `reload/cstore` | Pending | 5D exit 后展开 |
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

## Active work unit：5C Root HostRequest Pipeline

### Observable behavior

1. RuntimeCore/production Worker 使用 copy-owned root HostRequest envelope；payload/response 各最多
   4096 bytes，同一 session 同时最多一个 pending request。
2. production controller 遇到 root request 后暂停 scheduler 并进入可观察的 `waiting-host`；logical
   tick、frame、audio、input commit 在 completion 前不得推进。
3. injected consumer-owned handler 异步完成 success/error；completion 必须同时匹配 Worker generation、
   session generation 和 VM request ID，旧 load/reset/stop/dispose 会取消 pending handler。
4. runtime Worker 不因等待 handler 阻塞新 control command；late、duplicate、mismatched completion
   fail closed，不能提交 stale frame/audio/persistence 或恢复已替换 VM。
5. success continuation 必须回到原 boot/step transaction 并保留剩余 instruction budget；host error
   走结构化 fault，不允许无限保持 `waiting-host`。
6. 使用现有 real-WASM root probe 验证 production Node/Chrome path；nested request 继续固定为
   `nested-host-suspend`。本 unit 不注册 guest `load()`，不执行 cart swap 或 external data mutation。

### Allowed files

精确允许路径由机器合同 `workUnits.5C.allowedPaths` 控制。production owner 仅限 RuntimeCore
request port、Player Worker orchestration 与 versioned transport/client；5C 复用现有 z8lua root
HostRequest ABI，不修改 WASM、graphics/audio/input/persistence algorithm 或 worklet。

### Tests

- `pnpm run test:phase-5c`
- `pnpm run test:phase-5c:chrome`
- `pnpm run test:architecture`
- production/public contract 发生变化时最终运行 `pnpm run verify`

### Exit gate

- root boot/step suspension、success/error continuation、剩余 budget 与 nested policy 在 real WASM 通过。
- pending 时钟/音频/输入冻结；load/reset/stop/dispose race 的 stale commits 为 0。
- Node 与 Chrome production Worker 协议结果一致，RuntimeCore 仍无 browser global。
- 5C 结果折叠入机器合同，5D 成为唯一 active work unit，并独立提交。

## Phase exit gate

Phase 5H 必须证明项目原创 L3 corpus 在 Node real-WASM 与 Chrome production path 一致；完成
100 次 cart swap、1800 秒 mixed soak、request race/fault recovery 和资源释放；stale frame/audio/
input/request/persistence commit 为 0，开放 P0/P1 为 0。公开声明不包含 BBS/第三方成功率。
