# PICO-8 Player

可嵌入的 PICO-8 兼容播放器，提供独立会话用于自动试玩和 Agent 工具。基于 TypeScript 与 z8lua WebAssembly，为 [PICO-8 Maker](https://github.com/boxuechen/pico8-maker) 提供运行能力。

[![Verify](https://github.com/boxuechen/pico8-player/actions/workflows/verify.yml/badge.svg)](https://github.com/boxuechen/pico8-player/actions/workflows/verify.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[演示与静态构建](https://boxuechen.github.io/pico8-player/) · [English](README.md) · [参与贡献](CONTRIBUTING.md)

## 使用方式

- **浏览器：** `createPico8Player()` 提供画面、音频、控制与存档，默认主线程执行，可选 Worker。
- **独立会话：** `createPico8Session()` 加载源码或卡带，按指定帧数执行，返回复制的像素、诊断和日志；可在 Node.js 中运行，无需设备输出。
- **Agent 工具：** `createPico8SessionTool()` 为同一套会话运行时提供 JSON 接口。

运行时和 WASM 源码均在本仓库。Maker 使用完整静态组件，无需另外的运行时仓库。

## 快速开始

使用与 Maker 一致的 **Node.js 24.22.2**，以及 **pnpm 10.8.0**、**Emscripten 6.0.5**。首次构建前按 [WASM 指南](wasm/README.md) 安装固定编译器。

```sh
git clone https://github.com/boxuechen/pico8-player.git
cd pico8-player
pnpm install --frozen-lockfile
pnpm run build:wasm
pnpm run build:release
node tools/browser/server.mjs
```

打开终端打印的地址，选择本地 `.p8` 或 `.p8.png` 卡带。嵌入自己的站点时，复制完整的 `apps/player/dist/release/` 目录，并按[浏览器接入指南](docs/player.md) 操作。

## 开发

```sh
pnpm test
pnpm run verify:release
pnpm run test:browser
```

CI 按 [`.node-version`](.node-version) 从干净 checkout 运行以上检查。具体测试和发布方式见[开发指南](docs/development.md)。Pages 仅保留当前发布版本，下游应用应复制完整组件并同步更新版本锁定。

## 文档

详细技术文档统一维护英文版本，避免重复。

| 主题 | 指南 |
| --- | --- |
| 浏览器嵌入、生命周期与存档 | [Player API](docs/player.md) |
| 逐帧执行、JSON 工具与状态查询 | [独立会话](docs/standalone-session.md) |
| 模块职责与执行方式 | [架构](docs/architecture.md) |
| 工具链、测试与静态分发 | [开发](docs/development.md) |
| 支持能力与已知差异 | [兼容范围](docs/compatibility.md) |

项目处于 Alpha 阶段，目标为 PICO-8 v0.2.7 卡带运行时，浏览器验证范围是 Chrome/Chromium，不承诺所有卡带兼容。这是独立项目，并非 Lexaloffle 官方产品。

## 许可证

原创代码采用 [MIT](LICENSE)。依赖和用户卡带保留各自授权，详见[第三方说明](THIRD_PARTY_NOTICES.md)。
