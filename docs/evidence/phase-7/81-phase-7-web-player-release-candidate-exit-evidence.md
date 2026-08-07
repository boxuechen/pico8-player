# Phase 7 — Web Player Release Candidate 完成证据

> 状态：Complete
>
> 目标：PICO-8 v0.2.7 Web Player Release Candidate on desktop Chrome/Chromium
>
> 输入权限：caller-provided bytes 或 caller-authorized local bundle
>
> 发布边界：只生成本地、gitignored release artifact；未执行 npm、网站、GitHub Release 或其他外部发布

## 0. 完成结论与声明边界

Phase 7A–7H 已完成并关闭机器合同。player 现在提供 bytes-first embed API、可重复静态 artifact、
production DOM shell、VM-safe cart-defined pause menu、required API conformance closure，以及完整的
Chrome/Chromium desktop release hardening gate。当前 release profile 的 113 个 API inventory entry 为
`101 compatible / 3 partial / 9 unsupported / 0 unknown required`，开放 P0/P1 为 `0/0`。

这些结果只证明 project-owned regression、release artifact 与 Chrome/Chromium desktop gate，不构成
官方 bit-exact、BBS/第三方 cart 兼容率、移动端或非 Chrome 浏览器声明。player 不包含 BBS crawler、
任意 URL cart resolver 或 host-filesystem resolver。仓库及 exit manifest 不发布第三方 cart bytes、
身份、hash、本机路径、截图或逐-cart 结果。

## 1. Work-unit closure

| Unit | 完成结果 | 主要 gate |
| --- | --- | --- |
| 7A | RC profile、边界与 Phase 6 baseline 激活 | contract / no-publication |
| 7B | versioned bytes-first embed API 与多实例隔离 | Node / production Worker / Chrome |
| 7C | 12-file 可重复静态 artifact、6 个 stable keys | hashes / MIME / CSP / relative base |
| 7D | local choose/drop、控制、状态、fullscreen DOM shell | accessibility / lifecycle / Chrome |
| 7E | VM-local `menuitem()` invocation 与 pause menu | callback / generation / recovery |
| 7F | 28 个 required VM builtin 与 partial modes 定性 | real-WASM / inventory closure |
| 7G | release matrix、recovery fuzz、600 秒双 profile soak | Chrome hardening / teardown |
| 7H | aggregate exit、clean-checkout gate、文档与 evidence | reproducibility / privacy / full verify |

7H machine manifest：
[`phase-7h-exit.json`](../../../tests/conformance/manifests/phase-7h-exit.json)，SHA-256
`08d441d69cd0378ed7a88e01f6401d52bd4efce20d8a37ac608f20f0dc8a3365`。

## 2. Aggregate source locks

| Project-owned input | SHA-256 |
| --- | --- |
| Phase 7 contract | `90e5d793b65df93f7dc0077343511a421b131b2508d08e5f41cbf008f2a4cb4c` |
| Phase 7G Chrome hardening manifest | `6ac574d15b2b90dbdbabb70b5b96407180a9d1a8a5a0884d3be78f13ec1c5b16` |
| API inventory | `f7457766989c6a9a21e0531f2f5de23e726ac9b615fe8720ffbc922b00d638df` |
| runtime-v1 manifest lock | `ec3c5a88031021d5e30972bc9378c6580c4159691660ba6026ac146acf757098` |
| release artifact contract | `ed29245aa148b4b16f8ad57e08fe220fab8532e917a69bd2c26d6920d770414f` |

7G gate 的 10 个 source hash 由 7H manifest 逐项复核并绑定；普通后续任务不能在不重跑完整 RC gate
的情况下把它们静默替换。WASM、release artifact 与阶段合同之间的 provenance 由 generated manifest
和 aggregate manifest 共同闭合。

## 3. Release artifact

| 指标 | 结果 |
| --- | --- |
| Artifact files | `12`，exact allowlist |
| Stable keys | `main / worker / worklet / wasm / styles / demo` |
| Generated manifest SHA-256 | `37c62e119fa0a53c1fd96a26dc12d524a27c9189d2a8f59aae9827a4ff37ff17` |
| Main / Worker | `c523fe4507a9c7491f98e968f07df9cf1c4a4bae769a27ffcc81751ed9b7ce45` / `83e5b60fd2eeb9605de4c03bb49e105a651baf38a4049d7580071be3971d36e6` |
| Worklet / WASM | `fb535fecb5af527321fb94ada77dd2321ea463c22112a756ea0031d99fb8af1e` / `7dcd584a51ef504431fae47df11eb1a9a685efd6b1b2c372478f796766888fa8` |
| Styles / Demo | `50b799f1eb0c95ecefff3d1d8ac6eb5e13a11f90209a82fae54c58c4b28f3fcc` / `5762207e054277617cb02191eabebbe382a9ff794dd3ec2347b852cd9574abad` |
| Deployment | relative-base static HTTP；无需 cross-origin isolation |
| Cart authority | caller bytes/local bundle；zero network cart access |
| Publication | `false` |

构建使用 Node `22.22.x`、pnpm `10.8.0`、Emscripten `6.0.5` 与锁定的 esbuild `0.28.1`。
artifact 由 tracked source 重建且输出保持 gitignored；verifier 校验 content hash、byte length、MIME、
license、CSP、provenance、stable-key mapping 和 excluded path。

## 4. Chrome release hardening

最终完整 gate 运行于 `Google Chrome 151.0.7922.76`：

| Gate | 结果 |
| --- | --- |
| Desktop soak | `600.6033000001907 s` wall clock，30/60 Hz 并行 |
| 30 Hz | `18019` frames / `18019` ticks，cadence ratio `1.0000500052749337` |
| 60 Hz | `36037` frames / `36037` ticks，cadence ratio `1.0000222553996556` |
| Dropped ticks | `0` |
| Audio | underrun `0` / overrun `0` / discontinuity `0` |
| Main-thread long tasks | `0` |
| Measured retained heap delta | `-8500 bytes` |
| Recovery / fuzz | `20` forced Worker recoveries / `64` deterministic malformed inputs |
| Isolation | stale outputs `0` / external requests `0` / Worker errors `0` |
| Final teardown | Workers `3/3` terminated；RAF `0`；listeners `0`；AudioContexts all closed |

门禁同时覆盖 artifact MIME/fallback、strict CSP、nested relative base、44.1/48 kHz audio、persistence
failure、bfcache、visibility/blur、fullscreen、reduced motion、多实例和 fault recovery。10 秒 diagnostic
只用于定位，不能替代上述 600 秒完整 gate。

## 5. Compatibility profile 与 Known Differences

| Inventory disposition | 数量 |
| --- | ---: |
| compatible | 101 |
| partial | 3：`flip`、`stat`、`print` |
| unsupported | 9 |
| required unknown | 0 |

本 RC 继续明确发布以下差异：

- `P4-KD-02`：`stat()` 仅支持已列 selector subset。
- `P4-KD-03`：timed P8SCII delay control 不暂停 guest。
- `P4-KD-05`：fractional power edge 不承诺 official bit-exact。
- `P4-KD-06`：advanced screen/bitplane mode 超出 standard packed 4bpp profile。
- `P5-KD-01`：guest-created coroutine 中的 nested host suspension fail-closed。
- `P6-KD-02`：nested implicit quantum 延迟到 Runtime-owned root 返回后提交。

历史 `P6-KD-01` 已由 cart-defined menu invocation 关闭；PICO-8 system menu、编辑器、console、SPLORE
和导出工具仍不属于 player scope。

## 6. Clean-checkout release gate

7H 候选树在独立 detached clean checkout 中执行：

```text
pnpm install --offline --frozen-lockfile
pnpm run test:release
pnpm run verify
```

三项均通过；运行前后 tracked worktree 保持 clean。`test:release` 从 tracked source 重建 artifact、
执行 release verifier、7G 完整 Chrome gate和 7H aggregate exit tests。`pnpm run verify` 继续覆盖历史
architecture、codec、WASM、runtime、conformance 与 Chrome gates。命令只在本机生成 ignored output，
没有 registry、deployment 或 GitHub Release side effect。

Phase 7 关闭后，本 evidence 和 7H manifest 不随后续普通功能任务改写。任何 production 修改、兼容
口径扩展或外部发布都必须由新的 active phase 或用户明确授权承担。
