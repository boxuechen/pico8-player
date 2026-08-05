# ADR-012：z8lua 源码供应与 Phase 0A WASM 基线

状态：Accepted

日期：2026-08-05

适用范围：Phase 0A baseline；生产 `p8w_*` ABI 仍由后续阶段决定

## Context

Player 需要 P8 Lua parser、Q16.16 数值和 coroutine，但不能让本地研究 clone、
移动 branch head、额外 guest library 或未锁定编译器进入发布链。Phase 0A 还必须
证明产物能在 Worker 加载、重复构建，并把上游 notice 随产物交付。

## Decision

1. 选择 z8lua `pico8` branch 的
   `8575dfbc524003c869c0aa05e109819302c576f9`。拒绝对照的 `zepto8`
   `4a7089ea55556aef95a82a618d7bf19c1be1b568`：后者多出 11 个文件变更、
   约 3004 行，主要加入 Phase 0A 不需要的 Eris/Oua surface。
2. 将固定提交 vendored 到 `wasm/z8lua/`。`ref/z8lua/` 只用于研究，任何生产
   build/test 都不得读取它。`wasm/source.lock.json` 锁 upstream tree 和最终
   snapshot inventory。
3. 本地 patch 按编号保存在 `wasm/patches/`。Phase 0A 只有一个 patch：通过
   `P8W_BASELIB_SANDBOX` 在注册期编译掉 stdout、文件加载、dynamic source load
   和 guest GC control；bridge 再防御性删除对应 globals。
4. Emscripten 锁定 6.0.5，emsdk manager 锁定
   `17a714fde0f1aaac53d282efcc6093b377addc8d`。z8lua 必须作为 C++17 编译；
   因其 protected error path 使用 C++ `try/throw`，Phase 0A 使用 Wasm EH 和
   `SUPPORT_LONGJMP=wasm`。
5. 生成独立 `.mjs` + `.wasm`，环境限定为 `worker,node`。`node` 只为 CI 的真实
   Worker smoke test；浏览器目标仍是 Runtime Worker。memory growth、filesystem、
   dynamic execution、Asyncify 和 pthread 均关闭。
6. Phase 0A 实验 ABI 使用 `p8w0a_*` 前缀，只覆盖 context lifecycle、按 byte
   执行 source、raw Q16.16 result、bounded error、instruction budget 和观测计数。
   它不是 `docs/03` 中 Proposed production `p8w_*` ABI，也不允许 TS Runtime
   依赖其临时签名。
7. `wasm/dist/` 不提交 Git。`wasm/manifest.lock.json` 锁 source、patch、flags、
   import、notice 和每个生成文件 hash；CI 从源码重建并核验。每个 artifact 同时
   生成 `THIRD_PARTY_NOTICES.md`、Emscripten notice、Lua license 和 WTFPL v2
   license。

## Evidence

- [Phase 0A 完成证据](../12-phase-0a-evidence.md)
- `pnpm run verify:wasm`
- `tests/wasm/phase-0a.test.mjs`
- `wasm/manifest.lock.json`

## Consequences

- 发布构建不依赖 git submodule、移动 head、网络 fetch 或本地 `ref/`。
- guest 无法获得 debug/Eris/io/os/package/filesystem/native module；Phase 0A 的
  `print` 是只为验证 `?` shorthand 存在的 project-owned no-op。
- Native Wasm exception support 成为该 baseline 的浏览器能力前提；正式 production
  决策仍须在目标浏览器矩阵验证。
- `^` 继续采用上游 floating-point `pow`，只锁定 z8lua baseline 值，不宣称官方
  bit-exact。
- 16 MiB linear memory 只是 Phase 0A 固定 baseline，不回答 Phase 0B 的 shared
  Pico RAM、生产 heap cap 或最终固定容量。

## Rejected alternatives

- `zepto8` composite branch：不必要扩大序列化和实验语义 surface。
- 从 `ref/z8lua` 构建：本地状态不可复现且破坏研究/生产隔离。
- build 时 clone/fetch branch：引入网络和移动输入。
- submodule：可以 pin，但增加 checkout failure mode，且对当前单依赖没有优于
  vendored inventory + patch manifest 的收益。
- 提交 `.wasm`/`.mjs`：会让源码与二进制双重事实源；当前 CI 重建成本可接受。
