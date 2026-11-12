# 独立会话与 Agent 工具接入

Web Player 和 manual session 复用同一份 app runtime、RuntimeCore 与 z8lua。
以下入口均来自独立 release 的 `manifest.artifacts.main.path`；仓库 workspace 构建也可从
`@pico8-web/web-player` package root 导入。release 需要完整保留同级 WASM/assets 目录。
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
目前 observation 提供 runtime diagnostics，**没有新增 guest `printh` stdout 捕获、断点或 live eval**。
修改代码通过 loadSource/loadCart 开始新 revision。

## Web UI 与可选 Worker

```js
import { createPico8WebPlayer } from "./main/player.mjs";
const player = await createPico8WebPlayer({ root }); // 默认主线程
const isolated = await createPico8WebPlayer({ root: anotherRoot, execution: "worker" });
```

Web facade 保持 API v2 和实时播放/首帧契约；standalone session 使用独立 API version 1。
Agent 手动步进不需要创建 Web facade。Worker 使用同一执行实现，但其额外 RPC/watchdog 不进入
默认主线程路径。AudioWorklet 仍负责真实设备输出；manual session 默认不创建声音设备。

主线程模式保留 deterministic VM instruction cap，没有外部强制终止能力；这里没有承诺所有 cart
的 UI 延迟。部署仍以 Chrome/Chromium 为浏览器范围，Node 覆盖无设备的会话/tool loop。
