# Phase 1：L1 最小可玩闭环

- 状态：**Active**
- 当前 checkpoint：**1E Scheduler/player shell complete**
- 当前 work unit：**None**
- 下一 work unit：**1F L1 exit**
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
| 1D L1 graphics/input | **Complete** | `line/rect/circ`、normalized held/edge 与 `btnp` 最小闭环 |
| 1E Scheduler/player shell | **Complete** | Worker tick、load/reset/fault UI 与 Phase 0F adapters 接通 |
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

## 6. 1D 执行契约

### 6.1 目标、输入与兼容边界

1D 只补齐 L1 cart 在单个 simulation tick 内需要的 browser-neutral graphics/input 语义。
输入仍是 `PicoInputSnapshot.buttons` 的玩家 0 六键 bitmask；它是 main thread 未来把
keyboard/gamepad/touch 归一化后的逻辑输入，不是 DOM `KeyboardEvent`。物理键位、事件监听、
焦点和默认按键映射属于 1E 的 `apps/web-player` input frontend，不进入 RuntimeCore。

本 unit 交付：

1. 在现有 `cls/pset` 之上增加同步 generated bindings：`line`、`rect`、`rectfill`、
   `circ`、`circfill`；operation id 只追加，不重排 1A 的 `1..3`。
2. graphics 直接写 leased 64 KiB RAM 的当前 mapped screen；当前画笔色存于 `0x5f25`，
   `line` continuation 的 invalid flag/endpoint 存于 `0x5f35`、`0x5f3c..0x5f3f`，不得以
   renderer 或 module singleton 作为权威状态。
3. 每次 `FrameSliceRuntime.step` 在进入 guest 前恰好推进一次 input latch，写玩家 0 held
   register `0x5f4c`，并计算该 tick 的 pressed/repeat mask；一次 suspended HostRequest 的
   completion 不得再次推进 latch。
4. `btn` 保持 held query；新增 `btnp(button[, player])` edge/repeat query。L1 只支持玩家 0、
   button `0..5`；其他 player/button 返回 false，不扩大 multiplayer 声明。
5. cold boot/reset 清除 held/edge/hold-duration，恢复 pen `6` 和 invalid polyline；这些状态
   不得跨 1C generation 泄漏。

官方 v0.2.7 语义锁定：`rect/rectfill` 坐标可逆序且 corner inclusive；`circ/circfill` 默认
radius 为 4、负 radius 不画；`line()` 使下一次二/三参数 `line` 只建立 endpoint，显式五参数
形式同时更新 endpoint。显式 color 参数更新 `0x5f25` 的低 nibble；`cls` 不改变 pen。

本 unit 的 graphics 仍是 **partial**：camera、clip、draw palette、fillp、bitplane、screen mode、
`pget/oval/spr/sspr/map/tline/print` 全部 deferred 到 Phase 2。`cls` 只恢复 full-screen clip
register defaults，其他 L1 primitive 暂只受 128×128 physical bounds 限制。不得把目标 Graphics
接口示例误标为已经实现。

### 6.2 Input tick 与 repeat

```text
validate normalized snapshot
  -> beginTick(buttons, targetFps) exactly once
  -> write RAM held register / compute pressed mask
  -> VM update/custom-loop + draw
  -> optional HostRequest wait/resume without another beginTick
  -> commit frame or fault
```

- 初次 held tick 的 `btnp` 为 true；释放 tick 清零该键 hold duration；重新按下重新产生 edge。
- 默认 repeat 是 30Hz 下初次 edge 后等待 15 tick，再每 4 tick；60Hz 对应 30/8 tick。
- `0x5f5c` 非零覆盖 delay，`0x5f5d` 非零覆盖 interval；两者在 60Hz 同样按 2 倍 tick
  解释。delay `255` 禁止 repeat。寄存器在 tick 开始时 snapshot，本 tick 内 guest `poke`
  只影响下一 tick。
- boot 的 top-level/`_init` 使用全零 snapshot 和 30Hz startup epoch；正常 callback/custom
  step 使用 VM 已确定的 `targetFps`。invalid input 在 beginTick 前拒绝，不消费 edge/repeat。
- input latch 属于 RuntimeCore；WASM 仍接收同一个 held mask 供 frame ABI 使用，但不得另建
  一套 `btnp` 状态机。

这里的 keyboard-like repeat 是 L1 六键最小实现。完整多人输入、pause button、mouse、完整
keyboard/gamepad/touch frontend 与 device remapping 仍 deferred；不得把 1D 标成完整 Input。

### 6.3 Source 与 ownership

- `packages/runtime-core/src/pico-api/pico-api-host.ts`：公开 facade/port，验证 lease，并组合
  graphics/input；不拥有 frame scheduling。
- `packages/runtime-core/src/graphics/l1-graphics.ts`：RAM-backed pen/polyline 与 packed 4bpp
  raster；不 import Canvas、DOM 或 presenter。
- `packages/runtime-core/src/input/l1-input.ts`：逐 tick held/edge/repeat 与 hardware registers；
  不读取 physical keyboard。
- `packages/runtime-core/src/frame-runtime.ts`：只在 boot/step transaction 边界调用
  `beginTick`，HostRequest resume 复用 pending transaction。
- `spec/abi/pico-host-api-v1.json` 是 guest binding 顺序/签名的唯一机器源，generated TS/C
  和 hash manifest 由 generator 更新，不得手改。
- `spec/phase-1-l1-contract.json` 与 `spec/pico-api-inventory.yaml` 记录范围和已知差异；
  `ref/` 只用于人工交叉阅读，不进入 source、fixture、test 或 build。

RuntimeCore 继续只依赖 contracts/cart-codec。z8lua bridge 对 RuntimeCore 保持 type-only runtime
edge；新增 API 不允许在 bridge C++ 中实现 graphics/input 语义。

### 6.4 Tests 与 exit gate

新增 `tests/runtime/phase-1d-graphics-input.test.mjs`，使用 project-authored source carts 和
真实 z8lua WASM，覆盖：

- generated schema 顺序、全部新增签名、raw Q16.16/optional 参数和 synchronous dispatch；
- mapped packed framebuffer、default/explicit pen、line reset/continuation/endpoint RAM、
  reversed/inclusive rect、circle default/negative radius 和 screen clipping；
- held RAM register、press/release/repress、30/60Hz repeat、custom delay/interval、255 disable、
  invalid player/button；
- input 在 update 前可见、draw 同 tick 可见、HostRequest completion 不 double-advance、
  invalid snapshot 不消费状态、CartSession reset 后 input/draw state 不泄漏；
- package public exports、browser-capability/ref negative checks 和既有 0E/1A/1C 回归。

完成命令：

```text
pnpm run test:phase-1d
pnpm run test:phase-1a
pnpm run test:phase-0e
pnpm run test:phase-1c
pnpm run test:architecture
pnpm run verify
```

完成后把 1D 标记 Complete、checkpoint 更新为 1D complete、active work unit 清空、next work
unit 更新为 1E；README/roadmap/04/08 与 inventory 同步实际状态。最终提交后
`git status --short` 必须为空。

### 6.5 完成结论

Phase 1D 已交付 RAM-backed `L1Graphics`、逐 tick `L1Input` 与只负责组合的
`PicoApiHost` facade；production schema 以追加 id `4..9` 注册
`line/rect/rectfill/circ/circfill/btnp`，旧 `1..3` 保持稳定。真实 z8lua 测试锁定 mapped
packed pixels、pen/polyline hardware state、30/60Hz repeat、repeat register snapshot、
HostRequest resume 与 CartSession generation reset。完整 draw state、剩余 graphics API、
多人/device input 与 app physical mapping 仍按 6.1/6.2 deferred。下一 work unit 是 1E。

## 7. 1E 执行契约

### 7.1 目标、输入与明确排除

1E 把已经完成的 `decodeCart`、`CartSession`、L1 graphics/input 和 Phase 0F Canvas/audio
transport 组成第一个可交互 player path。用户选择的 `.p8` 或 `.p8.png` bytes 在 main thread
保留一份 watchdog recovery snapshot，实际 decode、VM object graph 和 simulation tick 全部留在
Runtime Worker。加载只进入 `ready`；只有显式 `start` 才进入 `running`。

本 unit 交付：

1. browser-neutral `FrameScheduler` accumulator：消费 wall-clock pulse，按 cart 的 30/60Hz
   产生 `0..5` 个 tick decision；它不读取 Worker timer、DOM 或 `requestAnimationFrame`。
2. production Worker composition 改为通过 `CartSession` factory 创建 fresh router/VM/runtime，
   同时接受 `.p8` 与 `.p8.png`；Phase 0E direct-runtime controller 只作为冻结的 probe 兼容路径。
3. versioned player protocol 与 main runtime client：覆盖 load/start/input/vsync/pause/resume/reset/
   stop/dispose、frame/state/heartbeat/fault，并把 Worker incarnation 与 cart session generation 分开。
4. main-thread keyboard frontend、Canvas presenter composition 和最小 DOM controller：load/reset/
   pause/resume/stop/fault 状态由 DOM 表达，playfield 仍只由 Canvas presenter 绘制。
5. fake-clock 单元/集成测试与真实 z8lua Chrome/Chromium smoke，验证 scheduling、input、reset、
   presenter 和 fault containment 的完整路径。

1E 不实现 BBS/network resolver、`load()` guest cart resolver、persistence、gamepad/touch、多人键位、
pause menu、audio synthesis、完整 PICO-8 console 或 Firefox/WebKit。Phase 0F audio frontend 只接入
session-generation/port lifecycle；没有 PCM producer 时保持静音是预期行为。

### 7.2 Execution-domain 与 ownership

```text
DOM / KeyboardEvent / File / requestAnimationFrame (main)
  -> normalized six-button snapshot + monotonic vsync pulse
  -> versioned transport
  -> Worker controller
       -> FrameScheduler decision (RuntimeCore)
       -> CartSession generation (RuntimeCore)
       -> fresh router + Z8LuaFrameVm + FrameSliceRuntime (Worker composition)
  -> immutable frame event
  -> Canvas2DFramePresenter (main)
```

- main thread 不能计算 simulation backlog、直接 step VM 或把 Canvas 当作游戏状态；它只在可见且
  running 时发送 rAF timestamp pulse。`visibilitychange`/blur 清除 held input 并暂停。
- Worker controller 拥有当前 normalized input、scheduler run state 和外部 session token；
  `CartSession` 继续独占 cart snapshot、core generation 和 runtime object graph。
- `FrameScheduler` 只返回 tick count/discontinuity metadata；Worker controller 按 decision 顺序调用
  `CartSession.step`。这样 scheduler policy 可用 fake clock 确定性测试，同时 RuntimeCore 不获得浏览器
  capability。
- renderer 只消费 generation-tagged packed frame；load/reset 先 reset presenter，旧 generation 或
  非单调 frame id 必须丢弃。DOM status/diagnostic 是唯一 shell UI，不绘入 playfield。
- composition/controller dispose 必须取消 rAF、移除 keyboard/DOM listener、清空 pending commands、
  dispose presenter/audio、终止 Worker；任何层不得使用 module/global singleton 保存 session state。

### 7.3 Protocol 与 generation

`apps/web-player/src/transport/player-protocol.ts` 是 1E production transport source。所有 control
command/event 固定 `v=1`、positive `requestId`、`workerGeneration` 和 `sessionGeneration`：

- `workerGeneration` 由 main client 在每次 Worker spawn/watchdog restart 时递增，只用于拒绝旧
  Worker reply。
- `sessionGeneration` 由 main client 在每次 load/reset transaction 前递增，在 Worker restart 后
  仍保持单调；Worker 把它映射到当前 `CartSession.generation`，不得假设二者数值相等。
- `input` 是 requestless、sequence-tagged snapshot；同 generation 的 stale sequence 被忽略。每个
  `vsync` control command 在零或多个 `frame` 后必须以一个 `heartbeat` 终止，供 main watchdog 收敛。
- load/reset/start/pause/resume/stop/dispose 以 `state` 或 `fault` 终止；protocol validation fail-closed，
  unknown version/type、NaN timestamp、错误 frame byte length 和不匹配 generation 不得进入 runtime。
- packed framebuffer 使用 transferable `ArrayBuffer`。原始 cart bytes 只在 load command transfer；
  main 保留自己的 copy，以便 Worker 被 watchdog 终止后显式 reset 能重建 session。

`hostRequest`/`supplyCart` 保持 deferred：L1 cart 若在 boot/step 产生 HostRequest，1E 以稳定
`E_FEATURE_UNSUPPORTED` fault 停止 scheduling，不能静默阻塞。Phase 0E prototype protocol 保持现有
专项测试兼容，但新的 player shell 不 import 或发送该协议。

### 7.4 Scheduler、input 与 shell policy

- scheduler 首个 pulse 只建立 anchor；正常 delta 进入 accumulator，tick duration 为 `1000/fps`。
  单个 pulse 最多 catch up 5 ticks；超过上限时执行 5 ticks并丢弃剩余 backlog，发 recoverable
  `E_TIME_DISCONTINUITY` diagnostic。pause/resume/hidden recovery 清空 accumulator 并重建 anchor，
  不追赶后台时间；不得自适应改变 cart 的 30/60Hz。
- main 在每个 rAF 中先发送当前 input sequence/snapshot，再发送 vsync；只有实际 tick 才由
  RuntimeCore 推进 edge/repeat。rAF pulse 为零 tick 时不得消费 `btnp` 或 frame clock。
- Player 1 默认 physical mapping 与官方 v0.2.7 一致：cursor keys + `Z/X`，并接受同组别名
  `N/M`、`C/V`；输出仍只是 bits `left/right/up/down/O/X = 0..5`。只在 player canvas/shell active
  时 prevent mapped key default；repeat `keydown` 不重复制造边沿。
- `blur`、hidden、pause、stop、fault、reset 与 dispose 都发送/本地设置 zero snapshot，防止 held key
  跨 lifecycle 泄漏。reset cold-runs 后回到 ready；若 reset 前正在 running，DOM controller 可显式
  再 start，但 protocol 不把 reset 和 start 合并。
- shell 至少提供 file input、play/pause、reset、stop、focusable 128×128 Canvas、live status 和
  diagnostic region。文件名/扩展名只用于显示；format detection 仍完全由 codec bytes magic 决定。

### 7.5 Source、tests 与 exit gate

- RuntimeCore：`packages/runtime-core/src/scheduler/frame-scheduler.ts` 与 public export。
- Transport：`apps/web-player/src/transport/player-protocol.ts`、validators/public barrel；
  `spec/phase-1-l1-contract.json#workUnits.1E` 锁定命令、generation、scheduler 和 key mapping。
- Worker：`compose-runtime.ts` 只新增 stable `CartSession` composition；`runtime-worker.ts` 只做
  validation、message serialization、transfer 和 audio-port lifecycle。
- Main：stable runtime client、`compose-player.ts`、`input-frontend.ts`、`player-controller.ts`、
  `main.ts` bootstrap；Canvas/audio browser APIs 不进入 Worker/RuntimeCore。
- Tests：`tests/runtime/phase-1e-scheduler-player.test.mjs` 使用 fake clock/worker ports；
  `tests/browser/phase-1e.*` 和 project-authored text cart 走真实 Worker、WASM、rAF、keyboard、Canvas。

专项覆盖：30/60Hz accumulator、zero-tick、5-tick cap/backlog drop、pause/resume anchor、non-monotonic
timestamp、request/worker/session/input sequence freshness、CartSession fresh graph、text/PNG detection、
load→ready→start、keyboard aliases/blur clear、frame presentation、pause/reset/stop、malformed-cart/VM fault、
watchdog byte retention、dispose/idempotence、architecture/ref/browser capability negative checks。

完成命令：

```text
pnpm run test:phase-1e
pnpm run test:phase-0e
pnpm run test:phase-0f
pnpm run test:phase-1c
pnpm run test:phase-1d
pnpm run test:architecture
pnpm run test:browser:chromium
pnpm run verify
```

完成后把 1E 标记 Complete、checkpoint 更新为 1E complete、active work unit 清空、next work unit
保持 1F；同步 README/roadmap/02/04/08 的实际状态。1F 才运行 original-cart compatibility matrix、
写 immutable phase evidence 并判定 L1 exit。最终提交后 `git status --short` 必须为空。

### 7.6 完成结论

Phase 1E 已交付 browser-neutral `FrameScheduler`、stable player protocol、main-owned
Worker/session 双 generation、watchdog cart-byte recovery、`CartSession` production Worker
composition、Player 1 keyboard normalization、minimal DOM controller、Canvas presenter 与可选
Phase 0F audio lifecycle。esbuild 只在 build-time 生成 Chrome Module Worker bundle；WASM、VM、
session 与 scheduling execution 仍在 Worker，DOM/Canvas/AudioContext 仍只在 main。

fake-clock/real-WASM tests 锁定 30/60Hz、zero-tick、5-tick catch-up、backlog drop、pause anchor、
protocol freshness、cold reset 和 bootstrap queue；Chrome gate 锁定真实 Worker+WASM+rAF、
`ZX/NM/CV` aliases、blur clear/pause、frame presentation、stop 与 parse-fault UI。audio synthesis、
BBS/resolver、persistence、gamepad/touch/multiplayer 和完整 conformance 仍未声明支持。下一 work
unit 是 1F L1 exit。
