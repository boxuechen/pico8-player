# ADR-022: Root-safe implicit frame slicing

状态：Accepted；部分取代 ADR-017 的 count-hook blanket rejection
日期：2026-08-07

## Context

PICO-8 v0.2.7 允许 cart 自己拥有 top-level main loop。官方 `flip()` 文档不仅说明 custom loop
通常应主动调用 `flip()`，还规定：如果一帧时间内没有调用 `flip()`、且 `_draw()` callback 不在执行，
当前 back buffer 会自动复制到 screen。官方 CPU 规格同时给出约 `4M` Lua VM instructions/s。
[PICO-8 manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html#FLIP)

ADR-017 为了防止 guest 吞掉 hook yield，把 instruction exhaustion 一律设计成不可恢复 poison，
并拒绝 count-hook slicing。Phase 6 的本地真实卡带证明这会把合法的 implicit top-level loop 误报为
`E_VM_INSTRUCTION_BUDGET`。需要把“官方 frame quantum”与“host safety hard cap”拆成两个不同机制。

z8lua spike 进一步确认 Lua 5.2 hook continuation 已在 VM 内显式支持：`traceexec()` 在 hook yield 时
设置 `CIST_HOOKYIELD`、回退 `savedpc`，resume 后清除标记并继续执行；`lua_yieldk()` 允许当前 Lua frame
从 hook 以无 continuation 的形式 yield。这个机制能保持 Lua PC、stack、protected call 和 GC state，
但 yield 仍只属于当前 coroutine 的直接 resumer，因此不能从 guest-created nested coroutine 直接提交
Runtime frame。

## Decision

1. 保留 ADR-017 的不可恢复 hard safety cap。每个 boot/step transaction 默认最多 `1,000,000`
   instructions；达到该 cap 时先 poison context，再抛出分类 sentinel，结果仍是
   `E_VM_INSTRUCTION_BUDGET`，不得原地 resume。
2. 另设只用于 top-level custom execution 的 implicit-frame counter。它按 Phase 4F 的固定
   `4,000,000 inst/s` 模型取 30 Hz 下界，即每帧 `133,333` instructions；这不是 hard cap，达到时
   产生现有 ABI `P8W_YIELD_FRAME_END`，不新增 public yield reason 或 ABI version。
3. implicit counter 在 `ActiveKind::TopLevel` 期间统计 root 与 nested coroutine 的所有 VM
   instructions，但只允许 Runtime-owned root Lua thread 实际 hook-yield。若 quantum 在 nested coroutine
   内到达，boundary 标记保持 pending，等控制返回 root safe point 后提交；若 nested coroutine 永不返回，
   hard cap 仍会 fail closed。
4. 每次新的 `p8w_boot()` / `p8w_step()` 重置 implicit quantum；同一 transaction 内的 root
   HostRequest continuation 保留剩余 quantum 和累计 instruction accounting。输入、logical time、audio、
   cartdata 与 framebuffer 仍只在完整 boundary 上原子 commit。
5. `_update()`、`_update60()`、`_draw()` 和 `_init()` 不使用 implicit slicing；它们可以作为普通
   slow frame 原子完成，最终仍由 hard cap 约束。显式 root `flip()` 继续使用自身 continuation，并在先
   到达时结束当前 frame。
6. 一次 Runtime `step()` 最多接受一个 `FRAME_END` 或 `FLIP`。implicit startup 采用既有 30 Hz
   `1/30s` epoch；后续每个 implicit boundary 只推进一个 completed slice。floor quantum 的 CPU fraction
   是 `0xffff`，不标记为 slow frame。
7. 若有限 top-level code 跨过一个或多个 implicit/explicit custom boundary 后最终返回，bridge 在该
   frame 内至多调用一次 `_init()` 并切换到 callback mode；不得返回没有 frame boundary 的成功 step。
8. ADR-017 关于 hard-cap poison、Window watchdog、root HostRequest 和 nested host-suspension fault 的
   决定保持有效。ADR-019 的 nested suspension policy 不因本 ADR 扩大。

## Evidence

- real-WASM Node spike 覆盖 infinite loop、任意 instruction-point resume、深层 stack、`pcall`、持续
  allocation/GC、nested coroutine safe-point、HostRequest transaction、有限 top-level transition、
  callback/explicit-flip controls、hard cap 与 fresh generation recovery：
  [`tests/runtime/phase-6f-cpu-slicing.test.mjs`](../../tests/runtime/phase-6f-cpu-slicing.test.mjs)。
- Chrome production Worker/WASM 路径以原创 implicit-loop cart 完成 `12 × 120` frames：
  [`tests/compat/run-phase-6f-project-smoke.mjs`](../../tests/compat/run-phase-6f-project-smoke.mjs)。
- 机器结论：
  [`spec/phase-6-real-cart-qualification-contract.json`](../../spec/phase-6-real-cart-qualification-contract.json)。

## Consequences

- 不调用 `flip()` 的合法 top-level loop 不再占有 Worker event loop，也不会被普通 1M hard cap 误杀；
  Runtime 仍以一次调用一个确定性 frame 的方式驱动它。
- callback 与显式 `flip()` cart 的既有边界、soft CPU classification 和 hard-fault recovery 不变。
- guest-created coroutine 内到达 implicit quantum 时可能晚于 133,333 instructions 才呈现；非返回 nested
  loop 会在 hard cap fault。该精确差异以 `P6-KD-02` 发布，避免伪装成完整任意-coroutine preemption。
- 该实现没有 Asyncify、source rewrite、busy-wait、wall-clock quantum、cart-specific branch 或新的
  Worker/Main capability。

## Rejected alternatives

- **维持 ADR-017 blanket rejection**：与官方未 `flip()` 时自动呈现的行为冲突，并已造成真实 cart
  的确定性 timing false negative。
- **把 hard cap 本身改成 resumable yield**：会取消故障隔离，使任何 callback 或 runaway nested
  coroutine 都能无限续跑。
- **直接从 nested coroutine hook-yield**：yield 会先返回 guest `coresume()`，可能被 cart 捕获，
  Runtime 无法证明一个 root frame 已完成。
- **源码插入 `flip()` 或识别特定 loop/cart**：破坏源码行号、语义与通用边界，且无法覆盖动态控制流。
- **用 Worker watchdog 当帧调度器**：wall clock 不确定、会销毁 generation，不能保存 Lua continuation。
- **引入 Asyncify**：扩大 WASM/host suspension surface，但不解决 Lua coroutine 的 direct-resumer ownership。
