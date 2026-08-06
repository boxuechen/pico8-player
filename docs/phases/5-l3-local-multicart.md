# Phase 5 — L3 Local / Multicart

> 状态：Active；5A–5C complete，5D active
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
| 5D Guest `load()` / Atomic Cart Swap | **Active** | 下节 |
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

## 5C closure

5C 已发布 4096-byte `RootHostRequestHandlerPort`、production `waiting-host` 状态和非阻塞 Worker
background completion sink。root boot/step continuation 保留 instruction accounting；generation、request
ID、oversize、error、cancel/late result 与 nested policy 由 real-WASM Node tests 和 Chrome module Worker
共同覆盖。Phase 4 evidence 字节保持 immutable；其历史源码/artifact 哈希不再与持续演进的 Phase 5
工作树做 live 比较。验证入口是 `pnpm run test:phase-5c` 与 `pnpm run test:phase-5c:chrome`。

## Active work unit：5D Guest `load()` / Atomic Cart Swap

### Observable behavior

1. z8lua 注册 PICO-8 `load(ref, breadcrumb?, param?)`，按 versioned copied byte payload 产生 root
   cart request；缺失/空 ref、payload 上限和 nested call fail closed，调用点之后的旧 cart code 不执行。
2. Worker 仅把该 request 交给 5B `CartLoader` 和 caller-authorized local bundle；必须检查 `access.load`，
   resolver failure/cancel 进入结构化 fault，不回退到任意 URL、文件系统或 BBS。
3. 成功 resolve/decode 后创建 fresh VM/router/runtime/RAM，按官方 startup 顺序 boot；staging 成功前
   不发布目标 frame/audio/input/persistence，旧 VM 绝不以 HostRequest continuation 恢复。
4. guest swap 分配精确下一个 Player session generation，并先发布 versioned replacement handshake；Main
   只接受 active Worker 的 old→next 单调替换，随后重置 presenter/audio/input request ownership。
5. `param` 以 copy-owned P8 byte string 暴露到目标 `stat(6)`；breadcrumb 只在 swap commit 后 push，
   failed/stale transaction 不修改 stack。目标 callback/custom-loop 均自动进入 running。
6. 解析、compile、boot、capability 或 generation 失败时销毁 staging 并 fault；旧 execution 已因
   `load()` 放弃，不能出现旧 VM + 新 RAM、旧 frame/audio 或隐式恢复。
7. 本 unit 不实现 external `reload/cstore`（5E）、nested suspension 扩展（5F）或 BBS adapter（5G）。

### Allowed files

精确允许路径由机器合同 `workUnits.5D.allowedPaths` 控制。production owner 限于 guest load request
ABI、RuntimeCore cart transaction、Worker loader/swap orchestration 和 versioned transport/client；不得
修改 graphics/audio/input algorithms、worklet、persistence storage、external data 或 BBS scope。

### Tests

- `pnpm run test:phase-5d`
- `pnpm run test:phase-5d:chrome`
- `pnpm run test:architecture`
- production/public contract 发生变化时最终运行 `pnpm run verify`

### Exit gate

- callback/custom target、`stat(6)` parameter、breadcrumb commit 与 old-code non-return 在 real WASM 通过。
- atomic staging、capability denial、resolver/compile/boot failure 和 repeated/cancel race 无 stale commit。
- Chrome replacement handshake 重置 frame/audio/input ownership，Node/Chrome oracle 一致。
- 5D 结果折叠入机器合同，5E 成为唯一 active work unit，并独立提交。

## Phase exit gate

Phase 5H 必须证明项目原创 L3 corpus 在 Node real-WASM 与 Chrome production path 一致；完成
100 次 cart swap、1800 秒 mixed soak、request race/fault recovery 和资源释放；stale frame/audio/
input/request/persistence commit 为 0，开放 P0/P1 为 0。公开声明不包含 BBS/第三方成功率。
