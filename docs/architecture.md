# 当前架构

## 一份 runtime，三种入口

```text
Web facade ── PlayerController / 生命周期队列 ── runtime port
                                                   │
独立会话 / JSON tool ── 生命周期队列 ── PlayerSession ──┤
                                                   ▼
                                  runtime/compose-session.ts
                                                   │
                               RuntimeCore ← ports ← z8lua bridge → WASM
```

`compose-player.ts` 负责挂载 Web 播放器。`PlayerComposition` 创建、连接和销毁 runtime、Canvas 与音频设备；Controller/facade 直接调用 runtime port，没有 Composition 方法转发。

Web 默认通过 `PlayerSession` 直接调用共享执行层。显式 `execution: "worker"` 时，`main/worker-client.ts` 中的 `PlayerRuntimeClient` 经消息协议连接 Worker，Worker 仍调用同一个 `compose-session.ts` 的类型化方法。命令分发、wire requestId 和 worker generation 仅由 Worker 适配维护；主线程不构造协议消息。手动会话不创建 DOM、RAF、Worker 或音频设备。AudioWorklet 只负责设备 PCM 队列与重采样。

## 源码归属

| 目录 | 职责与依赖 |
| --- | --- |
| `packages/contracts` | 稳定值类型、输入快照、错误；无状态、无平台依赖 |
| `packages/cart-codec` | `.p8` / `.p8.png` bytes 解码；仅依赖 contracts |
| `packages/runtime-core` | RAM、graphics、audio、input、cart/session、frame scheduler、外部能力 ports；依赖 contracts/codec |
| `packages/z8lua-bridge` | 实现 VM port，管理 WASM handle、内存 lease、host bindings；只以 type 引用 Core |
| `apps/web-player/src/runtime` | 组合 Core/bridge/codec、执行会话、独立会话 API、JSON tool、像素解码、调度、PCM 输出、IndexedDB 和 caller cart adapters |
| `apps/web-player/src/main` | 公共导出、Web facade、Canvas、音频设备、输入、UI 与宿主侧 Worker client |
| `apps/web-player/src/transport` | 执行事件、runtime port、错误、参数验证；Worker 协议单独拥有命令、requestId、版本和 worker generation |
| `apps/web-player/src/worker` | 可选 Worker 入口与消息适配；无重复模拟实现 |
| `apps/web-player/src/worklet` | PCM 消费、设备统计和重采样；不驱动模拟 |
| `wasm` | 固定 z8lua 源码、项目 C++ bridge、补丁、许可证和构建锁 |

Core 不使用 DOM、Worker、fetch、IndexedDB 或具体 WASM module。WASM handle/pointer 不暴露给 UI；物理 Pico RAM 的 lease 从 create 到 destroy 有效，逻辑寻址统一走 adapter mapper。`.p8.png` 不经过 Canvas 解码。

TypeScript project references 管理构建顺序。`tests/architecture` 检查跨层导入、平台 API、包导出和生成绑定。发布验证检查组件产物。源码和构建配置均不得引用 `ref/`。

## 帧、输入与状态

Core 拥有权威游戏状态，z8lua 负责 Lua parser/VM、Q16.16、协程与 GC。`FrameSliceRuntime` 在完整逻辑边界提交画面、输入、音频和存档；异步 host request 在原 transaction 中恢复。`CartSession` 管理载入、冷重置、generation 和故障恢复。

实时播放由 RAF 提供时间，`FrameScheduler` 决定逻辑 tick；manual `advance` 按精确帧数直接 step，不依赖墙钟。主线程单次 WASM 调用受指令上限约束，不能被 timer 抢占；Worker 适配另有 watchdog/recovery。

输入、cart 和存档的跨层常量由 `packages/contracts` 唯一定义，transport 直接 re-export；空输入使用同处的深度冻结快照。

普通帧与异步 host 恢复共用执行结果处理。`PcmOutput` 统一维护音频序号、样本位置和传输复制，无音频端口时仅推进传输状态。

输入为八玩家快照与 devkit 瞬态。暂停、菜单、失焦和停止清理按键。手动批次内保持按钮，keypress/wheel/movement 只用于首帧。

## 生命周期与资源

每个 Web controller / 独立会话拥有自己的串行生命周期队列。API、DOM、文件载入和环境事件使用同一队列；复合操作不递归入队。实时帧回调独立运行，使 `start()` 能等待当前 generation 的首帧实际呈现到 Canvas。

换卡先停止旧 producer 并 flush 旧身份，再验证并激活新存档。执行器使用单个带类型标记的 pending request 管理 host 调用、guest load 和外部 cartdata，统一取消请求。共享执行器通过每次调用持有的续体交付异步结果，普通结果直接返回，不经公共事件监听器匹配。VM host 回应仍以 generation/request identity 检查，迟到结果不能写入新会话。解析失败、写入失败和取消均有明确返回，队列不会因一次失败失效。

`dispose()` 立即关闭新的公共操作并取消未开始的操作；等待进行中的操作/必要存档提交后，释放 WASM 引用、监听器、RAF、AudioContext 和可选 Worker。重复 dispose 幂等。主线程无法抢占已进入的同步 WASM 调用。

## 外部能力

cart bytes/local bundle 由调用方显式提供；resolver 不推导 URL、文件系统或 BBS 权限。`load/reload/cstore` 的外部操作只从 runtime-owned root 恢复；nested guest coroutine 的 host suspension 拒绝且不产生外部副作用。

内存 cartdata 在会话实例内保留；Web 默认 IndexedDB，可替换为 host persistence port。`flushPersistence` 的 durable 结果反映真实存储能力，不能把仅排队成功当作落盘成功。

## 测试观察边界

Core 的 InspectionRequest/Result 与 prepareInspection 定义有界数据契约。只读路径不执行 guest Lua；debug 的安全边界、指令预算与 host 入口限制由 VM 实现。standalone 显式 opt-in 后通过串行生命周期队列调用相同执行器；Web facade 与可选实时 Worker RPC 不新增调试入口。normal/debug 用途、证据序号与图像编码属于调用方，VM 不了解卡带编辑版本。
