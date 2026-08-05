# 可执行交付计划

## 1. 执行原则

- 按阶段建立 vertical slice，不按“先写完全部 API”推进。
- Phase 0 的问题没有实验答案前，不开始完整 Runtime 移植。
- 每个阶段必须有自动验证、可观察 demo 和更新后的兼容矩阵。
- 新模块先确定 public contract，再实现；跨模块临时 import 不得作为阶段完成状态。
- fake-08/zepto8 只作为行为与算法参考。复制或翻译代码前必须记录来源和许可证。

## 2. Canonical workspace

源码布局不在交付计划中维护第二份目录树。所有 production source、WASM、生成物、测试和工具必须遵守 [08-source-layout-and-boundaries.md](./08-source-layout-and-boundaries.md)。其关键结构是：

- `packages/`：runtime-neutral contracts、cart codec、RuntimeCore 与 z8lua adapter，形成无环 DAG。
- `apps/web-player/`：Window、Runtime Worker、AudioWorklet 三个 execution domain 与 composition roots。
- `wasm/`：upstream pin、patch、C/C++ bridge、manifest 和 build output。
- `spec/`：machine-readable PICO API inventory 与 ABI schema。
- `tests/architecture/`：在业务实现之前机器验证 package/import/platform 边界。

是否使用 submodule、vendored source 或校验 fetch 必须在 Phase 0A 形成 ADR；发布构建不得依赖移动 branch head。

## 3. Phase 0 — 架构 Spike

状态：**进行中**（Phase 0S、Phase 0A 已完成；下一阶段为 Phase 0B）

目标：用最小实验验证混合架构成立，并锁定 ABI。Spike 代码可以被重写，不得被未经审查地升级为生产代码。

### 0S. Workspace Scaffold 与边界门禁

状态：**Complete（2026-08-05）**。工具选择、正反门禁和 clean-install 验证见 [Phase 0S 完成证据](./11-phase-0s-evidence.md)。

这是所有 production code 的前置任务。先建立可执行边界，再开始 z8lua 或 Runtime 行为实现。

任务：

- 按 [08-source-layout-and-boundaries.md](./08-source-layout-and-boundaries.md) 创建 workspace、四个 packages 与 web-player 的 main/worker/worklet execution domains。
- 为各 package/entrypoint 建立独立 tsconfig/project references 和最小 `package.json#exports`。
- 建立 `test:architecture`：dependency DAG、禁止 deep import、platform global 隔离、generated source 和 negative fixtures。
- 创建三个最小 composition roots；只完成 wiring/build，不加入 PICO API 行为。
- 创建 `spec/pico-api-inventory.yaml`、`wasm/patches/`、`wasm/manifest.lock.json` 的 schema/ownership 说明。
- pin pnpm workspace 版本，选择 build/test runner 与 boundary checker，并记录工具链/许可证影响。

验收：

- contracts、cart-codec、runtime-core、z8lua-bridge 可独立 typecheck，production graph 无环。
- main、worker、worklet 最小 entrypoint 可分别 build，且只拥有目标环境允许的 globals。
- 故意添加的 packages→apps、main→RuntimeCore、worklet→z8lua、跨 package deep import 都会使 `test:architecture` 失败。
- 所有 public exports 从 consumer fixture 可编译；internal 文件不可通过 package path 访问。
- [源码布局 Scaffold Exit Gate](./08-source-layout-and-boundaries.md#10-scaffold-exit-gate) 全部满足。

### 0A. z8lua WASM 基线

状态：**Complete（2026-08-05）**。source/toolchain pin、branch 选择、sandbox
ABI、语言结果、NOTICE 和可复现 hash 见 [Phase 0A 完成证据](./12-phase-0a-evidence.md)
与 [ADR-012](./adr/012-z8lua-source-and-phase-0a-wasm.md)。

任务：

- Pin z8lua commit。
- 在 `pico8` 与 `zepto8` branch 之间做有证据的选择，并建立 upstream commit + local patch manifest。
- 用 Emscripten 生成可由 Worker 加载的 ES module + WASM。
- 创建/销毁独立 Lua state。
- 执行 P8 shorthand、fixed-point overflow、coroutine yield 测试。
- 逐个打开最小 allowlist libraries；禁止直接暴露 debug、eris、io、os、package 等非 PICO-8 surface。
- 验证 license/NOTICE 产物。

验收：

- shorthand、`0x7fff.ffff + 0x0.0001`、division-by-zero、`sin/cos` 等语义 fixture 有确定结果。
- 上游已知的 `^` 非 bit-exact 差异进入兼容矩阵，不以“使用了 z8lua”视为自动通过。
- 创建/销毁 100 次后无可观察 heap/session 泄漏。
- WASM hash 与 pin/build config 可复现。

### 0B. Shared Pico RAM

任务：

- 在 WASM memory 分配连续 64 KiB。
- 将 pointer 交给 `lua_setpico8memory()`。
- TS 创建 `Uint8Array` / `DataView` view。
- 从 Lua `@/%/$` 与 TS 双向观察相同地址，并覆盖 `0x8000..0xffff` upper RAM。
- 验证 `@/%/$` 的地址 wrap、多字节跨界及 `0x5f54/0x5f55` GFX/SCREEN remap；必要时以最小 z8lua patch 接入统一 address mapper。
- 以 `initial === maximum`、growth off 构建，验证固定容量、受控 OOM 和 typed-view identity。
- 用官方 golden 校准 cold boot、cart run 与 reset 的 RAM 保留/清零 matrix；参考实现行为只作为候选。

验收：

- 100% 双向 alias 测试通过。
- upper RAM 和 video remap 下，direct operators、`peek/poke/memcpy` 与 graphics 不能产生两套地址语义。
- logical frame 内无 RAM sync copy。
- memory growth 被构建配置禁止；heap stress 只产生受控 OOM，不 detach/替换现有 typed views。

### 0C. Interop Microbenchmark

任务：

- 建立 `pset`、`peek/poke`、`spr` 代表性 JS imported API。
- 分别测试 1K、16K、64K calls/frame。
- 在 Chromium、Firefox、Safari 测 p50/p95/p99。
- 同时测试纯 WASM hot path 对照组。

Go 条件：

- 代表性 60 fps 压力 cart 在最低支持桌面浏览器上保留足够帧预算。
- Safari 不出现数量级退化。

若失败，严格执行 [全局 fallback ladder](./07-decisions-risks-open-questions.md#4-fallback-ladder)。每一级必须产出 benchmark/profile，或记录为什么对该 workload `not-applicable`；不能从去 allocation 直接跳到 full-core WASM，也不能省略 raw ABI、批量输出、局部 memory/pixel/block/audio 下沉的评估。

### 0D. Lossless `.p8.png`

任务：

- 直接解析 PNG bytes、IDAT、scanline filter 和 RGBA payload。
- 提取 channel low bits。
- 实现 code block 的三种模式。
- 与已知 fixture 的 Cart ROM 和 Lua source hash 比较。

验收：

- 禁止使用 Canvas decode 的测试/代码审查门禁存在。
- legacy/current fixture byte-for-byte 一致。
- malformed/truncated/bomb cases 受控失败。

### 0E. Coroutine Frame Slice

任务：

- 注册最小 `cls/pset/btn` API。
- boot 一个 `_init/_update60/_draw` cart。
- Worker 主动 step，一次 resume 只完成受控 frame slice。
- 同时验证 callback lifecycle 与 custom `flip()` main loop；`time()` 由 simulation slice 推进而不是 callback 次数。
- 加 instruction count hook、poisoned-state 处理和 Window Worker watchdog；budget hook 超限必须抛受控错误，不能把任意指令点当可恢复 yield。
- 原型验证异步 HostRequest 在 root 与 guest-created nested coroutine 中的控制流；若不能可靠恢复，将外部 `reload/cstore` 明确降级为预供给/同步 cache 或 unsupported。

验收：

- 手动 step 60 次得到精确 60 次 update/draw。
- custom `flip()` loop 完成 startup boundary 后，手动 resume 60 次必须精确到达后续 60 个 `flip()` boundary、推进 60 个 simulation slices，且没有 callback 也能推进 `time()`；首次 startup boundary 是否计时必须以官方差分结果形成 ADR。
- 无限循环 cart 不阻塞 Window，能终止并重建 Worker。
- Lua runtime error 带 phase、line 和安全 trace。
- nested coroutine HostRequest 有通过证据，或兼容矩阵与 L3 范围中存在明确、可测试的降级结论。

### 0F. Browser Render / Audio Transport

任务：

- 用固定 128 × 128 RGBA fixture 比较 Canvas2D 与最小 WebGL presenter 的像素、缩放、context-loss 和 present 成本，形成首版 renderer ADR。
- 由 Window 创建专用 `MessageChannel`，把端口分别转交 Worker 与 AudioWorklet；传输带 `sessionGeneration` 的 bounded PCM16LE chunks、reset、underrun/overrun 信号。
- 在 Chrome、Firefox、Safari 桌面验证 AudioContext 手势解锁、port transfer、背压和 10 分钟稳态队列；记录 44.1/48 kHz 设备输出下的重采样行为。
- 用合成确定性 timeline 和可复现 reference capture 验证 ADR-014 的 22050 Hz mono signed PCM16LE canonical 格式；此 spike 不要求完整 PICO-8 synth。
- 只有 dedicated port 路径失败且有证据时，才验证 Window relay fallback；SAB 仅在两者仍无法满足门禁时评估。

验收：

- ADR-009 明确首版 presenter；RGBA hash/nearest-neighbor 行为一致，present p95 满足预算。
- ADR-010 明确唯一默认 PCM transport；AudioContext 解锁和规定 prebuffer 后的 10 分钟计量窗口内 underrun 计数为 0，且无无界 queue/buffer 增长。启动前事件必须单独记录。
- `P0-RT-03`、`P0-RT-04` 和 Q-06/Q-07 有可复现证据；若采用 fallback，架构图、协议、测试矩阵已同步更新。

### Phase 0 Exit Gate

以下全部满足才进入 Phase 1：

- 03/04 文档的 ABI 和 Runtime contract 根据 spike 更新。
- 0S 与 0A–0F 自动测试全部通过；需要用户手势/真 Safari 的 0F 部分允许使用版本化、可重复的 device-run 记录。
- Interop 性能边界已形成 ADR。
- z8lua pin、patch 策略和 license strategy 已形成 ADR。
- upper RAM/remap patch surface 与 HostRequest coroutine 限制已形成 ADR/兼容条目。
- renderer 与 audio transport 已形成 Accepted/Rejected ADR；canonical PCM（ADR-014）的 sample/event 与重采样证据已记录；SAB 是否必要有明确结论。
- custom-loop startup `flip()` 的 frame/time 偏移已有官方 capture 与 ADR，相关契约和 golden 编号已同步。
- 失败 fallback 没有未决阻断项。

## 4. Phase 1 — L1 最小可玩闭环

状态：**未开始**

目标：运行项目自有的单 cart，具备输入、逻辑和像素输出，暂不追求完整 API。

范围：

- `.p8` parser 和基础 `.p8.png` parser。
- CartImage、Cart ROM、Base RAM load/reload 基线。
- Runtime state machine 和 Worker protocol v1。
- `_init/_update/_update60/_draw/flip`。
- `cls/color/pset/pget/line/rect/rectfill/circ/circfill` 子集。
- `btn/btnp` keyboard input。
- ADR-009 在 Phase 0F 选定的 nearest-neighbor presenter（Canvas2D baseline 或有证据的 WebGL 选择）。
- structured diagnostics、pause/reset/stop。

验收场景：

1. 一个 30 fps cart 可移动角色并稳定运行。
2. 一个 60 fps cart 的 update/draw count 正确。
3. 一个手写 `flip()` loop cart 可运行。
4. reload/reset 后内存、RNG、input edge 与 audio placeholder 状态正确复位。
5. Worker fault 后 UI 可以重新载入 cart。

## 5. Phase 2 — Graphics、Memory 与 Text

状态：**未开始**

目标：完成大多数可视 cart 依赖的 API 和内存语义。

任务组：

- sprite/map：`spr/sspr/sget/sset/map/mget/mset/fget/fset`。
- draw state：`camera/clip/pal/palt/fillp`。
- shape：oval、round rect、tline 等目标版本 API。
- text：P8SCII、control codes、custom font、cursor/print behavior。
- memory：`peek/poke` variants、`memcpy/memset/reload/cstore` 基线。
- screen/gfx/map remapping registers。

Exit Gate：

- graphics conformance golden 全部通过。
- RAM alias 与 remapping 测试通过。
- 目标 graphics API matrix 没有未标记的 stub。
- hot path profile 满足 Phase 0 性能决策；否则完成局部 WASM 下沉。

## 6. Phase 3 — Audio、完整 Input 与 Persistence

状态：**未开始**

目标：完成 L2 Playable 所需的 audio、input 与 persistence feature surface，产出 **L2 candidate**；此阶段尚未通过完整 corpus、浏览器和 MVP DoD，不得对外声明 L2。

任务组：

- SFX note、waveform、volume、speed、loop 和 effects。
- music pattern、channel、flow control 和 custom instruments。
- Worker PCM generation、AudioWorklet queue、sample-rate conversion。
- keyboard、Gamepad、touch overlay、pointer/devkit mode。
- `cartdata/dset/dget` 与 IndexedDB transaction。
- mute、visibility、AudioContext suspend/resume。

Exit Gate：

- audio golden/state tests 通过。
- 10 分钟稳态浏览器测试没有 underrun 或无限 buffer growth。
- persistence reload/upgrade/isolation 测试通过。
- 标准 gameplay fixture 可以完成从启动到存档再恢复的流程。

## 7. Phase 4 — L2 / MVP 兼容加固

状态：**未开始**

目标：从 API 完成度转向实际 cart 可玩率，并以完整测试门禁把 Phase 3 candidate 晋级为可声明的 L2 MVP。

任务：

- 建立版本/功能分层的授权 cart corpus。
- 完成 system/string/table/math/stat/menuitem 等剩余 player API。
- 处理 CPU accounting、frame drop、pause menu、edge registers。
- 运行浏览器矩阵、移动端和长时间稳定性测试。
- 建立公开的 known differences 文档和可复现 bug template。

Exit Gate：

- [06-testing-compatibility.md 的 MVP Player DoD](./06-testing-compatibility.md#162-mvp-player) 通过；只有此时发布物才可声明 L2。
- 每个失败 cart 都有分类：bug、unsupported、out-of-scope 或 fixture/license blocker。
- 未知/静默 API stub 数量为零。

## 8. Phase 5 — L3 与可选 BBS 集成

状态：**阻塞于范围与授权；不得提前实施自动访问**

Runtime 工作：

- `load/reload/cstore` 多 cart swap transaction。
- `needsCart` suspend/supply/resume 协议。
- cart dependency cache 与版本 identity。
- breadcrumb / param string 等相关 player 行为。

BBS 集成前置条件：

- Lexaloffle 和所涉及作者的许可范围已记录。
- API/抓取方式、rate limit、cache、删除和 attribution 策略已审核。
- resolver 与 Runtime core 保持独立，可完全关闭。

没有这些前置条件时，只实现 caller-provided cart dependency，不实现 BBS fetch。

## 9. 阶段证据模板

每次标记阶段完成时，在本文件对应阶段下增加：

```md
完成日期：YYYY-MM-DD
实现版本：<commit>
验证命令：
- `<command>`
关键结果：
- <test suite / benchmark result>
已知差异：
- <link to compatibility entry>
ADR：
- <links>
```

没有真实命令输出或 CI 链接，不得把状态改为“已完成”。
