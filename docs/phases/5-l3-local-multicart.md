# Phase 5 — L3 Local / Multicart

> 状态：Active；5A complete，5B active
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
| 5B CartLoader / Resolver / Repository | **Active** | 下节 |
| 5C Root HostRequest Pipeline | Pending | 5B exit 后展开 |
| 5D Guest `load()` / Atomic Cart Swap | Pending | 5C exit 后展开 |
| 5E External `reload/cstore` | Pending | 5D exit 后展开 |
| 5F Coroutine / L3 Compatibility | Pending | 5E exit 后展开 |
| 5G Optional BBS Adapter | Pending | 条件 work unit；允许 Rejected/Deferred 结论 |
| 5H L3 Exit / Resource Gate | Pending | aggregate exit |

## 5A closure

5A 已冻结 caller-authorized local bundle、四个 access bits、资源上限、原创 corpus、Terms 复核和
Phase 4 hash baseline。BBS 自动访问明确 Deferred；nested HostRequest 保持 root-only。验证入口是
`pnpm run test:phase-5a`。

## Active work unit：5B CartLoader / Resolver / Repository

### Observable behavior

1. RuntimeCore public contract 使用 opaque ref、immutable `CartAccess`、copy-owned resolved bytes 和
   runtime-neutral cancellation；不能暴露 URL、File、AbortSignal 或 adapter object。
2. caller 提供的 local bundle 最多 64 项，ref 最多 256 bytes，单 cart 输入继续遵守 1 MiB codec cap。
3. local resolver 只读取构造时复制的 bundle entry；missing、duplicate、oversize、cancel 和 disposed
   状态 fail closed，不执行网络或目录查找。
4. repository 按 content identity 保存 parsed cart 与 data ROM/COW overlay；相同 identity 的内容冲突
   必须拒绝，所有 read/write 返回或接收 copy-owned bytes。
5. capability 由 caller/adapter 创建并在 port boundary 再验证；ref 文本和扩展名不能提升权限。
6. 本 work unit 不接通 VM HostRequest、guest `load()` 或 Worker wire protocol；这些属于 5C/5D。

### Allowed files

精确允许路径由机器合同 `workUnits.5B.allowedPaths` 控制。production owner 仅限 contracts、
RuntimeCore ports/cart loader 和 Worker local-bundle/repository adapters；不得修改 z8lua/WASM、
graphics/audio/input/persistence algorithm 或 main/worklet。

### Tests

- `pnpm run test:phase-5b`
- `pnpm run test:architecture`
- production/public contract 发生变化时最终运行 `pnpm run verify`

### Exit gate

- consumer-owned ports、local adapter、limits、copy ownership、capability denial 和 cancellation 测试通过。
- RuntimeCore/cart-codec 不出现 browser/network/storage global。
- 5B 结果折叠入机器合同，5C 成为唯一 active work unit，并独立提交。

## Phase exit gate

Phase 5H 必须证明项目原创 L3 corpus 在 Node real-WASM 与 Chrome production path 一致；完成
100 次 cart swap、1800 秒 mixed soak、request race/fault recovery 和资源释放；stale frame/audio/
input/request/persistence commit 为 0，开放 P0/P1 为 0。公开声明不包含 BBS/第三方成功率。
