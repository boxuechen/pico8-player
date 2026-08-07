# Phase 7 — Web Player Release Candidate

> 状态：Active
> Active work unit：7C — Distributable Artifact Pipeline
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

## 5. 当前工作：7C Distributable Artifact Pipeline

### 5.1 范围内

- 新增单一 release builder，将 main facade、module Worker、AudioWorklet、WASM、基础 styles 和最小
  local-bytes demo 输出到 ignored `apps/web-player/dist/release/`。
- 生成 versioned `manifest.json`；consumer 只依赖 `main/worker/worklet/wasm/styles/demo` stable keys，
  不依赖 content-hashed 文件名。
- 所有运行时引用使用相对 manifest/base resolution；在非 root HTTP path 与非 cross-origin-isolated
  Chrome 中启动。
- Worker 优先使用正确 `application/wasm` 的 streaming instantiate，并在 MIME 不支持时回退到
  ArrayBuffer，不改变 runtime bytes/hash。
- 新增 artifact verifier，锁定 SHA-256、byte length、MIME、CSP、provenance、允许文件集合和 excluded
  paths；拒绝 `ref/`、local corpus、third-party cart/screenshot/playtest 产物。
- 在两个全新临时 output root 中执行 pinned Node/pnpm/Emscripten build，并逐文件证明 byte-identical。
- 添加 Node artifact contract 与 Chrome relative-base/MIME/CSP/fallback production-path gate。

### 5.2 范围外

- 不重做最终 DOM shell interaction/accessibility；属于 7D。7C demo 只证明 artifact boot 和
  caller-provided local bytes。
- 不实现 pause menu、required API compatibility closure、long soak 或 publication。
- 不引入 CDN、service worker、arbitrary base URL/cart URL、BBS access、registry publish 或部署脚本。
- 不把 ignored release output 或临时 reproducibility directories 提交到 git。

### 5.3 验收

1. 六个 stable artifact keys 都解析到 verifier 认可的 local file、hash、length 和 MIME。
2. Chrome 在 nested relative base、strict CSP、正确/错误 WASM MIME 两种路径可从 manifest 启动 demo。
3. 两次 clean build 的完整 manifest 与每个 emitted byte 一致。
4. release allowlist/provenance/exclusion audit fail closed。
5. Node 与 Chrome 7C gates、受影响回归和 `pnpm run verify` 通过。
6. 完成后单独提交，并把唯一 active work unit 切到 7D。

## 6. 后续 units

| Unit | 结果边界 |
| --- | --- |
| 7D | production DOM shell、local choose/drop、mute/fullscreen、状态恢复与 accessibility |
| 7E | VM-local menuitem snapshot + root-safe callback invocation + DOM pause menu |
| 7F | 28 个 required unknown API 与 partial mode 的 conformance closure |
| 7G | Chrome release matrix、20-cycle recovery、600-second soak、perf/fuzz/provenance |
| 7H | aggregate RC manifest/evidence、`test:release`、关闭合同且不执行外部发布 |

每个 unit 完成后必须把结果压缩进机器合同、更新本页唯一 active work unit、运行与影响面相称的
Chrome/Node gate 和 `pnpm run verify`，再以独立 commit 保持工作区干净。
