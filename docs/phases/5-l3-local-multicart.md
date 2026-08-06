# Phase 5 — L3 Local / Multicart

> 状态：Active；5A–5F complete，5G active
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
| 5G Optional BBS Adapter | **Active** | 下节；条件 work unit，允许 Rejected/Deferred 结论 |
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

## Active work unit：5G Optional BBS Adapter Decision

### Observable behavior

1. 先复核当前 Lexaloffle Terms、官方 cart/BBS 资源接口与现有 caller-authorized boundary；在决定前
   禁止编写 production network adapter、下载或提交第三方 cart bytes。
2. 5G 必须在 ADR-020 中只选择一个结论：`implemented-opt-in`、`rejected` 或 `deferred`。BBS adapter
   不是 Phase 5 exit gate；证据不足、授权边界不清或 Terms 不允许时必须保持 Deferred/Rejected。
3. 只有 Terms 与技术接口都允许时才可选择 `implemented-opt-in`，且必须由 caller 显式启用、固定
   allowlisted Lexaloffle origin、限定 ref grammar/redirect/content-type/1 MiB bytes、支持 cancellation，
   并复用 `CartLoader` 的 decode/capability 二次检查。guest string 不能成为任意 URL 权限。
4. 无论结论为何，RuntimeCore、z8lua/WASM、cart codec、local bundle 默认路径与 ADR-018 都不得获得
   browser/network dependency；具体 adapter 只能位于 Worker app boundary 并由 composition root 注入。
5. 禁止 crawler、搜索/列表发现、登录态、cookie/session 复用、公共镜像、持久缓存和跨 origin fallback；
   BBS/第三方结果及 bytes 对 tracked corpus 和公开 playable-rate 分母贡献保持 0。
6. 若结论为 Deferred/Rejected，必须以 architecture/policy tests 证明 production source 没有新增网络
   capability，local 5B–5F gates 仍通过；不得为了“预留”留下不可达的半实现 adapter。

### Allowed files

精确允许路径由机器合同 `workUnits.5G.allowedPaths` 控制。只有选择 `implemented-opt-in` 才允许增加
Worker-owned adapter/transport；Deferred/Rejected 路径只修改 policy tests、ADR、compatibility 与机器
合同。不得修改 RuntimeCore、WASM、graphics/audio/input、persistence schema 或 tracked corpus。

### Proposed tests（5G 实现时加入 package scripts）

- `pnpm run test:phase-5g`
- 若实现 adapter：`pnpm run test:phase-5g:chrome`
- `pnpm run test:architecture`
- production/public contract 发生变化时最终运行 `pnpm run verify`

### Exit gate

- 当前 Terms 与接口依据、访问日期和结论进入 ADR-020；机器合同只保留一个 outcome。
- implemented 路径通过 allowlist、redirect/content-type/size、cancel/late result、generation 与 Chrome
  production tests；Deferred/Rejected 路径证明 production network surface 未增加。
- local bundle、root request、guest load、external data 与 nested-policy 回归无变化。
- tracked BBS/第三方 bytes 为 0，published denominator contribution 为 0。
- 5G 结果折叠入机器合同，5H 成为唯一 active work unit并独立提交。

## Phase exit gate

Phase 5H 必须证明项目原创 L3 corpus 在 Node real-WASM 与 Chrome production path 一致；完成
100 次 cart swap、1800 秒 mixed soak、request race/fault recovery 和资源释放；stale frame/audio/
input/request/persistence commit 为 0，开放 P0/P1 为 0。公开声明不包含 BBS/第三方成功率。
