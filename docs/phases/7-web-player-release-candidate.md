# Phase 7 — Web Player Release Candidate

> 状态：Active
> Active work unit：7G — Chrome Release Hardening
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

## 9. 当前工作：7G Chrome Release Hardening

### 9.1 目标与输入边界

- 对 7C release artifact 和 7D/7E public shell 做 release hardening，不新增 cart API、网络 authority、
  浏览器或移动端范围；测试 cart 只用 project-owned bytes。
- 建立 versioned 7G gate manifest，固定 Chrome/Chromium-only matrix、project carts、artifact/provenance
  hashes、测量方法、性能/resource budgets 和每个 gate 的 fail-closed 条件。动态临时 profile、trace、截图
  和第三方内容不得提交。
- 先用自动化复现失败，再修改对应 owner；UI/lifecycle 修复留在 app main，Worker recovery 留在 transport/
  composition root，simulation 修复才进入 RuntimeCore。不得用测试专用 production branch 跳过失败。

### 9.2 Release/browser matrix

1. **Artifact boot**：复用 stable manifest keys，在 Chrome stable/fixed runner 上覆盖正确/错误 WASM MIME、
   strict CSP、non-cross-origin-isolated、nested relative base 和无网络 cart authority；验证 fallback 不重复启动。
2. **Audio/persistence recovery**：production AudioContext/AudioWorklet 分别在 44.1 kHz、48 kHz 覆盖 unlock、
   suspend/resume、mute 与 dispose；IndexedDB denied/quota/blocked 结果必须结构化、用户可见、可继续运行且不
   污染下一 generation。
3. **Page lifecycle**：覆盖 visibility、blur、pagehide/pageshow（含 bfcache 语义）、fullscreen、整数 resize、
   reduced motion 和多实例 teardown；隐藏/恢复不得积压 simulation burst 或留下 input/audio state。

### 9.3 Recovery、soak 与安全预算

- 运行 20 个 fault/hang/Worker-termination/recreate cycle；每轮 generation、frame/audio/state 必须隔离，最后
  仅一个 active instance，旧 Worker/AudioContext/listener/RAF 不可继续输出。
- 用 project-owned 60 Hz representative cart 运行 600 秒 Chrome desktop wall-clock soak；记录 committed
  frames、scheduler backlog、audio queue/underrun、command latency、JS/WASM memory 和 teardown result。
  `audioUnderruns=0` 是硬门禁，其他数值必须在 manifest 预先公布的预算内，不能测后放宽。
- 对 public byte ingress、DOM local file/drop metadata、Worker command/generation 和 persistence result 做
  deterministic bounded fuzz；超限/畸形输入只能得到结构化拒绝，不得 crash、hang、stale commit 或联网。
- provenance audit 重新验证 release allowlist、source/artifact hashes、license boundary、无 `ref/`/local corpus/
  third-party output、无绝对路径和无 publication side effect。

### 9.4 自动化与验收

- `test:phase-7g` 是单一 gate：release matrix、lifecycle/audio/persistence、20-cycle recovery、fuzz、artifact
  audit 和 600-second soak 都必须真实运行；可提供仅供定位的子命令，但不能以短测结果代替 exit。
- runner 输出一个无 cart identity/路径的 aggregate result；contract test 检查 gate completeness、预算先验、
  Chrome version、artifact/input hash、zero underrun、zero stale output、resource teardown 和 provenance。
- 运行受影响的 7B–7F regression 与 `pnpm run verify`。验证通过后独立提交并只激活 7H。
- 7G 不写 RC exit evidence、不创建 `test:release`、不删除 active phase 文档，也不执行 npm/网站/GitHub
  publication。

## 10. 后续 unit

| Unit | 结果边界 |
| --- | --- |
| 7H | aggregate RC manifest/evidence、`test:release`、关闭合同且不执行外部发布 |

每个 unit 完成后必须把结果压缩进机器合同、更新本页唯一 active work unit、运行与影响面相称的
Chrome/Node gate 和 `pnpm run verify`，再以独立 commit 保持工作区干净。
