# Phase 3 — Audio、Input 与 Persistence 完成证据

> 状态：Complete
> 阶段输入基线：Phase 2 exit，contract baseline commit `e130db0`
> 目标：PICO-8 v0.2.7 Phase 3 project profile
> 浏览器门禁：Google Chrome / Chromium desktop only
> 资产策略：project-authored only；无 BBS、第三方或 `ref/` test dependency

## 0. 完成结论

Phase 3A–3H 已完成并关闭机器合同。RuntimeCore 现在拥有 deterministic SFX/music/P8SCII
audio、八玩家 controller 与 input-only devkit 状态、同步 cartdata mirror 和 current-cart
`reload/cstore`；浏览器 adapter 继续分别拥有 keyboard/Gamepad/touch/mouse、AudioWorklet 和
IndexedDB。生产边界未因 Phase exit 测试而扩大。

两个项目原创 cart 在 Node real-WASM fresh/reset/reload 与 Chrome production Worker 路径得到
一致的 screen/palette oracle；Node 另外锁定 canonical PCM、input/live-RAM 和 cartdata/overlay
trace。Chrome 真实 Canvas、AudioWorklet、IndexedDB、60 秒 soak、fault/recovery 和 dispose
门禁通过。Phase 3 exit 开放 P0/P1 为 `0`。

本结论不表示 official audio bit-exact、第三方/BBS cart compatibility、guest `load()`、外部
filename/ref、multi-cart、完整 `stat()`、CPU-cost calibration 或 Firefox/WebKit 支持。

## 1. Work-unit closure

| Unit | 完成结果 | 主要 gate |
| --- | --- | --- |
| 3A Deterministic SFX Core | 4-channel live-RAM synth、22050Hz canonical PCM、`sfx()` | real-WASM sample/hash/reset |
| 3B Music / Browser Audio | `music()`、P8SCII audio、dedicated PCM、44.1/48kHz Worklet | Node audio golden + trusted Chrome output |
| 3C Controller Input | 8-player `btn/btnp`、keyboard/Gamepad/touch | deterministic replay + Chrome lifecycle |
| 3D Devkit Input | input-only `stat()`、key FIFO、mouse/wheel/pointer lock | real-WASM mixed return + trusted Chrome input |
| 3E Cartdata Core | `cartdata/dget/dset`、256-byte mirror、committed dirty snapshot | transaction/fault/reset golden |
| 3F IndexedDB Persistence | preboot hydrate、coalesced commit、flush/migration/fallback | fake-port + Chrome durable lifecycle |
| 3G Current-cart Storage | current-cart `reload/cstore`、identity COW overlay、range/ref fail closed | real-WASM + Chrome reset/isolation |
| 3H Conformance / Exit | 原创组合 corpus、Node/Chrome cross-oracle、性能/soak/recovery | aggregate exit gate + immutable evidence |

稳定接口与完整数值由
[`phase-3-audio-input-persistence-contract.json`](../../../spec/phase-3-audio-input-persistence-contract.json)、
[`phase-3h-exit.json`](../../../tests/conformance/manifests/phase-3h-exit.json) 和 runtime/ABI
manifests 锁定。

## 2. Project-owned conformance matrix

两个正常 cart 和一个 fault cart 均为仓库原创源码；没有下载或提交 BBS/第三方 cart，也不从
`ref/` 或被测实现动态导入 oracle。

| Case | 组合覆盖 | Cart / primary trace SHA-256 | Screen/overlay result | Result |
| --- | --- | --- | --- | --- |
| `phase-3/audio-input` | SFX/music、canonical PCM、P0/P1 controller、devkit key/mouse/wheel/movement、RAM/screen/palette | `e9119c48…abf0` / PCM `33508201…8c0b` / input-RAM `377faf11…a077` | final screen `10a3f93d…4377`，fresh/reset exact | Pass |
| `phase-3/persistence-overlay` | cartdata/dget/dset、IndexedDB、reload/cstore、reset/同 identity | `583dd2e9…aadc` | overlay `21→22→23`；三代 screen hash 与 Node/Chrome exact | Pass |
| `phase-3/host-api-fault` | code-range `cstore` fault、audio reset、fresh recovery | `445018db…5ee` | structured `E_HOST_API` | Pass |

这里的 exact 只描述 project oracle 的 byte/hash equality，不授予 official-exact/C3，也不进入
第三方 playable rate。

## 3. Chrome device gate

Reviewed run 环境：

- Google Chrome `150.0.7871.189`，HeadlessChrome production Module Worker。
- macOS `darwin 25.5.0`，Apple M4 Pro，arm64，14 logical CPUs。
- Raw result：[`chromium-macos-arm64-phase-3-exit.json`](../../../benchmarks/phase-3/results/chromium-macos-arm64-phase-3-exit.json)
  （SHA-256 `d69cf16c78d622c0000e56e34584508d1b68649f7fa7e1df878302e13ac623d6`）。

| Gate | Reviewed result |
| --- | --- |
| Deterministic Worker | audio/input initial+reset 与 persistence/overlay generation `1→2→3` 的 screen/palette 全部与 Node oracle 一致 |
| Representative performance | 两个 case 各 20 warm-up + 120 measured；最大 p95 `0.4001ms`，`>16.67ms` 为 `0/240` |
| Trusted device audio/input | 48kHz AudioContext 由 trusted gesture 解锁；keyboard P0/P1、devkit key/mouse/wheel 进入真实 controller/Worker/Canvas |
| 60 秒 bounded soak | `60.0088s`、`3603` runtime frames；计量窗口 startup/steady underrun 增量 `0/0`；steady underrun、overrun、drop、discontinuity、stale chunk 均 `0` |
| Fault/recovery | `E_HOST_API` contained；Worklet queue 清零；generation `2→3`；fresh valid cart rendered |
| Persistence fallback | schema 1 / 256 bytes durable；reset hydrate；store removal 后 `E_PERSISTENCE_WRITE` 可见且 simulation 保持 `paused`、未 fault |
| Resource lifecycle | production Workers created/terminated `6/6`；AudioContext `closed`；Worker errors `0` |

AudioWorklet 在正式 soak baseline 之前记录了 startup underrun `170`；该值作为启动期事件原样
保留，未纳入或豁免稳态窗口。prebuffer、unlock 与 input checkpoint 完成后的 60 秒窗口没有新增
startup/steady underrun，最终 steady underrun 为 `0`。

## 4. Recovery 与 compatibility conclusion

- Node production controller 证明 host fault 后 audio queue reset、旧 generation input/work 拒绝、
  fresh valid cart 恢复，以及 persistence read/write failure 可见但非致命。
- project-profile SFX/music、controller/devkit input、cartdata/IndexedDB 和 current-cart-only
  `reload/cstore` 标记为 `compatible`；official exact 仍为 `unknown`。
- canonical PCM/golden 是项目确定性 oracle，不是官方音频硬件规格或 bit-exact 声明。
- guest `load()`、外部 filename/ref、BBS/network/multicart 保持 `unsupported`/Deferred；
  current-cart overlay 仅在 Worker lifetime 内存在，不写回 caller 文件或 IndexedDB。
- Chrome/Chromium 是唯一浏览器 gate；Firefox/WebKit、Android release 和 Phase 4 corpus/CPU
  calibration 不属于本阶段。

## 5. 可复现命令

```text
pnpm run test:phase-3h
pnpm run test:phase-3h:chrome
pnpm run test:browser:chromium
pnpm run evidence:phase-3h
pnpm run verify
```

`evidence:phase-3h` 显式更新 reviewed raw result；普通 `test:phase-3h` 只写 gitignored smoke
artifact。Phase 3 关闭后，本文件和 reviewed raw result 不随普通功能任务重写。
