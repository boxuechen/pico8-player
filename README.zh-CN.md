# PICO-8 Player

**在浏览器里播放卡带，也能通过代码逐帧运行同一个游戏。**

基于 TypeScript 和 z8lua WebAssembly 的 PICO-8 兼容播放器与无界面会话 API。它为 [PICO-8 Maker](https://github.com/boxuechen/pico8-maker) 提供运行能力，也可独立用于浏览器应用、Node.js 测试及 Agent 工具循环。

[![Verify](https://github.com/boxuechen/pico8-player/actions/workflows/verify.yml/badge.svg)](https://github.com/boxuechen/pico8-player/actions/workflows/verify.yml)
[![Code license: MIT](https://img.shields.io/badge/code_license-MIT-blue.svg)](LICENSE)

[**在线演示与静态构建**](https://boxuechen.github.io/pico8-player/) · [快速开始](#快速开始) · [文档](docs/README.md) · [English](README.md)

> **当前为 Alpha 阶段。** 目标是 PICO-8 v0.2.7 卡带运行时；浏览器验证范围为 Chrome/Chromium，Node.js 支持不输出到设备的独立会话。这是独立实现，并非 Lexaloffle 官方产品，具体差异见[兼容范围](docs/compatibility.zh-CN.md)。

## 一套运行时，两种使用方式

| | 浏览器播放器 | 独立会话 |
| --- | --- | --- |
| 入口 | `createPico8Player()` | `createPico8Session()` |
| 执行 | 实时播放，默认主线程，可选 Worker | 显式推进 1–600 个逻辑帧 |
| 输入 | 键盘、手柄、触摸或宿主输入 | 控制器快照与 JSON 工具适配器 |
| 输出 | Canvas 与 AudioWorklet | 复制的画面像素、诊断、有界日志和可选状态查询 |
| 存档 | 默认 IndexedDB，可提供宿主适配器 | 默认独立内存，可显式使用浏览器 IndexedDB |
| 用途 | 游戏嵌入、创作工具 | 回归测试、自动试玩、Agent 循环 |

两条路径复用相同的运行实现。TypeScript 运行时、z8lua 源码和 C/C++ WASM bridge 都在本仓库，不需要另一个运行时仓库。

## 快速开始

### 在线试玩

打开[静态构建页面](https://boxuechen.github.io/pico8-player/)，点击 **Open player demo**，在 Chrome/Chromium 中选择本地 `.p8` 或 `.p8.png` 卡带。无需模型账号或 API Key。

### 从源码运行

使用 **Node.js 22.22.2**、**pnpm 10.8.0** 和固定的 **Emscripten 6.0.5**。首次构建前按 [WASM 指南](wasm/README.md) 准备工具链。

```sh
git clone https://github.com/boxuechen/pico8-player.git
cd pico8-player
pnpm install --frozen-lockfile
pnpm run build:wasm
pnpm run build:release
node tools/browser/server.mjs
```

打开终端打印的演示地址。完整静态组件在 `apps/player/dist/release/`，可独立解压的归档在 `apps/player/dist/package/`。

### 嵌入网页

将**整个**静态组件复制到站点的 `player/` 目录，通过 HTTP(S) 提供服务，保持内部相对路径。

```html
<link rel="stylesheet" href="./player/player.css">
<div id="player"></div>
<script type="module">
  import { createPico8Player } from "./player/main/player.mjs";
  const player = await createPico8Player({
    root: document.querySelector("#player"),
  });
  // 自带控制界面可打开本地卡带。
</script>
```

组件卸载时调用 `await player.dispose()`。自定义 UI 使用 `shell: "hosted"`，Worker 执行使用 `execution: "worker"`。卡带加载、事件、生命周期和存档见[接入指南](docs/player.zh-CN.md)。

### 在 Node.js 中逐帧执行

将以下代码保存为解压后静态组件根目录中的 `example.mjs`，运行 `node example.mjs`。无需源码仓库或 `node_modules`。

```js
import { createPico8Session } from "./main/player.mjs";
const session = await createPico8Session();
try {
  const loaded = await session.loadSource(`
    x=0
    function _update60() x+=1 end
    function _draw() cls(0) pset(x,64,8) end
  `);
  if (loaded.state === "faulted") throw new Error("卡带加载失败");
  const result = await session.advance({ frames: 30 });
  if (result.outcome !== "completed") throw new Error("帧批次中断");
  console.log(result.completedFrames);              // 30
  console.log(result.observation.frame.rgba.length); // 65536
} finally {
  await session.dispose();
}
```

[`createPico8SessionTool(session)`](docs/standalone-session.zh-CN.md) 提供平台无关的 JSON 接口，用于载入源码、发送按键、推进帧和观察结果。模型调用、工具注册和图片编码由接入方负责。

## 架构与开发

`packages/runtime-core` 负责 RAM、绘图、音频合成、输入与帧语义；`packages/z8lua-bridge` 连接 WASM VM；`apps/player` 负责共享会话、公开 API 和浏览器设备。RuntimeCore 不依赖 DOM、Worker、fetch 或 IndexedDB，详见[架构说明](docs/architecture.zh-CN.md)。

构建 WASM 后运行：

```sh
pnpm test
pnpm run verify:release
pnpm run test:browser
```

CI 从干净 checkout 执行架构、运行时、来源完整性、静态包和 Chrome 浏览器检查。具体命令见[开发指南](docs/development.zh-CN.md)，参与贡献见 [CONTRIBUTING](CONTRIBUTING.md)。欢迎中英文 Issue 和 PR。

## 分发与 Maker

Maker 负责创作体验和 Agent 工作流；Player 负责执行、绘图、声音与卡带兼容。Maker 下载、校验固定版本的静态构建，再随自己的站点分发。

分发使用 GitHub Pages，无需 npm 发布或 GitHub Release。**Pages 只保留当前发布版本**；请将完整组件复制到自己的应用，并在发布替代版本时同步更新下游锁定文件。操作步骤见[发布说明](docs/development.zh-CN.md#github-pages-静态组件)。

## 许可证与致谢

项目原创代码采用 [MIT](LICENSE)。z8lua、Lua、Emscripten 及上游字体和音频材料保留各自授权；静态构建携带完整声明，来源与授权归属见[第三方说明](THIRD_PARTY_NOTICES.md)。用户提供的卡带沿用各自许可证。

[更新记录](CHANGELOG.md) · [兼容范围](docs/compatibility.zh-CN.md) · [报告问题](https://github.com/boxuechen/pico8-player/issues/new?template=bug_report.yml)
