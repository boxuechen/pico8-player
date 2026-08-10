# Phase 13 — Mobile Host Ports

> 状态：Active
>
> Active work unit：13D — Focused Integration and Artifact Handoff
>
> 机器合同：[`spec/phase-13-mobile-host-ports-contract.json`](../../spec/phase-13-mobile-host-ports-contract.json)
>
> 浏览器门禁：Chrome/Chromium desktop only；移动端 WKWebView 由下游 Simulator 集成验证承担

## 目标与边界

把稳定 Embed API 从 v1 升级为 v2，使移动宿主无需读取 Web Player 内部模块即可提供原生输入、
原生 `cartdata()` 持久化和应用生命周期。默认 Web 使用仍保持完整 DOM shell 与 Worker IndexedDB；
宿主模式只替换公开 adapter，不把 Capacitor、文件系统或移动 UI 引入本仓库。

本阶段不改变 RuntimeCore 的 PICO-8 语义，不增加 Save State、网络 cart authority 或新浏览器支持，
不运行 external corpus、Top 200、historical matrix 或长 soak，也不执行任何远程发布。

## Stable inputs

- [`04-typescript-runtime.md#15-错误模型`](../04-typescript-runtime.md#15-错误模型)
- [`06-testing-compatibility.md#8-definition-of-done`](../06-testing-compatibility.md#8-definition-of-done)
- [`08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期`](../08-source-layout-and-boundaries.md#4-composition-roots-与实例生命周期)
- [`08-source-layout-and-boundaries.md#跨执行域-ownership`](../08-source-layout-and-boundaries.md#跨执行域-ownership)

## Work units

| Unit | 内容 | 状态 |
| --- | --- | --- |
| 13A | Active phase 与 API v2 机器合同 | Complete（`pnpm run test:phase-13a`） |
| 13B | Hosted shell 与外部标准化输入 | Complete（7 个 focused + 14 个 owner tests） |
| 13C | 宿主持久化、可等待 flush 与 lifecycle | Complete（6 个 focused + 16 个 architecture tests） |
| 13D | Focused Chrome、release artifact 与本地下游交接 | **Active** |
| 13E | Evidence 与阶段关闭 | Pending |

## Active work unit：13D

### Observable

- 生成 `0.2.0-alpha.1` / Embed API v2 自包含本地 integration artifact；manifest 明示 host ports。
- 一个项目自有最小 cart 在 focused Chrome 中完成 hosted shell、input、hydrate、commit、flush、background。
- artifact verifier 与 deterministic package 通过；不执行 external corpus、historical matrix 或长 soak。
- 产物只供 `pico8-mobile` 本地 vendoring，不发布、不 push。

### 允许文件

- `docs/phases/13-mobile-host-ports.md`
- `spec/phase-13-mobile-host-ports-contract.json`
- `spec/release-artifact-contract.json`
- `package.json`
- `apps/web-player/package.json`
- `CHANGELOG.md`
- `README.md`
- `docs/05-delivery-plan.md`
- `docs/06-testing-compatibility.md`
- `tools/release/portable-verify.mjs`
- `tools/release/release-artifact.mjs`
- `tests/artifact/phase-13d-mobile-host-artifact.test.mjs`
- `tests/browser/phase-13d.*`
- `tools/browser/run-phase-13d.mjs`
- `tools/benchmark/server.mjs`
- `tests/browser/phase-7b.mjs`
- `tools/browser/run-phase-7b.mjs`
- `package.json`

### Tests / Exit

```sh
pnpm run test:phase-13d
```

通过后 13E 成为唯一 active work unit。

## Phase exit gate

- Embed API v2 有 copy-owned 输入、hosted shell、宿主持久化、可等待 flush 和 lifecycle 契约测试。
- 默认 Web profile 的输入、IndexedDB、DOM shell 和 dispose 行为不回归。
- 一个项目自有 cart 通过 focused Chrome host-port flow；不执行外部兼容性语料。
- 生成可由 `pico8-mobile` 本地 vendoring 的自包含 release artifact，未发布、未 push。
- `pnpm test`、`pnpm run verify` 与 clean-worktree gate 通过；不运行 historical matrix 或长 soak。
- 归档 aggregate-only evidence，关闭机器合同并删除本 active phase 文档。
