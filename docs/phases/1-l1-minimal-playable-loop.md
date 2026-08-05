# Phase 1：L1 最小可玩闭环

- 状态：**Active**
- 当前 checkpoint：**1A Host API Boundary complete**
- 下一 work unit：**1B Text `.p8` decode and ParsedCart normalization**
- 机器契约：[`spec/phase-1-l1-contract.json`](../../spec/phase-1-l1-contract.json)
- 浏览器范围：Chrome / Chromium only

本文件是 Phase 1 的唯一执行入口。roadmap 只保留阶段摘要；1A 的具体签名、生成物和
生命周期以机器契约、ABI schema 与 public source 为准。

## 1. 稳定输入与边界

Phase 1 从已通过的 Phase 0 exit gate 开始，并保持以下边界：

- z8lua/WASM 只拥有语言 VM、Lua 栈薄封装、`flip()` 控制流、direct-memory primitive、
  instruction budget 和 fault containment。
- RuntimeCore 拥有 browser-neutral PICO hardware/API 语义；Canvas、DOM、AudioContext 和
  AudioWorklet 不得进入 `PicoApiHost`。
- `compose-runtime.ts` 是 bridge + RuntimeCore 的唯一 production composition root。
- 一个 session 一套 router/VM/core object graph；reset/cart swap 不复用旧 delegate。
- `.p8.png`、Phase 0E frame slice 和 Phase 0F presenter/audio transport 是稳定输入，
  不在 Phase 1 中重写。

开工阅读路由：本文件 → `08` 的 package、composition/bootstrap、generated sections →
当前 work unit 涉及的 `03`/`04` 小节。历史 evidence 只在定位回归时阅读。

## 2. Work units

| Unit | 状态 | 可观察交付 |
| --- | --- | --- |
| 1A Host API Boundary | **Complete** | exactly-once synchronous WASM→TS binding；`cls/pset/btn` 迁入 RuntimeCore；ADR-008 关闭 |
| 1B Text `.p8` / ParsedCart | Next | bytes-only `.p8` decode，统一 cart identity/diagnostic，不接网络 |
| 1C CartSession lifecycle | Not started | cold reset、reload/fault dispose、RAM/input/placeholder-audio reset matrix |
| 1D L1 graphics/input | Not started | `line/rect/circ`、keyboard held/edge 与 `btnp` 最小闭环 |
| 1E Scheduler/player shell | Not started | Worker tick、load/reset/fault UI 与 Phase 0F adapters 接通 |
| 1F L1 exit | Not started | 30/60/custom original carts、Chrome gate、兼容矩阵和 phase evidence |

后续 unit 启动前必须在本文件展开其 inputs、files、tests 和 exit gate；不得仅依据上表直接
实现。任一 unit 不得顺带加入 BBS resolver、第三方 cart、完整 graphics/audio 或
Firefox/WebKit 范围。

## 3. 1A 完成契约

### 3.1 Bootstrap transaction

```text
create session router (unbound)
  -> create VM / acquire stable PicoMemoryLease
  -> create RuntimeCore PicoApiHost over that lease
  -> bind router exactly once
  -> compile / boot / step
  -> destroy VM and release router
```

门禁：compile-before-bind、binding id 0、double-bind、rebind-after-release 和 stale dispatch
全部拒绝；host throw 转成不可恢复 `E_HOST_API` 并 poison VM。router 是 session object，
共享的 dispatch table 只存放在该 Emscripten module instance 上，不使用 `globalThis` 或
module-level mutable singleton。

### 3.2 API 与 ownership

`cls/pset/btn` 的 Lua 参数以 signed Q16.16 raw `int32` 加 presence mask 同步转发；返回值
经 `int32` out-parameter 回到 C wrapper。TS host 直接操作同一份 leased 64 KiB RAM。
`flip()` 仍是 yield/control-flow ABI；`peek/peek4/poke/poke4` 仍走 canonical C mapper；
`time/t` 仍由 slice input 提供。1A 不扩大 API 兼容声明。

production schema 只列这三个实际绑定；8-signature prototype 只验证 arity、optional、
void/integer/boolean/overload 和六参数生成能力，不注册为 guest API。生成物不得手改。

### 3.3 1A evidence commands

```text
pnpm run test:phase-1a
pnpm run test:phase-0e
pnpm run test:benchmark
pnpm run test:architecture
pnpm run verify
```

专项测试必须覆盖 unbound/double-bind/rebind/stale/cross-session、raw bits、nil/default、
integer/boolean return、host throw、stack balance、mapped screen 和 interop budget。最终提交
必须包含 `pnpm run verify` 通过结果且 `git status --short` 为空。

## 4. 1B 启动前检查

1B 只处理文本 `.p8` bytes decode 与统一 `ParsedCart` contract。开始前必须重新审计
`cart-codec` 当前 public shape、官方 `.p8` section/version 行为、diagnostic byte offset、
size limits 与 LF/CRLF cases；禁止让 codec 读取 File/URL/BBS，也不得在 1B 引入
CartSession、renderer 或 UI 行为。
