# ADR-026 — Phase 9 language compatibility boundary

> 状态：Accepted
>
> 日期：2026-08-10
>
> 决定范围：P8 Lua parser/VM compatibility、同步 host 参数、固定 Lua heap 与无 authority 的 player helper

## Context

Phase 9A 将 supplemental quick smoke 的 45 个 language failure 收敛为 13 个匿名共享根因。项目自有
real-WASM 最小复现确认这些根因横跨 parser shorthand、VM environment、库表面、host value lowering、
variadic memory API、persistence 边界和有限 Lua heap。它们不是 cart identity 问题，也不能通过导入
第三方实现、放宽宿主权限或按 cart 自适应资源来修复。

## Decision

1. P8 Lua parser 支持 `if <expr> do ... end`、`return ?...` 与单 token binary `~`。局部 `_ENV`
   参数和 upvalue 都按当前 lexical environment 解析；这些规则在 pinned z8lua patch 中维护并由原创
   `.p8` fixture 锁定。
2. VM-local compatibility surface 增加 `inext`、`pack`、`mapdraw`、string `all()`、`_set_fps`
   和 PICO hexadecimal string `rnd()`。`_set_fps` 是 deterministic no-op；callback discovery 仍是
   scheduler 的唯一帧率 authority。
3. `extcmd()` 只接受最多 256-byte command 并返回到 bounded null sink。它不获得进程、录制、窗口、
   clipboard、网络或 filesystem authority。需要真正 host side effect 的 mode 仍不受支持。
4. PICO host numeric parameters 使用 Lua number coercion；`print()` 的首值使用 `tostr()`；无参数
   `btnp()` 返回 player 0/1 的 edge/repeat mask。`stat()` 按 selector 返回 number/string/boolean/nil，
   而不是把所有未单独处理的结果压成 boolean。
5. `dget/dset` 的无效 slot 分别返回 `0` / no-op。`poke()` 无 value 时 no-op，nil value 写 `0`；
   `peek()` multi-return 保持最多 8,192 项，`poke()` finite varargs 上限为完整 65,536-byte Pico RAM，
   并在写前验证 arity。
6. production 继续使用固定 16 MiB WASM memory、禁止 growth；默认 Lua heap 从 1 MiB 调整为固定
   2 MiB，不按 cart 或宿主压力自适应。thread/bootstrap allocation 必须在 protected Lua boundary 内
   将 allocator rejection 转成 structured OOM；64 KiB diagnostic workload 锁定此路径。
7. 语言修复后才暴露的外部 `load()` 缺口重新归入 9D。9B 不改变 caller-authorized local repository、
   URL、BBS 或 host-filesystem 边界。
8. 9F requalification 后补充的 `camera()` previous-state return 与 absent-value `all()` 由
   [ADR-029](./029-phase-9-requalification-remediation-boundary.md) 单独锁定，不回写为 9B 原始测量。

## Consequences

- 13 个语言 candidate 分别由项目原创 real-WASM regression 覆盖；production cart-specific branch 为 0。
- 旧的 1 MiB resource 结论只保留为历史 evidence；当前发布 profile 以 runtime manifest 的 2 MiB
  fixed cap 为准。
- 新增 helper 是 VM-local compatibility，不穿越 RuntimeCore/browser adapter 边界。
- `extcmd` 的安全 no-op profile 与真实 host command side effect 必须在 API inventory 中保持区分。

## Verification

- `pnpm run test:phase-9b`
- `pnpm run verify:phase-9`
- 最多 10 个 caller-authorized external representative case 的 120-tick Chrome quick smoke
