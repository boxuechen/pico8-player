# 开发与验证

## 环境与构建

Node 版本见 `.node-version`，pnpm 版本见 `package.json`；依赖使用冻结 lockfile。首次或 WASM 源码变化后，按 [WASM 指南](../wasm/README.md) 安装固定 Emscripten，再运行：

```sh
pnpm install --frozen-lockfile
pnpm run build:wasm
pnpm test
```

`build` 编译 TypeScript；`build:wasm` 单独生成生产 `p8w` runtime 与 notices。普通 TS 改动不重编 WASM。`build:release` 使用已有 WASM，校验锁定产物后生成静态目录和确定性归档。

## 验证入口

| 命令 | 覆盖 |
| --- | --- |
| `pnpm test` / `pnpm run verify` | bindings、TypeScript、公共导出、架构、codec、全部 runtime/device 单元与集成回归、gallery、source/artifact hashes |
| `pnpm run test:runtime` | Lua、RAM、图形、音频、输入、存档、生命周期和 agent loop 的行为回归 |
| `pnpm run verify:release` | 构建、文件白名单/hash/许可、归档、解压后独立消费 |
| `pnpm run test:browser` | Chrome 中 agent loop、默认主线程 UI、可选 Worker、存档切换和资源释放 |
| `pnpm run test:wasm:repro` | 两次干净 WASM 构建逐字节比较；仅工具链/bridge 变更需要 |

浏览器由 CDP 启动独立临时 profile；可用 `P8W_CHROMIUM` 指定 Chrome/Chromium 路径。CI 从固定工具链构建 WASM，再运行默认、release 和 browser 门禁。没有 Firefox/WebKit、外部 cart 抓取或长时间 soak 的默认门禁。

`tests/runtime` 按功能命名；`tests/fixtures` 保存项目自写 cart/输入向量和所需预期；`tests/golden` 保存确定性结果。测试应验证当前行为，不再检查历史阶段完成状态。引入新兼容行为时同步更新 [API inventory](../spec/pico-api-inventory.yaml) 与相关回归。

## 本地体验

```sh
pnpm run build:release
node tools/browser/server.mjs
# 打开命令打印的 demo 地址，选择本地 cart。

pnpm run gallery --cart-root /absolute/path/to/carts
# gallery 仅绑定 127.0.0.1；cart 库留在仓库和发布包之外。
```

构建物在 `dist/`，临时数据放 `.cache/`；不提交截图、机器运行报告或历史基准产物。需要了解之前的设计或验证，查 Git 历史。

## GitHub Pages 静态组件

维护者提交源码后运行 `pnpm run publish:pages`。该命令构建组件，将完整文件发布到 `gh-pages` 分支的 `<source-commit>/` 目录，保留旧目录，不创建 GitHub Release。首次使用需在仓库 Pages 设置中选择 `gh-pages` 分支根目录。本项目源码仓库公开，Pages 提供编译产物。

静态入口为 https://boxuechen.github.io/pico8-player/ 。消费者下载固定 commit 目录的 `manifest.json` 及其列出的文件，保留目录结构与许可文件。`main/player.mjs` 同时公开 `decodeP8`，可供宿主验证导出的卡带，无需读取内部 workspace 包。Maker 在构建时下载到本地，运行时不依赖跨域模块或 Pages 在线状态。

## 仓库更名兼容

仓库名称与静态站点路径已由 `pico8-web-player` 改为 `pico8-player`。消费者应更新静态资源地址；历史 commit 目录保留在新站点下。已有本地 checkout 可通过 `git remote set-url origin https://github.com/boxuechen/pico8-player.git` 更新远端，目录名不必修改。

此次仅调整项目名称、展示文字和发布地址。`apps/web-player`、`@pico8-web/*`、现有 manifest 的 `artifactId: "pico8-web-player"`、归档名称及 IndexedDB 数据库名称保留，以兼容既有接口、消费者与存档。历史版本文件与 WASM 锁定值不变。
