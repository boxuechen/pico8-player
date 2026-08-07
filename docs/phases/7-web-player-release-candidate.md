# Phase 7 — Web Player Release Candidate

> 状态：Active
> Active work unit：7E — Pause Menu / menuitem Completion
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

## 7. 当前工作：7E Pause Menu / menuitem Completion

### 7.1 边界与所有权

- 在任何 production 修改前，以 replacement ADR 固定 snapshot、invoke、callback return、button filter、
  pause/continue、fault 和 generation 语义；ADR-021 的“registration only”决定不得被静默扩张。
- 当前 `lua_State` 继续独占五槽 registry、callback 强引用和调用栈。WASM 只导出 copy-out snapshot 与
  root-safe invoke operation；Lua function pointer、registry ref、stack address 和 borrowed label view 不得
  进入 TypeScript、Worker DTO 或 DOM。
- Runtime Worker 是 menu-open、generation、simulation pause 和 callback outcome 的权威源。Main 只渲染
  generation-bound slot DTO 并发送用户 intent；host lifecycle `pause()` 仍是独立命令，不能伪装成
  PICO-8 pause menu。
- Canvas 只呈现 playfield。Continue 与 cart-defined items 必须是 Canvas 外 DOM；菜单关闭后 focus 返回
  playfield，DOM 不缓存跨 generation callback identity。

### 7.2 具体实现

1. 在 z8lua production ABI 增加 bounded snapshot/invoke entry points。snapshot 按 slot 顺序复制 label bytes、
   filter 和 occupied 状态；invoke 只接受 `slot 1..5 + button bitfield`，并返回结构化
   `close/keep-open/removed/fault/stale` outcome。调用期间可安全 replace/remove menuitem，返回 `true`
   保持菜单打开，其余成功返回关闭菜单。
2. Runtime/transport 增加 versioned `openPauseMenu/closePauseMenu/invokeMenuItem` transaction。open 必须先在
   Runtime-owned frame boundary 停止 simulation 并清空 gameplay input；每个 snapshot/outcome 绑定当前
   generation。非 menu-open、slot/filter 不匹配、cart swap/reset/stop/dispose 或 stale generation 均
   fail closed，且不得调用 callback。
3. callback 在 Runtime-owned Lua root 执行并受现有 instruction/memory/fault containment 约束。callback
   fault 进入结构化 cart fault、关闭菜单且不提交半完成 generation；不得在 Main 重试 callback。
4. 在 production DOM shell 加独立“Menu”入口、Continue 和最多五个 cart item。使用 dialog/menu 语义、
   roving focus 或等价有界 keyboard model，覆盖 Escape、Enter/Space、方向键、pointer/touch 与 44 CSS px
   target；filter 禁用的 L/R/X intent 不得触发 callback。
5. menu-open 时 gameplay keyboard/touch/gamepad input 与 rAF pulse 不进入 simulation，AudioContext 按 pause
   policy suspend；keep-open outcome 原位刷新 snapshot/focus，close outcome 恢复同一 generation、清空边沿
   input 并把 focus 返回 playfield。
6. cart reset/replacement、host stop/fault、visibility/pagehide 和 dispose 必须关闭/清空菜单；late snapshot
   或 outcome 不得重开 DOM、恢复旧 generation 或产生 stale frame/audio。

### 7.3 自动化与验收

- real-WASM Node gate 覆盖 snapshot copy ownership、slot order、16-byte label、button filter、callback argument、
  `true` keep-open、nil/false close、callback 内 replace/remove、fault、reset/cart swap 和 20-generation cleanup。
- Runtime/transport contract 覆盖 operation allowlist、generation binding、invalid state、stale response、
  callback exactly-once、host pause/menu pause 分离，以及 timeout/dispose fail closed。
- Chrome production release gate 用 project-owned cart 验证 Menu/Continue、keyboard/pointer/touch、filter、
  keep-open refresh、callback fault recovery、focus return、audio/simulation pause 与 cart replacement cleanup；
  语义断言优先于截图。
- 更新 `pico-api-inventory.yaml` 与 Known Difference：只有上述 official-required modes 都有行为证据后，
  `menuitem` 才能从 partial 升级；否则把剩余模式精确保留为 Known Difference。
- `pnpm run test:phase-7e`、受影响的 WASM/runtime/7B/7C/7D 回归与 `pnpm run verify` 通过；完成后
  单独提交并把唯一 active work unit 切到 7F。

### 7.4 范围外

- 不复刻 PICO-8 system settings、options、reset-cart prompt、gamepad remap 或完整 console pause menu；7E 只实现
  Continue 与 cart-defined menuitem surface。
- 不把任意 Lua function invocation 做成 public API，不允许 menu callback 从 nested guest coroutine 或 Main
  直接调用，不改变 ADR-019 的 nested suspension 范围。
- 不顺带关闭 7F 的其他 required APIs，不执行 7G soak/fuzz/performance closure，不加入网络 cart、移动/
  non-Chrome gate 或外部发布。

## 8. 后续 units

| Unit | 结果边界 |
| --- | --- |
| 7F | 28 个 required unknown API 与 partial mode 的 conformance closure |
| 7G | Chrome release matrix、20-cycle recovery、600-second soak、perf/fuzz/provenance |
| 7H | aggregate RC manifest/evidence、`test:release`、关闭合同且不执行外部发布 |

每个 unit 完成后必须把结果压缩进机器合同、更新本页唯一 active work unit、运行与影响面相称的
Chrome/Node gate 和 `pnpm run verify`，再以独立 commit 保持工作区干净。
