# 参考源码登记与隔离规则

`ref/` 是被 Git 整体忽略的本地只读研究区，用于行为对照、算法调研和 provenance 查询。它不属于 pnpm workspace、production import graph、WASM build inputs、test fixtures 或 release artifacts。

| 本地目录 | 仓库 | 已核验 checkout | 用途 |
| --- | --- | --- | --- |
| `ref/z8lua/` | <https://github.com/samhocevar/z8lua> | `8575dfbc524003c869c0aa05e109819302c576f9`（`origin/pico8`，detached） | P8 Lua 语法、fixed-point VM、direct memory operators 和 native build baseline |
| `ref/fake-08/` | <https://github.com/jtothebell/fake-08> | `814991a2571ad3970e386cef48f3b148aa1c27b9`（`master`） | cart parsing、hardware behavior、graphics/audio 算法和 differential diagnosis |
| `ref/zepto8/` | <https://github.com/samhocevar/zepto8> | `b2929a4fe31e5765ef66d7794edd11086b9638b4`（`master`，detached） | 独立 emulator 行为及 compression/runtime 交叉检查 |
| `ref/tac08/` | <https://github.com/0xcafed00d/tac08> | `38c1f3bb2ae81c06983dc5132d45f0c8747dff95`（`master`） | Phase 2E 内建字体 provenance 与 MIT notice 交叉检查 |
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

git clone https://github.com/0xcafed00d/tac08.git ref/tac08
git -C ref/tac08 checkout --detach 38c1f3bb2ae81c06983dc5132d45f0c8747dff95

git clone https://github.com/emscripten-core/emsdk.git ref/emsdk
git -C ref/emsdk checkout --detach 17a714fde0f1aaac53d282efcc6093b377addc8d
```

这些命令只复现研究输入，不是 production dependency 的安装流程。clone 更新后必须同步本页；本地 `ref/README.md` 不属于 tracked source of truth。

## Phase 0D cart-codec 交叉检查记录

Phase 0D 在设计 raw/legacy/PXA contract 时检查了以下锁定路径：

- fake-08 `814991a…/source/cart.cpp`：PNG low-bit extraction、legacy/PXA header 与
  decoder 行为；该 repository component 标为 MIT，但其 bundled/transitive 组件有
  多种许可证，因此没有把文件或 dependency 引入项目。
- zepto8 `b2929a4…/src/pico8/cart.cpp` 与 `src/pico8/code.cpp`：payload、legacy/PXA
  decode 的独立交叉检查；所检查文件声明 WTFPL-2.0。

交叉检查只用于发现格式分支和设计项目自有 tests。production codec、DEFLATE、
fixtures 和 vectors 均独立编写，没有复制/翻译参考实现，也不在 build/test 时读取
`ref/`。机器登记及 source/contract/fixture hashes 见
`packages/cart-codec/manifest.lock.json`。

## Phase 2E P8SCII 字体记录

Phase 2E 检查了 fake-08 `814991a…/source/fontdata.cpp` 中的
`defaultFontBinaryData`，并通过 tac08 `38c1f3b…/LICENSE` 核对其上游归属和 MIT
notice。项目把固定 2048 bytes 转写为 RuntimeCore 内部 hex constant，保留 byte-for-byte
SHA-256 `a36a2826466ec5e8834462d8d438ddffa617b7bf938b46260eb7f80dfa4c5ea6`；
许可正文与改写说明位于 `packages/runtime-core/THIRD_PARTY_NOTICES.md`。production/test
不会读取 `ref/`。
