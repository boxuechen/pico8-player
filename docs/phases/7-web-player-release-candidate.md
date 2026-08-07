# Phase 7 — Web Player Release Candidate

> 状态：Active
> Active work unit：7F — Required API Conformance Closure
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

## 8. 当前工作：7F Required API Conformance Closure

### 8.1 目标与证据边界

- 关闭历史 `P4-CL-01`：28 个 required/implemented/unknown API 必须各有 project-owned、manual-linked、
  real-WASM 行为向量，不能用“当前能调用”或 inventory 改标签替代 conformance。
- 当前唯一清单是：`pairs`；`max/min/mid/flr/ceil/cos/sin/atan2/sqrt/abs/sgn`；
  `band/bor/bxor/bnot/shl/shr/lshr/rotl/rotr`；以及
  `setmetatable/getmetatable/rawset/rawget/rawequal/rawlen/select`。
- 每个向量固定 cart source/hash、PICO-8 0.2.7 manual section、输入类型与 Q16.16 raw oracle、返回数量/
  类型、error behavior、reset replay 和 Node/Chrome 结果。第三方 cart、官方二进制 output 和参考实现
  不能成为 tracked oracle。
- 先写 failing conformance vector，再修改 production；没有失败证据时只允许补测试和 inventory evidence。

### 8.2 四个实现簇

1. **Table iteration**：验证 `pairs(table)`、empty/nil、iteration termination、key/value 多返回和
   `__pairs` 行为；不能依赖宿主 JS key order，也不能把 Lua table 跨 WASM 边界。
2. **Q16.16 math**：覆盖正常值、负数、边界/overflow、角度方向与周期、零和 invalid-domain 行为；
   三角函数使用 raw Q16 oracle，禁止以 browser `Math.*` 作为运行时真值。
3. **Bitwise**：覆盖多参数/default、32-bit mask、负值、shift count normalization、logical/arithmetic
   shift、rotate 与 Q16.16 raw bit pattern；结果必须来自 z8lua VM，不新增 host binding。
4. **Lua base/raw surface**：覆盖 metatable 保护/查询、raw bypass、identity、string/table raw length、
   `select("#", ...)`、正负 index、多返回和 invalid index error；不开放 debug/package/io/os library。

修复优先落在对应 z8lua builtin/base implementation；只有向量证明跨 Runtime transaction 的真实缺陷时，
才允许触及 bridge/RuntimeCore。不得加入 cart-specific 分支、JS math fallback 或新网络/文件 authority。

### 8.3 Partial-mode closure

- `flip`：分别记录 root custom-loop compatible mode 与 ADR-019 nested suspension Known Difference；不得把
  nested guest coroutine 伪装为成功。
- `stat`：为当前 release-required selector 建显式向量，并把未支持 selector 精确留在 Known Difference；
  不能用统一 `false` 测试掩盖应支持 selector。
- `print`：分别证明普通/visual/custom-font/audio control；timed delay 若仍无 root suspension contract，
  保持 `P4-KD-03`，不得仅改成 compatible。
- `menuitem` 只做 7E 回归，不重复扩张 system menu 范围。完成后 inventory 必须满足 required unknown 为
  0；remaining partial modes 都必须有精确 supported/unsupported evidence。

### 8.4 自动化与验收

- 建立一个 versioned 7F manifest 和小型 project-owned carts；Node runner 在真实 release WASM 上输出
  byte/raw/type/error oracle，Chrome runner 通过 production Worker 对同一 carts 复核，不复制第二套语义。
- contract test 必须检查 28 个 API 一一覆盖、manual link 存在、manifest/cart hash 锁定、inventory evidence
  可达，以及 required unknown 计数为 0；negative vector 必须证明错误不会污染下一 generation。
- 对 production 修复运行对应 cluster test、WASM reproducibility、Phase 4C/4D/6G/7E 回归；最终运行
  `pnpm run test:phase-7f` 与 `pnpm run verify`。
- 验证通过后独立提交，把唯一 active work unit 切到 7G；7F 不执行 600-second soak、fuzz/provenance
  aggregate、外部发布、网络/BBS cart 或 non-Chrome 测试。

## 9. 后续 units

| Unit | 结果边界 |
| --- | --- |
| 7G | Chrome release matrix、20-cycle recovery、600-second soak、perf/fuzz/provenance |
| 7H | aggregate RC manifest/evidence、`test:release`、关闭合同且不执行外部发布 |

每个 unit 完成后必须把结果压缩进机器合同、更新本页唯一 active work unit、运行与影响面相称的
Chrome/Node gate 和 `pnpm run verify`，再以独立 commit 保持工作区干净。
