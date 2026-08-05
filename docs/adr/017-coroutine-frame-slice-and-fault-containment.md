# ADR-017: Coroutine frame slice 与双层故障隔离

状态：Accepted
日期：2026-08-05

## Context

Phase 0E 必须证明 z8lua cart 可以由 TypeScript Runtime 主动、确定性地推进，而不是
让 Lua 自己占有 Worker event loop。关键风险是 callback 与 custom `flip()` 有不同
lifecycle；Lua count hook 只能处理中断 VM instructions，不能覆盖 parser、WASM trap
或 JS/native stall；`lua_yieldk()` 在 guest-created nested coroutine 中只返回直接
`coresume()` caller，不能自然冒泡到 Runtime root。

官方 PICO-8 0.2.7 手册明确了 `_update()` 的 30 Hz、`_update60()` 的 60 Hz、
`_draw()` frame callback、按 update 计数的 `time()`，以及 custom main loop 中
`flip()` 的 back-buffer/wait boundary。当前开发机没有已授权的官方 PICO-8 binary，
因此手册未明确的“首次 startup flip 是否先推进 custom-loop time”不能伪造成官方
差分结果。

## Decision

1. production ABI 使用 unprefixed `p8w_*` v1，并编译到独立
   `z8lua-runtime-v1.{mjs,wasm}`；Phase 0C `p8w0c_bench_*` 不得出现在该 artifact。
2. VM lifecycle 固定为 `EMPTY → COMPILED → BOOTING → CALLBACK_LOOP | CUSTOM_LOOP`，
   host request 临时进入 `WAITING_HOST`，不可恢复错误进入 `FAULTED`。
3. callback frame 默认顺序为 `_update60`（优先）或 `_update`，再 `_draw`；一次
   Runtime `step()` 至多提交一个 `FRAME_END`。
4. top-level 首次 `flip()` 只识别 `CUSTOM_LOOP` startup，不增加 completed slice；
   之后每次 host step 从 continuation 到下一个 `flip()`，完成一个 slice。custom
   rate 暂定 30 Hz。此条是 project contract，不宣称已获官方 binary capture；获取
   合法本地 binary 后必须补 differential，再决定是否迁移 time offset。
5. `time()/t()` 由 Runtime 的 `completedSlices` 和 target FPS 计算，按 signed Q16.16
   raw bits 传入 VM；同一 slice 不读 wall clock。
6. count hook 超限先 poison context 再抛 sentinel。无论 guest 是否捕获 Lua error，
   outer resume 都返回 `E_VM_INSTRUCTION_BUDGET`；faulted VM 禁止原地恢复。count
   quantum 是安全限额，不冒充官方 CPU cost model。
7. Window 对命令设置 wall-clock watchdog。超时必须 terminate 整个 Worker、拒绝
   同 generation pending commands、递增 generation、创建新 Worker，并丢弃 stale
   response。它是 count hook 之外的第二层隔离。
8. root execution coroutine 的 HostRequest 使用 out-of-band request state +
   `lua_yieldk()` continuation，payload/response 都是 pointer+length byte string。
   Phase 0E 的 `__p8w_probe_host_request` 只用于验证控制流，不是 PICO-8 public API。
9. guest-created nested coroutine 中的 `flip()` 或 HostRequest 不向 host 发请求；下一
   instruction hook 中断 root，返回 `E_FEATURE_UNSUPPORTED`，details.reason 固定为
   `nested-host-suspend`。L3 `reload/cstore` 在一般 bubbling 完成前只能预供给、同步
   cache 或 unsupported；禁止 Promise/Asyncify 伪装同步。
10. Phase 0E 只注册闭环所需 `cls/pset/btn/time/t/flip` 及继承的最小 memory probe；
    不在本 ADR 接受完整 graphics/audio/input/persistence/loader/player UI。

## Evidence

- ABI machine contract：[`spec/abi/p8w-v1.json`](../../spec/abi/p8w-v1.json)。
- Runtime/Worker contract：[`spec/phase-0e-runtime-contract.json`](../../spec/phase-0e-runtime-contract.json)。
- Node lifecycle、RAM/frame hash、budget、error、HostRequest 与 watchdog tests：
  [`tests/runtime/phase-0e.test.mjs`](../../tests/runtime/phase-0e.test.mjs)。
- 真实 Chrome module Worker 的 60-step 与 hang/terminate/recreate gate：
  [`tests/browser/phase-0e.html`](../../tests/browser/phase-0e.html)。
- 完整交付记录：[Phase 0E 完成证据](../16-phase-0e-evidence.md)。

## Consequences

- RuntimeCore 不依赖 z8lua concrete adapter；composition root 仍是唯一装配点。
- custom-loop startup time offset 有明确、可测试的暂行值，不再是实现者自由选择；
  但 Phase 0 总 exit gate 仍保留官方 binary differential。
- Worker 被 watchdog 杀死后 session state 不恢复；caller 必须重新 `loadCart`。这是
  确定性安全语义，不做不完整 VM snapshot。
- nested async host behavior 是可观测的不支持项，不会产生一次或多次外部副作用。

## Rejected alternatives

- **把 count hook 当作 resumable yield**：会让无限循环跨 frame 永久续跑，且任意
  instruction point 不是安全 continuation boundary。
- **只用 Window watchdog**：不能给正常慢 cart 稳定分类，也无法证明 VM 内限额。
- **只用 VM hook**：不能覆盖 Worker JS stall、WASM trap 或 native parser hang。
- **Asyncify 所有调用**：增加 stack/state complexity，仍不解决 guest coroutine 的
  direct-resumer 所有权。
- **让 RuntimeCore import z8lua adapter**：破坏 package DAG 和可替换/可测试 port。
