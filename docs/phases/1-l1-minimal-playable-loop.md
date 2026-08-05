# Phase 1：L1 最小可玩闭环

- 状态：**Active**
- 当前 checkpoint：**1B Text `.p8` decode and ParsedCart normalization complete**
- 下一 work unit：**1C CartSession lifecycle**
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
