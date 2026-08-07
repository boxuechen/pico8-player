# Phase 7 — Web Player Release Candidate

> 状态：Active
> Active work unit：7D — Production DOM Player Shell
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

## 6. 当前工作：7D Production DOM Player Shell

### 6.1 边界与所有权

- `main/ui` 拥有 DOM structure、control availability、drop-zone、status copy、mute/fullscreen 与 responsive
  layout；`PlayerController` 只把 UI intent 映射到 stable lifecycle，不复制 Runtime 状态机。
- Worker/Runtime 仍是 simulation、frame、pause 和 fault 的权威源；Canvas 只呈现 128×128 playfield，
  controls、status、fault 和后续 pause menu 都必须是 Canvas 外的 DOM。
- 文件选择和 drop 只读取用户提供的 `.p8`/`.p8.png` bytes；不得接受 URL、目录、clipboard 或隐式
  network authority。每次只接受一个 bounded file，失败后仍可重新选择。
- 视觉样式只来自 release stylesheet/class/state attributes；production source 不写 inline layout style，
  不引入 UI framework 或新的 package/execution-domain edge。

### 6.2 具体实现

1. 把 Phase 1E 临时 shell 拆为独立 DOM view/controller boundary，提供 choose/drop、play/resume、pause、
   reset、stop、mute/unmute 和 fullscreen controls；control labels、pressed/disabled state 只由当前
   shell state 派生。
2. 显式呈现 `idle/loading/ready/running/paused/stopped/audio-blocked/faulted/disposed`。AudioContext
   无手势或被策略阻止时不得把 cart 判为 faulted；显示可操作的 audio resume 状态，并允许 silent
   playback、再次解锁或重新选择 cart。
3. drop-zone 支持 keyboard focus、drag enter/leave/drop 与 file picker；拒绝 multiple/unsupported/oversize
   input 时给出 `aria-live` diagnostic，且不改变已提交 Runtime generation。
4. Canvas 保持 128×128 backing store、nearest-neighbor 与整数 CSS scale；ResizeObserver/viewport/fullscreen
   只选择容器可容纳的最大整数 scale，窄容器降到 1×，不得拉伸或把 DPR 变成 simulation input。
5. keyboard focus 不困住页面；game controls 仅在 playfield focus/running 时消费。touch controls 提供可读
   label、pressed state、pointer cancellation 和至少 44 CSS px hit target；mute/fullscreen state 可被
   keyboard、pointer 与 assistive technology观察。
6. `prefers-reduced-motion: reduce` 禁用非必要 transition/animation；状态、错误与操作结果不依赖颜色、
   动画或 hover。fullscreen exit、blur/visibility 与 dispose 必须清理 transient UI/input state。

### 6.3 自动化与验收

- Node DOM-policy/view-model contract 覆盖 state→controls/ARIA mapping、file validation、integer scale 和
  audio-blocked recovery，不依赖浏览器成为 simulation oracle。
- Chrome production-path gate 通过真实 release artifact 验证 choose 与 drop、play/pause/resume/reset/
  stop、mute、fullscreen request/exit、keyboard focus、touch/pointer、resize、reduced motion、fault 后重选
  cart，以及 dispose 后无 listener/RAF 输出。
- 可访问性门禁至少检查 landmark/name/role、live region、tab order、disabled/pressed semantics、canvas
  accessible name、touch target 和 200% viewport layout；不以截图替代语义断言。
- `pnpm run test:phase-7d`、受影响 7B/7C 回归与 `pnpm run verify` 通过；完成后单独提交并把唯一
  active work unit 切到 7E。

### 6.4 范围外

- 不实现 7E pause menu/menuitem callback invocation；7D 的 pause button 仍是 host lifecycle pause。
- 不修复/重分类 required PICO API，不做 long soak/fuzz/performance closure，也不创建 public compatibility rate。
- 不加入 cart URL/BBS access、service worker、UI asset CDN、telemetry、mobile/non-Chrome gate 或外部发布。

## 7. 后续 units

| Unit | 结果边界 |
| --- | --- |
| 7E | VM-local menuitem snapshot + root-safe callback invocation + DOM pause menu |
| 7F | 28 个 required unknown API 与 partial mode 的 conformance closure |
| 7G | Chrome release matrix、20-cycle recovery、600-second soak、perf/fuzz/provenance |
| 7H | aggregate RC manifest/evidence、`test:release`、关闭合同且不执行外部发布 |

每个 unit 完成后必须把结果压缩进机器合同、更新本页唯一 active work unit、运行与影响面相称的
Chrome/Node gate 和 `pnpm run verify`，再以独立 commit 保持工作区干净。
