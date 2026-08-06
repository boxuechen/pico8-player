# Phase 6 — Real-cart Qualification 完成证据

> 状态：Complete
> 目标：local real-cart qualification for the PICO-8 v0.2.7 L3 project profile on Chrome/Chromium desktop
> 浏览器门禁：Google Chrome / Chromium desktop only
> 内容边界：只发布 aggregate 与 project-owned artifacts；不发布第三方 cart 身份、hash、路径、截图或逐-cart 结果

## 0. 完成结论与声明边界

Phase 6A–6H 已完成并关闭机器合同。12 个 caller-supplied local case 均获得 C* disposition；其中
11 个属于 v0.2.7 target 且全部完成 production Chrome fixed smoke trace，1 个 future-version case
按 parser version gate 明确置于 profile 外。3 个代表 case 完成 C2 手工门禁：2 个走完关键流程，
1 个完成 900 秒、27000 logical-frame duration gate；开放 P0/P1 为 `0/0`。

这些结果只证明本地 qualification 执行及其 aggregate，不构成第三方/BBS 兼容率、逐-cart 成功
声明、官方 bit-exact 声明或网络/BBS adapter 能力。仓库未跟踪第三方 cart bytes、截图、本机路径、
cart hash 或逐-cart observation；公开 denominator 贡献为 `0`。

## 1. Work-unit closure

| Unit | 完成结果 | 主要 gate |
| --- | --- | --- |
| 6A | local-only corpus policy 与 Phase 5 baseline | provenance / no-network |
| 6B | fail-closed schema、validator 与 path-redacted report | bounds / redaction |
| 6C | 12-case Chrome baseline 与 cluster triage | fixed trace / local-only |
| 6D | legacy `stat(20)` channel-0 note query | real-WASM / Chrome |
| 6E | VM-local `menuitem()` registration | lifecycle / GC / boundary |
| 6F | root-safe implicit frame slicing | ADR-022 / hard cap / recovery |
| 6G | global `unpack`、26 个 raw P8SCII globals、3-case C2 | language / playability |
| 6H | aggregate-only exit、evidence 与 documentation closure | privacy / full verify |

6H machine manifest：
[`phase-6h-exit.json`](../../../tests/conformance/manifests/phase-6h-exit.json)，SHA-256
`4a7d38eee00f9f57859c997dbe70fb6fdba462e62770b8188885316c3d53feba`。

## 2. 受理输入与 hash lock

| Project-owned input | SHA-256 |
| --- | --- |
| ADR-021 | `b8404e73062b2a40715c896a1f3453e1a417abf2b96cfd20a75bb934e145c658` |
| ADR-022 | `a2e8c0b71cbba2d0984337df792142ef3f8963dff13d064c18b26f991222738e` |
| `packages/runtime-core/src/audio/sfx-synth.ts` | `f12167b2277cea509360f4f418c526274cc23b5ed84406a7693ce7ed21a1b9ba` |
| local observation schema | `db8a02333f8329e34bb26bb36b23983f4bbbe510eaf6d81de3cd0e4c78fa795a` |
| local qualification validator | `31b726b77f2bb7993db522ee33aeade5b51cbc20c5c97cbeabcfdb557161e7ad` |
| `wasm/bridge/p8w_frame_runtime.cpp` | `7af8d9841840e2749567b8d20be865f93031e2396bfc044e9bbba24af91d8ff1` |
| `wasm/bridge/p8w_pico8_compat.cpp` | `ba1d1e7f953ea782a3a61eb5c6607e4ee7c9b7b00436cec07e89ab8b58268723` |
| runtime manifest | `be1d279baeecc3792aae3804d613ee12f21edab7dcfcc7079292ac4730dd43da` |
| Phase 6D regression | `0fb3a74cdc0d5260aff07337f93cc690acae1d4ea110c3c1c4afa5c992e5f067` |
| Phase 6E regression | `fc36d6d5cc712425bbae2ec63d94878bd100d877d7819c103034a576ea8a9ce5` |
| Phase 6F regression | `347895d85d24650a1b774d204c2af8245d36c59b2112835a0ed380159b80b352` |
| Phase 6G regression | `1b6081b03483186cf6558a8730345cc62d62f194974492418ee2f4c726bab688` |

本地 playability evidence 只以脱敏 SHA-256
`55f5f8cbf6a53516f3f4c5e810b0cda2c1102812a3fa49565c10a5499a31da1c` 绑定；其内容保持
gitignored，不进入 published artifact。

## 3. Aggregate qualification

| 指标 | 结果 |
| --- | --- |
| Local cases / classified | `12 / 12` |
| Aggregate C0 / C1 / C2 / C3 / CU | `1 / 0 / 3 / 0 / 8` |
| In-profile fixed smoke | `11/11` boots，`120` ticks/case |
| Out-of-profile | `1` future-version disposition |
| Manual C2 | `3`：critical-flow `2`，duration `1` |
| Duration gate | `900 s` / `27000` logical frames |
| Open P0 / P1 | `0 / 0` |
| Public denominator contribution | `0` |

这里的 C* counts 是 exit completeness 所需 aggregate，不是公开兼容率；`CU` 只表示未完成 C2/C3
可玩性证明，不能由 fixed-trace boot 自动提升。任何第三方逐-cart 结论仍只能在本地 ignored report
中审阅。

## 4. 关闭的兼容 cluster

- `stat(20)` 从 authoritative `PicoSfxSynth` 读取 channel-0 current note，inactive 返回 `-1`。
- `menuitem()` 在当前 `lua_State` 内持有 5 个 registration slot，replacement/removal/GC 生命周期明确。
- top-level custom loop 按 133333 guest instructions 产生 root-safe implicit 30 Hz frame，同时保留
  1000000 条 hard safety cap、transaction 和 fresh-generation recovery。
- VM 全局 `unpack` 覆盖默认/显式范围、空范围、nil hole 与多返回值；26 个 P8SCII source globals
  使用单 raw-byte 名称和官方 Q16.16 bit pattern。
- production runtime WASM SHA-256 为
  `747bb6ae2d4fbe9bfff14ec90e5193826f181ff0068c2d00c34859f89bd341b9`；最终 Chrome 为
  Google Chrome 150.0.7871.189。

## 5. Known Differences 与 scope

Phase 6 继续发布 `P4-KD-02`、`P4-KD-03`、`P4-KD-05`、`P4-KD-06`、`P5-KD-01`，并新增：

- `P6-KD-01`：`menuitem()` 只有 VM-local registration；player pause-menu UI/callback invocation 未实现。
- `P6-KD-02`：guest-created coroutine 的 implicit quantum 只在返回 Runtime-owned root 后提交帧；不返回
  则命中 hard cap。

BBS crawler、自动 cart 下载、公共镜像、第三方内容分发、任意 URL、Firefox/WebKit 和 cart-specific
runtime hacks 继续排除。Phase 6 没有修改 parser future-version gate，也没有新增 network capability。

## 6. 可复现命令

```text
pnpm run test:phase-6h
pnpm run test:phase-6g
pnpm run test:phase-6g:chrome
pnpm run test:architecture
pnpm run verify
```

外部 12-cart rerun 和 3-case manual review 需要 caller-supplied ignored corpus，不属于 CI 或公开
artifact。普通 `verify` 只使用 project-authored regression；Phase 6 关闭后，本 evidence 与 6H
manifest 不随后续普通功能任务重写。
