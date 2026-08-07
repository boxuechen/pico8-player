# Phase 7 — Web Player Release Candidate

> 状态：Active
> Active work unit：7H — Release Candidate Exit
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

## 4. 已完成：7B Stable Embed API

7B 已建立 `@pico8-web/web-player` v1 单一 public root，提供 bytes-first lifecycle 与
copy-owned typed events。每实例 operation queue、generation 过滤与 terminal dispose barrier 阻止 stale
输出；package-owned relative Worker/Worklet assets 不向 consumer 开放 URL/cart discovery authority。Node
合同与 Chrome production-path 证明双实例拥有独立 Worker、presenter、input、audio 和 persistence
lifecycle。

验证：`pnpm run test:phase-7b`、`pnpm run verify`。

## 5. 已完成：7C Distributable Artifact Pipeline

7C 已建立由 [`spec/release-artifact-contract.json`](../../spec/release-artifact-contract.json) 锁定的
单一 release builder/verifier。ignored output 含 12 个 allowlisted files，consumer 只依赖六个 stable
manifest keys。两个 fresh output build 逐 byte 一致；Chrome 在 nested base、非 isolated 环境和严格
CSP 下同时通过正确 WASM MIME streaming 与错误 MIME ArrayBuffer fallback。artifact 不含 `ref/`、
local corpus、third-party cart、截图或 playtest output，也未执行 publication。

验证：`pnpm run test:phase-7c`、`pnpm run test:phase-7b`、`pnpm run verify`。

## 6. 已完成：7D Production DOM Player Shell

7D 已把临时页面拆成 class-driven DOM view/controller boundary，提供 bounded local choose/drop、完整
host lifecycle controls、mute/fullscreen、显式 audio-blocked recovery、整数 Canvas scale、keyboard/touch
input 与可访问状态。真实 release artifact 在 Chrome 中覆盖 200% 窄视口、reduced motion、fault 后重选、
fullscreen 和 dispose 资源释放；Canvas 仍只包含 128×128 playfield。

验证：`pnpm run test:phase-7d`、`pnpm run test:phase-7b`、`pnpm run test:phase-7c`、
`pnpm run verify`。

## 7. 已完成：7E Pause Menu / menuitem Completion

7E 已按 [ADR-023](../adr/023-menuitem-invocation-boundary.md) 建立 VM-local callback、104-byte copy-out
snapshot、root-safe invoke 与 Worker-authoritative menu pause。production DOM 提供 Continue 与最多五个
cart item；P8SCII label、L/R/X filter、仅 boolean `true` keep-open、replace/remove、fault、generation、
watchdog 和资源回收都有 real-WASM/Worker/Chrome 行为证据。`menuitem` 已升级为 compatible，历史
`P6-KD-01` 关闭；完整 PICO-8 system menu 仍是产品范围排除。

验证：`pnpm run test:phase-7e`、受影响回归、`pnpm run verify`。

## 8. 已完成：7F Required API Conformance Closure

7F 用三个 project-owned、manual-linked cart 在同一 real-WASM / production Worker 路径关闭了历史
`P4-CL-01`。28 个 required unknown API 现均为 compatible；Q16.16 raw word、类型/多返回、metatable/raw
bypass、无序 `pairs` 聚合、reset replay、invalid `select` fault 与 fresh-generation recovery 均由
[`phase-7f-required-api.json`](../../tests/conformance/manifests/phase-7f-required-api.json) 锁定。没有行为向量
失败，因此未修改 z8lua、bridge、RuntimeCore 或 ABI。

剩余 partial 只包含 `flip`、`stat`、`print`；各自 supported modes 与 `P5-KD-01`、selector subset、
`P4-KD-03` 已精确记录。`menuitem` 保持 7E compatible 回归，required unknown 为 0。

验证：`pnpm run test:phase-7f`、`pnpm run verify`。

## 9. 已完成：7G Chrome Release Hardening

7G 由 versioned gate manifest 预先锁定 artifact、audio、persistence、lifecycle/recovery/fuzz、600 秒 soak
和 provenance 六个门禁。release path 在 Chrome 151 覆盖正确/错误 WASM MIME、strict CSP、nested base、
non-isolated、44.1/48 kHz、IndexedDB denied/quota/blocked、bfcache、整数 resize、reduced motion、双实例、
64 组畸形 bytes 和 20 次 Worker watchdog recovery。production main 修复了重复环境 pause 与 persisted
`pagehide/pageshow`；demo 只在非 bfcache 离页 dispose。30/60 Hz 并行 600 秒 wall-clock soak 达到 zero
audio underrun、zero stale output 和完整 resource teardown，未扩大网络、cart 或浏览器 authority。

验证：`pnpm run test:phase-7g`、`pnpm run verify`。`test:phase-7g:diagnostic` 只供定位，不能替代 exit。

## 10. 当前工作：7H Release Candidate Exit

### 10.1 冻结 aggregate release contract

- 创建 aggregate-only 7H exit manifest，绑定 Phase 7 contract、7G gate manifest、API inventory、WASM runtime
  lock、release artifact manifest/file hashes、Chrome exact version 和 required gate source hashes。
- manifest 只含 aggregate/profile 事实，不含 cart identity、用户路径、截图、逐-cart observation、动态 profile
  或 third-party bytes；open P0/P1 与 unknown required release modes 必须为 0。
- 重新生成 release artifact 后再锁 hash；任何后续 source/contract 变化都必须使 exit test fail closed，不能手改
  hash 绕过重建。

### 10.2 发布口径与最小复现文档

- 在用户入口写明唯一支持口径：PICO-8 v0.2.7、Chrome/Chromium desktop、caller-provided bytes/local file、
  compatible 101 / partial `flip`、`stat`、`print`，以及完整 Known Differences 与范围排除。
- 给出从 fresh checkout 构建、静态 HTTP 承载 release artifact、打开 local demo 和调用 stable embed API 的最短
  可复制步骤；禁止 `file://`、任意 URL/BBS fetch、host filesystem resolver 或隐式 publication。
- demo 必须继续从 stable manifest keys 发现 assets，接受本地 `.p8`/`.p8.png`，并清楚说明不会上传或联网解析 cart。

### 10.3 单一 release gate 与 clean-checkout proof

- 新建 `test:release`，从 clean checkout 所需的 tracked inputs 开始执行 build、artifact verifier、7G full gate、
  aggregate exit contract 与文档/许可/provenance audit；10 秒 diagnostic 不是 release gate。
- 在临时 clean checkout/worktree 中真实运行 `pnpm install --offline --frozen-lockfile`、`pnpm run test:release` 和
  `pnpm run verify`；证明无 ignored build output、local corpus、`ref/` 或当前工作区状态依赖。
- 只提交 aggregate evidence 与命令结果；不提交 release build、browser profile、trace、截图或 benchmark smoke
  output。

### 10.4 关闭与禁止事项

- 写入 immutable Phase 7 exit evidence，关闭机器合同，把 roadmap 压缩为 Phase 7 Complete，删除本 active phase
  执行文档并让 `docs/README.md` 明确“无 active phase”。
- 7H 不修改 Runtime/Worker/WASM 行为，不新增 capability，不访问 BBS，不执行 npm registry、网站、GitHub Release
  或任何外部 publication；外部发布仍需用户另行明确授权。
- `test:release`、clean-checkout `pnpm run verify` 与最终工作区 cleanliness 全部通过后，才允许提交 7H。
