# 参考源码登记与隔离规则

`ref/` 是被 Git 整体忽略的本地只读研究区，只用于行为对照、算法调研和 provenance 查询。它不属于
workspace、production import graph、WASM build、test fixture、CI 或 release artifact。

## 登记 checkout

| 本地目录 | 仓库 | 锁定 checkout | 用途 |
| --- | --- | --- | --- |
| `ref/z8lua/` | <https://github.com/samhocevar/z8lua> | `8575dfbc524003c869c0aa05e109819302c576f9` | P8 Lua VM、fixed-point 与 memory behavior |
| `ref/fake-08/` | <https://github.com/jtothebell/fake-08> | `814991a2571ad3970e386cef48f3b148aa1c27b9` | cart/hardware/graphics/audio 行为参考 |
| `ref/zepto8/` | <https://github.com/samhocevar/zepto8> | `b2929a4fe31e5765ef66d7794edd11086b9638b4` | 独立 codec/runtime 交叉检查 |
| `ref/tac08/` | <https://github.com/0xcafed00d/tac08> | `38c1f3bb2ae81c06983dc5132d45f0c8747dff95` | 内建字体 provenance 与 notice |
| `ref/emsdk/` | <https://github.com/emscripten-core/emsdk> | `17a714fde0f1aaac53d282efcc6093b377addc8d` | Emscripten release mapping；production toolchain 另由 lockfile 固定 |
| `ref/pico8-games/` | <https://github.com/MiniMechMedia/pico8-games> | `9c846040438bdc649b30c115c355c8864cbba06e` | caller-authorized local compatibility research only |

默认不初始化 submodule。更新或增加参考源时，必须在本表记录仓库、精确 commit、用途和适用许可。

## 不可破坏边界

- 禁止把 `ref/**` 加入 workspace glob、TypeScript project、bundler、WASM include、CI input 或 exports。
- production 和 tests 禁止 import、include、symlink 或读取 `ref/**`。
- 需要固化某个行为时，创建项目自有最小 fixture/vector，并单独记录官方依据或 provenance。
- production z8lua pin 位于 `wasm/z8lua/`，由 lock manifest 管理；`ref/z8lua/` 不是生产 pin。
- clone 只读；不得在其中开发项目 patch。
- 复制或翻译材料前，记录 upstream、commit、原路径、license/notice、本地目标和语义改动。
- provenance 或许可不明确时，依据官方行为契约独立实现，不复制参考实现。

## 已进入 production 的第三方材料

项目内建 2048-byte P8SCII font 经过 fake-08/tac08 provenance 交叉检查，byte SHA-256 为
`a36a2826466ec5e8834462d8d438ddffa617b7bf938b46260eb7f80dfa4c5ea6`。适用 notice 和改写说明只由
[`packages/runtime-core/THIRD_PARTY_NOTICES.md`](../packages/runtime-core/THIRD_PARTY_NOTICES.md) 维护；
build/test 不读取 `ref/`。

cart codec、P8 Lua compatibility shim、PRNG 与 hardware behavior 均按项目机器契约和原创测试实现。
参考 checkout 只用于发现分支或交叉检查，没有成为 production dependency。

## 外部 cart 与官方服务

`pico8-games` checkout 仅用于用户授权的本地研究。其 cart bytes、身份、路径、hash、截图和逐-case
结果不得进入 tracked repo、CI 或 release artifact；来源登记不授予再分发权。

[PICO-8 manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html) 是行为规范；
[Lexaloffle Terms of Use](https://www.lexaloffle.com/info.php?page=tos) 没有自动授予第三方 player 一个
稳定公开的 cart-download API。自动 BBS 访问继续由
[ADR-020](./adr/020-phase-5-bbs-adapter.md) 设为 Deferred；任何变化必须在实施时重新核验当前条款和
作者授权，不能沿用历史日期。

## 本地复现

需要参考 checkout 时，使用登记 URL clone 到对应 `ref/<name>/`，再以
`git -C ref/<name> checkout --detach <commit>` 固定到表中 revision。该过程只复现研究输入，不是依赖
安装流程；`ref/README.md` 不是 tracked source of truth。
