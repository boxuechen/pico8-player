# Phase 4 — L2 / MVP Compatibility Hardening 完成证据

> 状态：Complete
> 阶段输入基线：Phase 3 exit，contract baseline commit `73dc57e`
> 目标：PICO-8 v0.2.7 L2/MVP project profile
> 浏览器门禁：Google Chrome / Chromium desktop only
> 资产策略：project-authored only；无 BBS、第三方或 `ref/` test dependency

## 0. 完成结论与声明边界

Phase 4A–4H 已完成，机器合同关闭。可发布声明严格为：

> **PICO-8 v0.2.7 L2/MVP project profile on Chrome/Chromium desktop.**

它表示 7 个项目原创 corpus case 在 Node real-WASM 和 Chrome production path 均为 `C3`，
playable rate 为 `7/7 = 100%`；CPU、fixed-memory、30 分钟 Chrome long-run、多 cart lifecycle、
fault recovery 和 resource release 门禁通过。它不表示官方 bit-exact、任意第三方/BBS cart、
Firefox/WebKit/mobile、guest `load`、external resolver 或 multicart 已兼容。

112 项 API inventory 的最终 conformance 计数为 compatible/partial/unknown/unsupported
`68/5/29/10`。其中 5 项 required partial 已成为公开 Known Differences；28 项 required VM builtin
虽然已实现，但仍缺官方 edge conformance，作为 `P4-CL-01` accepted coverage limitation 明确排除
在 official-compatible/bit-exact 声明外。conditional `menuitem/printh/extcmd` 与 8 项 platform API
有明确 scope decision，不进入项目 corpus playable-rate 分母。

## 1. Work-unit closure

| Unit | 完成结果 | 主要 gate |
| --- | --- | --- |
| 4A Inventory / Corpus | 112 项四维 API inventory、7-case 原创 corpus、外部 cart 隔离 | machine contract + provenance/hash |
| 4B Runner / Baseline | Node/Chrome `C3=7`、playable `100%`、P0/P1 `0` | `phase4-l2-runner@1` cross-oracle |
| 4C P8 Lua/Core | 13 项 table/string/random/coroutine surface | real-WASM + Chrome exact project oracle |
| 4D Graphics/Memory/Text | 9 项 API、386-byte observation、scope decisions | Node/Chrome RAM/screen oracle |
| 4E System/Player | guest control、reset、stat/current-cart integration | Worker/Canvas/AudioWorklet/IndexedDB flow |
| 4F CPU/Scheduler | 4M VM inst/s Q16.16 cost、slow-frame 与 hard cap | 30/60/custom exact instruction trace |
| 4G Resources/Long-run | fixed memory、OOM/recovery、20-load lifecycle、1800 秒 soak | reviewed Chrome long-run artifact |
| 4H Exit | claim、Known Differences、coverage limitation、aggregate hash gate | `phase-4h-exit.json` + full verify |

4H machine manifest：
[`phase-4h-exit.json`](../../../tests/conformance/manifests/phase-4h-exit.json)，SHA-256
`974d496c1db81fff6d44d4838b2bdc2bda659161d620b6f8165eb24882ee98f8`。

受理输入的完整 SHA-256 锁如下；4H aggregate test 会逐项重算：

| 输入 | SHA-256 |
| --- | --- |
| `spec/pico-api-inventory.yaml` | `07832705a147a221cf85c2157a7e050db674e42e1e546f96ddf6c390f5561756` |
| `phase-4-l2-corpus.json` | `711561e8ed1280d602cb8368cd78d5efe8d8fa7bda13993199e3a4e30e2b6ff3` |
| `phase-4-issues.json` | `c6f79b57d6d8affc309c6a46eda5d7bdf80b1b2b5e9c455d36b609ee19559d91` |
| `phase-4-result.schema.json` | `d082678d9a19d5b85776dc0406d69286c992c5d8a4ff3afe04f030ef879eec2b` |
| `phase-4c-core-library.json` | `6639c6c2c88a23443265d9bc59d60d26c782685ad31e34935baea6ce4ee0039b` |
| `phase-4d-graphics-memory-text.json` | `5caf519d2d4b64c7df6794682f7a656f274500dfdff1cb6a0f881242b0ea254b` |
| `phase-4e-system-integration.json` | `76e75c454643de255e39cc5bb6473220edcd1cd4de8dd621a26aae1d5ae26a48` |
| `phase-4f-cpu-scheduler.json` | `bfc87a47f41226e2429f13f3f7c5c5986c7c9622b32971cb39e7def53cf5fa1d` |
| `phase-4g-resource-long-run.json` | `91fef7708ba4e179159ba5560ad71ca8038137cccdd419d9370021e0bd2a6b02` |
| Node L2 baseline | `3473d6f1cbd3ae034d7be92bc61c7f886dd074d066d55a6b421e110aceaf701d` |
| Chrome L2 baseline | `801460755de55c51e2bc4ee4e499ff217e7c2fd14e5d3b48a1a2be3477eb8c90` |
| Chrome 4G long-run | `f4f2b3197ef57bf8f5aa07b19480baaff8c322e798a27a7cd4f73ba7af6e8fab` |
| `wasm/runtime-v1.manifest.lock.json` | `c72542bd7882bc72436388ea3e83cddcf1420c48ad3a97f1f80c48a8e9eafd95` |

## 2. Project corpus 与兼容统计

Phase 4 corpus 是仓库内 7 个原创 case，覆盖 30/60Hz callback、custom `flip()`、`.p8.png`、
graphics/memory/map/text、audio/controller/devkit 以及 persistence/current-cart。Node real-WASM 与
Chrome production Worker/Canvas/AudioWorklet/IndexedDB 对每个 case 的 cross-oracle hash 一致。

| 指标 | 结果 |
| --- | --- |
| C0 / C1 / C2 / C3 / CU | `0 / 0 / 0 / 7 / 0` |
| Playable denominator / numerator | `7 / 7` |
| Playable rate | `100%`（门槛 `≥95%`） |
| Open P0 / P1 / P2 | `0 / 0 / 0` |
| Node reviewed result | SHA-256 `3473d6f1…01d` |
| Chrome reviewed result | SHA-256 `80146075…8c90` |

该分母不包含本地 external corpus、BBS 或第三方 cart；不能用 `100%` 推断这些 cart 的成功率。

## 3. Published Known Differences 与 coverage limitation

| ID | 用户可见差异 | 规避方式 |
| --- | --- | --- |
| `P4-KD-01` | nested coroutine 中的 `flip()` suspension unsupported | 只在 root custom loop 调用 `flip()` |
| `P4-KD-02` | `stat()` 只支持已公布 selector 子集 | 仅使用 `1,6,7,30,31,32,33,34,36,38,39` |
| `P4-KD-03` | timed P8SCII delay 不暂停 guest execution | 用 logical frame 驱动 timed text |
| `P4-KD-04` | `reload/cstore` 只支持 current-cart identity | 不使用 external filename/ref |
| `P4-KD-05` | fractional power edge 继承 z8lua floating 实现 | 不依赖该边界的 bit-exact 值 |
| `P4-KD-06` | advanced screen/bitplane modes 不在 MVP profile | 使用 standard packed 4bpp screen |

`P4-CL-01` 包含 28 个已实现、但未取得 official edge vectors 的 required builtin：
`pairs`、`max/min/mid/flr/ceil`、`cos/sin/atan2/sqrt/abs/sgn`、
`band/bor/bxor/bnot/shl/shr/lshr/rotl/rotr`、
`setmetatable/getmetatable/rawset/rawget/rawequal/rawlen/select`。
它们可被 runtime 调用，但当前只属于 z8lua/project baseline，不计作 official-compatible 或 bit-exact。

## 4. CPU、资源与 Chrome release gate

- CPU compatibility cost 使用 deterministic z8lua instruction count，参考 `4,000,000 inst/s`；
  raw Q16.16 大于 `65,536` 才标记 slow frame，默认 `1,000,000` instruction safety cap 独立。
- production 使用 fixed 16 MiB WASM、64 KiB Pico RAM、默认 1 MiB Lua heap；32 KiB diagnostic
  profile 返回含 live/limit bytes 的 `E_VM_OOM` 并可 fresh recovery。
- 受审 Chrome 150/macOS arm64 long-run：`1800.4173s`；30/60Hz 分别 `54,013/108,026` 帧，
  dropped tick、steady audio fault、long task、Worker error 均为 `0`。
- 20 次 sequential cart load、24 generations 的 stale frame/PCM/input probe 通过；3/3 Workers、
  3 AudioContexts、RAF/listener/queue 全部释放；CDP GC 后 main isolate retained heap `+2,776 B`。
- Raw long-run：
  [`chromium-macos-arm64-phase-4g-long-run.json`](../../../benchmarks/phase-4/results/chromium-macos-arm64-phase-4g-long-run.json)，
  SHA-256 `f4f2b3197ef57bf8f5aa07b19480baaff8c322e798a27a7cd4f73ba7af6e8fab`。

## 5. 可复现命令

```text
pnpm run test:phase-4h
pnpm run test:browser:chromium
pnpm run evidence:phase-4g
pnpm run verify
```

普通 `verify` 运行 Chrome smoke，并 hash-lock 受审 1800 秒 artifact；只有显式
`evidence:phase-4g` 会重新生成 30 分钟结果。Phase 4 关闭后，本文件、4H manifest 和 reviewed raw
artifacts 不随普通功能任务重写。
