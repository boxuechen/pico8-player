# Phase 5 — L3 Local / Multicart

> 状态：Active；5A–5E complete，5F active
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
| 5F Coroutine / L3 Compatibility | **Active** | 下节 |
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

## 5E closure

5E 已把显式 external ref 编码为 `P8WD` version 1 copied request；无 ref 的 current-cart
`reload/cstore` 继续同步执行。Worker 通过 `CartLoader` 的 `reloadData/cstoreData` capability
解析 target，`reload` 在 continuation 前写 suspended logical RAM，`cstore` 在 API 调用点 snapshot
RAM 后只提交 identity-scoped Worker COW overlay。generation 不变、无 replacement handshake；range、
denied、nested、cancel/late completion 与 current-cart 回归由 Node real-WASM 和 Chrome production
Worker 覆盖。历史 Phase 3/4 current-cart tests 只移除“external 永久 unsupported”的 live 假设，原同步
行为与 evidence 不改写。验证入口是 `pnpm run test:phase-5e` 与
`pnpm run test:phase-5e:chrome`。

## Active work unit：5F Coroutine / L3 Compatibility

### Observable behavior

1. 对 guest-created coroutine 中所有可 suspension surface 建立同一矩阵：`flip/run/stop/load`、external
   `reload/cstore` 与 diagnostic HostRequest；覆盖 callback、custom loop、single nested 与 multi-level nested。
2. 先用 pinned z8lua real-WASM spike 验证 direct-resumer ownership、continuation stack、instruction hook
   与 request side-effect count。不得用 Promise、Asyncify、同步 busy-wait 或 catchable Lua error 冒充 root bubbling。
3. 5F 必须作出一个显式结论：`supported-bubbling` 或 `accepted-root-only`。只有 Node/Chrome exact-once
   request、取消、budget 与 multi-level 恢复全部通过，并新增替代 ADR 时，才允许扩大 ADR-017；否则
   保持 `nested-host-suspend`，把它冻结为 L3 project profile 的 Known Difference。
4. 无论结论为何，nested call 都不得访问 resolver/repository、提交 overlay、替换 session、推进 logical
   time/frame/audio/input 或发布 stale output；guest `pcall/coresume` 不得吞掉结构化 host fault。
5. root callback/custom 的 `load/reload/cstore/flip` 已完成语义必须保持回归兼容；coroutine hook 继续
   继承统一 instruction budget，OOM/budget/fault 后不得原地恢复损坏的 VM。
6. project corpus 的 nested-suspension-policy lane 在 Node real-WASM 与 Chrome production Worker 得到相同
   classification，并在 inventory/Known Differences/机器合同中只保留一个公开结论。

### Allowed files

精确允许路径由机器合同 `workUnits.5F.allowedPaths` 控制。production 变更仅限 coroutine suspension、
fault containment 与对应 Worker orchestration；不得修改 graphics/audio/input 算法、Main transport、
persistence schema、cart resolver capability 或 BBS scope。若 spike 不满足扩大条件，不得留下半实现 bubbling。

### Proposed tests（5F 实现时加入 package scripts）

- `pnpm run test:phase-5f`
- `pnpm run test:phase-5f:chrome`
- `pnpm run test:architecture`
- production/public contract 发生变化时最终运行 `pnpm run verify`

### Exit gate

- suspension matrix 与 direct-resumer spike 有 machine-checkable Node/Chrome 结果。
- `supported-bubbling` 必须 exact-once、multi-level、budget/cancel 全通过并由替代 ADR 接受；否则结论必须是
  `accepted-root-only`，且所有 nested surface 统一、无外部 side effect。
- root behavior 与 Phase 5D/5E corpus 无回归，Chrome/Node classification 一致。
- 5F 结果折叠入机器合同，5G 成为唯一 active work unit并独立提交。

## Phase exit gate

Phase 5H 必须证明项目原创 L3 corpus 在 Node real-WASM 与 Chrome production path 一致；完成
100 次 cart swap、1800 秒 mixed soak、request race/fault recovery 和资源释放；stale frame/audio/
input/request/persistence commit 为 0，开放 P0/P1 为 0。公开声明不包含 BBS/第三方成功率。
