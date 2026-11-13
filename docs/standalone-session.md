# 独立会话与 Agent 工具接入

Web Player 和 manual session 复用同一份 app runtime、RuntimeCore 与 z8lua。
以下入口均来自独立 release 的 `manifest.artifacts.main.path`；仓库 workspace 构建也可从
`@pico8-player/player` package root 导入。release 需要完整保留同级 WASM/assets 目录。
Node 可直接 import 解压后的 `main/player.mjs`，不要求 DOM、Worker 或仓库 node_modules。

## 最小开发循环

```js
import { createPico8Session, createPico8SessionTool } from "./main/player.mjs";

const session = await createPico8Session();
const tool = createPico8SessionTool(session);
try {
  await tool.execute({ action: "load_source", source: `
x=0
function _update60()
 if btn(1) then x+=1 end
end
function _draw()
 cls(0)
 pset(x,0,8)
end
` });
  const result = await tool.execute({ action: "advance", frames: 30, buttons: 2 });
  // result.completedFrames === 30; result.observation.frame.frameId === 29
  // image: 128×128 RGBA8 bytes in base64, not a PNG/JPEG.
  // The host can encode these bytes as its image content format.
  const released = await tool.execute({ action: "advance", frames: 1, buttons: 0 });
  const metadata = await tool.execute({ action: "observe", image: false });
} finally {
  await session.dispose();
}
```

`tool.name / description / inputSchema / execute` 是平台无关的适配入口。Codex/Pi/MCP 的注册、
transport 和图片内容格式由外部插件负责；本组件不安装插件、不读写宿主工程、不调用模型。
输入严格限制为源码、帧数、按键和观察操作；没有 eval-JavaScript、文件系统或 URL cart 权限。

## 直接使用组件

- `loadSource(source, options?)`：PICO-8 Lua；codec 负责 P8SCII 与语法。初始化成功为 ready，
  编译/guest 错误返回 faulted observation 与结构化 diagnostics；参数错误 reject。
- `loadCart(bytes, options?)`：完整 `.p8`/`.p8.png` bytes；assets 使用完整 cart，依赖使用显式 localCartBundle。
- `advance({ frames, input? })`：1–600 个逻辑帧。input 是固定八玩家快照和 devkit batch；
  held buttons 持续整个批次，keypress/wheel/movement 瞬态仅用于第一帧。缺省输入释放全部按键。
- 返回 `requestedFrames / completedFrames / outcome / observation`。guest stop/fault/换卡会提前结束；
  换卡后的新 session 不在同一个批次中继续运行。批次结束暂停并清输入。
- `observe()`：同步、纯快照。包含 sessionId、源码 revision、session generation、state、
  最近 committed frame、至多 64 条 diagnostics。frame 为 null 表示尚无完成帧；不会隐式执行 `_draw()`。
- frame 内有 copy-owned RGBA、packedScreen 和 displayPalette，以及帧号、FPS、指令数和 slowFrame。
  调用方可用 RGBA 构建 `ImageData` 或图像文件。每次观察的数组可以独立修改。
- `reset()`：从当前 cart 冷启动新 generation，源码 revision 不变；内存 cartdata 在本实例内保留。
- `dispose()`：幂等；拒绝未开始的排队操作，在帧间结束进行中的批次，清理会话与 WASM 引用。
  已同步执行中的单个 WASM 调用无法被同线程 timer 抢占。

默认 persistence 为 `"memory"`，各实例独立；`{ persistence: "indexeddb" }` 显式启用浏览器 durable
storage。不要把 reset 当作清空存档；需要空环境时创建新 memory session。
observation 提供 runtime diagnostics；日志通过 readLogs 单独读取。修改 authored code 通过 loadSource/loadCart 开始新 revision。临时测试状态使用显式启用的 inspect，不创建新源码版本。

## Web UI 与可选 Worker

```js
import { createPico8Player } from "./main/player.mjs";
const player = await createPico8Player({ root }); // 默认主线程
const isolated = await createPico8Player({ root: anotherRoot, execution: "worker" });
```

Web facade 保持 API v2 和实时播放/首帧契约；standalone session 使用独立 API version 1。
Agent 手动步进不需要创建 Web facade。Worker 使用同一执行实现，但其额外 RPC/watchdog 不进入
默认主线程路径。AudioWorklet 仍负责真实设备输出；manual session 默认不创建声音设备。

主线程模式保留 deterministic VM instruction cap，没有外部强制终止能力；这里没有承诺所有 cart
的 UI 延迟。部署仍以 Chrome/Chromium 为浏览器范围，Node 覆盖无设备的会话/tool loop。

## 日志快照

`session.readLogs(after = 0)` 非破坏性返回 `{cursor, dropped, entries}`，entry 含 sequence、frameId、text、truncated。序号属于本次载入的 VM，换卡/reset 后调用方清 cursor；按成功交付结果的 cursor 继续读取。缓冲最多 64 条、8 KiB 原始字节，每条 1 KiB。frameId 表示尝试执行的帧，启动日志为 null；故障可能阻止该帧提交。非 ASCII P8 字节使用 `\xNN` 转义，避免误用 UTF-8 解码丢失内容。读取不推进帧，不改变存档；故障销毁 VM 前保留最后的日志快照。文件名参数不开放文件系统访问。该 API 属于手动 standalone session，不加入实时 Web UI 的控制接口。


## 音频调用事件

`createPico8Session({inspection:true})` 的 `advance` 结果额外包含 `audio: {events, dropped}`：本次推进期间 guest 实际启动声音的 `sfx()` 调用（`{frameId, sfx, channel, overMusic}`，channel 为实际使用的声道，overMusic 表示占用了正在播放音乐的声道）和 `music()` 调用（`{frameId, music}`，-1 表示停止）。载入时 `_init` 的调用随第一次 advance 返回。每次结果最多 32 条，超出计入 dropped。只记录调用和声道分配，不代表听感；music 按 pattern 自动推进不产生事件。非 inspection session 不返回该字段。

## 测试状态查询与调试

创建 `createPico8Session({inspection: true})` 后，在至少一个完成帧的安全边界调用：

```js
const snapshot = await session.inspect({mode: "read", paths: [["g", "board"], ["g", "moves"]]});
const debug = await session.inspect({mode: "debug", code: "g.moves=1; return g.moves"});
```

默认关闭；启用 inspection 的 session 仅使用 memory persistence，不能同时启用 IndexedDB。实时 Web facade 不暴露此方法。主线程/测试 Worker 的 standalone 共用同一个 Core 和 bridge。手动 JSON session tool 保持原有输入集合；宿主通过公开 session API 注册自己的状态工具。

`prepareInspection` 和 `INSPECTION_LIMITS` 是公开参数校验与限额定义；宿主可在发送 Worker 消息前使用。read 接收 1–16 条路径，每条 1–16 段，首段全局字符串，后续字符串或有符号 16-bit 整数；字符串键最多 128 bytes。总输入 4 KiB。debug 是 1–4096 字节 Lua chunk，指令预算 50,000，不接受调用方扩大限额。字符串和代码按 code points 0–255 映射 Lua byte string，不经过 Unicode/P8SCII glyph 转换。

结果 `{ok, executed, values, error?, truncated?}` 是拥有自己数据的 JSON 快照。布尔/数值/字节字符串直接编码，nil/function/userdata/thread 等返回 type 标签，不暴露地址。table 使用 `{type:"table", entries:[{key,value}]}`，保留稀疏项和键类型；循环、4 层深度、512 总 entry 和 16 KiB 字节上限均明确标记。字节溢出返回空 values 与 truncated:"bytes"，调用方应缩小路径范围。只读查询使用 raw 访问，暂停 GC，避免运行元方法或 finalizer，不改变模拟时间、随机数、输入和 RAM。

debug 在受保护执行边界运行，保留 callback/custom-loop 的暂停 root 和原预算，不触发隐式帧、update/draw。禁用 run/stop/reset/load/reload/cstore/cartdata/dset/extcmd/flip/yield 与 host suspension；缓存别名、pcall、嵌套协程不能绕过入口保护。printh 写入同一有界日志缓冲。成功或编译失败不会改变上一张完成帧；下一次 advance 才产生新画面。已执行错误或超预算不回滚部分写入：此后 raw read 仍可用于查看这些写入（不运行 Lua），但再次 debug 或 advance 会被拒绝，需 reset/load 后继续。宿主在调用前记录 debug 用途；中断、丢失响应或 Worker watchdog 后不能把该轮当成 normal。需要清掉调试影响和内存存档时，销毁并创建新 session。

ABI `0x00010006` 新增 `p8w_inspect`。输入为 raw 路径二进制或 debug 字节，输出为 16 KiB NUL 结尾 JSON；参数布局见 `spec/abi/p8w-v1.json`。日志 ABI 同时保留。源码、WASM hashes 和导出集合由锁文件与可复现构建校验。
