# Phase 7 — Web Player Release Candidate

> 状态：Active
> Active work unit：7B — Stable Embed API
> 机器合同：[`spec/phase-7-web-player-release-candidate-contract.json`](../../spec/phase-7-web-player-release-candidate-contract.json)
> 基线：Phase 6 exit commit `117882a8bbd368ea8d8ebea2a2145d8f71152ec3`

## 1. 阶段目标

把已经通过 local real-cart qualification 的 Runtime 交付为可重复构建、可嵌入、可由普通静态
HTTP server 承载的 Chrome/Chromium desktop Web Player Release Candidate。Phase 7 只接受
caller-provided bytes 或 caller-authorized local bundle；不新增网络、BBS、任意 URL、宿主文件系统
或第三方内容分发能力，也不自动执行 npm、网站或 GitHub Release 发布。

Release Candidate 的 simulation、Pico RAM、scheduler、audio synthesis 和 persistence transaction
仍由 Worker 内的 RuntimeCore 所有。Window 只拥有 DOM shell、physical input mapping、Canvas presenter、
AudioContext 生命周期和稳定 embed facade；AudioWorklet 只拥有 device PCM queue。

## 2. 不可破坏边界

- RuntimeCore 保持 browser-neutral；不得引入 DOM、Canvas、Worker、AudioContext、IndexedDB、File 或
  `fetch()`。
- public API 是 bytes-first；文件选择和拖放只能在默认 DOM shell 把用户选择转换为 bytes。
- stable artifact key 是公开发现协议；生成文件名不是公共 API。
- `menuitem()` callback 和强引用保持 VM-local；跨边界只允许 copy-owned slot DTO、generation 和结构化
  outcome。
- DOM menu/HUD 不成为 simulation source of truth；Canvas 只绘制 128×128 playfield。
- cartdata 继续只经 persistence port 序列化；不得持久化 renderer、DOM、Worker 或 WASM object。
- `ref/`、local corpus、第三方 cart、截图和 playtest 输出不得进入 build、test fixture 或 release artifact。
- Chrome/Chromium desktop 是唯一 gate；不加入 Firefox/WebKit/Android scope。

## 3. 已完成：7A Activation / Release Contract

7A 已锁定 Phase 6 baseline hashes、release profile、artifact/embed contracts、compatibility baseline、
7A–7H 顺序和 RC exit gate。Activation 不修改 production code，不执行外部发布，也不改变当前已发布的
L3 local/multicart compatibility claim。

验证：`pnpm run test:phase-7a`。

## 4. 当前工作：7B Stable Embed API

### 4.1 范围内

- 在 `apps/web-player/src/main/` 建立单一 versioned public root。
- 暴露 bytes-first `create/loadCart/start/pause/resume/reset/stop/dispose` 和 typed event subscription。
- 保持现有 Worker protocol 为 app-owned transport；public consumer 不直接依赖 transport DTO。
- 串行化所有 mutating operations；明确重复调用、并发 load/dispose、fault 后 retry 和 idempotent dispose。
- 用 generation 和 listener teardown 阻止 stale frame/audio/state/diagnostic commit。
- 证明两个 player 实例拥有独立 Worker、Canvas presenter、input、audio 和 persistence lifecycle。
- 为 public exports、Node lifecycle 和 Chrome production path 添加独立测试。

### 4.2 范围外

- 不在 7B 构建最终 release bundle、CSS 或 demo；属于 7C。
- 不在 7B 重做默认 DOM shell；属于 7D。
- 不读取或调用 `menuitem()` registry；属于 7E。
- 不修改 P8 Lua builtin、Pico API 或 compatibility inventory；属于 7F。
- 不新增 URL 参数、自动 fetch、BBS resolver、service worker 或缓存 authority。

### 4.3 验收

1. public root 只接收 bytes/local bundle，不接收 URL。
2. lifecycle operation 顺序可观察且 deterministic；dispose exactly-once 释放 listener、Worker、audio 和
   presenter。
3. pending load/pulse 与 dispose 竞态不能在 dispose 后产生可见输出。
4. 两实例的 state、generation、input、frame 和 teardown 不串扰。
5. Node contract 与 Chrome production-path 测试通过。
6. `pnpm run verify` 通过；完成后单独提交，并把唯一 active work unit 切到 7C。

## 5. 后续 units

| Unit | 结果边界 |
| --- | --- |
| 7C | 可重复的 main/Worker/Worklet/WASM/styles/demo 静态 artifact 与 manifest |
| 7D | production DOM shell、local choose/drop、mute/fullscreen、状态恢复与 accessibility |
| 7E | VM-local menuitem snapshot + root-safe callback invocation + DOM pause menu |
| 7F | 28 个 required unknown API 与 partial mode 的 conformance closure |
| 7G | Chrome release matrix、20-cycle recovery、600-second soak、perf/fuzz/provenance |
| 7H | aggregate RC manifest/evidence、`test:release`、关闭合同且不执行外部发布 |

每个 unit 完成后必须把结果压缩进机器合同、更新本页唯一 active work unit、运行与影响面相称的
Chrome/Node gate 和 `pnpm run verify`，再以独立 commit 保持工作区干净。
