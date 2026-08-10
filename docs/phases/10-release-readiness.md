# Phase 10 — Release Readiness

> 状态：Active
>
> Active work unit：10E — Local RC Assembly
>
> 机器合同：[`spec/phase-10-release-readiness-contract.json`](../../spec/phase-10-release-readiness-contract.json)
>
> 浏览器门禁：Chrome/Chromium desktop only

## 目标与边界

把当前高兼容度 Web Player 收口为可从 clean checkout 重建、校验和本地交付的
`0.1.0-rc.1` 静态 release candidate。发布单元是完整静态目录和确定性压缩包，不是 npm package。

本阶段不扩展 PICO-8 API 或浏览器范围，不读取完整 external corpus，不运行 historical matrix，
不自动访问 BBS，也不创建 remote、tag、GitHub Release、网站或其他外部发布。项目自有代码继续
`UNLICENSED`；本地候选必须明确不授予再分发许可，同时完整携带第三方 notices。

## Work units

| Unit | 内容 | 状态 |
| --- | --- | --- |
| 10A | Release Freeze / activation contract | Complete |
| 10B | Public metadata / license / notices | Complete |
| 10C | Versioned manifest / deterministic archive | Complete |
| 10D | Bounded release validation | Complete |
| 10E | Local RC assembly | **Active** |
| 10F | Evidence / local handoff / close | Pending |

## Active work unit：10E

### Observable

- release archive 内含 standalone Node verifier，不依赖 workspace package 或 repository-relative input。
- archive 解压到任意临时目录后，manifest allowlist、length 与 SHA-256 全部通过。
- verifier 对解压后任意文件 mutation fail-closed。
- release notes、manifest、archive filename 和 checksum 只标识同一个 `0.1.0-rc.1` 候选。

### 允许文件

- `tools/release/`
- `spec/release-artifact-contract.json`
- `tests/artifact/`
- `docs/`
- `package.json`
- `spec/phase-10-release-readiness-contract.json`

### 路由合同

- [`06-testing-compatibility.md#5-chrome-与-release-gate`](../06-testing-compatibility.md#5-chrome-与-release-gate)
- [`06-testing-compatibility.md#82-release`](../06-testing-compatibility.md#82-release)
- [`08-source-layout-and-boundaries.md#appsweb-player`](../08-source-layout-and-boundaries.md#appsweb-player)
- [`phases/README.md`](./README.md)

### Exit

```sh
pnpm run test:phase-10e
```

通过后 10F 成为唯一 active work unit。

## Phase exit gate

- release manifest、archive、checksums、LICENSE 与完整 notices 可由 clean checkout 重建。
- `pnpm run verify` 与 `pnpm run verify:release` 通过。
- 只运行项目自有 release fixtures；external full corpus、historical matrix 和长 soak 均为 0。
- open P0/P1 为 0，release artifact 不含 cart、截图、`ref/`、source map 或网络 cart authority。
- 创建 aggregate-only Phase 10 evidence，删除本 active phase 文档，恢复 `current phase: None`。
- 10F 只提交本地 Git；任何 remote/tag/publication 仍需用户另行授权。
