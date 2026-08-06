# ADR-019: Phase 5 coroutine compatibility 保持 root-only

状态：Accepted
日期：2026-08-06

## Context

Phase 5F 必须决定 guest-created coroutine 内的 host suspension 是扩大为通用 bubbling，还是
作为 L3 local/multicart project profile 的公开差异继续保持 root-only。ADR-017 已记录底层约束：
z8lua 的 `lua_yieldk()` 只把控制权交还当前 coroutine 的直接 resumer；nested coroutine 的 yield
首先返回 guest `coresume()`，不会自然到达 Runtime root。

本阶段用 pinned z8lua production WASM 建立了 28-case 矩阵：`flip/run/stop/load`、external
`reload/cstore` 与 diagnostic HostRequest，分别覆盖 callback/custom、single/multi-level nesting。
另有 plain guest yield/continuation control、root exact-once request、instruction-budget poison、target
overlay probe 与 fresh-session recovery。Node 和 Chrome production Worker 得到相同结果。

## Decision

1. Phase 5 的结论是 **`accepted-root-only`**。ADR-017 的 host continuation ownership 不扩大，
   不引入 replacement ABI、Promise bridge、Asyncify 或隐式同步等待。
2. root execution coroutine 的 `flip/run/stop/load`、external `reload/cstore` 与 HostRequest 继续使用
   已完成的受控 continuation/transaction；5D/5E 的 callback/custom 行为不变。
3. guest-created single 或 multi-level coroutine 对上述任一 suspension surface 的有效调用统一 poison
   当前 VM transaction，并由 root resume 出口返回：
   `E_FEATURE_UNSUPPORTED` + `details.reason="nested-host-suspend"`。
4. 该 fault 对 guest `pcall()` 和 `coresume()` 不可吞掉；faulted VM 禁止原地恢复，只能加载 fresh
   session。普通 guest-only `yield()` 仍返回直接 `coresume()`，其 continuation 不受影响。
5. nested attempt 不创建 pending request，不调用 host handler/resolver/repository，不写 external COW
   overlay，不发布 replacement handshake、frame、audio、input 或 run/stop control，也不推进 logical
   slices。因为没有 request 被分配，所以不存在 nested late completion 或 cancellation callback。
6. guest-created coroutine 继续继承同一 instruction hook；budget poison 的优先级和不可捕获性不变。
7. project corpus 的 `l3/nested-suspension-policy` lane 按该 profile 的预期结构化 fault 分类为 C3。
   这是 bounded profile compatibility，不宣称与 official nested suspension 行为完全等价。

## Evidence

- Node real-WASM direct-resumer、28-case matrix、side-effect、overlay、budget 与 root regression：
  [`tests/runtime/phase-5f-coroutine-policy.test.mjs`](../../tests/runtime/phase-5f-coroutine-policy.test.mjs)。
- Chrome production Worker 同矩阵、corpus classification 与 fresh recovery：
  [`tests/browser/phase-5f.html`](../../tests/browser/phase-5f.html)。
- 机器结论：
  [`spec/phase-5-l3-multicart-contract.json`](../../spec/phase-5-l3-multicart-contract.json)。
- 原始 ownership 决定：
  [ADR-017](./017-coroutine-frame-slice-and-fault-containment.md)。

## Consequences

- 不需要生产源码或 WASM artifact 变更；5F 只增加可执行证据、机器结论和公开 Known Difference。
- 所有 nested host suspension 使用单一错误语义，避免某些 API 静默运行、另一些产生部分外部副作用。
- 依赖 nested `flip/load/reload/cstore/run/stop` 的 cart 在该 profile 中不可运行；可行 workaround 是把
  suspension 调用移到 root callback 或 root custom loop。
- 将来若要支持 bubbling，必须用替代 ADR 明确拥有完整 resumer chain，并重新证明 exact-once、
  multi-level continuation、request cancellation、budget/OOM 与 Node/Chrome production path；不得在
  普通功能任务中局部放开某一个 surface。

## Rejected alternatives

- **按 surface 局部冒泡**：会产生不可解释的 coroutine 语义分叉，并使 resolver/overlay 副作用难以
  保证 exact-once。
- **把 nested yield 当 root yield**：直接 resumer 仍是 guest `coresume()`，Runtime 无法安全取得完整
  continuation ownership。
- **Promise、busy-wait 或 Asyncify 包装**：不会修复 Lua coroutine ownership，且破坏 Worker
  transaction、budget 或 event-loop 隔离。
- **把 structured fault 改成普通 Lua error**：会被 guest `pcall()` 吞掉，无法保证 transaction
  fail-closed。
