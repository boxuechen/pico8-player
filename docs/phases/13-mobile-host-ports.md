# Phase 13 — Mobile Host Ports

> 状态：Active
>
> Active work unit：13B — Hosted Shell and External Input
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
| 13B | Hosted shell 与外部标准化输入 | **Active** |
| 13C | 宿主持久化、可等待 flush 与 lifecycle | Pending |
| 13D | Focused Chrome、release artifact 与本地下游交接 | Pending |
| 13E | Evidence 与阶段关闭 | Pending |

## Active work unit：13B

### Observable

- `createPico8WebPlayer({ shell: "hosted" })` 只呈现 playfield 与 runtime pause menu；完整 shell 仍是默认值。
- `setInput(snapshot)` 接受 copy-owned、固定 8 controller 的标准化快照，并与 DOM input 逐玩家按位合并。
- pause、stop、cart load、lifecycle clear 和 dispose 不保留宿主按键，避免 stuck input。
- Embed API 版本升级为 2；bytes-first cart authority 与默认完整 shell 不变。

### 允许文件

- `docs/phases/13-mobile-host-ports.md`
- `spec/phase-13-mobile-host-ports-contract.json`
- `apps/web-player/src/main/`
- `apps/web-player/public/player.css`
- `tests/runtime/phase-13b-hosted-input.test.mjs`
- `tests/runtime/phase-7b-embed-api.test.mjs`
- `package.json`

### Tests / Exit

```sh
pnpm run test:phase-13b
```

通过后 13C 成为唯一 active work unit。

## Phase exit gate

- Embed API v2 有 copy-owned 输入、hosted shell、宿主持久化、可等待 flush 和 lifecycle 契约测试。
- 默认 Web profile 的输入、IndexedDB、DOM shell 和 dispose 行为不回归。
- 一个项目自有 cart 通过 focused Chrome host-port flow；不执行外部兼容性语料。
- 生成可由 `pico8-mobile` 本地 vendoring 的自包含 release artifact，未发布、未 push。
- `pnpm test`、`pnpm run verify` 与 clean-worktree gate 通过；不运行 historical matrix 或长 soak。
- 归档 aggregate-only evidence，关闭机器合同并删除本 active phase 文档。
