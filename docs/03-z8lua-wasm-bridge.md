# z8lua WASM Bridge 契约

本文定义 z8lua 与 TypeScript Runtime 之间的当前可执行边界，并把 production、隔离 probe 与未来目标明确分开；拟定接口不得误写成 z8lua 上游能力。

本文使用以下标记：

- **已核验上游事实**：来自固定提交的源码或上游说明。
- **MUST / MUST NOT / SHOULD**：本项目实现约束。
- **Target / Deferred**：尚未进入机器契约；只有 active phase、测试与必要 ADR 完成后才能视为稳定公共契约。

当前 production `p8w_*` 已覆盖 context lifecycle、64 KiB shared Pico RAM、append-only host
bindings `1..41`、frame stepping、root HostRequest、VM-local P8 helpers、instruction accounting、
fixed memory/Lua heap 和 structured errors。`p8w0a_*`/`p8w0b_*` 仍是隔离 probe，不是产品 ABI。
精确操作、版本和 artifact 只以 [`p8w-v1.json`](../spec/abi/p8w-v1.json)、runtime manifest、
public adapter 与自动测试的交集为准；完成测量见
[Phase 4 evidence](./evidence/phase-4/51-phase-4-l2-mvp-exit-evidence.md)。

| 状态 | 本文内容 |
| --- | --- |
| **Implemented** | raw integer ABI、80-byte host-call frame、bindings `1..41`、VM-local helpers/root controls、shared Pico RAM、fixed 16 MiB memory、1 MiB default Lua heap、instruction/resource diagnostics、structured errors |
| **Accepted invariant** | 同步且不可重入的 import、append-only binding IDs、同一 Pico RAM、root-only recoverable host suspension、host-owned capability policy |
| **Deferred** | general nested coroutine suspension、guest `load`/external resolver、multi-return/result vectors 和未激活的 capability/API 扩展 |

机器事实入口是 [`p8w-v1.json`](../spec/abi/p8w-v1.json) 与当前 public adapter。历史实施顺序、
benchmark 数值和关闭 checklist 只从 evidence/ADR 按需追溯，不在本 living contract 重复。

## 1. 结论与边界

WASM 只负责必须靠 z8lua 保真的语言内核及其薄桥接层：

- P8 Lua lexer、parser、bytecode VM、GC、table、coroutine。
- Q16.16 fixed-point 数值和 z8lua 已实现的 PICO-8 数学函数。
- Lua stack 与稳定、纯整数 C ABI 之间的转换。
- Base RAM 的分配和 `lua_setpico8memory()` 绑定。
- 受控 yield、instruction hook、Lua heap cap 和结构化错误提取。

TypeScript Runtime 负责：

- cart parse、Cart ROM、graphics、map、audio、input、persistence 和 scheduler。
- PICO-8 stateful API 的可观察行为。
- Worker session、frame transaction、renderer/audio 输出以及异步 host 协调。

Bridge **MUST NOT** 依赖 DOM、Canvas、AudioContext、IndexedDB、`fetch()` 或 wall-clock scheduler。WASM import **MUST** 是同步函数；Promise 不得穿过正在执行的 Lua/WASM 栈。

Bridge 可以为已测得的热点执行最小 RAM primitive，但这属于 [ADR-006 fallback ladder](./07-decisions-risks-open-questions.md#4-fallback-ladder)，必须先有基准、conformance 和 ADR，不能在首版无证据下扩张成 full-core WASM。

## 2. 已核验的 z8lua 上游基线

### 2.1 Pin 选择

Phase 0A 已按 [ADR-012](./adr/012-z8lua-source-and-phase-0a-wasm.md) 接受
z8lua 的 `pico8` feature branch，而不是默认 `zepto8` composite branch：

- 上游 README 把 `pico8` 描述为只实现 PICO-8 syntax/type system、适合作为自有 emulator 起点的 clean branch；`zepto8` 还合并了 Eris snapshot 和实验性 Oua 功能。[上游分支说明](https://github.com/samhocevar/z8lua/blob/4a7089ea55556aef95a82a618d7bf19c1be1b568/README.md#branches)
- 本文核验的 `pico8` 提交是 [`8575dfbc524003c869c0aa05e109819302c576f9`](https://github.com/samhocevar/z8lua/tree/8575dfbc524003c869c0aa05e109819302c576f9)，提交日期为 2024-11-14。
- 对照核验的 `zepto8` HEAD 是 [`4a7089ea55556aef95a82a618d7bf19c1be1b568`](https://github.com/samhocevar/z8lua/tree/4a7089ea55556aef95a82a618d7bf19c1be1b568)，同样不是版本化 release。

生产构建 **MUST** pin 完整 commit SHA，禁止从移动 branch head 构建。ADR-012
已决定使用 tracked vendored snapshot、ordered local patches 和 patched inventory
hash；`ref/z8lua`、submodule 与 build-time fetch 均不是生产输入。

### 2.2 已提供的能力

已核验上游事实：

- z8lua 是 Lua 5.2 系列 fork，支持 short `if`、`?` print、compound assignment、`!=`、`//` comment、binary literal、PICO-8 math 和 fixed-point overflow/infinity 等。[功能清单](https://github.com/samhocevar/z8lua/blob/4a7089ea55556aef95a82a618d7bf19c1be1b568/README.md#pico-8-features)
- `luaconf.h` 将 `LUA_NUMBER` 定义为 `z8::fix32`，将 `LUA_INTEGER` 定义为 `int16_t`。[固定点配置](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/luaconf.h#L550-L590)
- `fix32` 暴露 `bits()` / `frombits()`，内部值是 signed 32-bit Q16.16 bit pattern。[fix32 实现](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/fix32.h)
- `lua_setpico8memory(lua_State *, unsigned char const *)` 把一个 flat byte pointer 放入 z8lua global state，供 `@/%/$` 运算符读取。[声明](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/lua.h#L260)与[实现](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/lapi.c#L137-L141)
- z8lua 保留 Lua 5.2 的 `lua_yieldk()`、`lua_resume()` 和 count hook API，可作为 frame slice 与 instruction budget 的基础。[coroutine API](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/lua.h#L285-L289)与[hook API](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/lua.h#L382-L410)
- 上游 makefile 用 `g++` 和 C++17 编译扩展名为 `.c` 的源码；WASM 构建必须使用 `em++` 或等价 C++ driver，不能当成普通 C 编译。[上游 makefile](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/makefile#L19-L20)

### 2.3 上游明确或源码可见的限制

这些限制 **MUST** 进入 conformance，而不是用“采用 z8lua”掩盖：

- z8lua 不实现依赖 PICO-8 machine state 的绝大多数 API；这些属于本项目 TS Runtime。[上游限制说明](https://github.com/samhocevar/z8lua/blob/4a7089ea55556aef95a82a618d7bf19c1be1b568/README.md#limitations)
- `^` 仍经 floating point 实现，上游明确说明结果不保证与 PICO-8 bit-for-bit 一致。初始兼容矩阵必须记录此差异；不能声称 fixed-point 全部 bit-exact。[上游 `^` 限制](https://github.com/samhocevar/z8lua/blob/4a7089ea55556aef95a82a618d7bf19c1be1b568/README.md#limitations)
- 未 patch 的上游 `luaV_peek()` 把地址做 `int(a) & 0x7fff`，且 flat `PEEK` 只接受 `< 0x8000`；multi-byte 值直接从相邻 flat bytes 拼装。[源码](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/lvm.c#L221-L241) Phase 0B 已用 ordered patch 0002 让 direct operators 调 project-owned mapper；不得把这一项目 patch 误写成上游能力。
- `lua_setpico8memory()` 只有 flat pointer，没有 graphics/screen remap callback。由于 `@/%/$` 是 `peek/peek2/peek4` shorthand，不能在未测试时假设它们已符合 remapped memory access。
- `pico8` branch 的 `luaL_openlibs()` 默认仍开放 base、PICO-8、coroutine、table、string 和 `debug`。[library 列表](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/linit.c#L29-L36) 这不是官方 PICO-8 sandbox；特别是 `debug.sethook` 会威胁 CPU budget。

### 2.4 许可证事实

不得把整个依赖简单标为“MIT”：

- Lua core 的许可文本内嵌在 `lua.h`，是 Lua 的 permissive/MIT-style license。[Lua notice](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/lua.h#L433-L460)
- `fix32.h`、`lpico8lib.c`、`trigtables.h` 等 z8lua/ZEPTO-8 文件声明 WTFPL v2。[fix32 notice](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/fix32.h#L1-L12)
- `pico8` pin 没有可替代逐文件 notice 的顶层 LICENSE 文件。

供应链任务 **MUST** 保存 pin、patch provenance，发布产物 **MUST** 携带 Lua notice、WTFPL notice 和完整 third-party audit。是否满足具体发行政策仍需项目法律/许可证审阅，本文不作法律结论。

## 3. VM 初始化与库白名单

Bridge **MUST** 使用带限额的 `lua_newstate(customAllocator, context)`，不得用无限制的 `luaL_newstate()`。

Bridge **MUST NOT** 直接调用 `luaL_openlibs()`。初始化顺序应为：

1. 创建 main state，安装受限 allocator。
2. 只打开实现 P8 Lua 所需的 base、PICO pure math/string、table 与 coroutine 子集；
   project-owned table/string/coroutine helpers 保持在 VM 内，`rnd/srand` 直接使用 shared Pico
   RAM `0x5f44..0x5f4b` 的 PRNG state，不跨 JS↔WASM host binding。
3. 删除或从不注册 `debug`、`io`、`os`、`package`、`require`、`dofile`、`loadfile` 和 native module 能力。
4. 按目标 PICO-8 API inventory 删除多余 base globals，并注册 PICO aliases 与 generated host wrappers。
5. 安装不可由 guest 修改的 count hook。
6. 分配并绑定 shared Pico RAM。

`pcall`、`xpcall`、dynamic `load`、`collectgarbage` 等是否暴露，必须由官方行为和 conformance 决定。无论最终兼容选择如何，guest **MUST NOT** 获得修改/关闭 bridge hook 的途径。

Lua heap cap 与 64 KiB Base RAM 是两个不同限制。allocator **MUST** 正确追踪 realloc delta、在超限时返回 null，并把 `LUA_ERRMEM` 转成 `P8W_STATUS_OUT_OF_MEMORY`；不得让 Emscripten `abort()` 成为普通 cart OOM 路径。Phase 4G 已锁定 production 默认 cap 为 `1 MiB`，并用 `32 KiB` minimum diagnostic profile 验证 bounded OOM 与 fresh recovery；host 不得自适应扩大它。

## 4. 生命周期与控制流

### 4.1 Bridge 内部状态

每个 context 至少有以下状态：

```text
EMPTY -> COMPILED -> BOOTING -> CALLBACK_LOOP | CUSTOM_LOOP
  \          \          \                 \
   +----------+----------+-----------------> FAULTED -> RESET
```

- `COMPILED`：源码已按 byte length 编译，尚未执行 top-level。
- `BOOTING`：正在执行 cart top-level；若 top-level 返回，再执行 `_init()`。
- `CALLBACK_LOOP`：默认 `_update60/_update` + `_draw` 驱动。
- `CUSTOM_LOOP`：top-level 尚未返回，但通过 `flip()` 主动产生 frame boundary。
- `FAULTED`：runtime、OOM、budget、host 或 internal error；只有 reset/destroy 合法。

所有状态转换 **MUST** 可查询并有 invalid-state 测试。

这是 C/guest execution phase。外层 TS adapter 还必须遵守 [Worker 两阶段 bootstrap](./08-source-layout-and-boundaries.md#worker-两阶段-bootstrap) 的 `memory-ready -> host-bound -> runnable` gate：host router 未 exactly-once 绑定时，禁止进入 compile/boot/step。该 bootstrap state 不得伪装成新的 guest yield reason。

### 4.2 默认 callback loop

默认 cart 的 top-level 返回后，bridge 执行 `_init()`。当 `p8w_step()` 驱动一个完整 callback frame 时，bridge 按以下顺序执行：

1. 在 frame boundary 重新确认 `_update60` / `_update` 模式。
2. 优先调用 `_update60()`；否则调用 `_update()`。
3. 调用 `_draw()`（若存在）。
4. 通过 bridge 私有 frame-end yield 返回 Runtime。

当前 production scheduler 只使用机器契约和自动测试覆盖的 step 路径。任何用于慢帧、catch-up 或拆分 update/draw/present 的新组合，都必须先由 active phase 固定 conformance，不能仅因目标草图可表达就进入生产调度。

Bridge **MUST NOT** 把 cart source 与 glue 字符串拼接后重新编号；应保存原 chunk name/line。callback driver 可以由 C continuation 或单独预编译 glue 实现，但 runtime error 必须仍指向 cart source。

`p8w_target_fps()` 在 callback mode 返回 60 或 30，供 TS scheduler 使用。动态替换 callback 时，模式 **SHOULD** 在 frame boundary 重算。

### 4.3 手写 `flip()` loop

以下控制流必须被当成一等模式，而不是无限循环：

```lua
while true do
  -- update + draw
  flip()
end
```

若 top-level 在返回前调用 `flip()`：

- bridge 将 context 标记为 `CUSTOM_LOOP`，不得额外启动 callback loop。
- `flip()` wrapper **MUST** 用 `lua_yieldk()` 和 continuation；下一次 Runtime resume 后，该 Lua 调用正常返回并从下一条语句继续。
- 一次 `p8w_boot()` 或 `p8w_step()` 最多提交一个受控 frame/flip boundary。
- top-level 的首次 `P8W_YIELD_FLIP` 建立 custom startup boundary。官方 Web Player capture 已锁定：boot transaction 内 `time()` 为 `1/30s`，该 boundary 成功后 Runtime commit 1 个 30 Hz startup slice；从 continuation resume 到下一个 `P8W_YIELD_FLIP` 再 commit 1 slice。VM bridge 只保存 host 传入的 `time_raw`，clock counter 与 commit policy 仍归 RuntimeCore。

当前 custom loop profile 固定为 30 Hz；未来若支持其他 rate，必须由独立 conformance 固定，不得把 display refresh 直接当作 guest frame rate。

### 4.4 Nested coroutine 陷阱

`lua_yieldk()` 只向当前 coroutine 的直接 resumer yield。若 cart 在 guest-created coroutine 内调用 `flip()`、`load()` 等，yield 可能先被 `coresume()` 捕获，而没有自然冒泡到 Runtime root。

因此：

- host request **MUST** 带 out-of-band `pendingRequest` 状态；不能仅靠 Lua yield return values 猜测。
- Phase 5F 已由 [ADR-019](./adr/019-phase-5-coroutine-compatibility.md) 接受 root-only：仅 root HostRequest
  可恢复；guest-created single/multi-level coroutine 中的 `flip/run/stop/load`、external
  `reload/cstore` 与 diagnostic HostRequest 统一返回 `E_FEATURE_UNSUPPORTED`，并在结构化 details
  中标记 `reason: "nested-host-suspend"`。
- Node/Chrome 的 28-case matrix 已证明 guest `pcall/coresume` 不可吞掉该 fault，且不产生 resolver、
  repository、overlay、session replacement 或 stale output side effect。未来 general bubbling 仍必须由
  replacement ADR 取得完整 resumer-chain ownership，不能从目标说明或单个 wrapper 推导为已支持。
- 不得使用 Asyncify 来掩盖 Lua coroutine 所有权问题。

## 5. Shared Pico RAM

### 5.1 所有权

Bridge context **MUST** 在 WASM linear memory 中分配连续、对齐的 65,536 bytes，并保证 pointer 从 `create` 到 `destroy` 稳定。`reset` 清零内容但 **SHOULD NOT** 改变 pointer。

```ts
const base = wasm._p8w_ram_ptr(handle);
const size = wasm._p8w_ram_size(handle); // exactly 0x10000
const bytes = wasm.HEAPU8.subarray(base, base + size);
const data = new DataView(wasm.HEAPU8.buffer, base, size);
```

以上 view 创建只发生在 `@pico8-web/z8lua-bridge` adapter 内。对 RuntimeCore 的 public port 返回 [runtime-neutral `PicoMemoryLease`](./04-typescript-runtime.md#62-接口与视图生命周期)，不得暴露 Emscripten module、`HEAPU8` 或 `WebAssembly.Memory` concrete object。

- z8lua reader 与 TS graphics/audio/input/memory API **MUST** 观察同一份 bytes。
- 每帧不得同步复制整块 RAM。
- Cart ROM 是独立对象，不得把其 pointer 冒充 Base RAM。
- TS 必须以 unsigned address 和显式 little-endian `DataView` 操作 multi-byte 数据。

v1 production **MUST** 禁止 WASM memory growth，并令 `initial === maximum`。Emscripten 明确说明 growth 会替换 buffer、使既有 typed-array views 失效。[Emscripten memory view 说明](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html#access-memory-from-javascript) 当前固定容量已由 heap/cart/multi-instance stress 锁定；未来若要启用 growth，必须先有新 ADR、集中式 view factory 和完整 alias 回归，普通实现任务不得自行打开。

### 5.2 `@/%/$` 与 remap gap

flat `lua_setpico8memory()` 不能单独作为 v0.2.7 兼容完成条件。Phase 0B 已覆盖：

- lower RAM 与 upper RAM 读。
- negative/fixed-point address 到 16-bit address 的规则。
- `0xffff` wrap。
- `%` / `$` 在 `0x7fff`、`0xffff` 和 remap 边界上的逐 byte 行为。
- GFX/SCREEN remap 后，`@/%/$` 与 `peek/peek2/peek4` 的一致性。官方手册明确说明 GFX/SCREEN remap 在低层影响 `peek/poke/memcpy`，并把 `@/%/$` 定义为 peek shorthand。[官方 Memory/Remapping 章节](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)

Pinned z8lua 确认失败后，Phase 0B 的最小本地 patch 已按以下契约落地：

1. 把 direct operator 地址规范化为 `uint16_t`，不要硬编码 `& 0x7fff`。
2. 为 global state 增加 `readByte(ud, uint16_t address)` callback，或等价的受控 address translator。
3. `%/$` 对每个 logical byte 地址分别调用 translator，并在每次 `address + i` 后做 16-bit wrap；禁止“只翻译起始地址后连续读 raw RAM”。
4. 初始 callback 可以复用 host `peek` 语义；若跨界基准失败，再用带 golden tests 的 C-side translation table/primitive 优化。
5. patch 保持最小、单独存放、记录 upstream commit，并用 upper/remap/cross-boundary 回归锁定。

地址翻译的最终规则以官方手册和可复现 conformance capture 为准，不以 fake-08 或 z8lua 当前 flat behavior 为规范。

实际唯一 mapper 位于 `wasm/bridge/p8w_pico_memory.*`。`lvm.c` patch、bounded
memory probes 和 `Phase0BMemoryBinding` 都调用它；未来 graphics/memory fast path
不得复制 remap switch。非法 video base 当前防御性回退默认值，因手册未定义该
输入，其兼容状态保持 unknown。

production `p8w_*` 已注册 `peek/peek2/peek4`、`poke/poke2/poke4`、
`memcpy/memset`。只有 `peek/poke` 是最多 8192 项的 variadic API；width variants 为单值。
`memcpy` 先建立 source snapshot 以保持 remap 后的重叠复制语义。RuntimeCore 通过
`PicoLogicalMemoryPort` 调 production `_p8w_map_address`，frame snapshot 和 software raster
不再复制 video-base switch。

### 5.3 隔离的 bounded memory probe

`p8w0b_*` 是历史 Phase 0B probe：context create/destroy/run/result、RAM
pointer/size/reset、canonical map/read/write 和 source alloc/free。ABI version 为
`0x00020000`。它用于锁定 RAM boundary 与测试，不含 compile/resume/frame/request
state machine，不得被 RuntimeCore 当作 production `VmPort`。

## 6. C ABI v1

当前 public ABI version 为 `0x00010003`。唯一完整 symbol/status/state/yield 列表是
[`spec/abi/p8w-v1.json`](../spec/abi/p8w-v1.json)；public adapter 与 artifact tests 必须与其
完全一致。本文不复制容易漂移的 C header。

所有 public symbol 使用 `extern "C"`，只传 `i32/u32` 和 wasm32 pointer；禁止把
`lua_State *`、`z8::fix32`、C++ object、`i64` 或 JS object 暴露到边界。

契约：

- `p8w_create()` 返回 opaque handle；TS 不得假设它是 C pointer。
- `p8w_compile()` 按 byte length 读取 source，只编译、不执行；临时输入 buffer 仅需在调用期间有效。
- `p8w_boot()` / `p8w_step()` 驱动 top-level、`_init`、callback 或 custom loop，直到一个受控 boundary 或 fatal status。
- 当前 ABI 不发布通用 step-plan/capability vector；catch-up、拆分 update/draw/present 和 host result vector 都是 Deferred，必须先修改机器契约和 conformance。
- syntax/runtime/OOM/budget/host/internal fatal error 后 context 进入 `FAULTED`；`P8W_STATUS_INSTRUCTION_BUDGET` 不可继续 step。对 stale handle、错误 request ID 等 API misuse 返回 `P8W_STATUS_INVALID_STATE` 时不得改变当前有效 context。
- error/request pointer 由 context 拥有，有效期到下一次 mutating ABI call 或 destroy。TS 若需保留必须立即 copy。
- ABI version 不匹配必须 fail closed；新增 capability 必须先进入机器契约。
- `_malloc/_free` 只用于 `withWasmBytes()` 形式的短期输入 copy，必须成对；业务模块不得长期持有任意 malloc pointer。

Pending request 的完成契约：

- 一个 context 同时最多有一个 pending request；request ID 在 handle 生命周期内单调、非零且不得复用。
- `P8W_YIELD_HOST_REQUEST` 后 context 进入 `WAITING_HOST`，普通 step 不得推进 guest。
- `p8w_complete_host_request()` 只接受当前 pending ID。stale/mismatch、重复 completion、reset/destroy 后 completion 都返回 invalid state，不得影响新 session。
- response 是 copied opaque bytes，并带 `is_error`；Bridge **MUST** 在调用返回前完成 copy，不得借用 TS pointer，长度遵守机器契约的 host-byte cap。
- 拒绝、取消和 host error 必须由 response schema 显式表达并进入对应 continuation/结构化错误路径；不得无限保持 pending。停止或 reset 可以直接使旧 request 失效。
- request kind、payload schema version、一次性语义及 nested-coroutine 可恢复性必须有 ABI tests。多-cart `load()` 若采用“销毁旧 VM、原子换新 cart”，Runtime 仍须明确取消旧 request，而不能向已销毁 handle 回填。

## 7. WASM import 与 host-call frame

当前 host import 使用 binding id 与 bridge-owned 80-byte call frame，同步调用 module-local TS
dispatcher。它捕获 TS throw，并映射为 `P8W_STATUS_HOST_API_ERROR` / `E_HOST_API`。artifact layout 为：

```c
int32_t p8_host_call(uint32_t host_context_id,
                     uint32_t call_frame_ptr);
```

`call_frame_ptr` 指向 WASM memory 中 bridge-owned、固定布局的小 frame：

```c
struct p8w_host_call_frame {
  uint32_t byte_size;       /* forward-compatible size */
  uint32_t operation_id;
  uint32_t presence_bits;   /* optional arg: present vs nil */
  uint32_t flags;
  uint32_t scalar_count;
  int32_t  scalar_slots[12];
  uint32_t byte_buffer_ptr; /* one borrowed Lua byte string */
  uint32_t byte_buffer_len;
  int32_t result;
};
```

offset、descriptor、operation 到参数的映射由 machine-readable API schema 同时生成 C header
和 TS dispatcher，并由 hash manifest 锁定。一个 operation layout 进入 ABI v1 后不能静默改变。
byte-string view 只在同步调用期间有效；embedded NUL 不改变 `byte_buffer_len`。

boolean 参数仍占一个 scalar slot，descriptor 的 boolean mask 决定 C 侧 Lua truthiness lowering；
`q16.16-raw-i32` result 直接以 raw bits 返回。
`pal(table,[p])` 是 bounded dedicated wrapper：最多读取 16 个 table entry，再同步复用 operation
`13` 的 typed host method；它不在 bridge 实现 palette mapping。

sprite/map/flags/tline operation `19..28` 最多使用 10 个 scalar，并复用既有 presence、boolean 与
Q16 lowering。`print/cursor` operation `29..30` 使用 production byte-string slot；
`print` 是 production byte-string slot 的首个语义 consumer，C wrapper 以 pointer + explicit length
同步借出 guest bytes。map/text hardware semantics、texture sampling 与 glyph raster 均不进入 bridge。

operation `31..41` 覆盖 audio/input/persistence/memory/root controls。bridge 只处理 Lua stack、
optional/presence、boolean/Q16/string result 与同步错误边界；synthesis、input latch、RAM authority、
IndexedDB 和 current-cart repository 语义均由 RuntimeCore/app adapter 拥有。operation id、签名和
生成物 hash 以 [`pico-host-api-v1.json`](../spec/abi/pico-host-api-v1.json) 及 generated manifest 为准。

`scalar_slots[12]` 不是 PICO-8 vararg/multi-return 上限。`peek(addr,n)` 和
`poke(addr,val...)` 使用 dedicated C wrapper，因此不会穿过 host frame：

- bridge 在 push 大量 Lua return values 前必须 `lua_checkstack()`，失败转 OOM/runtime error。
- 超过 8192 或 Lua stack cap 时结构化失败；`poke` 在写入前验证总 arity，禁止部分 side effect。
- 8192-result/value 路径必须进入 stack correctness 与 interop regression。
- 未来 host-facing multi-return/result vector 仍需新 machine contract，不得借用 scalar slots 截断。

Host adapter **MUST**：

- 在 import 边界捕获所有 JS exception，写入安全错误并返回 host error status；禁止 exception 穿越 WASM 成为不透明 trap。
- 在调用期间直接读 frame/string view，但若异步保留则先 copy。
- 不得从 import 内重入 `p8w_*` export，也不得调用 `_malloc()`。
- 不得返回 Promise。
- 使用无 allocation 的 DataView/typed-array access 处理 steady-state numeric hot path。

只有当前 benchmark ladder 触发阈值时，才允许为 `pset/pget/peek/poke` 等加入 typed fast imports；fast path 必须与 generic path 共享 conformance，并通过机器契约协商。

## 8. 值编解码

### 8.1 Fixed-point

所有 P8 number 穿越 ABI 时 **MUST** 使用 signed Q16.16 raw `int32`：

```cpp
int32_t raw = lua_tonumber(L, index).bits();
lua_pushnumber(L, z8::fix32::frombits(raw));
```

- 禁止用 `lua_tointeger()` 代替 raw extraction；上游 `LUA_INTEGER` 是 `int16_t`。
- TS 用 `raw | 0` 保持 signed bit pattern；需要整数部分时使用经 conformance 固定的转换，不能默认 `raw / 65536` 后以 JS float 作为权威值。
- optional/nil 用 `presence_bits` 区分；不得用 `0`、`NaN` 或 sentinel fixed value 代替 nil。
- 需要 64-bit 中间值的 TS 算法使用 `Math.imul` 组合或 `BigInt`，最后显式截断到 32 bits。

### 8.2 Byte string / P8SCII

Lua string 是带显式长度的 byte sequence，允许内嵌 `\0`：

- C wrapper **MUST** 使用 `lua_tolstring(..., &len)` / `lua_pushlstring()`，禁止 `strlen()`。
- Lua → TS 传 `(ptr, len)`；view 只在当前 host call 有效。
- TS → Lua 通过 bridge-owned result buffer copy，且必须有长度/容量检查。超限返回结构化 host error，禁止截断。
- Runtime 语义层保持 `Uint8Array`；只有 diagnostic/UI boundary 可以用 replacement decoding 转为 Unicode。
- cart source 也以原始 bytes + length 进入 `p8w_compile()`，禁止先 JS decode 再 `TextEncoder` round-trip。

### 8.3 Table、function 与 multi-return

table、function、userdata 和 coroutine handle **MUST NOT** 直接跨 JS/WASM：

- `rnd(table)`、`add/del/deli/all/foreach`、coroutine aliases 等 Lua-semantic API 留在 z8lua/C/Lua glue。
- Host-facing API 先在 wrapper 中降为 fixed、bool、byte string 和 RAM operation。
- multiple return 由 frame result slots + count 表达，再由 C wrapper push 回 Lua stack。
- 每个 generated wrapper 必须有成功、nil/default、类型错误、host error、multi-return 和 stack-balance test。

## 9. Yield、HostRequest 与错误

### 9.1 受控 yield

每次 yield 都必须带 bridge 内部 reason，至少区分 `FRAME_END`、`FLIP`、`NEEDS_CART`、`STOP`。reason 不能只编码进 guest-visible Lua value。

`flip()` 与可恢复 host API 使用 `lua_yieldk()` continuation；普通 C wrapper 在返回前必须恢复 Lua stack invariant。不是所有 host request 都天然可恢复，尤其 nested coroutine 情况按 4.4 节降级。

### 9.2 Instruction budget：抛错，不分帧续跑

count hook 的安全策略已经锁定：budget exhaustion **MUST** poison context 并抛出分类 sentinel error，**MUST NOT** 通过普通 yield 把无限循环拆到后续 frame 继续执行。

建议实现：

1. `p8w_boot()` / `p8w_step()` / `p8w_complete_host_request()` 开始 execution segment 时设置 `remaining` 和 `budgetPoisoned=false`。
2. `lua_sethook(..., LUA_MASKCOUNT, quantum)` 每 `quantum` VM instructions 进入 C hook。
3. hook 更新计数；达到预算时先设置 `budgetPoisoned=true`，再 `luaL_error()`。
4. protected outer resume 无论 guest 是否尝试捕获 sentinel，都在返回路径优先检查 poison，并报告 `P8W_STATUS_INSTRUCTION_BUDGET`。
5. 所有新 coroutine 必须继承 hook；上游 `lua_newthread()` 当前会复制 hook fields，但仍需回归测试。[上游 thread 初始化](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/lstate.c#L237-L250)

`quantum`/safety cap 与 compatibility CPU cost 不是一回事。Phase 4F 已锁定每条 count hook
instruction 作为 deterministic accounting unit，由 Runtime 以 4M/s 和 logical target FPS 换算
Q16.16；默认 1M instruction cap 仍只负责安全。`p8w_consumed_instructions()` 返回当前 resume
segment，bridge 内的 `stat(1)` 另行累计同一 transaction 的先前 HostRequest segments。

Window watchdog 是第二层：若 Worker 在 wall-clock deadline 内没有回复，Window 终止整个 Worker 并重建 session。它覆盖 C parser、host import、WASM trap 或 hook 无法中断的情况；它不能替代 instruction hook。deadline 必须考虑后台暂停和移动设备抖动，并在 browser test 后确定。

### 9.3 Error record

Bridge error 至少包含：

- stable code：syntax/runtime/OOM/budget/host/invalid-state/internal。
- phase：compile/boot/init/update/draw/custom-loop/host-call。
- raw message bytes、chunk name、best-effort line 和 sanitized trace。
- recoverable flag；syntax 可通过加载新 cart 恢复，faulted VM 不可原地 resume。

错误 buffer 不保证是 UTF-8。TS 负责 copy，并把 bridge code 映射到 [Runtime 的 `SerializedRuntimeError`](./04-typescript-runtime.md#15-错误模型)，例如 `P8W_STATUS_INSTRUCTION_BUDGET` → `E_VM_INSTRUCTION_BUDGET`。生产错误不得包含宿主绝对路径、任意 JS object dump 或 secret。

WebAssembly trap、JS import exception 和 Lua error 必须可区分。bridge 内只有未知 invariant failure 使用 `P8W_STATUS_INTERNAL_ERROR`，Runtime 再映射为 `E_INVARIANT`。

## 10. Emscripten 构建基线

z8lua 没有上游 WASM build。本仓库的可复现构建入口为：

```sh
pnpm run build:wasm
pnpm run verify:wasm
```

Emscripten 锁定为 6.0.5；emsdk manager、release commit、完整 source list、flags、
imports 与 artifact hash 分别由 `wasm/toolchain.lock.json` 和
`wasm/manifest.lock.json` 机器验证。production artifact 使用 16 MiB fixed memory、
`worker,node` ES module、Wasm EH、`SUPPORT_LONGJMP=wasm`、filesystem/dynamic
execution/growth off。binary descriptor 已验证 `initial=maximum=256` pages，
`grow(1)` 失败且 view identity 不变。`node` 只服务 CI Worker smoke；当前资源契约固定为
16 MiB linear memory 与 1 MiB default Lua heap，变更必须先修改机器契约与资源测试。

z8lua 的 `.c` 作为 C++17 编译，并在 protected error path 使用 C++ `try/throw`，
因此不能使用 `-fno-exceptions`。工具链固定使用 native Wasm exceptions；正式浏览器
支持结论只须经过 Chrome/Chromium 目标矩阵。

构建要求：

- 使用 ES module factory，以便 Worker 中显式实例化并隔离 module scope。Emscripten 的 `MODULARIZE`/ES module 行为见[官方文档](https://emscripten.org/docs/compiling/Modularized-Output.html)。
- 业务热路径直接调用 exported function；不使用 Embind，默认也不导出 `ccall/cwrap`。Emscripten 说明 direct call 更快，但调用者必须自行处理 primitive/pointer。[官方 interop 文档](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html)
- production 禁止 Asyncify、pthreads 和 WASM Workers。pthreads 会引入 SharedArrayBuffer 及 COOP/COEP 部署要求。[Emscripten pthread 文档](https://emscripten.org/docs/porting/pthreads.html)
- error/exception mode 必须显式 pin，避免工具链升级静默改变；当前是 Wasm EH + `SUPPORT_LONGJMP=wasm`。[官方 longjmp 文档](https://emscripten.org/docs/porting/setjmp-longjmp.html)
- production 禁止 memory growth；固定 16 MiB descriptor、64 context、受控 OOM 与 view identity 已有验证。若后续代表 corpus 证明固定 memory 不足，先测量并修改资源契约，不得静默改为 growth。
- debug build 应开启 assertions、source map、stack overflow check；release build 与 debug build 分离。
- `.wasm` 与 `.mjs` 分文件发布；不默认 `SINGLE_FILE`，不嵌入文件系统或网络 shim。
- build 输出必须记录 z8lua SHA、patch hash、emsdk version、flags 与 artifact hash，支持可复现检查。

## 11. 验证与变更路由

- ABI operation、binding ID、artifact hash 与资源常量：以 `spec/abi/`、runtime manifest 和生成验证为准。
- 当前兼容范围、Known Differences 与 coverage limitation：见
  [测试兼容契约](./06-testing-compatibility.md#15-兼容等级已知差异与质量口径)。
- z8lua pin、patch、许可证、interop 与历史 Chrome 数据：从
  [ADR registry](./07-decisions-risks-open-questions.md#1-adr-registry) 和
  [evidence index](./evidence/) 按需追溯。
- 实现任务的测试层级和完成条件：由 active phase 路由到
  [Codex 协议](./09-codex-task-protocol.md) 与精确 contract 小节。

任何 ABI version、host-call frame、memory ownership、suspension model 或 sandbox 变更都必须先由
active phase 明确授权；影响 Accepted 决定时先提交替代 ADR。不得把历史 spike checklist 或
benchmark 门槛当作下一阶段的待办清单。

## 12. 主要参考

- [PICO-8 User Manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)
- [z8lua repository](https://github.com/samhocevar/z8lua)
- [z8lua `pico8` pin](https://github.com/samhocevar/z8lua/tree/8575dfbc524003c869c0aa05e109819302c576f9)
- [Emscripten: Connecting C++ and JavaScript](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/index.html)
- [Emscripten compiler settings](https://emscripten.org/docs/tools_reference/settings_reference.html)
- [Emscripten setjmp/longjmp support](https://emscripten.org/docs/porting/setjmp-longjmp.html)
