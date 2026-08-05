# 测试、兼容性与发布门禁

> 状态：执行规范（living document）
> 适用架构：z8lua WASM + TypeScript Runtime
> 基准版本：PICO-8 0.2.7
> 最近核验：2026-08-06

## 状态路由

本文是长期质量契约，不表示所有命令、fixture 和 CI lane 已经存在。

| 状态 | 对应范围 |
| --- | --- |
| **Implemented gates** | 当前 `package.json` 中的 architecture、cart-codec、WASM、benchmark、Phase 0E/0F、Phase 1A/1C/1D/1E/1F、Phase 2A–2F、`test:conformance` 和 aggregate verify scripts；已归档的 Phase 0/1/2 evidence |
| **Implemented Phase 0F gates** | framebuffer/presenter exactness、DPR/resize/performance、bounded audio transport/queue、dual-rate 10-minute Chrome soak 和 lifecycle integration；见 [0F evidence](./evidence/phase-0/17-phase-0f-evidence.md) |
| **Implemented Phase 1 exit** | project-owned 30/60/custom conformance carts、manifest/oracle、production Worker Chrome matrix、rAF/keyboard/fault/performance gate；见 [Phase 1 evidence](./evidence/phase-1/21-phase-1-l1-exit-evidence.md) |
| **Implemented Phase 2 exit** | project-owned graphics-memory/text-remap carts、Node real-WASM RAM/screen/palette oracle、production Worker/Canvas Chrome matrix、resource recovery 与双场景 p95 gate；见 [Phase 2 evidence](./evidence/phase-2/31-phase-2-graphics-memory-text-exit-evidence.md) |
| **Target** | 第 3 节其余完整测试资产布局、尚未落地的 fuzz/differential/nightly/release 命令与 release matrix |
| **Deferred** | 完整兼容等级、官方 golden corpus、移动 Chrome 和正式 release qualification |

执行时先检查 `package.json`，不得把本文示例命令当成已存在脚本。第 15 节维护当前
compatibility/known-difference 结论和必要摘要；原始环境记录与完整历史测量只在
[`evidence/`](./evidence/README.md) 中陈述。

本文定义 pico8-web-player 的测试策略、兼容性口径、性能预算和发布门禁。它是后续 Codex 开发时的执行契约，不是测试愿望清单。任何运行时行为变更都必须能回答三个问题：

1. 它对应哪条 PICO-8 行为或项目明确声明的扩展？
2. 哪个自动化测试能阻止它以后回归？
3. 与官方 PICO-8 不一致时，差异是否已记录、分级并对用户可见？

规范性来源按以下优先级排序：

1. [PICO-8 官方手册（当前为 v0.2.7）](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)。
2. 在合法安装的同版本官方 PICO-8 中观察到的可重复行为。
3. 官方更新说明和 Lexaloffle 对具体行为的说明。
4. z8lua 上游测试，用于验证语言实现自身。
5. fake-08 等开源实现，只用于交叉定位，不作为规范性 oracle。

如果手册与官方运行结果冲突，先保留最小复现、记录 PICO-8 精确版本和平台，再创建“规范歧义”问题；不要静默选择更容易实现的一边。

## 1. Codex 执行规则

Codex 在实现或修复任何功能时，必须遵守以下规则：

- 开工前先定位对应的手册章节、兼容性用例和已知差异；不存在时先补测试设计。
- 每个新 API 至少包含正常路径、边界值、状态交互各一个测试。涉及 P8 Lua 语义时，还必须有 z8lua/WASM 层测试。
- 修复 bug 时，先提交能稳定复现的最小测试，再修改实现。无法先写测试时，PR/变更说明必须解释原因。
- 不以“能启动某个游戏”替代 API conformance，不以代码覆盖率替代行为覆盖率。
- 不从当前实现自动生成结果后直接“批准” golden。Golden 必须来自官方参考结果，或来自经人工按规范审阅的项目自有测试向量。
- 不为了让测试通过而扩大误差容限、删除输入帧、忽略失败或批量更新快照；这类变更需要单独解释并审阅。
- 不把 fake-08 的结果当作官方结果。它与本项目一致、但与官方 PICO-8 不一致时，本项目仍判失败。
- 不在 CI、测试脚本、fixture 更新器或开发工具中访问 Lexaloffle BBS。详见第 13 节。
- 无法运行真实 Chrome/Chromium 或官方 PICO-8 时，明确标记“未运行”，不得用
  其他引擎、模拟器或 fake-08 冒充已验证。Firefox、Safari/WebKit 不属于当前
  支持矩阵，不要求维护其 `not-run` 状态。
- 修改 package、public export、import 或 entrypoint 时必须运行 architecture boundary tests；code review 不能代替机器门禁。
- 变更结束前运行与影响面相称的测试层级，并在交付说明中列出实际执行的命令、结果及未执行项。

本文中的 `MUST`/“必须”是合并或发布门禁；`SHOULD`/“应”是默认要求，偏离时需要记录理由。

## 2. 测试目标与非目标

测试要证明的是：对于给定 cart、初始状态和逐帧输入，播放器能在正确时间产生兼容的 P8 Lua 行为、RAM、屏幕、音频和宿主事件，并且恶意或损坏输入不能拖死网页。

测试不试图证明：

- 编辑器、命令行、SPLORE 等完整 PICO-8 Console 功能；本项目只实现 Player。
- 未公开内部实现逐位等同；除非该行为可由 cart 观察到。
- 所有历史或未来版本 cart 自动兼容。兼容范围必须绑定 cart version 和本项目支持矩阵。
- 第三方 BBS cart 的版权状态或授权范围。

## 3. 建议的测试资产布局

后续实现测试基础设施时使用以下约定。目录名可以通过 ADR 调整，但语义和资产隔离不得丢失。

```text
tests/
  architecture/                 # package DAG、exports、platform globals、negative import fixtures
  unit/
    contracts/                  # stable value/error encoding 与 public export compile tests
    cart-codec/                 # parser/decompressor 纯单元测试
    runtime-core/               # RAM/graphics/audio/input/scheduler 纯单元测试
    z8lua-bridge/               # binding、stack、pointer lifetime 测试
  contract/
    wasm-abi/                   # C ABI ↔ TS consumer contract
    worker-protocol/            # Window/Worker/Worklet schema、transfer、version contract
  conformance/
    carts/                      # 项目原创、单特性、可分发的 .p8 测试 cart
    manifests/                  # 帧、输入、观察点和预期结果
    traces/                     # 逐帧输入 trace
  golden/
    pico8-0.2.7/                # 与参考 PICO-8 版本绑定
      <case-id>/
        manifest.json
        screen-<frame>.bin
        screen-<frame>.png      # 仅供审阅，不能作为唯一 oracle
        ram-<frame>.bin
        audio.pcm
  differential/                 # 官方参考捕获和二级实现适配器
  integration/                  # RuntimeCore + adapters；Worker/storage/audio transaction
  fuzz/
    corpus/                     # 最小、可分发种子；不放第三方 BBS cart
    regressions/                # 每个已修复崩溃的最小输入
  browser/                      # Playwright 和浏览器端集成测试
  performance/                  # microbench、场景 benchmark、基线
  fixtures/                     # 合法、注明来源的非 cart 通用 fixture
  external-corpus.example.json  # 本地外部语料格式，不含实际 cart
```

测试命令形成稳定接口，供开发者和 CI 使用：

```text
pnpm test:architecture
pnpm test:unit
pnpm test:conformance
pnpm test:browser
pnpm test:fuzz
pnpm test:performance
pnpm test:differential
pnpm test:release
```

这些命令在脚本尚未建立时是目标契约。落地后不得无迁移说明地改名。

## 4. 确定性执行模型

Golden 和差分测试必须运行在 deterministic host 中：

- 固定 cart bytes、cart version、z8lua/WASM build ID 和 runtime commit。
- 每个 case 显式设置随机种子；禁止依赖测试进程启动时的随机状态。
- 使用虚拟时钟。`time()/t()` 由 deterministic simulation clock 按下述统一帧定义推进；日期、locale、timezone 和高分辨率宿主时间固定。专门的时间 API case 可以声明不同但仍可复现的 clock trace。
- `stat()` 中依赖浏览器、设备、剪贴板、网络或电量的项目由 manifest 固定或明确标为不可比。
- 持久化存储每个 case 使用全新 namespace；需要验证 `cartdata()` 的 case 自己声明预置值。
- devicePixelRatio、Canvas 尺寸、音频上下文采样率和输入设备状态显式设置。
- 禁止测试顺序共享 VM、RAM、palette、clip、camera、音频 channel、按键 repeat 或持久化状态，除非 case 专门测试跨帧/跨启动行为。

统一帧定义如下：

1. `boot` 检查点：callback cart 位于 cart 解码、RAM 初始化和 `_init()` 返回后、第一次 update 前；custom-loop cart 位于 top-level 的第一个受控 `flip()` boundary，且不得额外调用 `_init()`。
2. host `frame 0` 的输入先写入 runtime，再执行 `_update60()`；若不存在则按 30 Hz 计划执行 `_update()`，随后执行 `_draw()` 并 yield。其 logical slice ordinal 在 30 Hz 为 2、60 Hz 为 3，因为 startup epoch 已 commit。
3. 帧检查点在 draw/yield 返回后、下一帧输入写入前采集。
4. 该帧产生的音频样本归属于同一帧区间。

custom-loop manifest 必须显式声明 lifecycle；其 host `frame 0` 在锁存输入后从 startup `flip()` continuation resume 到下一个 `flip()`，不伪造 `_update/_draw` callback。

官方 Web Player capture 已对比 custom 首八次 `flip()`、callback 30/60 Hz 的 top-level、`_init` 和 update clock：startup 固定为 `1/30s`，首次 startup `flip()` commit 1 个 30 Hz slice。结构化证据见 [`phase-0e-official-clock.json`](./evidence/phase-0e-official-clock.json)；golden 必须同时断言 guest clock、`completedSlices` 与独立 `frameId`，禁止只偏移截图编号。

输入 trace 记录“状态变化”，而不是依赖浏览器事件时间戳。例如：

```json
{
  "schema": 1,
  "fps": 60,
  "events": [
    { "frame": 0, "player": 0, "button": "left", "down": true },
    { "frame": 4, "player": 0, "button": "left", "down": false },
    { "frame": 8, "player": 0, "button": "x", "down": true },
    { "frame": 9, "player": 0, "button": "x", "down": false }
  ]
}
```

`btnp()` 的首次按下、repeat 延迟、30/60 Hz 差异以及 focus 丢失后的清键必须分别测试。

## 5. 单元测试与属性测试

单元测试应尽可能不启动浏览器；涉及 WASM ABI 的测试使用真实编译产物，而不是 mock。

### 5.1 必测模块

| 模块 | 必测行为 |
| --- | --- |
| `.p8` parser | section 顺序、缺失/重复 section、换行格式、Unicode/原始 byte 边界、版本行、最大尺寸、错误位置 |
| `.p8.png` parser | PNG signature/IHDR、scanline filter 0–4、IDAT 拆分、CRC、截断、非法尺寸/色型、最低位 cart 数据提取、两类代码压缩、解压上限 |
| P8 fixed-point ABI | Q16.16 正负值、溢出、移位、除零、`-0`、raw `int32` 往返，JS 不得提前转浮点 |
| P8SCII/string ABI | pointer + byte length、内嵌 NUL、非 UTF-8 byte、空串、生命周期、固定 WASM memory 压力下 view identity 不变 |
| Pico RAM | 64 KiB 边界、little-endian、nibble pixel、gfx/map/screen remap、`memcpy` 重叠、`reload`/`cstore` 范围 |
| Graphics | clip、camera、palette、transparency、draw state、坐标截断、翻转、sprite/map/tline、屏幕 remap、自定义字体 |
| Audio | note 解码、4 channel 分配、SFX loop、music pattern、effect、停止/切换、逐帧调度、重采样 |
| Input | 8 players 位图、`btn`/`btnp`、键盘映射、Gamepad、mouse、touch、blur/visibility 清理 |
| Scheduler | `_update` 30 Hz、`_update60` 60 Hz、`flip()`、长帧追赶上限、暂停/恢复、无 update/draw 的 cart |
| Persistence | `cartdata` namespace、256 bytes、首次读取、写入失败、并发实例隔离、重启恢复 |
| Worker protocol | 消息版本、非法消息、重复响应、加载/运行/暂停/销毁状态机、崩溃与重建 |
| Renderer | 4-bit framebuffer 到 RGBA、默认/扩展 palette、nearest-neighbor、整数缩放、DPR 和 resize |

### 5.2 z8lua/WASM 专项

- 运行 z8lua 上游可用的 parser/VM 测试，并增加 P8 Lua 方言回归：short-if、`?`、复合赋值、位操作、table、coroutine、multiple return 和 16.16 数值行为。
- 对每个 import/export 校验参数个数、类型、nil/default、错误传播和多返回值。
- 对 `@/%/$` 覆盖 `0x0000..0xffff`、负值/地址 wrap、`0xffff` 附近的 multi-byte read，以及 `0x5f54/0x5f55` GFX/SCREEN remap；结果必须与 `peek/peek2/peek4` 和 RAM golden 一致。
- 以随机 raw `int32` 做至少 10,000 组 Q16.16 ABI 往返属性测试。
- 以随机 byte array 做至少 10,000 组 P8SCII 往返属性测试；不得把 JS Unicode equality 当作 byte equality。
- native z8lua harness 在 nightly 使用 ASan + UBSan；WASM build 另做越界和 trap 映射测试。

### 5.3 覆盖率门禁

- 整体语句覆盖率不低于 90%，分支覆盖率不低于 85%。
- cart parser、decompressor、RAM、fixed-point bridge、Worker state machine 等关键模块：语句不低于 95%，分支不低于 90%。
- 覆盖率下降超过 0.5 个百分点时 PR 失败，除非同时删除不可达代码且给出说明。
- API 行为覆盖率独立统计：每个标为 `implemented` 的 PICO-8 API 必须映射到至少一个 conformance case。代码覆盖率不能豁免此项。

## 6. Conformance carts

Conformance cart 是兼容性工作的最小事实单元。每个 cart 应只验证一个主要行为，通常在 1–120 帧内完成，不依赖网络、真实时间或第三方素材。

### 6.1 设计要求

- case ID 使用 `<area>/<feature>-<variant>`，例如 `gfx/pal-transparent`、`memory/screen-remap`、`input/btnp-repeat-30`、`lua/fix16-overflow`。
- cart 源码和素材由项目原创，并随仓库许可证明确授权。
- 测试必须初始化自己读取的 RAM/draw/audio 状态，避免依赖官方或本实现的未初始化字节。
- 一个 case 同时发现多个差异时，应继续拆小，直到失败能指向一个 API 或一组不可分行为。
- 每个 case manifest 链接官方手册章节；测试未公开行为时，记录参考 PICO-8 版本、平台和复现实验。
- 无效输入行为若官方未保证，不得擅自断言；可以只测试“不崩溃、不越界”。

建议 manifest：

```json
{
  "schema": 1,
  "id": "gfx/pal-transparent",
  "spec": "PICO-8 0.2.7 manual §6.2",
  "cart": "../carts/gfx/pal-transparent.p8",
  "runtime": { "fps": 60, "seedRaw": 305419896 },
  "inputTrace": null,
  "checkpoints": [
    {
      "phase": "boot",
      "ramRanges": [{ "start": 24320, "length": 128 }]
    },
    {
      "frame": 0,
      "screen": true,
      "ramRanges": [{ "start": 24320, "length": 8320 }]
    }
  ],
  "reference": {
    "implementation": "PICO-8",
    "version": "0.2.7",
    "capturedOn": "macOS",
    "capturedAt": "YYYY-MM-DD"
  }
}
```

十进制地址用于保持 JSON 有效；审阅 UI 应同时显示十六进制地址。

### 6.2 最低 conformance 面

在宣称 Player MVP 前，至少覆盖：

- cart：`.p8`、`.p8.png`、旧/新压缩格式、cart version。
- program lifecycle：`_init`、`_update`、`_update60`、`_draw`、`flip`、error。
- P8 Lua：数值、table、string/P8SCII、coroutine、random、主要语法扩展。
- memory：`peek/poke` 各宽度、`memcpy/memset`、base RAM layout、gfx/map/screen remap。
- graphics：所有已标记 implemented 的绘图 API、draw state、palette、clip/camera、text/custom font。
- map/sprite：shared region、flags、flip、scaling、边界裁剪。
- input：2 个以上 player、`btnp` repeat、键盘/Gamepad/touch 状态。
- audio：SFX、music、四声道、loop、effects、stop/fade、浏览器重采样。
- persistence：`cartdata/dget/dset` 的生命周期和隔离。
- host behavior：pause/resume、visibility、cart reload、Worker crash/hang recovery。

## 7. Golden：framebuffer、RAM 与 audio

### 7.1 通用规则

- 所有二进制 golden 使用 SHA-256，并在 manifest 中记录长度和 hash。
- Golden 路径绑定参考 PICO-8 版本；升级参考版本必须新建目录并生成差异报告，不能覆盖旧目录。
- PR 不允许自动执行 `--update` 后直接合并。每次更新必须说明规范依据、展示前后差异，并由非作者审阅。
- Golden 生成器输出必须稳定：相同输入重复 20 次，hash 必须完全一致。
- 预览 PNG、波形图或日志只服务人工审阅，binary/index data 才是自动化 oracle。

### 7.2 Framebuffer

逻辑 framebuffer oracle 是 128×128、每像素 4-bit palette index，而不是浏览器最终 RGBA 截图。

- 首选保存屏幕 RAM 对应的 8192 bytes packed indices；比较必须逐 byte 精确。
- 同时生成 128×128 无缩放 PNG 供审阅，解码后比较 palette index，忽略 PNG metadata 和编码差异。
- renderer 集成测试另外比较 RGBA；默认 palette 下必须逐像素精确。
- CSS scaling、DPR、letterbox 和 nearest-neighbor 使用浏览器截图测试，不与 VM framebuffer golden 混在一起。
- 失败报告必须生成 expected、actual 和 diff 三张图，并给出首个差异坐标、差异像素数和 bounding box。

### 7.3 RAM

- 本 runtime 可直接抓取完整 65,536-byte base RAM，但 case manifest 应声明有意义的 range 和 mask，避免把明确的宿主/易变寄存器误当规范。
- screen、gfx、map、draw state、hardware state、persistent data 分区分别报告 hash；不能只给一个全 RAM hash。
- 比较前不能“标准化”掉未预期的变化。只有 manifest 明确列出的 mask 才可忽略 byte。
- 官方 PICO-8 不暴露宿主内存时，由 conformance cart 使用文档化 API 对指定 range 计算/输出 digest；不要通过修改官方二进制或读取其进程内存制作基准。
- RAM 失败报告给出首个差异地址、连续差异区间和 hex diff。

### 7.4 Audio

音频分两层验证：

1. 内部确定性回归：项目固定 `22,050 Hz`、mono、signed 16-bit little-endian 作为 canonical test PCM。这是本项目的测试格式，不宣称为官方公开硬件规格。结果必须与受审 golden sample-exact、SHA-256 完全一致；相同 build 和输入重复运行也必须完全一致。
2. 官方差分：官方输出可能受平台音频链和重采样影响，因此不要求文件 hash 相同；比较 note/event 时序、基频、包络、RMS、频谱和 loop 点。

官方差分默认容限：

- note onset/stop：canonical rate 下误差不超过 1 sample；若参考捕获经过系统 mixer，则不超过 2 ms。
- 稳态基频：误差不超过 1 cent。
- SFX/music 总时长与 loop point：误差不超过 1 sample 或 0.1%，取较大者；系统捕获不超过 2 ms。
- 数字直出且已对齐时，归一化 RMS error 不高于 -40 dB；系统捕获只作趋势检查，容限必须在 case 中显式记录。
- 不得用较宽的全局容限掩盖单个 effect 的已知错误。需要放宽时只作用于该 case，并登记已知差异。

浏览器输出另测 44.1 kHz、48 kHz AudioContext 重采样、AudioWorklet chunk 边界、mute/resume 和 underrun；这些结果不改变 canonical PCM。

## 8. 参考实现差分

### 8.1 Oracle 规则

官方 PICO-8 是唯一规范性运行 oracle。使用时记录：

- 精确版本和 build（至少主版本字符串）。
- OS/CPU；音频差分还要记录设备采样率和捕获路径。
- cart SHA-256、输入 trace SHA-256、随机种子和捕获工具版本。
- 重复运行次数及是否完全稳定。

官方可执行文件是用户本地、合法安装的外部依赖：

- 不提交到仓库、不放 CI artifact、不打进 Docker image。
- 差分命令仅在显式提供 `PICO8_BIN`（或项目最终采用的等价配置）时启用。
- CI 使用经过审阅且可分发的结果 golden，不下载官方程序。

fake-08 可以作为第二参考，定位结果采用三方表：

| 官方 PICO-8 | 本项目 | fake-08 | 结论 |
| --- | --- | --- | --- |
| A | A | A | 通过 |
| A | B | A | 本项目 bug |
| A | A | B | fake-08 差异，不影响本项目 |
| A | B | B | 两个开源实现可能共享差异，仍是本项目 bug |
| 不稳定/未知 | A | B | 规范歧义，先最小化并补证据 |

### 8.2 差分工作流

1. 在项目原创的最小 cart 上固定种子和输入 trace。
2. 官方参考至少重复 3 次；任何不稳定 byte 先查时钟、未初始化 RAM 和平台状态。
3. 捕获 palette indices、指定 RAM digest、事件日志和必要时的音频。
4. 在本项目运行同一 cart；首个差异帧即停止，并输出前一帧与当前帧状态。
5. 可选运行 fake-08，帮助判断是 parser、VM、API 还是测试假设问题。
6. 修复后把最小复现留作 regression，不以大型游戏代替。

不得仅靠肉眼观看最终画面认定差分通过。

## 9. Fuzz、恶意输入与资源上限

Fuzz 的目标不是“接受一切”，而是保证 parser/VM 有清晰上限：合法输入正确，非法输入快速、可解释地失败，不崩溃、不越界、不永久占用 Worker。

### 9.1 Fuzz targets

- `.p8` section parser 和代码提取。
- PNG chunk/IHDR/IDAT/filter parser。
- cart data LSB 提取及旧、新代码 decompressor。
- z8lua lexer/parser/bytecode loader。
- P8SCII decoder、control code parser 和 custom font。
- JS↔WASM 数值、string、table/multi-return ABI。
- memory API 的随机地址、长度、overlap 和 remap 组合。
- graphics/audio API 的随机但类型合法参数。
- Worker 消息协议、乱序、重复、截断消息。

### 9.2 默认安全界限

- 上传的单文件默认不超过 4 MiB；产品若调整必须有资源评估和测试。
- `.p8.png` 必须先验证预期尺寸和可支持的 PNG 格式，再解压；根据 IHDR 预计算最大输出，禁止无界 inflate 和无界 ancillary chunk 累积。
- cart 解码结果不得超过格式允许的 cart 大小；代码 decompressor 在写入前检查目标上限。
- parser 单 case 在参考 CI 机器上 100 ms 内完成；超时按失败处理。
- 单帧 fuzz 执行 250 ms 未返回时由宿主终止 Worker；不得依赖 VM 自己有机会抛异常。
- WASM linear memory 设硬上限并在 manifest/build config 中可见；首版建议最大 64 MiB。提高上限需要专门 ADR 和 OOM 测试。

### 9.3 运行量和回归

- PR：每个纯 parser target 至少 60 秒或 10,000 cases，先到者为准；固定 regression corpus 全量运行。
- Nightly：每个 target 至少 30 分钟，native z8lua build 同时启用 ASan/UBSan。
- Release candidate：累计至少 10^7 个新增 cases，且最近 7 天无未归档 crash/hang。
- 每个独立 crash/hang/OOB 都要最小化；修复后输入进入 `tests/fuzz/regressions/`，文件名包含 issue ID 和 SHA-256 前缀。
- Fuzz 失败 artifact 只能包含项目可分发输入。若来自本地第三方 cart，只提交项目原创的最小复现，不上传原 cart 或变异副本。

## 10. JS↔WASM microbench 与性能门禁

性能测试必须使用 production build、固定浏览器版本和固定 runner。共享云 runner 的绝对时间只做告警；硬门禁运行在项目登记的固定性能 runner，并同时比较同机 main 分支。

### 10.1 Microbench 项目

至少测量：

- WASM export no-op 和 WASM import no-op。
- 单个 raw Q16.16 参数和多参数 API 往返。
- pointer + length 的 P8SCII 读取，长度 0/8/64/1024。
- `peek/poke`、`pset/pget` 的逐调用路径。
- `spr/sspr/map` 的粗粒度路径。
- 固定 WASM memory 在 heap/OOM stress 前后保持同一 buffer/view identity，失败分配受控返回而不 detach view。
- 每帧 framebuffer copy；目标架构为共享 view 时应证明没有多余 copy。

每项先 warm-up 100 轮，再测至少 30 轮，报告 median、p95、p99、calls/s 和 allocation。单次样本短于 100 ms 时在内部循环放大，避免计时器噪声。

Phase 0C 已把 bridge-only 子集锁定在
`benchmarks/interop/case-manifest.json`：四路径必须先通过 result checksum、完整
64 KiB RAM hash 与 fixed-buffer identity，再允许 timing；统计使用 R-7 quantile。
Chrome DedicatedWorker 不暴露 `performance.memory` 时 allocation 必须记为
`unavailable`，不能填 0。实测与浏览器缺失状态见
[Phase 0C 证据](./evidence/phase-0/14-phase-0c-evidence.md)。后续 framebuffer copy、完整
`pget/sspr/map`、audio 和 representative cart benchmark 是增量场景，不得改写
Phase 0C 原始 contract 或结果。

### 10.2 场景预算

固定桌面性能 runner 上的初始门禁：

| 场景 | 工作量 | p95 预算 |
| --- | ---: | ---: |
| pixel stress | 单帧 16,384 次 `pset` | runtime + draw ≤ 5 ms |
| memory bridge | 65,536 组 `peek` + `poke` | ≤ 4 ms |
| sprite stress | 4,096 个 8×8 `spr`，含裁剪 | ≤ 8 ms |
| ordinary 60 Hz cart | VM + APIs + audio generation | ≤ 8 ms/frame |
| ordinary 30 Hz cart | VM + APIs + audio generation | ≤ 12 ms/update |

这些绝对值在首个固定 runner 建立时校准一次；若硬件证明不适合，可以通过 ADR 修改，但不能在性能回归 PR 中顺手放宽。

所有 benchmark 还必须满足：

- 相对 main 的 median 或 p95 退化超过 10%，并且重复测量仍出现时，PR 失败。
- 单项退化 5%–10% 产生告警并要求说明。
- desktop 基准环境中主线程 frame present 的 p95 不超过 4 ms。
- input snapshot 到对应 logical update 的延迟不超过 1 logical frame；浏览器 compositor/display 延迟单独报告。
- Runtime 到 renderer 每帧不得复制超过必要的一份 128×128 RGBA payload；共享 screen view 路径还要单独报告实际 copy bytes。
- steady-state hot path warm-up 后不应产生逐 API 调用对象；10,000 帧运行的 live heap 增长不超过 1 MiB（不含明确缓存）。
- AudioContext 解锁并完成 case manifest 规定的 prebuffer 后才开始 60 Hz 10 分钟 soak 计量；窗口内 missed frame 不超过 0.1%，audio underrun 为 0。启动前事件必须单独记录，不能拿来豁免稳态失败。
- 浏览器主线程在加载完成后不得因 runtime 产生超过 50 ms 的 long task；cart 代码运行在 Worker。

PICO-8 手册描述了约 4M VM instructions/s 的虚拟 CPU 口径。项目必须另外建立 CPU-budget conformance cart，验证 `stat(1)`、30/60 Hz 和超预算行为；宿主机器更快不能使 cart 获得无限制的逻辑 CPU。

## 11. Chrome/Chromium 支持矩阵

### 11.1 支持层级

| 层级 | 平台 | 合并/发布要求 |
| --- | --- | --- |
| Tier A | Google Chrome stable，桌面 | 发布阻断；核心播放、输入、音频、存储全部通过 |
| Tier B | Chromium stable/headless，桌面或固定 CI image | PR/发布阻断；与 Tier A 使用同一行为 contract |
| Tier M | Android Chrome stable（仅当该 release 声明移动支持） | 移动 release 阻断；至少一台中端 Android 真机 |

Firefox、Safari/WebKit、iOS Safari 及其他引擎明确不在当前支持、测试或发布承诺
内。新增引擎属于产品范围变更，必须先更新本文、CI 与用户文档，不能仅增加一个
偶发 smoke 后宣称支持。

### 11.2 浏览器用例

Chrome/Chromium 至少覆盖：

- `WebAssembly.instantiateStreaming` 及 MIME 不正确时的 ArrayBuffer fallback。
- module Worker 创建、加载、销毁、异常映射和 CSP 场景。
- 非 cross-origin-isolated 环境可播放；首版不得把 SharedArrayBuffer 当作必要条件。
- Canvas 2D/WebGL 最终采用路径的 128×128 palette、nearest-neighbor、resize、fullscreen、DPR 1/2/非整数。
- Keyboard `code` 映射、阻止页面滚动、focus/blur 清键、Gamepad connect/disconnect。
- AudioContext 用户手势解锁、44.1/48 kHz、suspend/resume、设备切换后恢复、静音。
- Window 创建并转交专用 audio `MessagePort`；旧 `sessionGeneration` PCM、reset/underrun/overrun 和 fallback relay 路径按 ADR 分别验证，控制协议不得意外携带 PCM。
- IndexedDB 可用、被拒绝、quota/error 和 private mode 下的降级。
- 页面 visibility、后台节流、前进后退缓存和 tab 恢复。
- 正常 HTTP header 与 COOP/COEP 环境各一次，避免可选优化改变行为。

### 11.3 Android Chrome 真机门禁（仅移动 release）

- Android：真实 Chrome stable，至少一台 4–6 GiB RAM 的中端设备；不能只用桌面 DevTools throttling。
- AudioContext 解锁/prebuffer 后连续播放 30 分钟：无 crash、无可感知音画漂移、audio underrun 为 0、输入不粘键；启动前事件单独记录。
- 60 Hz 标准 cart：p95 runtime frame ≤ 12 ms，p99 ≤ 16.7 ms，missed frame ≤ 0.5%。
- 触控到下一可见响应 p95 ≤ 100 ms；旋转/resize 后 500 ms 内恢复正确画面与输入坐标。
- 用户首次手势后 500 ms 内开始音频；后台返回后 1 s 内恢复，或展示明确的“点击恢复音频”状态。
- 10 次装载/退出不同 cart 后，活动 Worker、AudioWorklet、RAF 和事件监听器数量回到基线；live heap 增长不超过 8 MiB。

## 12. Worker hang、crash 与恢复

必须提供专门的恶意/故障 carts：

- `_init()` 中 `while true do end`。
- update 中无限循环。
- 无界递归/stack overflow。
- 持续 table/string 分配直至 VM memory limit。
- WASM trap、JS import throw、非法 Worker response。
- 每帧刚好低于和刚好高于 CPU budget 的 busy loop。

前台恢复门禁：

1. Host 发送 frame 命令时启动 watchdog；250 ms 未收到完成/heartbeat，判定 hung。
2. 判定后 100 ms 内停止/淡出该实例音频并终止 Worker。
3. 总计 750 ms 内 UI 显示可操作错误状态，主线程仍能响应按钮。
4. 用户选择重试时创建全新 Worker/VM；不复用可能污染的 linear memory。
5. 20 次连续 hang→recover 后，活动 Worker 恰为 1、音频节点不累积、事件监听器不累积，live heap 增长不超过 8 MiB。

页面处于 hidden 状态时浏览器会节流 timer，因此不能直接把超时当 hang：

- hidden 前暂停提交新帧并挂起严格 watchdog。
- visible 后给予 1 s heartbeat grace；失败再终止重建。
- 恢复时不做无限 catch-up，最多按 scheduler 规定的有限帧追赶，其余时间丢弃。
- hang/cart error 不得清除已提交的持久化数据，但未完成事务不得被当作成功。

错误 UI 和日志必须区分：cart Lua error、instruction/CPU budget、memory limit、WASM trap、worker protocol error、host timeout。

## 13. 测试数据版权与 BBS 访问限制

这一节是工程门禁，不是法律意见。发布前仍应由项目负责人核验最新条款。

截至 2026-08-05，[Lexaloffle Terms of Use](https://www.lexaloffle.com/info.php?page=tos) 页面标注更新于 2026-06-22，并明确说明：

- BBS 上的 cart 和其他作品默认仍属于各自作者；没有作者许可或适用许可证时，不应分发或 remix。
- Lexaloffle 网站和在线服务原则上只供人通过浏览器或 Lexaloffle 软件使用；未经 Lexaloffle 及相关作者许可，不应由自动脚本、第三方客户端、crawler 或其他自动系统访问（条款列出的搜索索引/归档例外不适用于本项目测试）。

因此必须执行：

- CI、fuzzer、benchmark、crawler、BBS URL resolver 测试均不得访问 `lexaloffle.com` 或其 cart endpoint。
- 不自动抓取、镜像、缓存、批量枚举 BBS cart；不要用 CORS proxy 绕过限制。
- 仓库和 CI artifact 只包含项目原创 test cart，或有明确、兼容且已履行归属要求的资产。默认选择项目原创。
- 官方 demo cart、BBS cart、商业 cart 和 PICO-8 可执行文件均不得因为“网上可下载”而提交。
- 外部兼容 corpus 只允许由开发者在本地显式配置。仓库仅保存 schema；默认 gitignore/测试工具应防止把实际 cart 上传（相关 ignore 规则在基础设施落地时添加）。
- 即使开发者通过正常人工渠道取得 cart，也要确认其许可是否允许复制到测试仓库或 artifact。没有分发许可时，只能本地临时运行，不上传原文件、截图、音频或变异副本。
- Bug 报告默认记录 cart 自述名称/版本、SHA-256 和授权状态；附件必须是项目原创最小复现。仅有 BBS cart 才能复现时，先请求作者许可或由有权访问者本地诊断。
- CC4-BY-NC-SA 等有条件许可的 cart 必须隔离记录作者、来源、许可证版本、attribution、非商业和 ShareAlike 义务；不能因为可搜索到 CC 标记就自动下载。
- 每次 release candidate 重新核验官方 Terms 更新时间。条款变化时先暂停相关流程，再更新本文和产品设计。

允许且推荐的核心兼容 corpus 是：项目成员专门编写、只使用原创代码/像素/音频、明确随仓库许可发布的 conformance carts。测试第三方真实游戏是补充证据，不能成为可复现 CI 的必要条件。

## 14. CI 分层

### 14.1 PR fast gate（每个 PR，目标 ≤ 10 分钟）

- build、typecheck、lint、license/fixture provenance 检查。
- 全量 unit/property tests 和关键模块覆盖率。
- `tier: core` conformance carts，全量 binary golden。
- Chrome/Chromium 一个核心 smoke。
- parser fuzz 每 target 60 秒或 10,000 cases。
- Worker hang/recovery 基础用例。
- microbench 相对 main 的快速回归；共享 runner 只告警，固定 runner 才阻断。

### 14.2 Nightly gate（每日）

- 全量 conformance、所有输入 traces 和所有 golden。
- 全量 Chrome/Chromium 版本矩阵。
- 每个 fuzz target 30 分钟；native z8lua ASan/UBSan。
- 固定 runner 完整 performance suite。
- 30 分钟运行时和音频 soak；20 次 hang/crash/reload 循环。
- 与已提交官方 golden 的差分；有本地官方依赖的受控 runner 可额外重放，但不得联网 BBS。

### 14.3 Weekly/device gate（每周）

- Chrome stable 桌面；声明移动支持时再加入 Android Chrome 真机。
- 键盘、Gamepad、touch、音频 unlock、后台恢复、方向变化。
- 30 分钟真机 soak、内存和温度/降频后的性能记录。
- 本地外部授权 corpus 可以在私有 runner 上运行，但结果不得携带未授权 cart/artifact。

### 14.4 Release candidate gate

- 第 16 节 DoD 全部满足。
- Tier A/B 无遗漏；声明移动支持时 Tier M 也必须无遗漏。支持范围内的“未运行”项
  有明确阻断或经负责人书面接受。
- 重放全部历史 regression 和最新 fuzz corpus。
- 核验官方手册版本、Terms 更新时间、第三方依赖许可证和测试资产清单。
- 对 reference golden 更新逐项人工审阅，不允许大批量无解释变化。
- 生成兼容性报告、已知差异和性能报告，并与 release artifact 的 commit/build ID 绑定。

## 15. 兼容等级、已知差异与质量口径

### 15.1 功能状态

每个 API/行为使用以下状态之一：

- `exact`：项目 conformance 与官方参考在声明的精确/tolerance 范围内通过。
- `compatible`：行为可用，存在不影响典型 cart 的已记录平台差异。
- `partial`：只支持参数/模式子集，用户可能遇到明显问题。
- `unsupported`：明确未实现或 Player 范围外。
- `unknown`：尚无足够测试，不能视为支持。

只有 `exact` 和 `compatible` 可以计入“已支持”。`implemented` 但没有 conformance case 时必须标为 `unknown`。

### 15.2 Cart 结果

以下 `C*` 是单个 cart/revision 的实测结果，不替代 [范围文档](./01-scope-and-success-criteria.md) 中描述发布能力的 `L0`–`L3` 等级。

| 等级 | 定义 |
| --- | --- |
| C3 Verified | 固定 trace 下 framebuffer/RAM 精确，audio 在容限内；关键流程由官方参考验证 |
| C2 Playable | 至少 15 分钟或完整关键流程可玩，无 crash、软锁、输入/存档丢失；仅有已知轻微视听差异 |
| C1 Boots | 能加载并进入交互，但存在影响玩法、画面、音频或进度的差异 |
| C0 Fails | 无法解析/启动，崩溃、挂死、主要输入失效或核心流程不可达 |
| CU Untested | 没有足够、合法且可重复的证据 |

等级必须绑定 player build、cart SHA-256、测试时长/trace 和浏览器；不能把一个版本的结果永久继承到新 revision。

兼容率只在明确、合法的 corpus 内计算：

```text
playable_rate = (C2 + C3) / (C0 + C1 + C2 + C3)
```

`CU` 不进入分母，也不能当通过。报告必须同时给出 corpus 大小，禁止只报百分比。

### 15.3 已知差异登记

每个未修复差异至少记录：

- issue ID、标题、首次发现/最后验证日期。
- 对应手册/API、最小原创复现 case。
- 官方结果、本项目结果、首个差异帧和 artifact hash。
- 影响的浏览器、cart version、功能状态和 cart 等级。
- 严重度、用户可见症状、workaround。
- 技术原因、owner、目标 milestone；无计划修复时说明原因。
- 是否需要对用户文档、兼容性声明或 golden tolerance 做调整。

严重度：

- P0：安全边界突破、宿主页崩溃/不可恢复卡死、持久化数据损坏。
- P1：合法 core cart 无法启动/继续，广泛错误的 VM/RAM/输入/音频时序，Worker 无法恢复。
- P2：特定 API/模式明显不兼容但有规避方式，或部分 cart 的可玩性受损。
- P3：轻微视觉/听觉/性能差异，不影响核心玩法。

### 15.4 Phase 0A P8 Lua baseline 矩阵

本表只记录 [Phase 0A artifact](./evidence/phase-0/12-phase-0a-evidence.md) 的 z8lua baseline，
不等同于完整 Player API 支持。没有正版 PICO-8 capture 的项目保持 `unknown`，即使
上游 fixture 已稳定。

| 行为 | Phase 0A 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| short-if、`?`、compound assignment | z8lua/WASM fixture passed | `unknown`（尚无官方 capture） | official differential 收录最小原创 cart |
| Q16.16 wrap 与 division-by-zero | raw bits fixture passed | `unknown`（baseline locked） | 与 PICO-8 0.2.7 edge capture 对比 |
| `sin/cos` | raw table result deterministic | `unknown`（baseline locked） | official differential 扩充角度边界 |
| coroutine yield/return | nested Lua fixture passed | `unknown`（仅 VM 语义） | Phase 0E 验证 frame/host continuation |
| `^` power | `2^0.5` baseline raw = `92681` | `partial` / Known Difference | 上游明确使用 floating point；不得宣称 bit-exact |
| `@/%/$` lower/upper/remap | Phase 0A artifact 未实现；已由后续 Phase 0B artifact 取代 | `unsupported`（仅 Phase 0A 历史 artifact） | 见下表与 ADR-013 |

`^` 的当前记录是 upstream-declared difference，不伪造未知的官方 raw expected。
获得合法官方 capture 后，必须补充官方值、artifact hash、PICO-8 版本和平台。

### 15.5 Phase 0B Shared Pico RAM 矩阵

本表只记录 [Phase 0B artifact](./evidence/phase-0/13-phase-0b-evidence.md) 的 RAM boundary，不代表
完整 memory/graphics API 或 cart lifecycle 已实现。手册明确项目可标为
`implemented-baseline`；未定义/尚无正版 capture 的行为保持 `unknown`。

| 行为 | Phase 0B 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| physical 64 KiB / lower+upper alias | Lua direct/API 与 JS 双向 passed | `implemented-baseline` | production `VmPort/PicoRam` 复用 lease，不另分配 |
| negative / 16-bit address wrap | `-1`、`-0.5`、超 `0xffff` passed | `implemented-baseline` | official edge capture 扩充 invalid/fraction corpus |
| `peek2/peek4` little-endian + `0xffff` wrap | direct/API raw bits 一致 passed | `implemented-baseline` | 保留逐-byte mapper 回归 |
| GFX/SCREEN documented bases | `00/60/80/a0/c0/e0` 两窗口 passed | `implemented-baseline` | graphics/API 实现必须调用 canonical mapper |
| invalid `0x5f54/55` base | 防御性回退对应 default | `unknown` | 正版 PICO-8 capture 前不宣称兼容 |
| context reset 初态 | 全零 + `5f54=00`,`5f55=60` | `implemented-baseline`（仅 Shared RAM） | cart-run/reset matrix 留给 Phase 1 official golden |
| fixed memory/OOM | descriptor 256/256 pages；growth/heap pressure 受控 | `implemented-baseline` | 代表 cart corpus 继续校准 production sizing |

### 15.6 Phase 0E Coroutine Frame Slice 矩阵

本表只覆盖 [Phase 0E evidence](./evidence/phase-0/16-phase-0e-evidence.md) 的 lifecycle/safety slice，
不把最小 `cls/pset/btn` 宣称为完整 API conformance。startup time 已由官方 Web
Player capture 锁定；custom 60 Hz/fps-selection 仍留给后续 conformance。

| 行为 | Phase 0E 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| `_init/_update60/_draw` lifecycle | 1/60/60 counters、60 frame boundaries passed | `implemented-baseline` | official representative cart differential |
| `_update60` 优先于 `_update` | 0/60 counters passed | `implemented-baseline` | dynamic callback replacement 另测 |
| callback 30/60 Hz logical time | startup `1/30s`；60 steps → slices 61/62 passed | `implemented-baseline` | slow-frame multi-update policy 后续 |
| top-level custom `flip()` | official samples 1..8；startup + 后续 60 boundaries passed | `implemented-baseline`（30 Hz） | custom fps-selection 后续 |
| root HostRequest continuation | embedded-NUL request/response、一次 frame passed | `implemented-prototype` | 用真实同步-cache API 替换非公开 probe |
| nested HostRequest/`flip()` | host side-effect 未发出；structured unsupported | `unsupported` | `nested-host-suspend`；L3 只用预供给/同步 cache |
| instruction budget | infinite Lua loop → poisoned fault；不可再 step | `implemented-safety` | Phase 4 校准官方 CPU cost，不改变 hard limit |
| Worker watchdog | Chrome JS stall → terminate/recreate/generation passed | `implemented-safety` | boot/step deadline 与 background policy 后续校准 |
| Lua error record | phase/line/safe trace passed | `implemented-baseline` | Wasm trap/JS import/OOM 分类 corpus 继续扩充 |
| minimal framebuffer | packed screen golden SHA-256 locked | `implemented-probe` | Phase 0F presenter 已通过；Phase 1 graphics conformance |

### 15.7 Phase 0F Browser Boundary 矩阵

本表只覆盖 [Phase 0F evidence](./evidence/phase-0/17-phase-0f-evidence.md) 的 browser
presenter、PCM transport 和 lifecycle composition，不代表完整 Graphics、AudioSynth 或
Player UI 已实现。

| 行为 | Phase 0F 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| packed 4bpp → RGBA / Canvas2D | 128×128 exact RGBA hash；DPR 1/2/1.25 与 fractional resize 无 blended colors | `implemented-boundary` | Phase 1/2 graphics golden 复用 presenter contract |
| present performance/lifetime | 10,000 frames p95 `0.0388 ms`；heap delta `15,156 B`；stale generation/dispose passed | `implemented-boundary` | Chrome 升级时重跑 evidence |
| dedicated PCM transport | 44.1/48 kHz 并发 10 分钟；steady underrun/overrun/drop/discontinuity 均为 `0` | `implemented-boundary` | AudioSynth 实现后保留同一 queue 门禁 |
| queue/resource bound | capacity `66,150`，high water `44,100`；实测 peak `22,406` / `22,530` | `implemented-boundary` | 参数变更必须更新 spec/evidence |
| watchdog/generation/dispose | Worker infinite loop 后 generation `1→2`，frame/audio reattach 与 AudioContext close 通过 | `implemented-integration` | Phase 1 CartSession/UI 复用 composition lifecycle |

### 15.8 Phase 1D L1 Graphics/Input 矩阵

本表只覆盖 Phase 1D 的 player 0 六键与基础 integer raster。测试 cart 和 framebuffer/input
vectors 均为项目原创；完整官方 differential 属于 1F/Phase 2 compatibility gate。

| 行为 | Phase 1D 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| `line/rect/rectfill/circ/circfill` generated dispatch | raw Q16.16、optional、stable id `4..9` 与 stack path passed | `partial` | 1F official representative cart；Phase 2 补完整 draw state |
| packed mapped screen | `0x5f55=0xe0` project vector、nibble/corner/radius/physical bounds passed | `partial` | camera/clip/palette/fillp/bitplane/screen mode deferred |
| pen/polyline state | `0x5f25`、`0x5f35`、`0x5f3c..0x5f3f` reset/readback passed | `implemented-l1` | Phase 2 交互矩阵与 official golden |
| `btn` held / `0x5f4c` | player 0 six bits、update 前可见、invalid player/button passed | `implemented-l1` | multiplayer、pause/mouse/devkit input deferred |
| `btnp` edge/repeat | release/repress、30Hz 15/4、60Hz 30/8、自定义寄存器和 255 disable passed | `implemented-l1` | 1F trace differential；完整 device input 属于后续阶段 |
| input transaction | invalid snapshot 不消费；HostRequest resume 不 double-advance；generation reset passed | `implemented-l1` | Phase 1E physical mapping/scheduling passed；1F trace differential |

### 15.9 Phase 1E Scheduler/Player Shell 矩阵

本表覆盖 project-authored cart 的可执行 player path，不替代 1F original-cart compatibility
matrix，也不声明 audio synthesis、resolver 或完整 device input 已完成。

| 行为 | Phase 1E 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| wall-clock pacing | fake clock 30/60Hz、zero-tick、5-tick cap、backlog drop、pause/resume/non-monotonic anchor passed | `implemented-l1` | 1F real-rAF/custom result见 15.10 |
| Worker/session freshness | distinct Worker/session generation、stale input、in-flight pulse supersession、watchdog byte recovery passed | `implemented-l1` | 1F fault/reset/reload result见 15.10 |
| production composition | text cart decode → CartSession fresh VM → frame event；cold reset/frame id restart passed | `implemented-l1` | 1F generated `.p8.png` matrix passed |
| Chrome player path | real Worker+WASM+rAF、Canvas、keyboard aliases、blur pause、reset/stop/fault UI passed | `implemented-l1` | Phase 1 exit evidence archived |

### 15.10 Phase 1F L1 Exit 矩阵

本表关闭 Phase 1 的 **L1 bounded profile**。三个 cart 和所有像素/code 均为项目原创；Node
real-WASM 与 Chrome production Worker 使用同一 manifest/input trace，完整 8,192-byte screen、
logical clock、reset 和 fresh replay hash 一致。Reviewed raw artifact 与环境见
[Phase 1 evidence](./evidence/phase-1/21-phase-1-l1-exit-evidence.md)。

| Cart / behavior | Phase 1F result | 功能/Cart 状态 | Claim boundary / 后续动作 |
| --- | --- | --- | --- |
| `l1/callback-30-input` | text `.p8`；30Hz callback；held + `btnp`；trace/final/reset exact against reviewed project oracle | `compatible`；bounded flow `C2` | 完整 graphics/device input 仍 Phase 2/3；无 official-exact 声明 |
| `l1/callback-60-p8png` | generated project `.p8.png`；60Hz `_update60`；trace/final/reset exact against reviewed project oracle | `compatible`；bounded flow `C2` | 压缩/codec 广度由 parser suite；代表游戏 corpus 属于 Phase 4 |
| `l1/custom-flip-30` | text `.p8`；top-level `flip()`；trace/final/reset exact against reviewed project oracle | `compatible`；bounded flow `C2` | custom slow-frame/host suspension 未扩大 |
| Chrome real-rAF pacing | callback/custom 30Hz median `33.40/33.20ms`；60Hz `16.00ms`；frame/slice continuous | `compatible`（Chrome desktop L1） | background/slow-frame policy保持 ADR-011；release soak deferred |
| Chrome keyboard visible response | Player 0 position `8→11`；O `btnp` edge visible；无 browser repeat dependence | `compatible`（bounded six-button） | multiplayer/gamepad/touch/devkit input deferred |
| fault/reload | instruction budget fault structured；main responsive；generation `4→5`；valid cart reloaded | `compatible` host-safety path | CPU cost calibration Phase 4；hard Worker hang由 0F/1E gate继续覆盖 |
| ordinary 60Hz performance | 120 measured Worker round-trips；p95 `0.1001ms`；`>16.67ms` `0/120` | gate passed | 只适用于 ordinary L1 cart；Phase 2/4 stress corpus 必须另测 |

三个 bounded flows 均完成完整关键流程，所以按 15.2 记 `C2`；它们不是 MVP 代表游戏
corpus，`3/3` 不作为第三方 playable rate，也不授予 C3。当前 Known Differences：

- Phase 2E 已关闭 standard-4bpp palette/clip/camera/基础图元、sprite/map、tile-precision
  `tline` 与 visual P8SCII/custom font；P8SCII audio/timed controls、`tline(bits)` precision
  overload 与 advanced screen/bitplane mode 仍 `partial`。
- AudioSynth、persistence、gamepad/touch/multiplayer 和 resolver 仍 `unsupported`/Deferred。
- 未做合法本地官方 executable 的全量 edge differential；project oracle exact 不等于
  official bit-exact，相关 P8 Lua/graphics edge behavior 继续 `unknown`。

以上均为已声明后续范围，不是开放 P0/P1；Phase 1 exit 时开放 P0/P1 为 `0`。

### 15.11 Phase 2A Memory/Host ABI 矩阵

本表覆盖 in-session Base RAM 和 Phase 2 host-call foundation，不包含 Phase 3 的
`reload/cstore/cartdata`，也不把项目 vector 升级为官方 bit-exact。

| 行为 | Phase 2A 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| `peek/poke` variadic | scalar 与 8192 result/value 通过；8193 在 side effect 前结构化失败 | `compatible`（手册边界） | 代表 cart differential 留 Phase 4 |
| width/block memory | unaligned/cross-wrap `peek2/4`、`poke2/4`、overlap-safe `memcpy`、`memset` 通过 | `compatible`（project vectors） | 非法/溢出参数 edge 仍 `unknown` |
| canonical remap | direct/API/RuntimeCore graphics/frame snapshot 在 GFX/SCREEN remap 下收敛 | `compatible`（documented bases） | invalid video base defensive fallback 继续 `unknown` |
| logical-memory port | stable lease、buffer identity、destroy 后 stale rejection、无 browser/WASM concrete type leak | `compatible`（architecture contract） | map resolver 属于 2D，不混入 low-level mapper |
| Host call frame | ABI `0x00010002`、80 bytes、12 scalar slots、presence、byte pointer/length、result/error passed | `implemented-foundation` | byte-string guest behavior已由 2E `print` 完成；multi-return 仍 deferred |
| regression/performance | reproducible artifact、Phase 0C benchmark、Phase 0E/1A/1D 与 Chrome production gates passed | gate passed | graphics stress 从 2B/2C 建立 |

Known Differences：memory API 的未定义 invalid inputs 沿用 defensive/structured error，不宣称
official exact；`reload/cstore/cartdata` 仍 unsupported/deferred。2A 没有开放 P0/P1。

### 15.12 Phase 2B Draw State/Primitive 矩阵

本表只声明 standard 128×128 packed-4bpp。测试 cart、packed-RAM golden 与 Chrome 页面均为
项目原创；advanced screen/bitplane mode 未被标记 compatible。

| 行为 | Phase 2B 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| typed graphics bindings | append-only id `10..18`；boolean scalar、Q16 result、`pal(table)` bounded wrapper passed | `compatible`（2B profile） | sprite flip 已在 2C 复用 boolean lowering |
| RAM-backed draw state | `0x5f00..0x5f3f`、secondary `0x5f60..0x5f6f` default/API/direct-poke 双向 passed | `compatible`（standard 4bpp） | advanced mode 明确 deferred |
| raster ordering | camera→clip→draw palette→fillp、pattern transparency/global secondary/inversion passed | `compatible`（project vectors） | sprite apply-pattern 已由 2C 关闭 |
| primitive golden | existing primitives + reversed/fractional/off-screen oval hash `0f5af6e7…39dcc` deterministic | `compatible`（project golden） | official edge differential 留 2F/Phase 4 |
| display palette boundary | 16-byte RuntimeFrame/Worker DTO、validator/dual transfer、standard+extended RGBA Canvas passed | `compatible`（Chrome 150） | Canvas 禁止读取 RAM/draw state |
| regression/performance | Phase 1D/1E/1F passed；ordinary Worker p95 `0.4001ms`，`>16.67ms` `0/120` | gate passed | sprite stress 从 2C 建立 |

Known Differences：camera/clip 的 undocumented multi-return 不是当前 v0.2.7 manual claim；bitplane、
advanced screen modes 仍未实现；map/tile-precision tline 已由 2D、visual text 已由 2E 关闭。2B 没有开放 P0/P1。

### 15.13 Phase 2C Sprite Sheet/Blitter 矩阵

本表只声明 standard 128×128 packed-4bpp sprite path。测试 cart、RAM/framebuffer golden 与
Chrome 页面均为项目原创；advanced screen/bitplane mode 不在本 unit 的兼容声明内。

| 行为 | Phase 2C 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| typed sprite bindings | append-only id `19..22`；`sspr` 10 scalar/boolean 参数沿用 80-byte frame | `compatible`（2C profile） | map/tline 从 2D 复用同一 host boundary |
| `sget/sset` 与 mapper | low/high nibble、fractional/bounds/custom return、default/explicit palette、direct poke equality passed | `compatible`（documented GFX bases） | invalid remap bases 仍 `unknown` |
| GFX alias | default、screen 与 upper-RAM remap 下 API/direct/frame 共用 canonical mapper | `compatible`（documented bases） | MAP base/width resolver 属于 2D |
| `spr` raster | fractional `w/h`、sheet row boundary、camera/clip、flip、palette/transparency passed | `compatible`（project vectors） | official edge differential 留 2F/Phase 4 |
| `sspr` sampling | up/down scale、negative destination dimensions、source clipping 与 bounded visible iteration passed | `compatible`（project vectors） | negative source dimensions 未作 official-exact 声明 |
| sprite fill pattern | draw palette→secondary pair、pattern transparency；global-secondary primitive regression passed | `compatible`（manual ordering） | map/tline 在 2D 复用同一 sprite pixel path |
| framebuffer/Chrome | packed golden `337c0b37…07180`；production Worker/Canvas pattern 与 negative-scale pixels passed | gate passed（Chrome 150） | 2D 继续保持 transport/presenter 无 tile dependency |

Known Differences：advanced screen/bitplane mode 和 undocumented invalid/overflow input 仍不声明
official exact；map、flags 与 tile-precision `tline` 已由 2D、visual text 已由 2E 关闭。2C 没有开放 P0/P1。

### 15.14 Phase 2D Map/Flags/Tline 矩阵

本表只声明 standard packed-4bpp、tile-coordinate Q16.16 `tline` profile。测试 cart、RAM/
framebuffer golden 与 Chrome 页面均为项目原创；不存在 Canvas/Worker tile-state dependency。

| 行为 | Phase 2D 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| typed map bindings | append-only id `23..28`；`fget/fset` boolean presence 与 9 参数 `tline` 沿用 80-byte frame | `compatible`（2D profile） | `print/cursor` 从 2E 首次消费 byte-string slot |
| map resolver | default/shared lower ring、`0x30..0x3f` alias、upper base、width `128/256/4`、derived height/OOB/direct RAM passed | `compatible`（documented bases） | invalid lower base fallback 仅 defensive，不声明 official exact |
| flags | `0x3000..0x30ff` whole-byte/bit、boolean lowering、direct poke 与 invalid boundaries passed | `compatible`（manual API） | 无第二份 flag cache |
| `map` raster | defaults/explicit range、tile 0 override、layer masks、upper source、camera/clip 与 bounded visible work passed | `compatible`（standard 4bpp） | advanced screen/bitplane mode deferred |
| `tline` sampler | horizontal/diagonal/reversed、default/positive/zero/negative delta、mask/offset、layers、draw state passed | `partial` | v0.2.7 one-argument precision mode `tline(bits)` 留后续兼容阶段 |
| upper arbitration | MAP overlap 使冲突 GFX/SCREEN 回退默认；不重叠 upper video mapping 保持生效 | `compatible`（documented bases） | undocumented invalid register values 仍 `unknown` |
| framebuffer/Chrome | packed golden `c99d9aaf…24e60`；Chrome 150 production Worker/Canvas map+tline pixels passed | gate passed（Chrome 150） | 2F 汇总 project conformance 与性能/恢复门禁 |

Known Differences：`tline(bits)` precision-setting overload、advanced screen/bitplane mode 和未记录
invalid/overflow edge 不在 2D compatible claim；project golden 不等于 official bit-exact。2D 没有开放 P0/P1。

### 15.15 Phase 2E P8SCII/Custom Font 矩阵

本表只声明同步 visual P8SCII、standard packed-4bpp text path。测试 byte arrays、RAM/framebuffer
golden 与 Chrome 页面均为项目原创；字体 bitmap 的固定来源、checkout、hash 和 MIT notice 记录于
[`10-reference-sources.md`](./10-reference-sources.md) 与 RuntimeCore third-party notice。

| 行为 | Phase 2E 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| byte-string host binding | append-only id `29..30`；empty、embedded NUL、non-UTF8、1024 bytes、类型/arity/error 与同步 lifetime passed | `compatible`（2E profile） | async-retained byte view 仍禁止；multi-return deferred |
| `print/cursor` basics | explicit/implicit overload、rightmost return、cursor/pen、NUL/newline/carriage return 与 scroll enable/disable passed | `compatible`（project vectors） | undocumented invalid coordinate edge 仍 `unknown` |
| built-in/custom font | 256 glyph bitmap hash `a36a2826…5ea6`；`0x5600..0x5dff` rows/attrs/adjustments/tab 和 `0x5f58..5b` defaults live-read passed | `compatible`（documented RAM） | external Unicode font shaping 不在 P8SCII runtime scope |
| visual controls | repeat、shift/tab、decorate、foreground/font switch、special modes、one-off、outline 与 raw writes passed | `compatible`（visual synchronous profile） | audio control 无 synth side effect；timed controls 不 suspend |
| raster ordering | camera/clip、foreground/background draw palette、mapped screen、scroll 与 packed framebuffer hash `da6169dd…9f65` deterministic | `compatible`（standard 4bpp） | advanced screen/bitplane mode deferred |
| bounds/fuzz | 65,536-byte input、65,536 glyph、8,388,608 pixel-write、256 nested-control hard caps；10,000 deterministic arrays 无 crash/hang/OOB | gate passed | 代表 cart stress/performance 由 2F 汇总 |
| Chrome boundary | Chrome 150 production Worker/Canvas built-in/custom/one-off/background pixels passed；frame DTO 无 text/font/glyph state | gate passed（Chrome 150） | 2F 汇总同 cart Node/Chrome oracle |

Known Differences：P8SCII audio command 只被同步消费而不产生 AudioSynth side effect，timed delay/
frame-skip commands 不引入 suspension；`tline(bits)`、advanced screen/bitplane mode 仍 deferred。
project golden 不等于 official bit-exact。2E 没有开放 P0/P1。

### 15.16 Phase 2F Graphics/Memory/Text Exit 矩阵

本表汇总 Phase 2A–2F 的 project-owned standard packed-4bpp profile。它只证明机器合同列出的
memory/draw/sprite/map/text 组合在相同 production path 中可复现，不表示第三方 playable rate、
完整官方 differential、advanced video mode 或 Phase 3 audio/input/persistence 已完成。

| 行为 | Phase 2F 结果 | 功能状态 | 后续动作 |
| --- | --- | --- | --- |
| corpus/provenance | `graphics-memory`、`text-remap` 和 resource fault 均为项目原创；source/cart hash 锁定；无 BBS、第三方或 `ref/` dependency | gate passed | Phase 4 代表 corpus 需要独立合法授权与口径 |
| memory/draw/sprite/map | Base RAM widths/block、draw state/primitives、draw/display palette、sprite、map/flags/tline 和 remap 在一个 60Hz flow 中通过 | `compatible`（Phase 2 project profile） | `tline(bits)` 与 advanced video mode 保持 partial/deferred |
| P8SCII/custom font | built-in/custom/one-off/outline/raw write、cursor/default attrs、GFX/SCREEN remap 与 extended display palette 在一个 60Hz flow 中通过 | `compatible`（同步 visual profile） | audio/timed controls 由后续已激活范围处理 |
| Node determinism | 每 cart 两个 fresh real-WASM session；每个 session cold reset；4-frame trace、screen、palette、RGBA 和列出的 RAM region exact | gate passed | oracle 变更必须人工审阅 manifest diff |
| Chrome production path | Worker initial/reset trace 与 Node hash 一致；Canvas RGBA `17614085…a0ae` / `0db0886d…45f6` exact；无 Worker error | gate passed（Chrome 150） | Chrome 版本升级时重跑 reviewed evidence |
| performance | graphics/text 各 20 warm-up + 120 measured；p95 均 `0.4001ms` 以下；`>16.67ms` 均 `0/120` | gate passed（≤8ms） | 不是 Phase 4 stress 或长稳 soak 的替代品 |
| fault/recovery | 65,537-byte print → structured `E_HOST_API`；main responsive；stale generation rejected；generation `3→4` 后有效 cart 出帧 | gate passed | hard hang/watchdog 继续由 Phase 0F/1E regression 覆盖 |

Phase 2 exit 时开放 P0/P1 为 `0`。Known Differences：P8SCII audio/timed controls 不产生
Phase 3 设备语义，`tline(bits)` precision overload 与 advanced screen/bitplane modes deferred；
未记录的 invalid/overflow edge 和未运行的官方/第三方 cart 保持 `unknown`。这些是显式范围边界，
不升级为 official bit-exact 或第三方兼容声明。

## 16. Definition of Done

### 16.1 单个功能或 bugfix

功能只有同时满足以下条件才算完成：

- 有对应规范链接或明确的 Player 范围决策。
- 单元测试覆盖正常、边界和错误路径，关键模块覆盖率未下降。
- 至少一个最小 conformance cart；bugfix 保留 regression。
- framebuffer/RAM/audio 中所有受影响观察面都有 assertion，不只检查“未抛异常”。
- 若行为来自官方观察，记录 PICO-8 版本、平台、cart/input hash 和重复性。
- 相关 Chrome/Chromium 测试通过；声明移动支持时按 Tier M 执行。
- 性能场景无超过门限的退化，Worker/内存资源能够释放。
- 兼容矩阵和已知差异已更新；没有通过放宽全局 tolerance 掩盖问题。
- 测试数据来源与许可证清楚，不包含未授权第三方 cart/artifact。

### 16.2 MVP Player

- 所有 `tier: core` conformance cases 100% 通过，无 skip。
- 所有标记 `implemented` 的 API 都有行为映射；`exact + compatible` 覆盖 MVP 清单的 100%。
- `.p8`/`.p8.png` parser、decompressor、fixed-point ABI、RAM 和 Worker state machine 达到关键模块覆盖率门禁。
- Tier A/B 桌面核心矩阵通过；声明移动支持时 Tier M 也通过。
- 固定性能 runner 和移动性能满足第 10、11 节预算。
- 恶意 parser/VM 输入不能逃逸 Worker；hang 在规定时间内恢复。
- 0 个开放 P0/P1；P2 必须登记并体现在兼容性声明。
- 项目原创代表 corpus 的 C2+C3 比例至少 95%，并同时报告总数；第三方 cart 不用于凑指标。
- 最近 7 天 nightly flake rate 低于 0.5%，不得通过自动 rerun 隐藏首轮失败。

### 16.3 Release

- MVP DoD 持续满足，release commit 的全部 PR/nightly/device/release gates 为绿。
- 最近 7 天无新增未解决 fuzz crash、hang、OOB 或 sanitizer finding。
- 60 Hz 桌面 10 分钟和移动 30 分钟 soak 达标，audio underrun 为 0。
- 所有 reference/golden 变化已经人工批准并绑定官方版本。
- 已知差异、支持浏览器、兼容范围和 BBS 限制已对用户公开。
- Terms、依赖许可证、test fixture 版权和 release artifact 清单已复核。

## 17. Bug 报告模板

```markdown
## 摘要
一句话描述用户可见问题，不写“和 PICO-8 不一样”这种空泛结论。

## 严重度 / 分类
- Severity: P0 / P1 / P2 / P3
- Area: cart | lua | memory | graphics | audio | input | scheduler | storage | worker | browser
- Compatibility: exact / compatible / partial / unsupported / unknown

## 环境
- pico8-web-player commit/build:
- z8lua/WASM build ID:
- Browser + exact version:
- OS / device / CPU:
- AudioContext sample rate（如相关）:
- DPR / Canvas renderer（如相关）:

## Cart 与权限
- Cart name/version:
- Cart SHA-256:
- Source: project-original / locally-supplied / licensed-third-party
- License or permission evidence:
- 是否允许把 cart、截图、音频附到 issue: yes / no / unknown
- 注意：未确认权限时不要上传附件，只提供原创最小复现。

## 确定性输入
- Test case / manifest ID:
- Random seed raw int32:
- Input trace SHA-256:
- First divergent frame:
- Persistent-data preset:

## 复现步骤
1.
2.
3.

## 预期（官方参考）
- PICO-8 exact version/platform:
- Manual section or observed behavior:
- Repeated runs:
- Expected framebuffer/RAM/audio/event hashes:

## 实际
- Error/log:
- Actual hashes:
- First pixel/address/sample difference:

## Artifacts
- Minimal project-owned .p8:
- expected / actual / diff images:
- RAM hex diff:
- audio diff report:
- Worker timeline / performance trace:

## 三方差分（可选）
- Official PICO-8:
- pico8-web-player:
- fake-08:

## 最小化与初步定位
- Smallest reproducer:
- Suspected API/module:
- Last known good commit:

## 验收条件
- 新增哪个 regression/conformance case:
- 哪些 browsers/devices 必须通过:
- 是否需要更新 known differences:
```

任何包含第三方 cart 的 issue 在公开前先移除文件和衍生 artifact。仅保留 hash 也不能替代最小原创复现，但可以帮助有权访问的开发者确认本地文件版本。

## 18. 维护与审计

- 每次 PICO-8 官方版本升级，先冻结当前基线，新建版本化 golden，并生成 API/行为变更清单。
- 每季度审阅 performance runner、浏览器支持矩阵、设备档位、fuzz 上限和 flake rate。
- 每次 release 核验 [PICO-8 官方手册](https://www.lexaloffle.com/dl/docs/pico-8_manual.html) 与 [Lexaloffle Terms of Use](https://www.lexaloffle.com/info.php?page=tos) 的版本/更新时间。
- 测试工具升级后先在同一 commit 上比较旧/新 runner，确认没有因为 PNG、audio、timer 或浏览器实现变化误改 golden。
- 废弃 test 必须说明它覆盖的行为由哪个新 test 接替；禁止通过删除失败 test 关闭兼容性问题。

最终发布判断应基于证据链：规范或官方观察 → 最小 conformance cart → 确定输入 → 可审阅 golden/diff → 浏览器与设备门禁 → 已知差异声明。链条中任何一环未知，就应诚实标记为 `unknown`，而不是推断兼容。
