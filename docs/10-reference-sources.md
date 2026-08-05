# 参考源码登记与隔离规则

`ref/` 是被 Git 整体忽略的本地只读研究区，用于行为对照、算法调研和 provenance 查询。它不属于 pnpm workspace、production import graph、WASM build inputs、test fixtures 或 release artifacts。

| 本地目录 | 仓库 | 已核验 checkout | 用途 |
| --- | --- | --- | --- |
| `ref/z8lua/` | <https://github.com/samhocevar/z8lua> | `8575dfbc524003c869c0aa05e109819302c576f9`（`origin/pico8`，detached） | P8 Lua 语法、fixed-point VM、direct memory operators 和 native build baseline |
| `ref/fake-08/` | <https://github.com/jtothebell/fake-08> | `814991a2571ad3970e386cef48f3b148aa1c27b9`（`master`） | cart parsing、hardware behavior、graphics/audio 算法和 differential diagnosis |
| `ref/zepto8/` | <https://github.com/samhocevar/zepto8> | `b2929a4fe31e5765ef66d7794edd11086b9638b4`（`master`，detached） | 独立 emulator 行为及 compression/runtime 交叉检查 |
| `ref/emsdk/` | <https://github.com/emscripten-core/emsdk> | `17a714fde0f1aaac53d282efcc6093b377addc8d`（detached） | Emscripten release mapping 与安装器审计；实际 toolchain 安装在 repo 外且由 `wasm/toolchain.lock.json` 锁定 |

默认不初始化 submodule。只有明确、有限的调研需要时才能初始化指定 submodule，并把仓库和 commit 补记在本页。

## 边界规则

- 禁止把 `ref/**` 加入 `pnpm-workspace.yaml`、TypeScript project references、bundler inputs、CI build inputs 或 package `exports`。
- production code 和 tests 禁止 import、include、symlink 或读取 `ref/**`。测试需要某个行为时，必须建立项目自有、已审查许可并独立记录 provenance 的 fixture/vector。
- production z8lua pin 属于 `wasm/z8lua/`，由 `wasm/manifest.lock.json` 管理；`ref/z8lua/` 不是生产 pin。
- 所有 clone 视为只读；不得在其中开发本项目 patch。
- 复制或翻译前，必须记录 upstream repository、精确 commit、原路径、相关 license/notice、本地目标和语义改动。provenance 或许可边界不明确时，优先依据官方行为契约独立实现。
- fake-08 包含多种许可证组件，必须按源码组件检查 `ref/fake-08/LICENSE.MD`。z8lua 和 zepto8 的 notice 也可能位于单个源码文件中，不能只做仓库级许可假设。

## 复现本地 checkout

```sh
git clone https://github.com/samhocevar/z8lua.git ref/z8lua
git -C ref/z8lua checkout --detach 8575dfbc524003c869c0aa05e109819302c576f9

git clone https://github.com/jtothebell/fake-08.git ref/fake-08
git -C ref/fake-08 checkout 814991a2571ad3970e386cef48f3b148aa1c27b9

git clone https://github.com/samhocevar/zepto8.git ref/zepto8
git -C ref/zepto8 checkout --detach b2929a4fe31e5765ef66d7794edd11086b9638b4

git clone https://github.com/emscripten-core/emsdk.git ref/emsdk
git -C ref/emsdk checkout --detach 17a714fde0f1aaac53d282efcc6093b377addc8d
```

这些命令只复现研究输入，不是 production dependency 的安装流程。clone 更新后必须同步本页；本地 `ref/README.md` 不属于 tracked source of truth。
