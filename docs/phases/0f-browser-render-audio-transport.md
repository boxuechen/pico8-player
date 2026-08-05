# Phase 0F — Browser Render / Audio Transport

> 状态：Ready
> 当前实现基线：Phase 0E，commit `c19a112`
> 浏览器门禁：Google Chrome / Chromium desktop only
> 阶段性质：browser boundary spike；不实现完整 Graphics、AudioSynth 或 Player UI

## 1. 阶段目标

Phase 0F 只回答两个浏览器边界问题，并把答案固定为 ADR 和可复现 Chrome 证据：

1. 128 × 128 PICO frame 的首版 presenter 使用 Canvas2D 还是 WebGL？
2. Worker 产生的 canonical PCM 如何以有界队列送入 AudioWorklet，是否需要
   SharedArrayBuffer？

本阶段不把未来完整 Runtime 协议提前落地。Phase 0E 已有的
`loadCart/step/hostResponse/dispose` 和 packed-screen frame DTO 是当前事实；02/04 中
标为 `Target` 的完整 player 协议仍是未来设计。

## 2. 必读与权威来源

按以下顺序读取，除此之外不要求通读全部历史文档：

1. 本文。
2. [`08-source-layout-and-boundaries.md`](../08-source-layout-and-boundaries.md) 的
   `apps/web-player`、composition root 和跨执行域 ownership。
3. Renderer：[`04-typescript-runtime.md`](../04-typescript-runtime.md#7-graphics)
   与 [`06-testing-compatibility.md`](../06-testing-compatibility.md#72-framebuffer)。
4. Audio：[`04-typescript-runtime.md`](../04-typescript-runtime.md#8-audiosynth-与-audioworklet)
   与 [`06-testing-compatibility.md`](../06-testing-compatibility.md#74-audio)。
5. 浏览器与性能：[`06-testing-compatibility.md`](../06-testing-compatibility.md#10-jswasm-microbench-与性能门禁)
   和 [Chrome/Chromium 支持矩阵](../06-testing-compatibility.md#11-chromechromium-支持矩阵)。

机器可读的 Phase 0E ABI/Runtime contract 继续由 `spec/` 拥有，不在本文复制字段清单。

## 3. 稳定输入与不可破坏的不变量

### 已实现输入

- Runtime Worker 和 Window client 已有 generation/watchdog/recreate 基线。
- Phase 0E frame event 携带 8,192-byte packed 4bpp screen、独立 `frameId`、
  `completedSlices`、`timeRawBeforeStep` 和 `targetFps`。
- `apps/web-player/src/main`、`transport`、`worker`、`worklet` 已由独立 tsconfig 和
  architecture tests 隔离；audio/presenter 文件目前仍是 scaffold。
- canonical test PCM 已由 ADR-014 固定为 22,050 Hz、mono、signed PCM16LE；这是
  项目内部 deterministic contract，不宣称为官方硬件输出格式。

### 必须保持

- RuntimeCore 不得依赖 Canvas、WebGL、AudioContext、AudioWorklet 或 DOM。
- presenter 只消费 immutable frame snapshot，不读取 WASM/Pico RAM，不回写 draw state。
- Worklet 只拥有 device queue、resampling 和 underrun/overrun counters；不得拥有
  SFX/music 或 simulation clock。
- device refresh/audio queue 不得反向推进、暂停、加速或回滚 guest simulation。
- 所有 frame/audio 消息带 `sessionGeneration`；旧 generation 必须丢弃。
- queue/buffer 有明确上限；失败必须可观测，不得静默无限增长。
- 非 cross-origin-isolated 页面必须能使用默认路径；SAB 不是预设依赖。

## 4. 明确范围外

- 完整 PICO-8 graphics API、palette/draw-state conformance 或文本渲染。
- 完整 SFX/music synth、音效编辑数据解释或官方音频逐样本兼容。
- input、persistence、cart loader、Player controls/fullscreen UI。
- wall-clock scheduler、hidden-tab policy、慢帧 catch-up。
- 移动 Chrome、Firefox、Safari/WebKit。
- BBS/network resolver 或第三方 cart corpus。

## 5. 交付单元 0F-R：Renderer decision

### 要回答的问题

在目标 Chrome/Chromium 中，Canvas2D baseline 能否同时满足像素正确性、
nearest-neighbor resize、context lifecycle 和 main-thread present p95 ≤ 4 ms？只有它
不能满足门禁时，才保留 WebGL 为默认候选。

### 实现边界

- 项目原创固定 fixture 同时覆盖 4bpp unpack、16 色 palette、边角像素、奇偶 nibble、
  透明 UI 外围和每帧 buffer identity。
- Canvas2D 与最小 WebGL 候选必须消费同一个 presenter input contract；不得各自实现
  一套 PICO draw semantics。
- 生产代码只能保留 ADR-009 选中的默认 adapter；被拒方案可以留在 benchmark/test，
  但不得成为无规则 runtime branch。
- 推荐 owner：`apps/web-player/src/main/`。协议 DTO 只能位于 `transport/`；纯
  simulation/raster 逻辑不得为 presenter 移入 main。

### 必须观察

- 128 × 128 source pixel hash 与审阅 PNG。
- integer/non-integer CSS size、DPR 1/2/非整数、resize 后无 smoothing。
- Canvas resize/state reset；若测试 WebGL，包含 context lost/restored。
- warm-up 后 present p50/p95/p99、每帧 copy/allocation bytes 和 10,000-frame heap 趋势。

### 完成证据

- ADR-009 转为 Accepted 或 Rejected，并只选择一个默认 presenter。
- 项目原创 fixture、Chrome screenshot/hash 和 raw benchmark JSON 可复现。
- browser test 对 smoothing、resize、stale generation 和 dispose 做阻断。

## 6. 交付单元 0F-A：Audio transport decision

### 要回答的问题

Window 创建的 dedicated `MessageChannel` 能否把 transferable PCM chunks 从 Worker
稳定送到 AudioWorklet，并用有界队列在规定 prebuffer 后完成 10 分钟前台 soak、
underrun=0？若能，拒绝 Window relay 和 SAB 作为默认路径。

### 实现边界

- 使用 synthetic deterministic PCM producer；不得为 transport spike 提前实现完整
  `AudioSynth`。
- Window 创建 channel，并把两个 port 分别 transfer 给 Worker 和
  `AudioWorkletProcessor`；PCM 不进入 Window↔Worker control protocol。
- audio DTO 至少区分 version、`sessionGeneration`、chunk sequence/first sample、
  canonical sample rate、frame/byte length、reset 和 stats。
- queue 定义 capacity、prebuffer、low/high watermark、underrun/overrun policy；旧
  generation、reset、dispose 后的 chunk 不得播放。
- Worklet 的设备重采样可以为 transport probe 的最小实现，但不得把 device PCM 纳入
  deterministic core hash。

### 决策阶梯

1. Worker → dedicated `MessagePort` → AudioWorklet。
2. 仅当步骤 1 有可复现失败时测试 Worker → Window relay → Worklet。
3. 仅当前两者仍无法通过 soak，且部署可提供 COOP/COEP 时评估 SAB ring buffer。

禁止同时保留三条“自动选择”路径。

### 必须观察

- trusted user gesture 后的 AudioContext unlock；启动前 underrun 单独计数。
- 请求/实际 44.1 kHz 与 48 kHz device rates、chunk 边界和 sample-index continuity。
- prebuffer 后 10 分钟 missed-frame、underrun、overrun、queue high-water、live buffers。
- reset、generation swap、pause/resume、Worker terminate 和 Worklet dispose。

### 完成证据

- ADR-010 接受唯一默认 transport，并记录被拒 fallback 与部署前提。
- versioned DTO、validator、transfer-list 和 bounded queue contract tests。
- 真实 Chrome trusted-gesture run 产生环境、raw counters 和 10 分钟报告。

## 7. 交付单元 0F-I：Integration 与 Phase 0 exit

0F-R 与 0F-A 可独立推进；只有两个 ADR 都有证据后才做 integration：

- `compose-player.ts` 只装配选中的 presenter、AudioContext/Worklet 和 Worker client。
- 明确 init/attach/start/reset/fault/dispose 顺序，释放 Worker、RAF、ports、Worklet 和
  listeners；不在 composition root 实现算法。
- 更新 02/04 中相应项的状态与唯一默认路径；更新 06 的兼容矩阵。
- 新增稳定、可单独运行的 Chrome/Chromium 命令，并纳入全量 `pnpm run verify`。

Phase 0F 完成必须同时满足：

- ADR-009、ADR-010 已决，不存在多默认路径。
- `P0-RT-03` 已从 Proposed 转为 Accepted/Rejected；ADR-014 的 transport/sample
  证据已记录。
- renderer pixel/resize/perf gate 和 audio 10-minute soak 全部通过。
- architecture tests 继续证明 main/worklet/core 边界没有倒置。
- 所有 artifact 为项目原创或有明确 provenance；`ref/` 不是测试依赖。
- `pnpm run verify` 通过，失败 fallback 没有未决阻断项。

## 8. 推荐执行顺序

将 Phase 0F 作为三个独立 goal 推进，不做一个跨 renderer/audio 的大提交：

1. **0F-R contract + fixture + Canvas2D baseline**；只有门禁失败才补 WebGL candidate。
2. **0F-A protocol + MessagePort + bounded Worklet queue**；先短测，再跑 10 分钟 soak。
3. **0F-I composition + documentation + full verification**。

每个 goal 开始前从当前源码复核 scaffold，不得仅根据本文假设 API 已存在。
