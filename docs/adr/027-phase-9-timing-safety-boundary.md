# ADR-027 — Phase 9 timing safety boundary

> 状态：Accepted
>
> 日期：2026-08-10
>
> 决定范围：deterministic transaction safety cap 与 Q16.16 numeric-for termination

## Context

Phase 9A 将 supplemental quick smoke 的 5 个 timing failure 收敛为一个匿名
`timing-instruction-budget-boundary` candidate。仓库外定点测量将其中的合法有限 transaction envelope
定位在约 3.5M–21.7M VM instructions；另一个 case 的有限 Q16.16 numeric `for` 在正上界后回绕，
最终被旧 hard cap 误判成 runaway。旧默认 2M cap 不能区分这些有限工作与真正不 yield 的 callback。

## Decision

1. 默认 transaction safety cap 固定为 `32,000,000` VM instructions。该值为已测有限上界保留约 47%
   headroom，同时继续为 runaway 提供有界 containment；它不是 PICO-8 的 soft CPU 额度。
2. safety cap 只由 deterministic instruction hook 计数。不得按 cart identity、host CPU、wall-clock、
   前序 frame 或运行时采样自适应；Window watchdog 仍是独立的第二层 Worker containment。
3. 超过 4M instructions/s compatibility cost 的有限 callback 仍原子完成并标记 `slowFrame`，不拆成
   implicit frame，不跳 draw，也不改变 logical clock。只有达到 hard cap 才报告
   `E_VM_INSTRUCTION_BUDGET` 并 poison 当前 VM。
4. numeric `for` 的下一 raw Q16.16 index 在 `int64` 中计算。若下一步超出 signed `int32` 表示范围，
   循环结束；实现不得依赖 C++ signed overflow 或回绕后的方向比较。
5. owner regression 必须成对包含 finite-heavy cart 与 explicit runaway cart，并在 fresh Runtime 上证明
   fault 后可恢复。外部验证只运行 5 个受影响 case、每个 120 ticks，不触发 supplemental full sweep。

## Consequences

- 32M 是 Chrome/Chromium desktop 的固定 project safety profile，不是对每个 cart 保证实时完成的预算。
- 重型 callback 在 Runtime Worker 内执行；它可表现为慢帧，但不会把 guest wall-clock 引入决定性结果，
  Window 主线程仍由 watchdog/lifecycle contract 隔离。
- 接近 Q16.16 边界的有限 numeric loop 不再因宿主语言未定义行为退化成 runaway。
- 对 2M 的历史判断只描述旧 phase；当前值由 runtime manifest 和 Phase 9C owner test 机器锁定。

## Verification

- `pnpm run test:phase-9c`
- `pnpm run verify:phase-9`
- 5 个 caller-authorized affected external case 的 120-tick Chrome quick smoke
