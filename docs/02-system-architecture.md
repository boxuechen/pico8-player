# 系统架构

> 文档角色：稳定的系统边界与目标拓扑。当前实现状态以机器契约、源码和
> [Phase 4 机器合同](../spec/phase-4-l2-mvp-contract.json)为准。

## 状态路由

| 状态 | 本文内容 |
| --- | --- |
| **Accepted** | 三执行域、状态唯一所有权、依赖方向、固定 Pico RAM 和资源上限原则 |
| **Implemented through Phase 4E** | Phase 3 全部边界；current-cart guest `run`、root `stop`、system `reset`、`stat(6)`；versioned `runtime-control` event；同 generation runtime/audio/persistence lifecycle |
| **Target** | slow-frame/CPU compatibility policy、guest `load`、external cart transaction、representative corpus hardening 与 release qualification |
| **Deferred** | nested async HostRequest、完整 cart swap/multicart、BBS resolver 和完整 L3 host integration |

第 4–11 节描述的是目标系统约束，不代表其中每个 command、event 或 adapter 已存在。
当前 production player 协议由
[`player-protocol.ts`](../apps/web-player/src/transport/player-protocol.ts) 定义；阶段能力与完成状态由
[`phase-3-audio-input-persistence-contract.json`](../spec/phase-3-audio-input-persistence-contract.json)
及其前置合同锁定。Phase 0E `worker-protocol.ts` 只保留为兼容 probe。已实现的 browser boundary 由
[`phase-0f-browser-boundary.json`](../spec/phase-0f-browser-boundary.json)、ADR-009 和 ADR-010
定义。

## 1. 架构总览

本项目采用三执行域架构：Window 主线程、Runtime Worker、AudioWorklet。未来经许可的远端 cart resolver 属于可选外部服务，不进入 player core。

```mermaid
flowchart LR
    UI["Window: Player UI"]
    W["Worker: TS Runtime"]
    VM["WASM: z8lua + bridge"]
    RAM["WASM linear memory: Pico RAM"]
    AW["AudioWorklet: PCM output"]
    DB["IndexedDB: cartdata"]
    UI -->|"commands / input snapshots"| W
    W -->|"status / frame / diagnostics"| UI
    W --> VM
    VM <--> RAM
    W <--> RAM
    W -->|"dedicated MessagePort: PCM chunks"| AW
    W <--> DB
```

### Window 主线程

负责：

- 文件选择、drag-and-drop、controls 和 error UI。
- keyboard、pointer、gamepad、touch 状态采样。
- Canvas/WebGL 呈现和 fullscreen。
- AudioContext / AudioWorklet 生命周期。
- 建立专用 `MessageChannel`，把两个端口分别转交 Runtime Worker 与 AudioWorklet；
  [ADR-010](./adr/010-dedicated-messageport-audio-transport.md) 已接受该唯一默认路径。
- Worker watchdog、终止和重建。

禁止：

- 执行 cart Lua。
- 在 UI component 内实现 PICO-8 API。
- 让 DOM refresh rate 决定模拟帧数量。

### Runtime Worker

负责：

- Cart parse 和 load transaction。
- z8lua WASM lifecycle。
- Pico RAM、Cart ROM 和 Runtime state。
- frame scheduler、input edge、graphics 和 audio synthesis。
- persistence 命令与 runtime diagnostics。

Runtime Worker 是一局 player session 的唯一权威状态源。

### AudioWorklet

只负责消费已生成的 PCM、重采样/缓冲中必要的实时部分和输出。它不得拥有游戏逻辑或权威 audio/music state。

## 2. 所有权与共享内存

z8lua 的 WASM linear memory 内必须预留一块连续 64 KiB Base RAM，并导出其 pointer。TypeScript Runtime 通过 `Uint8Array` / `DataView` 建立零复制视图。

```ts
export interface PicoMemoryView {
  readonly bytes: Uint8Array;
  readonly data: DataView;
  readonly baseAddress: number;
}
```

要求：

- z8lua 的 `lua_setpico8memory()` 指向同一块地址。
- JS view 与 WASM pointer 生命周期绑定。
- v1 **MUST** 固定 WASM memory（`initial === maximum`，growth off）；Phase 0 用 heap/cart stress 确定容量。未来若要允许 growth，必须先用 ADR 修改所有权契约，并实现集中式 view identity 检查与原子重建，普通功能任务不得自行开启。
- debug/test build 可以在内部断言 `memory.buffer` identity 未改变；变化时 fail-fast 为 `E_INVARIANT`，不暴露 production refresh API。
- Cart ROM 是独立 32 KiB 逻辑对象；load/run/reload 时按规范拷贝到 Base RAM。
- Renderer 可以复制或转换 8 KiB screen region，但不得把 renderer buffer 变成 Runtime 权威状态。

官方 Base RAM 关键区间：

| 起始地址 | 区域 |
| --- | --- |
| `0x0000` | GFX |
| `0x1000` | GFX2 / MAP2 shared |
| `0x2000` | MAP |
| `0x3000` | GFX flags |
| `0x3100` | SONG |
| `0x3200` | SFX |
| `0x4300` | User data |
| `0x5600` | Custom font |
| `0x5e00` | Persistent cart data |
| `0x5f00` | Draw state |
| `0x5f40` | Hardware state |
| `0x6000` | Screen, 8 KiB |
| `0x8000` | Upper user data |

完整和更新后的解释以官方手册 Memory 章节为准。

## 3. 依赖方向

允许的依赖方向：

```text
player UI
  -> worker client protocol
    -> runtime orchestrator
      -> cart / ram / graphics / audio / input / persistence
      -> z8lua bridge
```

模块约束：

- `graphics`、`audio`、`input` 依赖 RAM interface，不依赖 UI。
- `cart` 只产生规范化 CartImage，不直接启动 VM。
- `z8lua bridge` 不导入 DOM、Canvas、AudioContext 或 IndexedDB。
- `runtime orchestrator` 是唯一允许同时协调 VM、RAM、input、graphics 和 audio 的模块。
- `player UI` 只消费协议消息，不得读取 WASM memory。

以上是概念依赖；代码级 package DAG、composition roots、public exports 和禁止 import 由 [08-source-layout-and-boundaries.md](./08-source-layout-and-boundaries.md) 唯一定义并通过 `test:architecture` 强制。其他文档不得再维护竞争性的源码目录树。

## 4. Session 状态机

> 状态：Mixed。host-driven load/reset 与 `idle/loading/ready/running/paused/faulted/stopped`
> 主路径已实现；`waiting_cart`、guest `load` 和 external cart transaction 仍是 Target。

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> loading: loadCart
    loading --> ready: parsed + VM booted
    loading --> faulted: parse/boot error
    ready --> running: start
    running --> paused: pause / hidden policy
    paused --> running: resume
    running --> running: guest run / fresh runtime graph
    paused --> loading: reset
    running --> waiting_cart: load/reload/cstore dependency missing
    waiting_cart --> running: reload/cstore bytes supplied
    waiting_cart --> loading: load target supplied
    waiting_cart --> faulted: rejected/timeout
    running --> faulted: runtime error/budget exceeded
    paused --> faulted: host/session fault
    faulted --> loading: reset or loadCart
    idle --> stopped: stop
    loading --> stopped: stop / cancel
    ready --> stopped: stop
    running --> stopped: host or guest stop
    paused --> stopped: stop
    waiting_cart --> stopped: stop
    faulted --> stopped: stop
    stopped --> loading: loadCart
```

状态转换必须原子化。新 cart load 失败时，不得留下旧 VM 与新 RAM 混合状态。

## 5. Worker 协议

> 状态：Mixed。当前 source 已实现 load/start/input/vsync/pause/resume/reset/stop/dispose、
> state/frame/heartbeat/runtime-control/diagnostic/fault 和独立 audio/persistence lifecycle；下方
> `supplyCart`/`needsCart` 仍是 Target 示例。

协议必须带版本，并使用可判别 union。下面是 v1 的跨线程基线；更具体字段以 [04-typescript-runtime.md](./04-typescript-runtime.md) 为准，不能再引入 `boot`、`host-response` 等同义消息。

```ts
export type HostToRuntime =
  | { v: 1; type: "loadCart"; requestId: string; bytes: ArrayBuffer; sourceName?: string }
  | { v: 1; type: "attachAudioPort"; port: MessagePort }
  | { v: 1; type: "start" }
  | { v: 1; type: "vsync"; sequence: number; timestampMs: number }
  | { v: 1; type: "pause" }
  | { v: 1; type: "resume" }
  | { v: 1; type: "stop" }
  | { v: 1; type: "reset" }
  | { v: 1; type: "input"; snapshot: NormalizedInputSnapshot }
  | { v: 1; type: "supplyCart"; requestId: string; bytes?: ArrayBuffer; error?: SerializedRuntimeError };

export type RuntimeToHost =
  | { v: 1; type: "state"; state: RuntimeState; sessionGeneration: number }
  | { v: 1; type: "frame"; sessionGeneration: number; frameId: number; tick: string; width: 128; height: 128; rgba: ArrayBuffer }
  | { v: 1; type: "needsCart"; request: HostRequest }
  | { v: 1; type: "heartbeat"; sessionGeneration: number; tick: string; sequence?: number }
  | { v: 1; type: "runtime-control"; control: "run" | "stop"; payload: ArrayBuffer }
  | { v: 1; type: "diagnostic"; diagnostic: SerializedRuntimeError }
  | { v: 1; type: "fault"; error: SerializedRuntimeError };
```

协议要求：

- `ArrayBuffer` SHOULD 使用 transferable，避免复制大 buffer。
- `attachAudioPort` 的 port 必须放入 transfer list；PCM 只走该专用 port，不混入控制协议。
  Window relay 和 SAB 已被 ADR-010 拒绝为默认 fallback；改变路径必须有新 evidence 并取代该 ADR。
- `sessionGeneration`、`frameId`、vsync/input/audio `sequence` 和 request IDs 必须在各自作用域单调/唯一，支持丢弃 stale message。
- 未知协议版本必须失败关闭，不得猜测。
- 输入消息传 snapshot，而不是把 DOM event 原样传进 Runtime。

## 6. Boot transaction

> 状态：host-driven load/reset transaction 已实现并通过 Phase 1–3 recovery gate；guest `load`
> 与 external resolver staging 仍是 Target。

一次 cart load 按以下顺序执行：

1. 验证输入长度和 signature。
2. 解析为不可变 `CartImage`，产生 source hash、cart version 和 diagnostics。
3. 检查版本支持策略。
4. 创建或重置 VM、Base RAM、Cart ROM、graphics/audio/input state。
5. 将 Cart ROM 规定区域复制到 Base RAM。
6. 注册受控 PICO-8 globals 和 Lua glue。
7. 编译 cart code；失败则回滚整个 transaction。
8. 以官方差分锁定的 `1/30s` clock 启动 root coroutine：若 top-level 返回，进入 callback mode 并执行 `_init()`；若先到达受控 `flip()` boundary，进入 custom-loop mode，把该 boundary 作为成功 startup，禁止再额外调用 `_init()` 或启动 callback driver。commit 时把 startup epoch 换算为 target-rate slices（30 Hz 为 1、60 Hz 为 2），但不发布 host frame event。
9. 只有全部成功后，Window `loadCart` 才把 session 提交为 `ready`；显式 `start` 后进入 `running`。guest `run(param)` 使用 retained current cart 创建 fresh runtime graph，并在同一 player session 中继续 `running`；它不是 Window reset，也不授权 guest `load()`。

旧 session 在新 session commit 前应保持可销毁但不可继续写入的状态。

## 7. Frame transaction

> 状态：Phase 3 project profile 已实现 input → VM → audio/frame → persistence 的 committed
> transaction；slow-frame update/draw policy、完整 CPU accounting 与 external HostRequest 仍是 Target。

每个 logical frame 的权威顺序为：

1. scheduler 决定本次 simulation slice、callback 次数与是否 draw。
2. Runtime latch 最新 `InputSnapshot`，计算 pressed/repeat 并更新 hardware/input memory state。
3. 按 callback 模式或 custom `flip()` loop 模式推进 z8lua，直至受控 boundary。
4. 处理 VM error、instruction budget、host request 和 queued cart change。
5. 根据 logical simulation clock 生成该 slice 对应的 PCM。
6. 若本次是 visible draw/flip，读取 screen + palette/draw mode 生成 frame output。
7. 提交 diagnostics、heartbeat 和 persistence dirty state。

同一 logical frame 中 Lua API 对 RAM 的写入必须立即对后续 API 可见。

## 8. 时间模型

> 状态：startup/manual slice 与 Phase 1E bounded interactive scheduler 已实现；完整 slow-frame/conformance policy 仍是 Target。

- Runtime 维护自己的 accumulator 和 logical simulation clock。
- `_update()` 模式逻辑速率为 30 Hz；`_update60()` 模式为 60 Hz。
- display refresh 只决定何时请求/显示最新 frame，不直接决定 update 数。
- `time()` / `t()` 必须由 logical simulation clock 推导，不等同于 callback 调用计数。官方 Web Player 差分锁定 startup 为 `1/30s`；custom main loop 的首次 `flip()` commit 这个 startup epoch，之后从 continuation 到每个受控 `flip()` 再 commit 一个 30 Hz slice。callback 60 Hz 用 2 个 target-rate slices 表示同一 startup epoch。
- Phase 1E scheduler 最多追赶 5 ticks/vsync；超出后丢弃 backlog 并发出
  `E_TIME_DISCONTINUITY`，避免 spiral of death。
- [ADR-011](./adr/011-hidden-tab-pause.md) 已锁定默认 hidden/blur pause：清输入并重建
  scheduler anchor，恢复时不补跑隐藏期间的所有帧。
- 测试模式必须允许手动逐帧推进，不依赖 wall clock。

## 9. Error 模型

跨 Worker 边界只使用 [04-typescript-runtime.md 的 `SerializedRuntimeError`](./04-typescript-runtime.md#15-错误模型)。架构层不得再定义第二套错误码或字段别名；例如 instruction hook 超限使用 `E_VM_INSTRUCTION_BUDGET`，Window watchdog 终止 Worker 使用 `E_VM_WATCHDOG`。

要求：

- 用户错误与内部 invariant failure 必须区分。
- 错误消息不得泄露任意宿主路径、cookie、token 或 JS object。
- `E_INVARIANT` 必须同时产生开发日志；生产 UI 只显示安全摘要。
- Worker 无响应由 Window watchdog 转换为 `E_VM_WATCHDOG` 后重建；VM 内确定性预算超限则使用 `E_VM_INSTRUCTION_BUDGET`，两者不得混为同一故障来源。

## 10. 安全与资源限制

- Cart bytes 必须有输入大小上限；PNG 解码必须防止 decompression bomb。
- `.p8.png` 必须验证 160 × 205 和受支持的 color/bit-depth 解码结果。
- z8lua 只打开经过 allowlist 的库和 globals。
- 禁止 `io`、`os.execute`、动态 native module、任意 fetch 和 DOM interop。
- 每次 VM resume 必须有 instruction/cycle budget。
- Worker watchdog 是第二层保护，不能替代 VM budget。
- `printh` 等宿主输出必须进入受限 diagnostic sink，而非任意文件路径。
- persistence key 必须按 API 分域：`cartdata(id)` 使用校验后的显式 ID，允许官方定义的跨 cart/version 共享；`cstore` overlay 才绑定规范化 cart identity。两者不得共用 key space。

## 11. 性能预算基线

以下是已用于项目 profile 的工程预算；Phase 4 必须用代表 corpus 和长稳测试重新校准，不能把
既有 microbench/短场景结果外推为 release 承诺：

- 60 Hz logical frame 总预算为 16.67 ms。
- desktop 基准环境中，VM + TS Runtime 的 p95 SHOULD 不超过 8 ms/frame。
- 主线程 frame present 的 p95 SHOULD 不超过 4 ms。
- input-to-logical-update latency MUST 不超过 1 logical frame（不含浏览器显示延迟）。
- Runtime 与 renderer 之间不得每帧复制超过必要的 128 × 128 RGBA/frame payload。
- 稳态运行不得产生与运行时长线性增长的未回收消息或 buffer。

基准失败时按照 [07-decisions-risks-open-questions.md](./07-decisions-risks-open-questions.md) 的 fallback ladder 调整边界。
