# z8lua WASM Bridge 契约

本文定义 z8lua 与 TypeScript Runtime 之间的可执行边界。它服务于 Phase 0 spike 和后续生产实现，不把拟定接口误写成 z8lua 上游能力。

本文使用以下标记：

- **已核验上游事实**：来自固定提交的源码或上游说明。
- **MUST / MUST NOT / SHOULD**：本项目实现约束。
- **Proposed**：Phase 0 的起始设计；只有通过测试并形成 ADR 后才能视为稳定公共契约。

实施状态：Phase 0A baseline 与 Phase 0B Shared Pico RAM 已完成；证据分别见
[12-phase-0a-evidence.md](./12-phase-0a-evidence.md) 和
[13-phase-0b-evidence.md](./13-phase-0b-evidence.md)。`p8w0a_*`/`p8w0b_*` 都是
bounded spike ABI，不是本文件后文 Proposed production `p8w_*`。

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
2. 只打开实现 P8 Lua 所需的 base、PICO pure math/string、table 与 coroutine 子集；`rnd/srand` 等有 Runtime state 的函数仍走受控 host wrapper。
3. 删除或从不注册 `debug`、`io`、`os`、`package`、`require`、`dofile`、`loadfile` 和 native module 能力。
4. 按目标 PICO-8 API inventory 删除多余 base globals，并注册 PICO aliases 与 generated host wrappers。
5. 安装不可由 guest 修改的 count hook。
6. 分配并绑定 shared Pico RAM。

`pcall`、`xpcall`、dynamic `load`、`collectgarbage` 等是否暴露，必须由官方行为和 conformance 决定。无论最终兼容选择如何，guest **MUST NOT** 获得修改/关闭 bridge hook 的途径。

Lua heap cap 与 64 KiB Base RAM 是两个不同限制。allocator **MUST** 正确追踪 realloc delta、在超限时返回 null，并把 `LUA_ERRMEM` 转成 `P8W_ERROR_OOM`；不得让 Emscripten `abort()` 成为普通 cart OOM 路径。初始 heap cap 数值是 Phase 0 未决参数，必须用真实 heap stress 决定。

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

这是 C/guest execution phase。外层 TS adapter 还必须遵守 [Worker 两阶段 bootstrap](./08-source-layout-and-boundaries.md#worker-两阶段-bootstrap) 的 `memory-ready -> host-bound -> runnable` gate：host router 未 exactly-once 绑定时，禁止调用 `p8w_resume()`。该 bootstrap state 不得伪装成新的 guest yield reason。

### 4.2 默认 callback loop

默认 cart 的 top-level 返回后，bridge 执行 `_init()`。当 `p8w_resume(..., P8W_STEP_DEFAULT)` 驱动一个完整 callback frame 时，bridge 按以下顺序执行：

1. 在 frame boundary 重新确认 `_update60` / `_update` 模式。
2. 优先调用 `_update60()`；否则调用 `_update()`。
3. 调用 `_draw()`（若存在）。
4. 通过 bridge 私有 frame-end yield 返回 Runtime。

`P8W_STEP_UPDATE`、`P8W_STEP_DRAW`、`P8W_STEP_PRESENT` 的非默认组合可以按第 6 节 `step_flags` 契约跳过相应阶段；它们不会推翻上述 default path。Phase 1 只允许 `P8W_STEP_DEFAULT`，其他组合必须在慢帧/catch-up conformance 固定后才能用于生产调度。

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
- 一次 `p8w_resume()` 最多提交一个受控 frame/flip boundary。
- top-level 的首次 `P8W_YIELD_FLIP` 是暂行 startup boundary，不单独计入 Runtime logical frame/time；从其 continuation resume 到下一个 `P8W_YIELD_FLIP` 才完成 custom-loop frame 0。Phase 0 必须用官方 capture 验证这一帧偏移规则并形成 ADR。

custom loop 的精确 30/60 Hz 规则必须由 Phase 0/1 conformance 固定；在证据前不得把 display refresh 直接当作 guest frame rate。

### 4.4 Nested coroutine 陷阱

`lua_yieldk()` 只向当前 coroutine 的直接 resumer yield。若 cart 在 guest-created coroutine 内调用 `flip()`、`load()` 等，yield 可能先被 `coresume()` 捕获，而没有自然冒泡到 Runtime root。

因此：

- Phase 0 **MUST** 分别测试 root coroutine 与至少两层 nested coroutine 中的 `flip/load/reload/cstore`。
- host request **MUST** 带 out-of-band `pendingRequest` 状态；不能仅靠 Lua yield return values 猜测。
- 在可靠的 root bubbling（例如受测试的 `coresume` glue/最小 VM patch）完成前，缺失的多-cart 数据只允许从预供给或同步内存 cache 取得。
- 若 nested suspension 不能安全恢复，MVP **MUST** 返回 `E_FEATURE_UNSUPPORTED`，并在结构化 details 中标记 `reason: "nested-host-suspend"`；禁止伪装成通用异步暂停已经解决。
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

v1 production **MUST** 禁止 WASM memory growth，并令 `initial === maximum`。Emscripten 明确说明 growth 会替换 buffer、使既有 typed-array views 失效。[Emscripten memory view 说明](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html#access-memory-from-javascript) Phase 0 负责用 heap/cart/multi-instance stress 确定固定容量；未来若要启用 growth，必须先有新 ADR、集中式 view factory 和完整 alias 回归，普通实现任务不得自行打开。

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

### 5.3 Phase 0B bounded ABI（已实现）

Phase 0B 只新增 `p8w0b_*` probe：context create/destroy/run/result、RAM
pointer/size/reset、canonical map/read/write 和 source alloc/free。ABI version 为
`0x00020000`。它用于锁定 RAM boundary 与测试，不含 compile/resume/frame/request
state machine，不得被 RuntimeCore 当作 production `VmPort`。

## 6. Proposed C ABI v1

本节是本项目 **Proposed** ABI，不是 z8lua 上游 API。Phase 0 可以修改它，但修改后必须更新本文、TS declarations 和 ABI tests。

所有 public symbol 使用 `extern "C"`，只传 `i32/u32` 和 wasm32 pointer；禁止把 `lua_State *`、`z8::fix32`、C++ object、`i64` 或 JS object 暴露到边界。

```c
#define P8W_ABI_VERSION 0x00010000u /* major << 16 | minor */

typedef uint32_t p8w_handle_t; /* opaque; 0 is invalid */

enum p8w_status {
  P8W_OK                    = 0,
  P8W_READY                 = 1,
  P8W_YIELD_FRAME           = 2,
  P8W_YIELD_FLIP            = 3,
  P8W_NEEDS_CART            = 4,
  P8W_STOPPED               = 5,
  P8W_YIELD_SLICE           = 6,

  P8W_ERROR_INVALID_STATE   = -1,
  P8W_ERROR_SYNTAX          = -2,
  P8W_ERROR_RUNTIME         = -3,
  P8W_ERROR_OOM             = -4,
  P8W_ERROR_BUDGET          = -5,
  P8W_ERROR_HOST            = -6,
  P8W_ERROR_INTERNAL        = -7
};

enum p8w_step_flags {
  P8W_STEP_UPDATE           = 1u << 0,
  P8W_STEP_DRAW             = 1u << 1,
  P8W_STEP_PRESENT          = 1u << 2,
  P8W_STEP_DEFAULT          = P8W_STEP_UPDATE |
                              P8W_STEP_DRAW |
                              P8W_STEP_PRESENT
};

enum p8w_request_result {
  P8W_REQUEST_OK            = 0,
  P8W_REQUEST_NOT_FOUND     = 1,
  P8W_REQUEST_DENIED        = 2,
  P8W_REQUEST_CANCELLED     = 3,
  P8W_REQUEST_HOST_ERROR    = 4
};

enum p8w_capability {
  P8W_CAP_STEP_PLAN         = 1u << 0,
  P8W_CAP_REQUEST_COMPLETE  = 1u << 1,
  P8W_CAP_HOST_VECTORS      = 1u << 2
};

uint32_t     p8w_abi_version(void);
uint32_t     p8w_capabilities(void);
p8w_handle_t p8w_create(uint32_t host_context_id,
                        uint32_t lua_heap_limit_bytes);
void         p8w_destroy(p8w_handle_t handle);
int32_t      p8w_reset(p8w_handle_t handle);

uint32_t     p8w_ram_ptr(p8w_handle_t handle);
uint32_t     p8w_ram_size(p8w_handle_t handle); /* always 65536 */

int32_t      p8w_compile(p8w_handle_t handle,
                         uint32_t source_ptr, uint32_t source_len,
                         uint32_t chunk_name_ptr, uint32_t chunk_name_len);
int32_t      p8w_resume(p8w_handle_t handle,
                        uint32_t instruction_budget,
                        uint32_t step_flags);

uint32_t     p8w_phase(p8w_handle_t handle);
uint32_t     p8w_target_fps(p8w_handle_t handle);
uint32_t     p8w_last_instruction_count(p8w_handle_t handle);

int32_t      p8w_last_error_code(p8w_handle_t handle);
uint32_t     p8w_last_error_ptr(p8w_handle_t handle);
uint32_t     p8w_last_error_len(p8w_handle_t handle);
int32_t      p8w_last_error_line(p8w_handle_t handle);

uint32_t     p8w_pending_request_id(p8w_handle_t handle);
uint32_t     p8w_pending_request_kind(p8w_handle_t handle);
uint32_t     p8w_pending_request_ptr(p8w_handle_t handle);
uint32_t     p8w_pending_request_len(p8w_handle_t handle);
int32_t      p8w_complete_request(p8w_handle_t handle,
                                  uint32_t request_id,
                                  int32_t result_code,
                                  uint32_t payload_ptr,
                                  uint32_t payload_len);
```

契约：

- `p8w_create()` 返回 opaque handle；TS 不得假设它是 C pointer。
- `p8w_compile()` 按 `source_len` 读取 bytes，只编译、不执行；source/chunk buffers 仅需在调用期间有效。
- `p8w_resume()` 驱动 top-level、`_init`、callback 或 custom loop，直到一个受控 boundary 或 fatal status。
- `step_flags` 在 boot/custom-loop mode 被忽略；在 callback mode 中决定本 slice 是否调用 update、draw，以及是否提交 visible frame。Phase 1 只需 `P8W_STEP_DEFAULT`。支持 catch-up 时，Runtime 可以先执行若干 `UPDATE` slice（返回 `P8W_YIELD_SLICE`），最后执行 `UPDATE | DRAW | PRESENT`（返回 `P8W_YIELD_FRAME`）。跳过 `_draw` 是否符合目标 CPU/frame-drop 行为仍必须由 conformance 决定，不能仅因 ABI 可表达就默认启用。
- syntax/runtime/OOM/budget/host/internal fatal error 后 context 进入 `FAULTED`；`P8W_ERROR_BUDGET` 不可继续 resume。对 stale handle、错误 request ID 等 API misuse 返回 `P8W_ERROR_INVALID_STATE` 时不得改变当前有效 context。
- error/request pointer 由 context 拥有，有效期到下一次 mutating ABI call 或 destroy。TS 若需保留必须立即 copy。
- ABI major 不匹配必须 fail closed；minor capability 通过 `p8w_capabilities()` 协商。
- `_malloc/_free` 只用于 `withWasmBytes()` 形式的短期输入 copy，必须成对；业务模块不得长期持有任意 malloc pointer。

Pending request 的完成契约：

- 一个 context 同时最多有一个 pending request；request ID 在 handle 生命周期内单调、非零且不得复用。
- `P8W_NEEDS_CART` 后，未完成 request 时再次 `p8w_resume()` 只能幂等返回同一状态，不得推进 guest。
- `p8w_complete_request()` 只接受当前 pending ID。stale/mismatch、重复 completion、reset/destroy 后 completion 都返回 `P8W_ERROR_INVALID_STATE`，不得影响新 session。
- `payload` 是 request-kind schema 定义的 opaque bytes；成功时是对应结果，失败时可以是受限 diagnostic bytes。Bridge **MUST** 在调用返回前完成 copy，不得借用 TS pointer；`payload_len` 必须有 kind-specific cap。
- `P8W_REQUEST_CANCELLED`、拒绝和 host error 必须在下一次 resume 进入对应 continuation/结构化错误路径；不得无限保持 pending。停止或 reset 可以直接使旧 request 失效。
- request kind、payload schema version、一次性语义及 nested-coroutine 可恢复性必须有 ABI tests。多-cart `load()` 若采用“销毁旧 VM、原子换新 cart”，Runtime 仍须明确取消旧 request，而不能向已销毁 handle 回填。

## 7. WASM import 与 host-call frame

Phase 0 初始实现只需要一个必选同步 import：

```c
int32_t p8_host_call(uint32_t host_context_id,
                     uint32_t call_frame_ptr);
```

`call_frame_ptr` 指向 WASM memory 中 bridge-owned、固定布局的小 frame。Proposed v1 布局：

```c
struct p8w_host_call_frame {
  uint32_t byte_size;       /* forward-compatible size */
  uint32_t opcode;
  uint32_t presence_bits;   /* optional arg: present vs nil */
  uint32_t flags;
  uint32_t scalar_count;
  int32_t  slots[12];       /* common scalar fast path */

  uint32_t arg_vector_ptr;  /* bridge-owned int32/raw-fix vector */
  uint32_t arg_vector_count;

  uint32_t result_vector_ptr;
  uint32_t result_vector_capacity;
  uint32_t result_vector_count;

  uint32_t byte_buffer_ptr; /* byte string / bounded bulk result */
  uint32_t byte_buffer_capacity;
  uint32_t byte_buffer_len;
};
```

具体 opcode 到 slot/vector 的映射 **SHOULD** 由 machine-readable API schema 同时生成 C wrapper、TS decoder 和 stack-balance tests。一个 opcode 的 layout 一旦进入 ABI v1 就不能静默改变。

`slots[12]` 只是常见 scalar fast path，不是 PICO-8 vararg/multi-return 上限。`peek(addr,n)`（官方最大 8192 results）、`poke(addr,val...)` 等必须使用 bridge-owned bounded vector 或专用 wrapper：

- host 不得修改 vector pointer/capacity，只能在 cap 内写内容和 result count。
- bridge 在 push 大量 Lua return values 前必须 `lua_checkstack()`，失败转 OOM/runtime error。
- 超过 PICO API limit、scratch cap 或 Lua stack cap 时结构化失败；禁止静默截断到 12、截断到 scratch 大小或部分执行 side effect。
- scratch buffer 可复用但不得在 reentrant call 中别名；steady state 不得 per-element malloc。
- 1K/8K vararg 与 multi-return 必须进入 stack correctness 和 interop benchmark。

Host adapter **MUST**：

- 在 import 边界捕获所有 JS exception，写入安全错误并返回 host error status；禁止 exception 穿越 WASM 成为不透明 trap。
- 在调用期间直接读 frame/string view，但若异步保留则先 copy。
- 不得从 import 内重入 `p8w_*` export，也不得调用 `_malloc()`。
- 不得返回 Promise。
- 使用无 allocation 的 DataView/typed-array access 处理 steady-state numeric hot path。

Phase 0 先测 generic import。只有 benchmark 触发阈值时，才为 `pset/pget/peek/poke` 等加入 typed fast imports；fast path 必须与 generic path 共享 conformance，并通过 capability bit 协商。

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

1. `p8w_resume(handle, budget, step_flags)` 设置 `remaining` 和 `budgetPoisoned=false`。
2. `lua_sethook(..., LUA_MASKCOUNT, quantum)` 每 `quantum` VM instructions 进入 C hook。
3. hook 更新计数；达到预算时先设置 `budgetPoisoned=true`，再 `luaL_error()`。
4. protected outer resume 无论 guest 是否尝试捕获 sentinel，都在返回路径优先检查 poison，并报告 `P8W_ERROR_BUDGET`。
5. 所有新 coroutine 必须继承 hook；上游 `lua_newthread()` 当前会复制 hook fields，但仍需回归测试。[上游 thread 初始化](https://github.com/samhocevar/z8lua/blob/8575dfbc524003c869c0aa05e109819302c576f9/lstate.c#L237-L250)

`quantum`、默认 budget 与官方 CPU cost model 不是一回事。Phase 0 只保证安全和跨浏览器确定性，Phase 4 再校准兼容 CPU accounting。

Window watchdog 是第二层：若 Worker 在 wall-clock deadline 内没有回复，Window 终止整个 Worker 并重建 session。它覆盖 C parser、host import、WASM trap 或 hook 无法中断的情况；它不能替代 instruction hook。deadline 必须考虑后台暂停和移动设备抖动，并在 browser test 后确定。

### 9.3 Error record

Bridge error 至少包含：

- stable code：syntax/runtime/OOM/budget/host/invalid-state/internal。
- phase：compile/boot/init/update/draw/custom-loop/host-call。
- raw message bytes、chunk name、best-effort line 和 sanitized trace。
- recoverable flag；syntax 可通过加载新 cart 恢复，faulted VM 不可原地 resume。

错误 buffer 不保证是 UTF-8。TS 负责 copy，并把 bridge code 映射到 [Runtime 的 `SerializedRuntimeError`](./04-typescript-runtime.md#15-错误模型)，例如 `P8W_ERROR_BUDGET` → `E_VM_INSTRUCTION_BUDGET`。生产错误不得包含宿主绝对路径、任意 JS object dump 或 secret。

WebAssembly trap、JS import exception 和 Lua error 必须可区分。bridge 内只有未知 invariant failure 使用 `P8W_ERROR_INTERNAL`，Runtime 再映射为 `E_INVARIANT`。

## 10. Emscripten 构建基线

z8lua 没有上游 WASM build。Phase 0A 已把 baseline 落为真实命令：

```sh
pnpm run build:wasm
pnpm run verify:wasm
```

Emscripten 锁定为 6.0.5；emsdk manager、release commit、完整 source list、flags、
imports 与 artifact hash 分别由 `wasm/toolchain.lock.json` 和
`wasm/manifest.lock.json` 机器验证。实际 Phase 0B artifact 使用 16 MiB fixed memory、
`worker,node` ES module、Wasm EH、`SUPPORT_LONGJMP=wasm`、filesystem/dynamic
execution/growth off。binary descriptor 已验证 `initial=maximum=256` pages，
`grow(1)` 失败且 view identity 不变。`node` 只服务 CI Worker smoke；16 MiB 与默认
1 MiB Lua cap 是 Phase 0B artifact 参数，不是代表 cart corpus 的最终容量决定。

z8lua 的 `.c` 作为 C++17 编译，并在 protected error path 使用 C++ `try/throw`，
因此不能使用 `-fno-exceptions`。Phase 0A 选择 native Wasm exceptions；正式浏览器
支持结论仍须经过目标 Chromium/Firefox/Safari 矩阵。

构建要求：

- 使用 ES module factory，以便 Worker 中显式实例化并隔离 module scope。Emscripten 的 `MODULARIZE`/ES module 行为见[官方文档](https://emscripten.org/docs/compiling/Modularized-Output.html)。
- 业务热路径直接调用 exported function；不使用 Embind，默认也不导出 `ccall/cwrap`。Emscripten 说明 direct call 更快，但调用者必须自行处理 primitive/pointer。[官方 interop 文档](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html)
- 禁止 Asyncify、pthreads 和 WASM Workers 作为 Phase 0 依赖。pthreads 会引入 SharedArrayBuffer 及 COOP/COEP 部署要求。[Emscripten pthread 文档](https://emscripten.org/docs/porting/pthreads.html)
- error/exception mode 必须显式 pin，避免工具链升级静默改变；Phase 0A 是 Wasm EH + `SUPPORT_LONGJMP=wasm`。[官方 longjmp 文档](https://emscripten.org/docs/porting/setjmp-longjmp.html)
- production 禁止 memory growth；Phase 0B 已验证 16 MiB descriptor、64 context、受控 OOM 与 view identity。若后续代表 corpus 证明固定 memory 不足，先测量并调整，不得静默改为 growth。
- debug build 应开启 assertions、source map、stack overflow check；release build 与 debug build 分离。
- `.wasm` 与 `.mjs` 分文件发布；不默认 `SINGLE_FILE`，不嵌入文件系统或网络 shim。
- build 输出必须记录 z8lua SHA、patch hash、emsdk version、flags 与 artifact hash，支持可复现检查。

## 11. Phase 0 实施顺序

Codex 应按以下 vertical slices 实现，不能一次提交全部 bridge：

1. **Baseline VM（Phase 0A Complete）**：pin source、tracked allocator、白名单 libs、compile/execute shorthand/fixed/coroutine fixture、instruction budget、NOTICE。
2. **Shared RAM（Phase 0B Complete）**：64 KiB stable allocation、`lua_setpico8memory` alias、TS 双向读写、upper/wrap/remap conformance、fixed memory/OOM。
3. **Raw ABI**：`p8w_*` lifecycle、Q16.16、byte string、structured error 和 stack tests。
4. **Host schema prototype**：选择 5–10 个不同签名 API，生成 generic call frame wrapper/binding。
5. **Frame control**：callback loop、root custom `flip()`、instruction error、Window watchdog。
6. **Nested control flow**：nested `flip/load/reload/cstore`；决定可靠 bubble、同步-cache 降级或 unsupported contract。
7. **Interop benchmark**：依据结果接受 generic ABI 或增加最小 typed fast paths。

每个 slice 必须同时提交 tests 和相应 ADR/本文更新；spike 结果不能只存在于聊天或 benchmark 截图。

## 12. 性能 Spike

### 12.1 必测 workload

Phase 0C browser harness 在 Chromium、Firefox、Safari 使用同一 contract；缺失
browser 必须记录 `not-run`/`unavailable`，不能生成替代值。bridge-only matrix 为：

| Case | 规模 | 要回答的问题 |
| --- | ---: | --- |
| no-op scalar / raw Q16.16×3 | 1K / 16K / 64K calls/frame | 纯边界与 raw 多参数成本 |
| `pset(rawX, rawY, color)` | 16,384/frame | pixel hot path 是否需 typed import/下沉 |
| `peek_poke` | 1K / 16K / 64K pairs | per-call import 与 shared RAM 成本 |
| `spr_8x8` | 1K / 4K / 16K / 64K | block operation 边界与 total pixel work |
| byte string | 1024 calls × 0/8/64/1024 B | pointer + length、embedded NUL 与 payload cost |

四条路径分别是 JS→WASM export、WASM→JS import、pure-WASM control 和
canonical-mapped JS shared memory。每轮记录 calls、calibration、p50/p95/p99、
calls/s、ns/call、allocation availability、result checksum、完整 RAM hash 和 buffer
identity。Phase 0C 刻意不运行 Lua parser/VM，因此不记录伪造的 VM instruction
count；direct `@/%/$` correctness 属于 Phase 0B，nested HostRequest/coroutine 属于
Phase 0E。

### 12.2 初始 Go gate

- 代表性 60 Hz cart 的 VM + TS Runtime desktop p95 **SHOULD** ≤ 8 ms/frame，与 [系统架构预算](./02-system-architecture.md#11-初始性能预算)一致。
- bridge-only 16K no-op/raw calls 不得产生每 call JS object/string allocation。
- 16K `pset` stress 的 desktop p95 目标为 ≤ 5 ms，以给 VM/audio 留出总计 8 ms 的 core budget；超出时不能宣布 generic ABI Go。该数值与 [测试性能门禁](./06-testing-compatibility.md#102-场景预算) 同步维护。
- Safari 不得比同设备 Chromium 出现数量级退化；实际支持设备/浏览器版本必须写入 ADR。
- 所有 workload 在优化前后 output/RAM hash 必须一致。
- steady state 不得 memory grow，不得随帧数线性增长 heap、message 或 buffer。

若失败，必须按 [全局 fallback ladder](./07-decisions-risks-open-questions.md#4-fallback-ladder) 从第 1 级逐级评估。某一级对当前 workload 不适用时，也必须记录 profile 与 `not-applicable` 理由后才能继续；不得用本节的 bridge 局部视角跳过 raw buffer、批量输出或 audio 层级，直接宣布 full-core WASM。每次升级只移动被 profile 证明的热点。

Phase 0C 的已测 Chrome 结论为 conditional Go：16K `pset`、65,536
`peek_poke`、4K `spr_8x8` import p95 为 0.090/0.599/0.442 ms；80/80
cross-path hash 与 fixed-buffer 门禁通过，未触发下沉。Firefox/Safari 尚无实测，
因此 portability condition 和 representative-cart 8 ms gate 仍开放。见
[ADR-006](./adr/006-interop-hot-path-boundary.md) 与
[Phase 0C 证据](./14-phase-0c-evidence.md)。

## 13. 验收标准

Phase 0 Exit 前，本 bridge 至少满足：

### Build / supply chain

- [x] z8lua 与 emsdk 均 pin，clean build outputs 可重复构建相同 artifact hash。
- [x] Phase 0A 比较后选定的 z8lua upstream branch、精确 commit 与所有本地 patch 都有 provenance。
- [x] Lua/WTFPL notices 和 third-party 清单进入生成 artifact。

### Language / sandbox

- [x] shorthand、compound assignment、overflow、division by zero、sin/cos 和 coroutine fixture 通过。
- [x] `^` 差异有明确 baseline result/known-difference；未宣称 bit-exact。
- [x] guest 无法取得 `debug.sethook`、filesystem、network 或 native module。
- [x] 创建/销毁 100 contexts 后无可观察 session/tracked-Lua-heap 线性泄漏。

### RAM / ABI

- [ ] `p8w_abi_version`、invalid handle/state、reset/destroy 和 major mismatch 测试通过。
- [ ] TS 与 Lua 对同一 64 KiB RAM 双向 alias，无 frame copy。
- [ ] lower/upper、negative、`0xffff` wrap、multi-byte cross-boundary、GFX/SCREEN remap conformance 通过，或存在带 tests 的最小 pin patch。
- [ ] raw fixed、nil/default、embedded NUL、multi-return、host error、stack balance 全覆盖。
- [ ] 8K vararg/result vector 不截断、不过界，Lua stack 不足时受控失败。
- [ ] 所有 error/request pointer lifetime 有 use-after-next-call 测试或 defensive copy test。
- [ ] pending request 的 ID 匹配、success/error/cancel、重复/stale completion、payload copy 与 size cap 测试通过。

### Control / safety

- [ ] callback cart 手动推进 60 次得到精确的 update/draw count。
- [ ] root 手写 `flip()` loop 每 resume 只前进一个 boundary，且不重复启动 callback loop。
- [ ] nested coroutine 的 `flip/load/reload/cstore` 有测试和明确结果；未解决项按同步-cache/unsupported 降级。
- [ ] Lua 无限循环由 count hook 转成不可恢复 `P8W_ERROR_BUDGET`，Runtime 映射为 `E_VM_INSTRUCTION_BUDGET`，不是 yield 后继续。
- [ ] JS import throw、Lua runtime error、OOM、budget 和 raw Wasm trap 可区分。
- [ ] hook 失效或 native stall 时，Window watchdog 能终止并重建 Worker。

### Performance

- [ ] 12.1 workload 在浏览器矩阵有可复现 p50/p95/p99。
- [ ] generic/fast/downshift 决策形成 ADR，并更新 capability/ABI。
- [ ] 优化前后 semantic hash 一致。

## 14. 风险与未决问题

| 问题 | 当前默认 | 关闭条件 |
| --- | --- | --- |
| 固定 WASM memory 容量 | Phase 0B artifact 为 16 MiB，descriptor/64-context/OOM/view identity passed | 代表 cart corpus 继续校准 production sizing；禁止开启 growth |
| Lua heap cap | 未定 | 兼容 corpus 和恶意 allocation fixture |
| generic call frame 是否足够快 | 未定 | 12.1 browser benchmark |
| `@/%/$` upper/remap 精确规则 | 上游 flat 实现不满足假设 | 官方 capture + 最小 patch + golden |
| `^` bit mismatch | 已知风险 | 接受 known difference 或带 conformance 的 patch |
| callback 动态替换及 custom loop fps | 未定 | 30/60/custom conformance |
| nested coroutine HostRequest | 不宣称通用支持 | root bubbling + resume tests；否则显式降级 |
| count quantum/default budget | 未定 | 跨浏览器 determinism + representative corpus |
| generated binding（ADR-008） | Proposed | 5–10 signature prototype/stack tests |
| Emscripten exception/longjmp mode | Phase 0A 为 Wasm EH + `SUPPORT_LONGJMP=wasm` | browser matrix 后接受或替换 production mode |

实现者不得自行“顺手解决”这些问题并静默改变契约。每项必须以 fixture、benchmark 或官方依据关闭，并同步 [07-decisions-risks-open-questions.md](./07-decisions-risks-open-questions.md)。

## 15. 主要参考

- [PICO-8 User Manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)
- [z8lua repository](https://github.com/samhocevar/z8lua)
- [z8lua `pico8` pin](https://github.com/samhocevar/z8lua/tree/8575dfbc524003c869c0aa05e109819302c576f9)
- [Emscripten: Connecting C++ and JavaScript](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/index.html)
- [Emscripten compiler settings](https://emscripten.org/docs/tools_reference/settings_reference.html)
- [Emscripten setjmp/longjmp support](https://emscripten.org/docs/porting/setjmp-longjmp.html)
