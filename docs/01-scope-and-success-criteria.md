# 范围、兼容目标与成功标准

## 1. 产品目标

实现一个可嵌入网页、可离线运行用户提供 cart 的 PICO-8 player。它应当：

- 在现代 Chrome 或 Chromium 中载入 `.p8` 与 `.p8.png`；其他浏览器引擎不在
  当前支持与测试范围内。
- 正确执行 P8 Lua cart，并提供 PICO-8 player 所需的 graphics、audio、input、memory 和 persistence 行为。
- 对错误、超时、缺失功能和版本不兼容给出结构化诊断。
- 将不可信 cart 隔离在可终止的 Worker 中。
- 允许后续逐步提高兼容率，而不需要推翻运行时边界。

“可以打开 cart”不等于“可玩”。可玩至少要求启动、输入、逻辑帧、渲染、音频和持久化不会出现阻断游戏的偏差。

## 2. 目标规范

基线目标为 PICO-8 v0.2.7 的 cart runtime。官方手册给出的关键约束包括：

- 128 × 128 display。
- 16 色基础调色板与扩展 palette 行为。
- 6-button controller，支持多个 player slot。
- 4-channel sound。
- 64 KiB Base RAM、32 KiB Cart ROM、2 MiB Lua RAM 的概念模型。
- 16:16 fixed-point number，范围约为 `-32768` 到 `32767.ffff`。
- `_update()` 为 30 fps，`_update60()` 为 60 fps，`_draw()` 与可见帧调度有关。

实现可以拥有不同的内部内存分配，但外部可观察行为必须符合规范。

## 3. 范围内功能

### 3.1 Cart 输入

- `.p8` 文本 cart。
- `.p8.png` 160 × 205 cart image。
- `.p8.png` 中未压缩、legacy `:c:` 和 `\0pxa` code block。
- `.p8` 各 section：`__lua__`、`__gfx__`、`__gff__`、`__map__`、`__sfx__`、`__music__`、`__label__`。
- cart version 检查和 unsupported-future-version 错误。

### 3.2 P8 Lua

- PICO-8 shorthand syntax。
- fixed-point arithmetic、溢出、bitwise 和相关 math library。
- Lua table、multiple return、metatable 和 coroutine 行为。
- P8 byte string / P8SCII 行为。
- `_init`、`_update`、`_update60`、`_draw` 和手写 `flip()` loop。

### 3.3 Player runtime

- Base RAM、Cart ROM 与 reload/copy 行为。
- Graphics、Map、Table、Input、Audio、Memory、Math、String、Cart Data 等 player 需要的 API。
- Keyboard、pointer、gamepad 和触控映射。
- `cartdata` / `dset` / `dget` 持久化。
- pause、mute、reset、fullscreen 等宿主 player 控件。
- 运行错误、CPU budget 超限和 Worker hang recovery。

## 4. 非目标

以下内容不属于 v1 player：

- Code、sprite、map、SFX、music 编辑器。
- PICO-8 shell / command line。
- `save`、HTML/native export、GIF/video capture 等创作或分发工具。
- SPLORE 列表、账号、收藏、评分、在线 leaderboard。
- 对 PICO-8 私有实现的 bit-for-bit 重制承诺。
- 未经许可的 BBS crawler、第三方客户端、批量下载器或公共 cart 镜像。
- 执行 cart 自带的任意宿主文件、网络或系统命令。

某个非目标 API 被 cart 调用时，Runtime 必须返回明确的兼容错误、受控 stub 或规范允许的无操作；禁止静默访问宿主能力。

## 5. 兼容等级

每个发布版本必须声明兼容等级，不得使用模糊的“支持 PICO-8”表述。

| 等级 | 定义 | 必备能力 |
| --- | --- | --- |
| L0 Parse | 能可靠解析和检查 cart | `.p8` / `.p8.png`、ROM sections、code decompression、错误位置 |
| L1 Visual | 单 cart 可运行和操作 | P8 Lua、RAM、核心 graphics、30/60 fps、keyboard input |
| L2 Playable | 主流单 cart 游戏可完整游玩 | audio、gamepad/touch、persistence、常用 draw/audio state、pause/reset |
| L3 Extended | 复杂和多 cart 内容可运行 | `load/reload/cstore`、cart swap、custom font、advanced registers、兼容数据库 |

当前已关闭 **L2/MVP project profile**：范围严格限于 PICO-8 v0.2.7、Chrome/Chromium desktop、
项目原创 7-case corpus 和已发布 Known Differences。它不表示 official bit-exact、第三方/BBS cart
成功率或完整 L3。精确分母、未验证 API 与资源结果只由
[兼容性当前口径](./06-testing-compatibility.md#154-当前发布-profile)和
[MVP exit evidence](./evidence/phase-4/51-phase-4-l2-mvp-exit-evidence.md)维护。

L3 是后续候选阶段；在 active phase 与机器合同明确扩展范围前，不改变当前产品承诺。

## 6. 当前成功标准

当前 L2/MVP profile 必须持续满足：

1. cart code 只在可终止 Worker 内运行，fault/watchdog 后可创建 fresh session。
2. `.p8` / `.p8.png`、30/60/custom-loop、RAM/graphics/audio/input/persistence 的项目 profile 回归通过。
3. Chrome/Chromium desktop 的 production path、fixed resources、long-run 与 lifecycle release gate 通过。
4. 当前公开分母中无开放 P0/P1/P2，所有差异和未验证覆盖面都在兼容性文档中可见。
5. corpus 不包含未经授权取得或再分发的 BBS cart fixture。

精确分母、性能、浏览器命令和 release 门禁只由
[06-testing-compatibility.md](./06-testing-compatibility.md) 定义；本节不复制测量数字。

## 7. 架构不变量

后续开发禁止破坏以下不变量：

- P8 Lua 数值语义不得退化为 JS `number` 语义。
- Lua 与 Runtime 必须观察同一份 64 KiB Pico RAM；禁止逐帧复制整块 RAM 作为同步机制。
- `@/%/$`、`peek/poke/memcpy` 与 graphics/map address resolver 必须共享同一套 upper-RAM、wrap 和 video-remap 语义；不能把上游 flat pointer 当作完整兼容实现。
- cart code 不得在 Window 主线程执行。
- host API 不得暴露任意网络、文件系统、DOM 或 JS object 给 cart。
- cart parse、Runtime step 和 render 必须可以分别测试。
- logical time 必须来自模拟帧计数，不得直接使用 wall clock 代替 `time()`。
- 随机数、输入和测试模式必须支持确定性 seed/replay。
- 浏览器渲染刷新率不得直接改变游戏模拟速度。
- `.p8.png` 数据提取必须保持原始 channel bits。

## 8. 禁止的实现捷径

- 禁止用普通 Lua 5.3/5.4 VM 加简单正则预处理冒充 P8 Lua。
- 禁止通过 Canvas、`<img>` 或色彩转换后的 `ImageData` 解析 `.p8.png` cart payload。
- 禁止把每个 Lua number 无条件转换成 JS float 再参与 Runtime 运算。
- 禁止用 `requestAnimationFrame` “调用一次就更新一次”而不维护 logical-frame accumulator。
- 禁止为了通过单个游戏而加入按 cart ID 判断的兼容 hack；例外必须形成 ADR 和回归测试。
- 禁止在没有 benchmark 的情况下提前把全部 TS graphics/audio 下沉到 WASM。
- 禁止把 fake-08 整体引入作为“临时依赖”后再声称本项目采用 TS Runtime。

## 9. BBS 与内容边界

截至 2026-08-05，[Lexaloffle Terms of Use](https://www.lexaloffle.com/info.php?page=tos) 说明：

- BBS cart 默认仍属于各自作者。
- 未经许可不应分发或 remix cart。
- 在线服务不应被自动脚本或第三方客户端访问，除非取得 Lexaloffle 与相关作者许可，或属于条款列出的例外。

因此：

- 本项目首版只实现本地 file picker / drag-and-drop / caller-provided bytes。
- “从 BBS ID/URL 打开”是独立集成，不是 Runtime 的默认能力。
- 获得许可之前，测试 fixture 只使用项目自有 cart、明确许可的 cart 或人工编写的 conformance cart。
- 即使未来获得许可，BBS resolver 也必须与 player core 分离，并遵守 allowlist、rate limit、缓存和删除策略。
