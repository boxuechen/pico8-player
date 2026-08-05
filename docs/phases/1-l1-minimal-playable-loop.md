# Phase 1：L1 最小可玩闭环

- 状态：**Active**
- 当前 checkpoint：**1C CartSession lifecycle complete**
- 当前 work unit：**None**
- 下一 work unit：**1D L1 graphics/input**
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
| 1B Text `.p8` / ParsedCart | **Complete** | bytes-only `.p8` decode，统一 cart identity/diagnostic，不接网络 |
| 1C CartSession lifecycle | **Complete** | cold reset、reload/fault dispose、RAM/input/placeholder-audio reset matrix |
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

## 4. 1B 执行契约

### 4.1 范围与输入

1B 只修改 `@pico8-web/cart-codec` 的纯 bytes 解码边界以及对应机器契约、测试和文档。
输入是 caller-owned `Uint8Array`；format detection 必须检查 PNG signature 或文本 cart
header，不读取扩展名、`mediaType`、File、URL、BBS、filesystem 或 network。

本 unit 交付：

1. 新增同步 `decodeP8(bytes)` 与 bytes-magic `decodeCart(bytes)`；保留
   `decodeP8Png(bytes)` 的兼容入口。
2. 两种 decoder 都返回统一 `ParsedCart` 核心字段：raw-input SHA-256 identity、format、
   version、固定 32 KiB ROM、P8SCII code bytes 和 immutable warnings。
3. 文本 decoder 验证 header/version、LF/CRLF、UTF-8→P8SCII、section 行格式与容量，
   并把 gfx/map/gff/music/sfx 写成 RAM packed bytes。
4. 所有 parse failure 都返回稳定 `E_CART_*` code 和原始输入的 byte offset；未知 section
   只产生 warning，且其内容不得落入 Lua。

`contentSha256` 只标识原始输入 bytes；display name、locator、origin 和 resolver capability
属于后续 loader/session metadata，不进入 content identity。返回 record、identity、warning
数组和 warning record 必须 freeze；typed-array 元素由调用方只读对待，每次 decode 都返回
无内部 alias 的独立 snapshot。

### 4.2 文本格式策略

- 接受可选 UTF-8 BOM、LF、CRLF 及二者混用；内部 code newline 统一为 LF。lone CR、非法
  UTF-8、NUL 或无法映射到 P8SCII 的 Unicode 必须失败，不做 Unicode normalization、
  case fold 或通用 trim。
- header 行验证 `pico-8 cartridge` official prefix，version 必须是十进制 `0..255`；高于
  配置上限默认 `E_CART_FUTURE_VERSION`。
- 识别 `__lua__`、`__gfx__`、`__gff__`、`__map__`、`__sfx__`、`__music__`、
  `__label__`。已知 section 重复是结构错误；unknown section 产生带 marker byte offset 的
  warning 并忽略其内容。
- 每个非空 data row 必须是完整官方宽度：gfx/label 128 chars，gff/map 256 chars，sfx
  168 hex chars，music 为 `ff cccccccc` 11 chars。缺失和未提供的尾部 rows 保持零；超出
  row 容量、错误字符或半字节输入禁止截断。
- gfx 每两个文本 pixel nibble 交换后写入 ROM；map rows 0..31 写 `0x2000`，可选 rows
  32..63 与 gfx2 `0x1000` 区域按位 OR；gff 写 `0x3000`。music flags 写入四个 channel
  byte 的高位；sfx 的 32 个五字符 note 写成 little-endian packed note。
- `__label__` 按 base32 palette index 验证但不写 ROM；label presentation 继续 deferred。
- 缺少 resolver 时，独占一行的 `#include` 返回 `E_CART_INCLUDE_UNRESOLVED`；1B 不猜测
  相对路径，也不引入异步 loader。

以上严格行宽和 unmapped-Unicode failure 是本项目 player ingestion policy；官方手册是
格式与字符集的规范来源，参考实现只用于隔离的行为交叉检查，不进入 build/test。

### 4.3 文件边界

- Production：`packages/contracts/src/public.ts` 只新增共享 `CartIdentity`；
  `packages/cart-codec/src/{public,model,p8,p8scii,sha256,errors}.ts` 承担 decoder/model，
  现有 PNG/compression 文件只做统一返回形状所需的最小修改。
- Machine contract：`spec/cart-codec-contract.json`、`spec/phase-1-l1-contract.json`、
  `packages/cart-codec/manifest.lock.json`。
- Tests：`tests/cart-codec/*.test.mjs` 与 project-authored synthetic vectors；禁止将
  `ref/` 或第三方 cart 作为 fixture/build input。
- Documentation：本文件、`04` 的 cart parser 状态、`08` 的 package status、package
  README 和 roadmap checkpoint。

不得在 1B 引入 CartSession、Runtime reset、renderer、UI、Canvas label decode、BBS resolver
或任何 Chrome 之外的浏览器范围。

### 4.4 Exit gate

专项测试必须覆盖 LF/CRLF/mixed、BOM、version、missing/unknown/duplicate sections、所有
ROM section packing、gfx/map2 overlap、P8SCII、include failure、input/code/row limits、
byte-offset errors、identity、snapshot ownership、`.p8.png` normalization、magic detection、
manifest/provenance 和 ambient-capability negative checks。

完成命令：

```text
pnpm run test:cart-codec
pnpm run test:architecture
pnpm run verify
```

完成状态必须保持 1B Complete、checkpoint 为 1B complete、next work unit 为 1C；Phase 1
仍保持 Active。最终提交后 `git status --short` 必须为空。

### 4.5 完成结论

Phase 1B 已交付 `decodeCart` / `decodeP8` / normalized `decodeP8Png`、shared
`CartIdentity`、bounded text section packing、P8SCII conversion、raw-byte SHA-256、稳定
warning/error inventory、project-authored LF/CRLF vectors 和 source/provenance manifest。
codec 不含 browser、I/O、RuntimeCore 或 `ref/` capability；label presentation、include
resolver 与 CartSession 保持 deferred。下一 work unit 启动前必须在本文件展开 1C 的
reset matrix、ownership、files 和 exit gate。

## 5. 1C 执行契约

### 5.1 目标与范围

1C 在 `@pico8-web/runtime-core` 内增加 browser-neutral `CartSession`。它只拥有当前 cart
snapshot、单调递增 generation、当前 frame runtime object graph 和生命周期状态；不拥有
Worker timer、MessagePort、Canvas presenter、DOM、AudioContext 或 AudioWorklet。

本 unit 交付：

1. `ParsedCart` 进入 session 时复制 `rom`/`code`，保存 immutable identity/format/version；
   caller 后续修改 decoder 返回的 typed array 不得改变 reset 输入。
2. 首次 `load`、同 cart `reset` 和换 cart `load` 都分配新 generation，创建全新的
   `FrameSliceRuntime`/VM/router/RAM object graph，并以六键全零输入 cold boot。
3. boot/step/host-completion 的 VM fault 立即 dispose 当前 runtime；session 保留 cart snapshot，
   进入 `faulted`，只能通过新 generation reset/load 或终态 dispose 离开。
4. host request 带 generation；completion 必须同时匹配 active generation 和 request id。
   stale generation 返回 `E_INVALID_STATE`，不得调用 VM、改变 state 或覆盖 `lastError`。
5. `stop` 释放当前 runtime、保留 cart 供 reset；`dispose` 幂等释放 runtime 并丢弃 cart，之后
   所有 load/reset/step/completion 都拒绝。

1C 不实现 in-place VM reset、warm reload、`reload()`/`cstore()` guest API、cartdata persistence、
input edge/repeat、audio synthesis、Worker scheduler、player UI、BBS resolver 或网络获取。

### 5.2 Ownership 与 dependency boundary

`CartSession` 只依赖 RuntimeCore 内部定义的 `CartSessionRuntimePort` 和同步 factory；factory
由 `apps/web-player/src/worker/compose-runtime.ts` 在 1E 接入 concrete z8lua adapter。RuntimeCore
不得 import `@pico8-web/z8lua-bridge`，factory 不得返回共享 singleton。

每个成功创建过的 runtime object 只能属于一个 generation。即使旧 runtime 已 dispose，factory
再次返回相同 object 也属于 `E_INVARIANT`。session 不回滚或恢复旧 object graph：load/reset 一旦
开始，旧 runtime 就被冻结并释放；candidate boot 失败后 session 进入 `faulted`，防止“旧 VM +
新 RAM/cart”混合状态。

cart snapshot 是 session-private，不暴露可写 `rom`/`code` view。对外只暴露 frozen identity 和
metadata。frame/screen snapshot 继续沿用 `FrameSliceRuntime` 的复制边界。

### 5.3 状态机与 generation

```text
empty --load--> loading --boot ok--------> ready
                     \--host request-----> waiting-host
                     \--failure----------> faulted

ready --step/frame-----------------------> ready
ready --step/host request----------------> waiting-host
waiting-host --matching completion-------> ready | waiting-host | stopped
ready|waiting-host --VM fault------------> faulted (runtime disposed)
ready|waiting-host|faulted|stopped --reset/load--> loading (new generation)
ready|waiting-host --stop----------------> stopped (runtime disposed, cart retained)
any non-disposed --dispose---------------> disposed (terminal)
```

generation 从 1 开始，只有已开始的 load/reset transaction 才递增。参数校验在 transaction 前
失败时不得 teardown 当前 session。`loading` 是同步 transaction 的内部可观察状态，不允许重入
控制调用。`FrameSliceRuntime` 的 `ready/waiting-host/stopped/faulted` 由 `CartSession` 映射，
Worker 的 `running/paused` 和 wall-clock scheduling 仍属于 1E。

### 5.4 Cold-run reset matrix

| State/resource | load/reset policy | 1C verification |
| --- | --- | --- |
| z8lua state、coroutine、host router | 全新 factory result；旧 graph dispose，不原地复用 | fake-runtime ownership + real WASM integration |
| Base RAM 64 KiB | 全零后恢复 `0x5f54=0x00`、`0x5f55=0x60`，再复制 Cart ROM `0x0000..0x42ff` | real WASM RAM assertions |
| Cart ROM/code | session-owned byte copies；reset 复用该 immutable snapshot | caller-mutation/reset test |
| Lua globals/stack/pending request | 随旧 VM 销毁；pending completion 由 generation 失效 | stale completion test |
| input | boot 固定 `buttons=0`；held/edge/repeat 后续状态不得跨 generation | boot input spy；1D 扩展 |
| frame clock/output | `frameId=0`、startup epoch 和 completed slices 从新 runtime 开始；screen 由新 RAM/cart boot 产生 | reset clock/frame test |
| `0x5e00..0x5eff` persistence | 1C 未映射 persistence，cold run 为零；未来 hydrate 必须在 boot transaction 显式加入 | RAM assertion；Phase 2 扩展 |
| placeholder audio | 1C 没有 audio simulation state；新 generation 是未来 PCM/event queue 的失效 token | public contract + no browser/audio import |

官方手册说明 cart 在 run 时把 Cart ROM 数据区复制到 Base RAM；本表额外规定当前 L1 player 的
deterministic cold-run policy。它不是对未来 `run()`、`reload()`、`cartdata()` 兼容性的声明。

### 5.5 Errors 与 teardown

- public lifecycle misuse、stale generation、无 cart reset、terminal dispose 后调用返回
  non-recoverable `E_INVALID_STATE`，但不把健康 session poison。
- factory throw、runtime object reuse、teardown/port invariant failure 转为 non-recoverable
  `E_INVARIANT`；不得让异常跨 Worker-facing RuntimeCore API 泄漏。
- VM syntax/runtime/budget/host fault 保留原 code/phase/line/trace；`CartSession.lastError` 保存最近
  一次真正使 generation fault 的序列化错误。stale/misuse 不覆盖它。
- fault、stop、replacement 和 dispose 都必须 exactly-once teardown 当前 runtime；dispose 本身
  对重复调用幂等。

### 5.6 文件边界

- Production：把现有 frame-slice implementation 从 public barrel 移到
  `packages/runtime-core/src/frame-runtime.ts`；新增
  `packages/runtime-core/src/session/cart-session.ts`；`src/public.ts` 只导出稳定入口。
- Runtime integration：`FrameSliceRuntime.boot` 消费 normalized `ParsedCart` 的 `rom`/`code`
  字段，不再把 `.p8.png` compatibility alias 写进新 lifecycle contract。
- Machine contract：展开 `spec/phase-1-l1-contract.json#workUnits.1C`。
- Tests：新增 `tests/runtime/phase-1c-cart-session.test.mjs`，使用 project-authored synthetic cart、
  fake runtime ownership probes 和真实 z8lua WASM；不得引用 `ref/` 或第三方 cart fixture。
- Documentation：本文件、`04` 的 CartSession/reset implementation status、`08` 的 RuntimeCore
  source status、README/roadmap checkpoint。

1C 不修改 Worker command protocol 或 player composition；该接线属于 1E。`compose-runtime.ts`
当前 Phase 0E probe 继续直接构造单个 runtime，不得被误标为已使用 CartSession。

### 5.7 Exit gate

专项测试必须覆盖：首次 load、same-cart reset、cart swap、snapshot ownership、cold RAM defaults、
zero input、frame clock restart、host request generation、stale completion、factory reuse/throw、
compile/runtime fault teardown、stop/reset、idempotent dispose、invalid-state non-poisoning、public
exports、package dependency/browser-capability negative checks。

完成命令：

```text
pnpm run test:phase-1c
pnpm run test:phase-0e
pnpm run test:phase-1a
pnpm run test:architecture
pnpm run verify
```

完成后把 1C 标记 Complete、checkpoint 更新为 1C complete、next work unit 更新为 1D；Phase 1
保持 Active。最终提交后 `git status --short` 必须为空。

### 5.8 完成结论

Phase 1C 已交付 browser-neutral `CartSession`、normalized cart private snapshot、fresh
generation runtime factory、cold load/reset、generation-tagged HostRequest、stale completion
拒绝与 fault/stop/dispose teardown。真实 z8lua 集成测试锁定 64 KiB clear、video mapping defaults、
Cart ROM `0..0x42ff` copy、zero input 和 frame clock restart；fake runtime tests 锁定 ownership、
object reuse、factory failure 与 exactly-once dispose。Worker/player 接线、audio simulation、
input edge/repeat、persistence 和完整 `run/reload` compatibility 保持 deferred。下一 work unit 是
1D L1 graphics/input。
