# 04 — Web-native TypeScript Runtime 架构

> 状态：Living boundary contract（当前 production 边界 + 明确 Deferred 项）
> 目标运行环境：现代 Chrome 或 Chromium；主线程 + Dedicated Worker + AudioWorklet
> 兼容目标：PICO-8 v0.2.7 Player；以官方手册为规范，以 fake-08 为可读参考实现
> 本文范围：除 P8 Lua VM 本体外的 Web Runtime。z8lua/WASM 的 ABI 与构建细节由独立文档定义。

## 状态路由

本文同时保存已接受边界和明确 Deferred 项。示意代码只解释稳定语义；精确 API 必须以
机器契约、public export 和测试的交集为准，避免在文档中维护第二套类型。

| 状态 | 对应范围 |
| --- | --- |
| **Implemented** | browser-neutral CartSession/RuntimeCore；canonical RAM/graphics/audio/input/persistence；CartLoader/local resolver/repository 与 caller-authorized text include；root controls 与 root HostRequest；atomic guest `load`、external `reload/cstore`；deterministic scheduler/CPU accounting；Worker/Canvas/AudioWorklet/IndexedDB adapters；bounded resource lifecycle |
| **Accepted invariant** | WASM/TS 分工、单一 Pico RAM、浏览器中立 RuntimeCore、确定性 canonical PCM 与错误边界 |
| **Deferred** | label presentation、advanced Graphics、general nested-coroutine HostRequest、BBS/network resolver 与未激活 capability |

当前 L3 local/multicart profile 以
[`phase-5-l3-multicart-contract.json`](../spec/phase-5-l3-multicart-contract.json) 为准；早期
control 与 browser boundary 分别由 `phase-0e-runtime-contract.json` 和
`phase-0f-browser-boundary.json` 保留。本文不得被用来提前实现未激活 phase 范围。

## 1. 文档目的与规范用语

本文把“z8lua WASM + TypeScript Runtime”拆成可以直接编码、测试和验收的模块契约。后续 Codex 实现代码前，必须先能回答：代码属于哪个模块、依赖方向是否正确、状态由谁拥有、如何确定性测试、错误如何跨 Worker 上报。

规范用语：

- **MUST / 必须**：不满足即不接受合并。
- **MUST NOT / 禁止**：违反会破坏兼容性、安全边界或架构边界。
- **SHOULD / 应当**：默认实现；偏离时必须在 PR 中记录理由和测试影响。
- **MAY / 可以**：可选优化，不得改变可观察语义。

规范优先级：

1. [PICO-8 v0.2.7 官方手册](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)；
2. 由正版 PICO-8 生成并获准纳入仓库的 conformance golden；
3. [fake-08](https://github.com/jtothebell/fake-08) 与 [zepto8](https://github.com/samhocevar/zepto8) 的行为参考；
4. 本项目的明确兼容策略。

fake-08 不是规范。本文调研时参考提交 `814991a2571ad3970e386cef48f3b148aa1c27b9`，重点参考其 [`cart.cpp`](https://github.com/jtothebell/fake-08/blob/814991a2571ad3970e386cef48f3b148aa1c27b9/source/cart.cpp)、[`PicoRam.h`](https://github.com/jtothebell/fake-08/blob/814991a2571ad3970e386cef48f3b148aa1c27b9/source/PicoRam.h)、[`Audio.cpp`](https://github.com/jtothebell/fake-08/blob/814991a2571ad3970e386cef48f3b148aa1c27b9/source/Audio.cpp) 和 [`vm.cpp`](https://github.com/jtothebell/fake-08/blob/814991a2571ad3970e386cef48f3b148aa1c27b9/source/vm.cpp)。若参考实现与官方/金标冲突，必须以官方/金标为准并加入回归测试。

## 2. 核心决策

### 2.1 WASM 与 TypeScript 的边界

WASM 只负责：

- z8lua parser、bytecode VM、GC、coroutine；
- P8 Lua 的 Q16.16 数值与语言语义；
- Lua stack 与宿主 API 的薄 ABI；
- 指令预算和可恢复的宿主请求 trap。

TypeScript 负责：

- cart 识别、解析、依赖解析与 ROM 生命周期；
- 64KiB PICO RAM 的宿主视图；
- graphics、map、audio、input 和高层 hardware API；低层 Base RAM API 使用 bridge 内的
  dedicated wrapper，但与 RuntimeCore 共用同一个 canonical mapper；
- 帧调度、持久化、多 cart、Worker 协议和播放器状态机；
- Canvas/WebGL 呈现与 AudioWorklet 输出。

**MUST** 使用同一块 WASM linear memory 中的 64KiB 区域作为 PICO RAM，z8lua 与 TypeScript 不得各自维护一份 RAM。**MUST NOT** 每帧复制整块 RAM。

### 2.2 状态所有权

| 状态 | 唯一所有者 | 其他模块如何访问 |
|---|---|---|
| PICO Base RAM allocation/pointer lifetime | z8lua bridge context | `PicoMemoryLease`；固定 typed views |
| PICO Base RAM runtime 语义与 hardware writes | `PicoRam`（Worker 内） | 对同一 lease 的同步 typed views；不另分配 RAM |
| 当前 normalized Cart ROM/code snapshot | RuntimeCore `CartSession` | session-private byte copies 用于无 payload `reset`；只暴露 frozen identity/format/version metadata |
| 当前 cart 原始 source bytes | main `PlayerRuntimeClient` / Worker repository | 用于 Worker watchdog 重建、重新 decode 与 caller-authorized local resolution；不进入逐帧 core state |
| Lua/协程/GC | z8lua WASM | ABI 命令，不直接读内部结构 |
| 图形 draw state | RAM `0x5f00..` | `Graphics` 每次从 RAM 读取/写回 |
| SFX/Music 播放状态 | `AudioSynth` | 只由逻辑 tick/采样推进 |
| 原始 DOM 输入 | 主线程 `InputFrontend` | 归一化消息 |
| PICO 按键/重复状态 | Worker `Input` | 每 tick 更新 RAM/API |
| 永久 cartdata | `PersistenceAdapter` | Worker 内镜像 + 异步提交 |
| Canvas/DOM | 主线程 `ScreenPresenter` | 只消费帧消息 |
| AudioContext 生命周期 | 主线程 `AudioFrontend` / `PlayerController` | 创建 Worklet、resume/suspend、设备错误 |
| 设备 PCM queue | `Pico8AudioProcessor`（AudioWorklet） | 只消费 PCM，不驱动模拟 |

同一状态不得有两个可写权威来源。派生缓存必须能从权威状态重建。

### 2.3 决策归属

历史 decision ledger 已由 [`docs/adr/`](./adr/) 和
[`07-decisions-risks-open-questions.md`](./07-decisions-risks-open-questions.md) 接管，本文件不复制其
阶段状态。当前必须保持的结论包括：fixed WASM memory、bytes-only `.p8.png`、dedicated
MessagePort audio、四 package/三 execution-domain 边界、root-only recoverable HostRequest，以及
callback/custom-loop committed-slice clock。改变其中任一项必须先替代对应 Accepted ADR。

## 3. 运行拓扑与数据流

```text
Window PlayerController <── control / input / frame / diagnostics ──> RuntimeWorker
        │                                                          ├─ RuntimeCore
        │ creates MessageChannel                                   ├─ z8lua WASM <─> PicoRam
        │ transfers port A                                         ├─ Cart/Graphics/Input/Scheduler
        ▼                                                          └─ AudioSynth
AudioWorklet <──────── port B : bounded PCM queue ──────────────────────────┘
```

关键约束：

- **MUST** 在 Dedicated Worker 内运行 z8lua、Graphics、AudioSynth 和调度器。cart 卡死时，主线程必须仍可响应并终止 Worker。
- **MUST NOT** 从 WASM import 中操作 DOM、Canvas、AudioContext、`fetch()` 或 IndexedDB Promise。
- 所有 Lua 调用的 PICO API 都是同步的。需要异步资源时，ABI 必须产生可恢复的 `HostRequest`，Runtime 暂停 VM，资源就绪后显式 resume；不得伪造同步网络读取。
- Canvas/WebGL 只是呈现器，AudioWorklet 只是设备适配器。二者不得反向决定游戏状态或逻辑 tick。
- Window 只负责创建 AudioContext/AudioWorklet 和转交专用 port；完成握手后，PCM 数据
  **MUST** 走 Worker ↔ AudioWorklet 的专用 `MessagePort`，不混入 Window↔Worker 控制协议。

## 4. 依赖方向

允许的依赖方向如下：

```text
player-ui ──> runtime-client/protocol
runtime-worker ──> RuntimeCore ──> domain ports
RuntimeCore ──> CartSession / PicoRam / Graphics / AudioSynth / Input / Scheduler
Graphics / AudioSynth / Input ──> PicoRam
WasmBridge ──> PicoApiHost interfaces ──> RuntimeCore modules
IndexedDB / network / File API ──> port adapters（实现接口）
```

禁止的反向依赖：

- `PicoRam` **MUST NOT** 依赖 Graphics、Audio、VM 或浏览器 API。
- `CartParser` **MUST NOT** 发网络请求、读 IndexedDB 或创建 Canvas。
- Graphics **MUST NOT** 依赖 Canvas/WebGL；AudioSynth **MUST NOT** 依赖 AudioContext。
- z8lua glue **MUST NOT** 知道 URL、BBS、IndexedDB schema 或 UI。
- 主线程 **MUST NOT** 直接读写 WASM/PICO RAM。

源码目录不在本文重复定义；唯一 canonical layout、package exports、composition roots 和机器边界门禁见 [08-source-layout-and-boundaries.md](./08-source-layout-and-boundaries.md)。本文概念模块映射如下：

| 本文概念 | Canonical code owner |
|---|---|
| 跨 package stable values / serialized RuntimeError | `@pico8-web/contracts` |
| CartParser / ParsedCart | `@pico8-web/cart-codec` |
| PicoRam / Graphics / AudioSynth / Input / Scheduler / CartSession / RuntimeCore | `@pico8-web/runtime-core` |
| Runtime ports 与 PicoApiHost contract | `@pico8-web/runtime-core` public exports |
| z8lua loader / raw ABI / generated binding | `@pico8-web/z8lua-bridge` |
| Window ↔ Worker、Worker ↔ Worklet DTO | `apps/web-player/src/transport` |
| DOM、renderer、input frontend、Worker/Worklet entrypoint、IndexedDB adapter | `apps/web-player` 对应 execution domain |

RuntimeCore 不 import z8lua concrete adapter；`apps/web-player/src/worker/compose-runtime.ts` 是唯一把 core、codec、bridge 和浏览器 adapters 组装起来的 composition root。

ADR-008 已 Accepted：production API schema 单向生成 C descriptor 与 TS dispatcher，生成物
必须位于独立目录并由 hash manifest/architecture test 审计。prototype schema 不得作为
runtime capability；typed `PicoApiHost` 仍是 hardware 语义 owner。

## 5. Cart 加载与解析

### 5.1 公共接口

```ts
type CartSource = Readonly<{
  bytes: Uint8Array;
  name?: string;
  mediaType?: string;
  origin: "file" | "drop" | "cache" | "resolver" | "test";
  locator?: string;       // 仅诊断，不作为身份
}>;

type CartIdentity = Readonly<{
  contentSha256: string;  // 对原始输入 bytes 计算
}>;

type ParsedCart = Readonly<{
  identity: CartIdentity;
  format: "p8" | "p8.png";
  version: number;
  rom: Uint8Array;        // 内部 0x8000-byte container；guest 仅可读/写 < 0x4300
  code: Uint8Array;       // 解压后的 P8SCII bytes，不是 JS Unicode string
  warnings: readonly CartWarning[];
  sourceBytes: number;
}>;

interface CartParser {
  parse(source: CartSource): Promise<ParsedCart>;
}

interface IncludeResolver {
  resolve(specifier: string, parent: CartIdentity): Promise<Uint8Array>;
}
```

当前 codec 提供同步、无 I/O 的 `decodeCart(Uint8Array)`、`decodeP8(Uint8Array)` 和
`decodeP8Png(Uint8Array)`；RuntimeCore 已提供 `CartLoader` 和 resolver/repository ports，Worker
已提供 caller-authorized local adapters。上方 `CartParser`/`CartSource` 只是 codec 输入语义示意，
不是待复制的 public facade；`IncludeResolver` 仍 Deferred。`decodeCart` **MUST** 先检查文件
magic，而不是信任扩展名或 `mediaType`。

`CartIdentity` 由 `@pico8-web/contracts` 拥有且只含内容 SHA-256。display name、locator、
origin 和 opaque resolver ref 是 loader/session metadata，不得污染 raw-byte content
identity。`ParsedCart` 和 format-specific metadata 由 `@pico8-web/cart-codec` 拥有；早期 contract
字段 `cartVersion`/`luaSource` 暂作为 `version`/`code` 的兼容 alias。

record、identity 和 warning records 在运行时 freeze；typed-array 元素受 JavaScript 限制不能
freeze。每次 decode 返回无内部 alias 的 caller-owned snapshot；`CartSession.load`
会再次复制 ROM/code 并且每次 boot 只把 generation-local copy 交给 runtime，因此 caller 后续
修改 decoder snapshot 不影响 reset。需要 `cstore` 时仍须创建 copy-on-write overlay。

### 5.2 `.p8` 文本 cart

解析器必须：

1. 验证 `pico-8 cartridge` header，并读取 `version`；未来版本默认返回 `E_CART_FUTURE_VERSION`，只有显式兼容开关才继续。
2. 接受 LF/CRLF，但 **MUST NOT** 对 Lua 代码做 Unicode NFC/NFKC、大小写转换或通用 trim。
3. 识别 `__lua__`、`__gfx__`、`__gff__`、`__map__`、`__sfx__`、`__music__`、`__label__`；未知 section 保留 warning，不得误并入 Lua。
4. 按 PICO-8 的文本/P8SCII 映射把外部 UTF-8 转为字节，且只能转换一次。内部字符串与代码始终使用 byte + length。
5. 对十六进制 section 做逐行长度、字符和总容量检查；禁止隐式截断溢出内容。
6. 将文本 music/sfx 格式转换为 RAM/PNG 中的 packed 表示；不得把编辑器文本布局直接 memcpy 到 ROM。
7. 处理 `#include` 时遵守官方的“相对当前 cart、非递归”语义。Player 无可用目录权限或 resolver 时返回 `E_CART_INCLUDE_UNRESOLVED`；不得猜路径或访问任意 URL。

`__label__` 是展示数据，不得覆盖 `__gfx__`。空缺 section 对应 ROM 区域填零。所有 section 汇总后，`rom.byteLength` 必须严格为 `0x8000`。

当前 ingestion policy 还包括：可选 UTF-8 BOM、LF/CRLF/mixed 输入统一为 LF；
known section 不可重复；data row 使用官方完整宽度；label 以 base32 palette index 验证但
不暴露 presentation buffer；map rows 32..63 与 gfx2 共享区按位 OR。非法 UTF-8、无法映射
的 Unicode、lone CR、row 溢出均 fail closed，并以原始输入 byte offset 诊断。无 resolver
时独占行 `#include` 返回 `E_CART_INCLUDE_UNRESOLVED`。

### 5.3 `.p8.png` 无损解码

`.p8.png` payload 藏在 RGBA 每个通道最低两位。**MUST NOT** 使用 `<img>`、Canvas、`createImageBitmap()` 或会进行色彩管理/alpha premultiply 的路径提取数据。

实现步骤固定为：

1. 从原始 bytes 校验 PNG signature 和 chunk 边界；限制总输入、解压后大小和 chunk 数，防止 zip bomb。
2. 只接受宽 `160`、高 `205` 的 cart PNG；解压 IDAT 并逆向 PNG scanline filter，得到原始 8-bit RGBA。使用第三方 decoder 时必须有“原始 RGBA8、无色彩变换、无 premultiply”的测试证明。
3. 对第 `i` 个像素提取：

   ```ts
   payload[i] = ((a & 3) << 6) | ((r & 3) << 4) | ((g & 3) << 2) | (b & 3);
   ```

4. 160×205 共得到 `0x8020` bytes；`payload[0..0x7fff]` 是 32KiB cart，`payload[0x8000]` 是 cart version。剩余保留位不得越界解释。
5. `0x0000..0x42ff` 作为 cart data；`0x4300..0x7fff` 为 code block。识别三种 code：
   - raw：以首个 NUL 为结束；
   - legacy：header `:c:\0`，长度为 bytes 4..5 的 big-endian 值；
   - PXA：header `\0pxa`，原长度与压缩长度来自 header，bitstream 按格式定义解析。
6. legacy/PXA 的每个 offset、length、bit read 和输出增长都必须先做边界检查；无效回引用返回 `E_CART_CODE_CORRUPT`，禁止读取负 offset、补零后继续或输出超出配置上限。

公共 API 只返回 ROM/source，不暴露 label/payload 的 live view。未来 PNG
label 可以另行解码给 UI，但不得反向成为 cart payload 来源。解压算法已与锁定的
fake-08/zepto8 参考路径做格式交叉检查；production 实现和 fixtures 均为项目原创，
没有 import/copy `ref/`。

### 5.4 CartLoader 与资源边界

> 状态：Implemented。精确 public shape 只以 RuntimeCore 的
> [`cart-loader.ts`](../packages/runtime-core/src/cart/cart-loader.ts)、
> [`cart-resolver-port.ts`](../packages/runtime-core/src/ports/cart-resolver-port.ts)、
> [`cart-repository-port.ts`](../packages/runtime-core/src/ports/cart-repository-port.ts) 和 package
> exports 为准；本文不复制接口定义。

Runtime 只认识 opaque cart ref。当前 Worker 的
[`LocalCartBundleResolver`](../apps/web-player/src/worker/adapters/host-cart-resolver-adapter.ts) 只解析
调用方随 `loadCart` 显式提供的 bounded bundle，不做 discovery、文件系统或网络访问；
[`CartRepositoryAdapter`](../apps/web-player/src/worker/adapters/cart-repository-adapter.ts) 负责
Worker-local parsed-cart cache 与 copy-on-write data overlay。BBS、URL 或其他来源必须由未来 phase
显式授权新的 adapter，RuntimeCore **MUST NOT** 内建抓取 Lexaloffle BBS 的逻辑。

`CartCancellationToken` 是 RuntimeCore 自己的 runtime-neutral contract；`AbortSignal`/DOM type 不得
进入 core public exports。resolver 返回的四项 `CartAccess` capability（`load/reloadData/cstoreData/include`）
必须由 caller/adapter 显式提供，不能从 cart 内容、文件名或 locator 推断。`CartLoader` 在 decode/cache
前检查对应 purpose；repository adapter 仍须重复做范围和 copy-ownership 检查。取消、reset、stop、
dispose 或 generation 变化后的晚到结果必须被丢弃。

`ParsedCart.rom` 使用 32KiB container 是为了保留 `.p8.png` 的原始 code block 与版本诊断，不等于 guest 可以访问整个 container。官方手册明确保护 `>= 0x4300` 的 code section：

- `reload(dest, src, len)` 的 **ROM source** 必须满足 `src >= 0` 且 `src + len <= 0x4300`；Base RAM destination 单独按 64KiB 范围验证。
- `cstore(dest, src, len)` 的 **ROM destination** 必须满足 `dest >= 0` 且 `dest + len <= 0x4300`；Base RAM source 单独按 64KiB 范围验证。

`CartRepositoryPort` 的公共 data API 不得返回可绕过这些检查的 live view。具体无效范围是报错、截断还是无操作必须用官方 golden 固定；在此之前禁止越过保护区。

## 6. PicoRam：64KiB 共享地址空间

### 6.1 布局

依据官方手册，Base RAM 为 64KiB：

| 范围 | 大小 | 用途 |
|---|---:|---|
| `0x0000..0x0fff` | 4096 | GFX sprites 0..127 |
| `0x1000..0x1fff` | 4096 | GFX2 / MAP2 共享区 |
| `0x2000..0x2fff` | 4096 | MAP rows 0..31 |
| `0x3000..0x30ff` | 256 | sprite flags |
| `0x3100..0x31ff` | 256 | song patterns |
| `0x3200..0x42ff` | 4352 | 64 个 SFX |
| `0x4300..0x55ff` | 4864 | user/work RAM |
| `0x5600..0x5dff` | 2048 | user RAM；启用时为 custom font |
| `0x5e00..0x5eff` | 256 | persistent cart data window |
| `0x5f00..0x5f3f` | 64 | draw state |
| `0x5f40..0x5f7f` | 64 | hardware state |
| `0x5f80..0x5fff` | 128 | GPIO |
| `0x6000..0x7fff` | 8192 | 128×128 packed screen |
| `0x8000..0xffff` | 32768 | user RAM |

屏幕/GFX 每 byte 两个 4-bit pixel，低 nibble 是左侧像素。Map 每 tile 一个 byte。Cart ROM 是独立的 32KiB 镜像；默认 `reload()` 只把 cart-backed 区域复制到 Base RAM，不能把 ROM 和 RAM 当作同一个数组。

### 6.2 接口与视图生命周期

```ts
const PICO_RAM_SIZE = 0x1_0000;

interface PicoRamLayout {
  readonly byteOffset: number;      // 来自 PicoMemoryLease；不暴露 WASM pointer API
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly gfx: Uint8Array;
  readonly map: Uint8Array;
  readonly flags: Uint8Array;
  readonly songs: Uint8Array;
  readonly sfx: Uint8Array;
  readonly cartData: Uint8Array;
  readonly screen: Uint8Array;
}

interface PicoMemoryLease {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: 65536;
  readonly leaseId: string;          // session-local opaque ID；用于拒绝 stale lease
}

interface PicoRam {
  bind(lease: PicoMemoryLease): void;
  assertBoundLease(leaseId: string): void;
  resetForColdBoot(): void;
  resetForCartRun(policy: RamResetPolicy): void;
  copyFromCart(rom: Uint8Array, dest: number, src: number, length: number): void;
  readU8(address: number): number;
  writeU8(address: number, value: number): void;
  readI32LE(address: number): number; // 原始 Q16.16 bits
  writeI32LE(address: number, raw: number): void;
}
```

`@pico8-web/contracts` 提供 `PICO_RAM_SIZE` / `PicoMemoryLease`；隔离 probe 的
`Phase0BMemoryBinding` 只用于历史 boundary 验证。该 binding
只证明 adapter 内 zero-copy views、lease freshness 与 canonical mapper，不是完整
`PicoRam`、`VmPort` 或 production `p8w_*` lifecycle。

production `FrameVmPort` 提供 browser-neutral
`PicoLogicalMemoryPort { memoryLeaseId, mapAddress() }`。z8lua adapter 对每次 mapping 验证
固定 lease、handle 与 buffer identity，再调用 `_p8w_map_address`；RuntimeCore internal
`PicoRam` 组合 lease 和该 port，提供 logical read/write/fill/copy。`FrameSliceRuntime` 的
packed-screen snapshot 与 `L1Graphics` pixel path 均使用这条路径。Emscripten module、handle
和 `WebAssembly.Memory` 仍不越过 adapter boundary。

v1 构建 **MUST** 将 WASM memory 的 `initial` 与 `maximum` 固定为同值，并使用机器契约锁定的 z8lua heap 上限，避免 `memory.grow()` 使 JS typed views 失效。真实 `WebAssembly.Memory` 只由 z8lua bridge 持有；RuntimeCore 只接收 runtime-neutral `PicoMemoryLease`，验证固定长度、范围和 session-local `leaseId`。Bridge 可以在 debug/test build 比较 `memory.buffer` identity 并在变化时立即触发 `E_INVARIANT`，但不能把 view 重建当成 production growth 支持；不满足固定内存的 artifact 不得发布。

production 数值固定为 16 MiB WASM / 1 MiB Lua heap；`luaHeapLimit` 只作为
Worker diagnostic composition option，用于 32 KiB OOM/recovery gate，不是按 cart 或宿主压力调整的
自适应策略。Worklet queue capacity/prebuffer/low/high water 常量由 `pcm-queue.ts` 唯一拥有并导出。

`PicoRam` 的 layout views 是物理 64KiB，不把 raw `DataView` 连续访问伪装成 guest 地址重映射。官方手册明确：GFX/SCREEN 两个 8KiB video block 的重映射会低层影响 `peek/poke/memcpy`；MAP base/width remap 则由 map/tline address resolver 解释，不能笼统套到全部 memory access。z8lua 的 `@/%/$` 还会绕过普通 JS imports。因此，guest memory API、direct operators、Graphics 与 Map 必须服从 [03-z8lua-wasm-bridge.md](./03-z8lua-wasm-bridge.md) 定义的同一个分层 mapping 契约。upper RAM、`0x5f54/0x5f55` 与 direct operators 已由共享 mapper 测试证明收敛；未来实现不得把 raw physical `PicoRam.readU8()` 直接注册为完整 guest `peek()`。

当前 production 已关闭上述 gap：`peek/poke` family、`memcpy/memset`、direct operators、
RuntimeCore graphics 与 frame snapshot 均由同一 mapper 决定 physical byte；`copyRam()` 继续只作
明确命名的 physical diagnostic snapshot，不可用于 guest/remapped semantics。

所有多 byte PICO 数据 **MUST** 显式使用 little-endian。不得依赖宿主 CPU endian，也不得用 JS `number` 先转换 Q16.16 再写回。ABI 层传 `int32` raw bits。

### 6.3 地址与 reset 语义

- Guest API 的 wrap、截断、越界和负数行为必须由 conformance cart 决定；不得用 TypeScript `RangeError` 替代 PICO-8 行为。
- Host 内部方法必须严格验证范围，失败返回结构化 internal error；Guest 地址归一化只能发生在 API adapter。
- `resetForColdBoot()` 必须产生可复现的全零初态，再应用硬件默认寄存器。
- `resetForCartRun()` 必须集中实现“哪些区清零、哪些区保留、何时把 ROM `0..0x42ff` reload 到 RAM”的矩阵。禁止各模块自行 `fill(0)`。
- 当前 cold-run policy 固定为：每次 load/reset 创建全新 VM/router/runtime/RAM
  object graph；64 KiB 全零后设置 `0x5f54=0x00`、`0x5f55=0x60`，再复制 Cart ROM
  `0x0000..0x42ff`。input 固定从六键全零开始，frame clock/frame id 由新 runtime 重建。
- 上述 policy 已由真实 z8lua RAM/lifecycle 测试覆盖，但不是完整官方 `run()` compatibility
  声明。fake-08 的 warm preservation 行为仍只作参考；未来 `reload()`、`cartdata()`、GPIO、
  AudioSynth 和完整 hardware defaults 必须由 active phase 与官方 golden 扩展矩阵。
- `0x5e00..0x5eff` 在新 cart 执行时必须先处于未映射/零状态；成功 `cartdata(id)` 后才加载对应持久化镜像。

不能只依赖高层 Graphics/API hook 做 dirty tracking：cart 可以通过 `poke`、`memcpy` 或 VM 的低层 memory path 改 screen/cartdata。当前 baseline 每个呈现帧解码固定 8KiB screen，并在逻辑 tick 后比较 256-byte cartdata；这是正确性优先的有界成本。

## 7. Graphics

> 状态：Implemented。当前覆盖 standard 128×128 packed-4bpp graphics/text、presenter boundary
> 与 bounded `tline()` precision profile；advanced screen/bitplane 仍 Deferred。

### 7.1 分层

Graphics 在 Worker 内做确定性 software rendering，直接读写 mapped packed RAM。
`RuntimeFrame` 只快照 packed screen 与 display palette；主线程 `ScreenPresenter` 负责
palette-to-RGBA、Canvas2D 最近邻呈现和 letterbox。精确 DTO 由 app transport source 拥有，
本节不维护第二份 TypeScript wire interface。

当前实现位于 `graphics/l1-graphics.ts`、`graphics/map-memory.ts`、
`graphics/p8scii-text.ts` 与 `graphics/p8scii-font.ts`：支持
`cls/color/camera/clip/pal/palt/fillp/pget/pset/line/rect/rectfill/circ/circfill/oval/ovalfill`，
使用 mapped packed screen，并从 `0x5f00..0x5f3f` 与 `0x5f60..0x5f6f` 即时读写 draw state。
`sget/sset/spr/sspr` 通过同一个 `PicoRam` logical mapper 访问 GFX，blitter 在 RuntimeCore 内
执行 scaling、flip、palette/transparency 和 apply-to-sprites fill pattern；不存在独立 sprite sheet。
`mget/mset/map/tline` 通过独立的 live map resolver 解释 `0x5f56/57`，直接访问同一 physical
RAM，并复用 sprite raster；lower map 在 `0x1000..0x2fff` ring 中排列，upper map 使用
`base<<8..0xffff`，GFX/screen upper conflict 仍由 C++ canonical mapper 裁决。
`print/cursor` 使用原始 byte string，经 software parser/raster 读取内建字体或 RAM-backed custom
font；cursor、scroll、camera/clip 与 palette 仍经过同一 RAM/pixel path。P8SCII audio
通过窄 sink 同步进入唯一 AudioSynth；timed controls 仍只消费、不产生 suspension。`RuntimeFrame`
另外快照 `0x5f10..0x5f1f` 的 16-byte display
palette，main Canvas 只把 palette index 映射到标准/extended RGBA。当前兼容声明包含 standard
128×128 packed 4bpp 与 `tline()` 13/16 fractional-bit profile；bitplane 和 advanced screen mode 延后。

### 7.2 必须保持的行为

- draw state 的权威值在 RAM 寄存器中。`camera`、`clip`、draw palette、display palette、透明色、fill pattern、line continuation、memory remap 均不得只存在 TS 私有字段。
- 所有坐标转换和 raster 算法必须规定整数/Q16.16 舍入点；不得让 Canvas 画 primitive。
- `0x5f54/55` 由 canonical logical mapper 处理；`0x5f56/57` 由唯一 map resolver 处理，
  upper-memory overlap 通过同一 arbitration rule 使冲突 video mapping 回退默认值。
- `spr/sspr/map/tline` 必须看到同一时刻 RAM 中的数据，包括共享 `GFX2/MAP2`。
- `print` 内部使用 P8SCII bytes，支持控制码和 `0x5600` custom font；不得先转 JS Unicode 再测长度。
- display palette 只影响呈现，不应破坏 screen RAM 中的 4-bit color index。
- Canvas2D 是 ADR-009 选定的唯一默认 `ScreenPresenter`。未来若改用 WebGL，
  必须先提供新 Chrome evidence 并取代 ADR-009；不得改变核心 raster 语义。

热点优化顺序固定为：先 conformance 正确，再 profile；只下沉被测量证明的 `pset/pget/spr/sspr/map/tline/memcpy` 热点。任何 WASM 下沉实现必须继续以同一块 RAM 和同一组 golden 为准。

## 8. AudioSynth 与 AudioWorklet

> 状态：Implemented。SFX/music/P8SCII AudioSynth、production Worker PCM 与
> transport/queue/device adapter 保持 ADR-010 边界。

### 8.1 责任边界

已实现 transport DTO 不在本文复制；精确的 version、generation、sequence、
decimal sample index、frame count、stats 与 control fields 由
[`audio-protocol.ts`](../apps/web-player/src/transport/audio-protocol.ts) 和
[`phase-0f-browser-boundary.json`](../spec/phase-0f-browser-boundary.json) 拥有。

`PicoSfxSynth` 在 RuntimeCore 内从 `0x3100..0x42ff` 和音频硬件寄存器 live-read song/SFX，
并统一处理 `sfx()`、`music()` 与同步 P8SCII audio；`FrameSliceRuntime` 为 startup transaction 与每个 committed frame 发布
`CanonicalAudioSlice`。`firstSample` 使用 decimal uint string，PCM 固定为 `22050Hz`、mono、
signed PCM16LE；30Hz 为 735 samples，60Hz 用整数 remainder 生成 367/368。它不 import
Worker、MessagePort、AudioContext 或 Worklet。production Worker 将这些 slices 只发送到
dedicated port；一般 control DTO 不携带 PCM。官方 capture 是时序/频谱校准源，fake-08 只能
作为带 provenance 的辅助对照。AudioWorklet 负责：

- 将 22050Hz PCM 重采样到实际 `AudioContext.sampleRate`；
- 维护小型 ring buffer；
- mono 到设备 channel 的复制；
- underrun 时输出静音并上报计数。

Window 初始化时创建 `MessageChannel`：一个 port 作为 transferable 交给
Runtime Worker，另一个通过 `AudioWorkletNode.port` 再转交给
`AudioWorkletProcessor`。握手完成后，audio transport DTO **MUST** 只走该专用
channel；Window↔Worker 的一般 `RuntimeCommand/RuntimeEvent` 不转发 PCM。该路径已通过
`P0-RT-03` 和 ADR-010。

### 8.2 时序与确定性

- AudioSynth **MUST** 由逻辑 tick 和已生成 sample index 驱动，禁止读取 `performance.now()`。
- 22050/60 = 367.5；必须使用整数有理数 accumulator（例如交替 367/368），不得因浮点累计漂移。30fps 每 tick 为 735 samples。
- 输入相同的 cart、RAM、API 调用和 tick 数时，Worker 生成的 PCM bytes 必须 bit-exact；设备重采样结果不属于核心确定性状态。
- AudioContext 未经用户手势启动或 worklet underrun 时，audio subsystem 不得自行暂停、加速或回滚游戏模拟。页面后台化只可由 Runtime 明确的 visibility policy 同时暂停 scheduler/audio；不得由设备 queue 状态暗中决定。
- 队列超过高水位时应丢弃/重同步设备队列并上报 `audio-overrun`，不得让音频反压阻塞 VM。
- cart swap/reset/fault 必须使旧 `sessionGeneration` 的 chunk 失效，并重置 synth 与 worklet 队列。

当前 baseline 使用 transferable `ArrayBuffer`。SharedArrayBuffer ring buffer 仅在实测需要且部署
具备 COOP/COEP 时采用，不是基线依赖。

## 9. Input

> 状态：Implemented。覆盖 controller、input-only devkit `stat()`、mouse/keyboard event batch
> 与 pointer-lock lifecycle。

RuntimeCore 在每个 boot/step transaction 前锁存固定 `PicoInputSnapshot.controllers[8]`，写
`0x5f4c..0x5f53` 并按 30/60Hz 与 `0x5f5c/0x5f5d` 计算独立 `btnp`。HostRequest completion
复用当前 latch；CartSession generation reset 清除 held/edge/duration。main thread 的
`PlayerInputFrontend` 合并 keyboard、standard Gamepad 与 multitouch source，只把 normalized
8×6-bit snapshot 送入 Worker。3D 已在该 DTO 上增加固定 devkit state/event batch；
keypress FIFO、逐 slice delta latch 与 `stat()` consumption 由 RuntimeCore 拥有，DOM coordinate、
pointer lock 和 event normalization 仍由 app 拥有。

- **MUST** 在每个 simulation slice 开始锁存输入；常规 callback 模式在 `_update`/`_update60` 前可见，自定义 loop 则在 resume 后直至下一 `flip()` boundary 保持稳定。同一 slice 内多次 `btn()` 结果相同；慢帧多 update 的重锁存细节由 conformance 固定。
- `btnp()` edge/repeat 由 Worker 的 tick 计数计算，不使用浏览器 `KeyboardEvent.repeat`。`0x5f5c/0x5f5d` 的初始延迟和重复间隔必须生效。
- replay 记录每 tick 的 normalized input snapshot，不记录 DOM timestamp。相同 replay 必须产生相同状态 hash。
- `blur`、visibility loss、设备断连和 cart swap 必须显式清 held 状态，防止 stuck key。
- 主线程映射可配置，但 core 只接收 PICO button index；UI 快捷键不得泄漏为 cart 输入。
- devkit mouse/keyboard 模式通过 `0x5f2d` 与 3D 列出的 input-only `stat()` 契约实现；
  未列出的完整 `stat()` 仍 Deferred。基础 controller 输入是 MUST，devkit 输入是兼容阶段的 SHOULD。

## 10. FrameScheduler

> 状态：Implemented。`FrameScheduler` 覆盖 browser-neutral interactive decision 子集：
> 30/60Hz accumulator、首 pulse anchor、0..5 ticks、overflow drop/diagnostic 与 pause/resume
> re-anchor，以及 deterministic 单 transaction CPU classification；不会按宿主性能自动
> 合并 update、跳过 draw 或降频。

production Worker 已用 fixed synthetic pulses 重放 30/60/custom carts；历史设备测量只保存在
[Phase 1 evidence](./evidence/phase-1/21-phase-1-l1-exit-evidence.md)。下方 `stepExact` API 仍是
Target，不得从已实现 interactive scheduler 推导为 production API。

### 10.1 双模式

```ts
type TickMode = "interactive" | "deterministic";

interface FrameScheduler {
  configure(fps: 30 | 60, mode: TickMode): void;
  onVsync(timestampMs: number): SchedulerDecision;
  stepExact(ticks: number): readonly StepResult[];
  pause(reason: PauseReason): void;
  resume(timestampMs: number): void;
}

type StepResult = Readonly<{
  tick: bigint;
  updateCount: number;
  drew: boolean;
  yielded: "frame" | "host-request" | "stopped";
  cpuInstructions: number;
}>;
```

`interactive` 接收主线程 rAF pulse，用 accumulator 决定执行 0..N 个逻辑 tick；`deterministic` 完全忽略墙钟，只由测试/回放调用 `stepExact()`。

### 10.2 帧语义

- 有 `_update60` 时逻辑频率为 60Hz；否则 `_update`/`_draw` 正常为 30Hz。callback cart 的 `_init` 至多调用一次：top-level 在 startup 内返回时立即执行；若有限 top-level 先跨过 custom boundary，最终返回的那个 frame 再执行并切换 callback mode。
- `time()/t()` 来自 Runtime 的 logical simulation clock，不直接等同于 callback 调用计数。官方 Web Player capture 锁定 startup transaction 为 `1/30s`：30 Hz callback/custom boot commit 1 slice，60 Hz callback boot commit 2 slices。每次 `step()` 以 `completedSlices+1` 计算即将执行的 clock，只有到达 callback frame-end、root `flip()` 或 [ADR-022](./adr/022-cpu-slicing-decision.md) 的 root-safe implicit boundary 才 commit；fault/stop 不 commit。`updateCount` 另行记录；慢帧下多个 update/一次 draw仍由后续 conformance 固定。禁止返回浏览器时间，同一 transaction 内多次读取必须一致。
- `flip()` 是显式 VM→Runtime frame yield；不调用它的 top-level custom loop 还可在固定 30 Hz implicit quantum 交还控制权。两者都只能从 Runtime-owned root 提交 frame。
- 每个 logical frame transaction 的固定次序为：scheduler 先决定本次 simulation slice、callback 次数与是否 draw → 在 slice 开始锁存输入并更新 hardware state（常规慢帧模式下每次实际 update 前重新锁存规则由 conformance 固定）→ resume VM → 同步 API/RAM 写即时生效 → 接收 yield/trap → 按 logical clock 生成音频 →（若本次 visible draw/flip/implicit copy）发布画面 → 持久化 dirty check → heartbeat。只收到、但未形成 simulation slice 的 rAF pulse 不得消耗 `btnp` edge、推进 `time()` 或生成音频；custom-loop 在 startup 之后到达的每个 explicit/implicit boundary 都结束并推进一个 slice，即使没有 `_update/_update60` callback。
- catch-up 必须有上限（建议最多 5 ticks/vsync）。超过上限时丢弃墙钟 backlog、发出 `E_TIME_DISCONTINUITY` warning；不得一次执行数百 tick 冻结页面。
- 页面从后台恢复时先重置 accumulator anchor，不“补跑”后台经过的全部时间。
- 第一版不根据宿主机器性能自动从 60 降 30 或从 30 降 15；这会让相同输入产生机器相关结果。官方的慢帧策略作为单独 conformance 功能实现。

### 10.3 CPU budget 与慢帧

> 状态：Implemented；机器 oracle 见
> [`phase-4f-cpu-scheduler.json`](../tests/conformance/manifests/phase-4f-cpu-scheduler.json)。

- compatibility cost 只使用 z8lua deterministic guest instruction count，参考速率固定为每秒
  `4,000,000` 条 VM instruction。每个 boot/frame transaction 的 signed Q16.16 fraction 为
  `floor(cpuInstructions * accountingFps * 65536 / 4,000,000)`，上限为 `INT32_MAX`；普通 frame
  的 `accountingFps` 是 logical target FPS，固定 `1/30s` startup 始终使用 30。Node/Chrome 容差
  都是 0 instruction。
- 30 Hz implicit-frame quantum 固定使用 `floor(4,000,000 / 30) = 133,333`，只负责让 top-level
  custom loop 形成官方 back-buffer copy boundary；它与普通 frame 的 soft `slowFrame` 分类、默认
  `2,000,000` hard safety cap 分别计数。floor quantum 的 Q16.16 fraction 是 `0xffff`。
- raw `0x00010000` 仍属预算内；只有量化结果大于它才标记 `slowFrame=true`。ordinary slow frame
  不降频、不跳 draw，也不拆成部分提交，而是完成一个原子 logical frame。默认
  `2,000,000` instruction safety hard cap 专门 containment 非 yield/infinite loop，使用
  `E_VM_INSTRUCTION_BUDGET`，与 soft classification 分离。
- `stat(1)` 报告当前 transaction 到调用点为止的 CPU fraction，并跨 root HostRequest continuation
  累计；因此它可略小于 frame 完成后的诊断值。`stat(7)` 返回 logical target FPS。两者都不读取
  浏览器刷新率或 host wall-clock；`stat(0)` 因缺少稳定 oracle 继续返回 false。
- legacy `stat(20)` 返回 authoritative AudioSynth channel 0 的当前 note number；inactive 时为 `-1`。
  该查询与 canonical audio 使用同一 deterministic state，不读取 AudioContext、device mixer、
  output queue 或 host wall clock；它不代表 legacy selectors `16..26` 已整体实现。
- CPU policy 不得改变 logical `time()`、canonical audio、input edge、draw/persistence transaction，
  也不得根据当前机器性能自适应改变 guest 结果。

## 11. Persistence

> 状态：Implemented。覆盖 browser-neutral 同步 guest mirror、Worker-owned IndexedDB
> hydrate/commit transaction、migration、lifecycle flush 与 recoverable diagnostics。

### 11.1 同步 guest、异步浏览器

`cartdata(id)` 是同步 Lua API，而 IndexedDB 是异步的。因此 Runtime 启动 VM 前 **MUST** `hydrate()` 出可同步查询的镜像；禁止在 WASM import 内等待 Promise 或让 `cartdata()` 永远返回 false。

规则：

- ID 最长 64，字符限制按官方手册验证；每次 cart execution 只允许成功选择一个 ID。
- 存储 key 以用户 profile/runtime namespace + cartdata ID 组成，**不得默认加 cart hash**，否则合法的跨版本/跨 cart 共享失效。
- `open(id)` 先清 `0x5e00..0x5eff`，存在记录时复制完整 256 bytes 并返回 true，否则保持零并返回 false。
- 每 tick 比较完整 256 bytes 或计算稳定 hash，以捕获 direct poke；写入采用 debounce，并在主线程转发 `pagehide`、swap/fault 前 best-effort flush。
- 提交必须 copy bytes，不能把会继续变化的 RAM view 交给 IndexedDB。
- quota、事务失败必须上报 `E_PERSISTENCE_WRITE`，游戏可以继续但 UI 必须可见“存档未保存”；不得谎报成功。
- schema migration 必须版本化、可回滚读取，并保留 256 bytes 原值。

`cstore` 不得覆写用户本地原文件。Web Player 使用每 cart identity 的 copy-on-write ROM overlay，并可由 UI 另行提供导出；overlay 是否跨 session 持久化由产品配置决定，但同一次运行内 `cstore` 后的 `reload` 必须读取新值。

## 12. Worker、watchdog 与消息协议

> 状态：Implemented。精确 union、validator 与 transfer list 只以
> [`player-protocol.ts`](../apps/web-player/src/transport/player-protocol.ts)、
> [`audio-protocol.ts`](../apps/web-player/src/transport/audio-protocol.ts) 和同目录 source 为准；本文
> 不维护第二份 wire type。

Window → Worker 的 v1 control surface 是 `loadCart`（cart bytes + optional caller-authorized local
bundle）、`start/vsync/pause/resume/reset/stop/dispose`，另有 versioned input、persistence flush
与 audio attachment envelope。Worker → Window 事件是 `session-replaced`、state/frame/heartbeat/
runtime-control/diagnostic/fault。root HostRequest 在 Worker 内通过 RuntimeCore port 处理，不使用
额外的 resolver DTO 跨线程往返。

- 这是 [02-system-architecture.md](./02-system-architecture.md) 中架构协议的 Runtime 实施命名：
  Window `loadCart` 完成 transaction 并进入 `ready`，随后用 `start` 进入 `running`；guest
  `load()` 成功时按当前 controller continuation policy 原子替换 session。禁止再引入
  `boot`/`host-response` 等同义 wire command。
- `reset` 无 payload：Worker 必须调用当前 `CartSession`，使用其 private normalized
  ROM/code snapshot 创建全新 generation；`reset` 不得依赖主线程临时回传，也不得在原
  VM/RAM 上就地清零后继续。Worker 若被 watchdog 整体终止，则由 loader/repository 或主线程
  保留的原始 bytes 重建，不依赖已销毁 session。
- guest `run(param)` 与 host `reset` 是不同入口：VM control result 携带最多 4096-byte copy-owned
  parameter，Worker 在同一外部 `sessionGeneration` 内创建 fresh RuntimeCore/VM graph、重置同
  generation audio timeline，并从 `stat(6)` 暴露参数；guest `stop(message)` 同样只产生 control
  result。两者都不得直接访问 Window、Worker、IndexedDB 或 AudioContext。
- 未知 `v` 必须 fail closed。`requestId` 在未完成请求中唯一；每次 Worker spawn 有单调
  `workerGeneration`，每次 load/reset transaction 有跨 Worker restart 单调的
  `sessionGeneration`；`frameId`、vsync/input/audio sequence 各自在所属通道单调。主线程/
  Worklet 必须丢弃旧 generation 的 frame、audio 和 reply。
- bridge request ID 是 handle-local `uint32`，只在 Worker 内与 runtime generation、session
  generation 和 cancellation owner 共同校验；它不暴露为 Window wire request。旧 session 的
  同号 completion 不得命中新 handle。
- `loadCart` 输入 bytes 应 transferable；Worker decode 后把 normalized `ParsedCart` 交给
  `CartSession` 复制，主线程或 Worker repository 还必须独立保留可在 watchdog 终止后重新发送
  的原始来源/缓存副本。两类 copy 用途不同，不作为逐帧同步机制。
- `attachAudioPort` 的 port 在发送时必须列入 transfer list；PCM 只走该 port 定义的 `AudioTransportMessage`，不出现在 `RuntimeEvent`。
- VM 内的确定性 instruction budget 是第一道防线；主线程 wall-clock watchdog 是第二道防线。二者必须分开记录。
- 主线程发出 step/vsync 后若超过配置 deadline 无 heartbeat/响应，必须 `worker.terminate()`，转入 `faulted`，错误码 `E_VM_WATCHDOG`。Worker 内 `setTimeout` 无法中断卡在 WASM 的调用，不能作为唯一 watchdog。
- restart 必须创建全新 Worker/WASM instance，不复用可能损坏的 linear memory。恢复只允许从已提交 cart、cartdata 和明确的 replay 开始，不伪造 VM save-state。
- 消息 payload 必须 structured-clone 可序列化；禁止跨边界发送原生 `Error`、DOM 对象或 live typed view。

`250ms` 前台单 tick 与 `2s` startup/compile 只是 `P0-RT-07` 的暂定测试值；最终值必须由 conformance/perf corpus 校准，并允许调试构建放宽。

## 13. `load`、`reload`、`cstore` 与 cart swap

> 状态：Implemented for the closed local L3 profile。覆盖 Window load/reset、current-cart
> `reload/cstore`、caller-authorized external cart-data、root guest `load()` 和原子 generation
> replacement。BBS/network 与 general nested-coroutine recovery 仍 Deferred；text include 只使用当前 command
> 携带且显式授予 `include` capability 的 Worker-local bundle。

### 13.1 状态机

对外状态枚举只由
[`player-protocol.ts`](../apps/web-player/src/transport/player-protocol.ts) 定义；Worker 内部还拥有
`empty/faulted` 等 lifecycle state。合法主路径：

```text
Window loadCart/reset -> ready -> running
running -> waiting-host -> running                      (root external reload/cstore)
running -> waiting-host -> session-replaced -> running  (root guest load)
ready/running <-> paused                                (host lifecycle policy)
any live state -> stopped/disposed
transaction failure -> fault event + internal fault containment
```

这里的 `paused` 只表示 host lifecycle/scheduler policy，不是 PICO-8 pause menu。按照
[ADR-023](./adr/023-menuitem-invocation-boundary.md)，Worker 另拥有 transient `menu-open`：它在 completed
frame boundary 暂停 scheduler、清 input/audio queue，并只传递 copy-owned slot DTO。Main 发送
generation-bound intent；callback/ref 仍不离开 VM。host `pause` 可关闭 guest menu 后进入普通 `paused`，
后续 `resume` 不会重开 guest menu。

### 13.2 HostRequest

精确 public port 是
[`RootHostRequestHandlerPort`](../packages/runtime-core/src/ports/root-host-request-handler-port.ts)；
guest cart payload 由
[`guest-cart-request.ts`](../packages/runtime-core/src/cart/guest-cart-request.ts) 和
[`external-cart-data-request.ts`](../packages/runtime-core/src/cart/external-cart-data-request.ts) 版本化
编码。它们是 Worker 内部边界，不是 Window transport DTO。

- `load(ref, breadcrumb, param)`：root API 触发受控 HostRequest，停止旧 cart 的当前执行路径；
  `CartLoader` 只接受 caller-authorized local bundle 中具有 `access.load` 的目标。
- `reload(dest=0, src=0, len=0x4300, ref?)`：无 ref 或当前 cart 可同步从 `CartSession.rom` 的 data region 复制；外部 ref 未缓存时必须产生可恢复 HostRequest，VM 停在该 API 调用点，资源返回后完成 copy，再从调用点之后继续。外部目标必须有 `access.reloadData`；当前 resolver 只接受 caller-authorized local bundle。
- `cstore(dest=0, src=0, len=0x4300, ref?)`：先从 RAM 复制稳定 bytes，再写当前/目标 cart data overlay。异步目标解析/提交同样需要可恢复 HostRequest。目标必须有 `access.cstoreData`；每 execution 最多写入 64 个目标 cart。范围保护见 5.4，具体无效参数行为用 golden 校准。
- Runtime 不得用“这一帧末尾再悄悄 reload”替代同步语义。当前只接受 root suspension；
  nested coroutine 组合按 ADR-019 的 28-case matrix 产生结构化 fault，不返回伪造数据。
- breadcrumb 是 copy-owned replacement metadata，只有 successful commit 才进入新 generation；不得从
  browser history 或 locator 猜测。
- resolve 期间逻辑 tick、`time()` 和 AudioSynth 全部暂停；UI 可以继续绘制 loading overlay，但 overlay 不写 PICO screen RAM。

### 13.3 原子 load transaction

Window `loadCart/reset` 与 guest `load()` 共享 cold-boot、rollback、generation 和 output isolation
原则；guest replacement 额外遵守以下握手：

1. 暂停 scheduler，flush 旧 cartdata，并用 request/session/runtime generation 与 cancellation owner
   锁定 pending request。
2. 通过 `CartLoader` resolve、检查 purpose capability/size/ref，decode 并缓存 copy-owned cart。
3. 创建完全独立的 staged `CartSession`，用新 VM/RAM/audio/input state 完成 startup；commit 前不得
   发布 staging frame/audio/state。
4. 任一步失败时销毁 staging、停止旧 session 并发布 fault；不发布 replacement handshake，也不
   恢复已被 guest `load()` 放弃的旧协程。
5. 全部成功后销毁旧 session、安装 staged session 并递增 generation；新 generation 的第一个 event
   必须是 `session-replaced(previous,next,ref,breadcrumb)`。
6. main 接受该握手后原子切换 generation、清理旧 pending/输入序列并 reset presenter ownership；
   Worker 随后开始新 audio generation，并发布新 state/audio。所有旧 frame/audio/reply 都按
   generation 丢弃。

resolver 取消或晚到结果必须同时匹配 pending identity、worker/session/runtime generation 与
cancellation token 才能进入 commit。改变失败恢复策略或 replacement event ordering 必须先更新
机器合同与 conformance。

## 14. 确定性契约

给定以下输入：

- 相同的 parsed cart bytes 与 cart version；
- 相同的 Runtime/ABI compatibility version；
- 相同的初始 cartdata/overlay；
- 相同的每 tick 输入 snapshot、宿主请求结果和显式 seed；
- 相同的逻辑 tick 数；

核心必须产生相同的：

- 64KiB RAM hash；
- Lua 可观察结果与 Runtime event 顺序；
- 每个呈现帧的 RGBA hash；
- 22050Hz mono signed PCM16LE bytes；
- cartdata 最终 256 bytes。

以下不得进入核心状态 hash：wall clock、rAF timestamp、AudioContext sample rate、Canvas scale、设备像素比、网络到达时间、日志 timestamp。

```ts
type DeterminismSnapshot = Readonly<{
  compatibilityVersion: string;
  cartSha256: string;
  tick: bigint;
  ramSha256: string;
  frameSha256?: string;
  audioSha256: string;
  eventSequence: number;
}>;
```

测试构建 **MUST** 能导出此 snapshot。生产构建 MAY 关闭昂贵 hash，但不能使用不同的模拟算法。随机种子策略必须显式：正常播放可从宿主 entropy 初始化一次；conformance/replay 必须注入 seed，并记录为输入。

## 15. 错误模型

跨 package/Worker 的精确 `RuntimeErrorCode`、`RuntimePhase` 与 `SerializedRuntimeError` 只由
[`packages/contracts/src/public.ts`](../packages/contracts/src/public.ts) 定义。cart byte-format 错误
由 [`CartCodecError`](../packages/cart-codec/src/errors.ts) 单独拥有；resolver/repository 的细分失败
在 RuntimeCore 内分类，并在 app boundary 转为公共 runtime error + safe `details`。本文不维护第二份
code、stage 或 severity union。

规则：

- `recoverable` 与 `phase` 必须反映发生 transaction 的真实恢复能力；同一 codec failure 在初始
  Window load 与已放弃旧协程的 guest replacement 中可以有不同 lifecycle 后果。
- VM panic、instruction budget、OOM、invariant 和 watchdog 不得伪装成可继续 step 的结果。
- persistence/device diagnostics 不得擅自改变 simulation；是否恢复由对应 owner contract 决定。
- Guest 传入 PICO-8 本就会截断/忽略的参数不是 RuntimeError，应复刻 guest 行为。
- 错误 message 面向开发者，UI 文案由主线程映射；错误对象不得包含整个 cart code、用户路径或
  未脱敏 URL。
- 捕获未知异常时转成 `E_INVARIANT`，只保留安全 details；不得跨 Worker 发送原生 `Error`。

## 16. 变更与验证路由

- 实施顺序、允许文件和 observable exit：只由当前
  [active phase](./phases/README.md) 定义。
- 单功能、MVP 与 release 门禁：只由
  [测试兼容契约](./06-testing-compatibility.md#16-definition-of-done) 定义。
- package owner、import edge、composition root 与 public export：只由
  [源码边界契约](./08-source-layout-and-boundaries.md) 定义。
- 产品 non-goals、浏览器和兼容等级：只由
  [范围文档](./01-scope-and-success-criteria.md) 定义。
- 已完成能力、性能数字和环境 hash：只从 [evidence](./evidence/) 与机器合同按需追溯。

第 5.4 和第 13 节描述的是已关闭 local L3 profile 的稳定边界；精确接口仍以 public source、
[`phase-5-l3-multicart-contract.json`](../spec/phase-5-l3-multicart-contract.json) 与 conformance 的
交集为准。当前没有 active phase，不得据此增加 BBS/network/include、nested recovery 或其他
production path；未来扩展继续复用同一 RuntimeCore 和 Chrome boundary，不复制第二套 core。
