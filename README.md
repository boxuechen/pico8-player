# PICO-8 Web Player

基于 z8lua WASM 和 TypeScript 的 PICO-8 运行组件。支持 Chrome/Chromium；无设备的独立会话也可在 Node 中运行。

- **独立会话**：加载 Lua 或 cart、按帧输入、观察像素和诊断，供 agent loop 使用。
- **Web Player**：Canvas、音频、键盘/手柄/触摸、暂停菜单与存档。
- **执行方式**：默认主线程；可选 Worker 复用同一份 runtime。

## 与 Maker 的关系

[pico8-maker](https://github.com/boxuechen/pico8-maker) 是面向用户的创作工具；本仓库提供它所使用的播放器与独立会话。公开维护重点是这两个仓库。

```text
pico8-maker
    └── 固定版本的 Web Player 静态资源
            ├── packages/runtime-core：TypeScript 运行时
            └── wasm/z8lua + wasm/bridge：C/C++ 编译的 WASM
```

运行所需的源码都在本仓库，不需要另一个运行时仓库。卡带执行、绘图、声音及兼容性由本仓库维护；创作体验和 Agent 工作流由 Maker 维护。z8lua 等第三方源码继续保留其来源记录和许可证。

Maker 通过 [GitHub Pages](https://boxuechen.github.io/pico8-web-player/) 获取固定源码版本的静态构建，校验后打包到自己的站点。接入与升级步骤见 [Maker 开发指南](https://github.com/boxuechen/pico8-maker/blob/main/docs/development.md#player-updates)，不要求使用者编译播放器，也不需要 GitHub Releases。

## 开发

使用 `.node-version` 指定的 Node 和 `package.json` 固定的 pnpm。首次构建需要 [固定 Emscripten 工具链](wasm/README.md)。

```sh
pnpm install --frozen-lockfile
pnpm run build:wasm
pnpm test
pnpm run build:release
```

`apps/web-player/dist/release/` 是完整静态组件；`dist/package/` 下生成可独立解压的归档。保留完整目录，使用 HTTP 服务打开 `demo/index.html`。

```js
import { createPico8Session } from "./main/player.mjs";
const session = await createPico8Session();
try {
  await session.loadSource("function _draw() cls(8) end");
  const result = await session.advance({ frames: 1 });
  // result.observation.frame.rgba: 128×128 RGBA8 像素
} finally {
  await session.dispose();
}
```

[组件与工具接入](docs/standalone-session.md) · [Web 接入](docs/web-player.md) · [架构](docs/architecture.md) · [开发与验证](docs/development.md) · [兼容范围](docs/compatibility.md)

本项目不包含编辑器、BBS 下载器或宿主插件注册。cart 由调用方提供；项目授权见 [LICENSE](LICENSE)，第三方来源见 [WASM notices](wasm/THIRD_PARTY_NOTICES.md) 和 [RuntimeCore notices](packages/runtime-core/THIRD_PARTY_NOTICES.md)。

## License

Project-owned source code and compiled components are licensed under [MIT](LICENSE), copyright © 2026 boxuechen, starting with the `0.2.0-alpha.2` static build. Third-party components retain their own licenses and notices; the project license does not relicense z8lua, Lua, Emscripten, or upstream font/audio material. Complete notices are included in every static build.

This is an independent PICO-8-compatible implementation, not an official Lexaloffle product.
