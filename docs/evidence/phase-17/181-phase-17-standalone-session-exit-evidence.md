# Phase 17 — Standalone player session 完成证据

> Status: Complete · Date: 2026-11-12 · Chrome/Chromium desktop + Node manual-session consumer
>
> Machine contract: [phase-17-player-session-contract.json](../../../spec/phase-17-player-session-contract.json)
>
> Decision: [ADR-031](../../adr/031-standalone-session-main-thread-default.md)
>
> Starting revision: a2ac3cc; initial worktree clean. User requested ordered steps 1–5 and commit.

## 按 1–5 完成

1. RuntimeCore、z8lua bridge 和 WASM source/ABI/artifact 未修改。帧执行、Pico RAM、PICO API、
   guest continuation、32M instruction cap 与音频合成仍由同一套核心实现负责。
2. 生产 composer 从 worker/ 提取至 runtime/compose-session.ts；共享实现移除 wire version 与
   workerGeneration。Runtime data contract、async request correlation 和 session generation 保留；
   direct PlayerSession 是 178 行的调用/continuation facade，不创建 Worker、RPC response map 或 watchdog。
   storage/resolver/repository/PCM adapters 移至同一 app runtime 层，旧路径仅保留兼容 shim。
3. Web composition 默认直接创建 PlayerSession；Canvas、UI、AudioContext/Worklet 和首帧 gate
   继续使用原有 main adapters。默认不创建 Worker。dispose 清理运行时并释放持有 WASM 的 closure，
   避免调用方保留已关闭的 session 对象时继续保留整个模块。
4. package root 与独立 release 导出 createPico8Session、Pico8Session 和 createPico8SessionTool。
   支持 PICO-8 Lua source/cart bytes、1–600 committed logical frames、固定输入、pure/copy-owned
   RGBA/packed/palette observation、bounded diagnostics、revision/generation/frame identity。
   每 8 帧让出 event loop；stop/fault/guest replacement 提前结束并报告实际帧数；换卡后不在同批次
   继续运行目标。JSON tool adapter 提供 schema 与执行入口，图像以 rgba8-base64 表示。
5. execution: worker 为显式可选路径，原 Worker client/watchdog 和消息 installer 委托同一 composer。
   默认调用不构造 Worker envelope。协议增加 step；无第二套 guest implementation。

Web facade API 保持 v2；新增独立 session API 为 v1。独立会话默认 memory persistence，不创建 DOM、
RAF、Worker 或音频设备；IndexedDB 为显式选项。未安装或发布 Codex/Pi/MCP 插件，工具注册和图像
内容格式适配由外部集成负责。未新增 printh stdout 捕获、断点、live eval 或任意文件/URL 权限。
使用说明见 [standalone guide](../../11-standalone-session.md)，release notes 内也包含独立运行示例。

## 最终验证

环境：Node 22.22.2、pnpm 10.8.0、Google Chrome 157.0.8103.51。

| Check | Observed result |
| --- | --- |
| pnpm run test:player-session | 75/75：既有 persistence/startup 27、queue/shell/input 16、guest/host/menu/scheduler 20、新增 standalone/direct/tool 12 |
| pnpm run verify | 78/78，含新增 runtime→UI/Worker 反向依赖与平台 global negative checks；consumer TypeScript 与 codec manifest 通过 |
| Release rebuild | 使用既有锁定 WASM，重建 main/optional Worker/worklet 和 deterministic package；没有重建或修改 WASM |
| node tools/release/verify-release.mjs | 15 release files、6 stable keys、16 package files 通过 |
| Package SHA256 | e277c15813cc60f68f30733bcb3e59bf09aaa66596c87437ba4ba1135a3027e5 |
| node --test tests/artifact/phase-17-standalone-package.test.mjs | 1/1：解压到仓库外临时目录，portable verifier 通过；Node 从独立 main/player.mjs 执行 tool loop，无仓库/node_modules import |
| node tools/browser/run-phase-17.mjs | manual source/input 30 帧，对应 frameId 29 和预期红色像素；语法错误后新 revision 恢复；standalone device count 0 |
| Phase 17 Chrome realtime | 默认 Worker count 0；delayed hydration、UI Reset、API start、blur/focus 严格按队列完成；menu roundtrip 通过 |
| Phase 17 optional Worker | 显式创建 1 Worker，像素匹配，1/1 terminated；两种 realtime host 的 2 AudioContexts 均 closed，RAF 0 |
| node tools/browser/run-phase-15.mjs | 默认主线程 A/B persistence identity 与 fresh facade 回归通过；4 writes，IndexedDB durable true；Workers 0、AudioContexts closed 2、RAF 0 |
| Chrome unhandled rejections | 两个场景均为 0 |
| git diff --check | 通过 |

Direct regression 覆盖：30/60 Hz、custom flip loop、按键与释放、reset 决定性、snapshot ownership、
多实例、语法/运行错误、guest stop、异步 guest load、内存 cartdata、dispose queued/in-flight、
root HostRequest、换卡取消旧 continuation、JSON 工具参数/图像序列化与创建参数验证。

开发期间先发现一个新测试构造的 root completion 缺少 generation/requestId，修正 fixture 后通过；
architecture gate 也要求同步新增 runtime project-reference ownership，已更新并保留 negative tests。
最终检查恢复了此前由 Worker client 承担的 commandTimeoutMs admission 校验；common composition
现在对两种执行方式都在分配资源前校验，回归通过。相关修改后重建并重新验证最终 release 与 Phase 17
Chrome 场景；Phase 15 的 persistence 路径未受该参数 guard 修改影响。

## 边界与关闭

默认主线程无法用同线程 timer 抢占同步 WASM；外部 terminate/restart 只属于可选 Worker。
保留 VM deterministic instruction cap，不宣称任意 cart 的 UI latency。历史 Worker corpus 的兼容/
性能 evidence 未改写，也不视为主线程外部 corpus 重新认证。

现有 Worker-specific Phase 7B/14A/16 browser fixtures 改为显式选择 Worker；本阶段默认路径由 Phase 17
和 Phase 15 focused Chrome 覆盖，没有运行历史全集、long soak、external corpus 或 Top 200。
没有修改 mobile project、创建 remote/tag 或执行任何外部发布。更新 owner docs、ADR、机器合同和
组件指南后撤下 active phase；当前 active phase 为 None。本提交保留所有已接受的旧 evidence。
