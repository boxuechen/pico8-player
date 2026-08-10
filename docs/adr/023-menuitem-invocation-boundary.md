# ADR-023: `menuitem()` snapshot 与同 generation invocation boundary

状态：Partially superseded by ADR-030（只涉及 label admission），替代 ADR-021 第 5、6 条
日期：2026-08-07

## Context

ADR-021 已把五槽 `menuitem()` registry、label byte string、button filter 和 Lua callback 强引用放在
当前 z8lua VM 内，并明确 Phase 6 只有 registration、没有 pause-menu UI 或 callback invocation。
Phase 7E 需要完成 cart-defined pause menu，但不能把 closure、registry ref、Lua stack address 或 WASM
borrowed pointer 暴露给 TypeScript。

PICO-8 v0.2.7 的 required behavior 是：slot 为 `1..5`，copy-out display label 最多 16 P8SCII characters；选中条目时 callback
接收 L/R/X press bitfield；`index & 0xff00` 可屏蔽对应触发；callback 只有返回 boolean `true` 才保持
菜单打开，其他正常返回关闭菜单；callback 内可更新、增加或删除条目。Web player 原有 `pause` 是 host
lifecycle pause，不能承担这些 guest-menu 语义。

## Decision

### 1. VM ownership 与 production ABI

Lua VM 继续独占 registry 与 callback。production ABI 升版并只增加两个 operation：

- `p8w_menu_snapshot(handle, destination, capacity)`：只在 VM 位于 completed frame boundary 且没有
  pending host request 时成功，把当前五槽 registry 复制到 caller-owned buffer。
- `p8w_menu_invoke(handle, slot, button_mask, instruction_budget)`：只在同一 root-safe boundary 调用
  一个仍存在、且 filter 允许该 intent 的 callback。

snapshot 使用固定 `P8W_MENU_SNAPSHOT_BYTES` 字节的 versioned little-endian record：4-byte header
`[codecVersion, slotCount, recordBytes, reserved]`，随后五个 20-byte slot record
`[occupied, labelLength, filterLo, filterHi, label[16]]`。空槽的 length/filter/label 全为零。ABI 不返回
snapshot pointer；TypeScript 必须先分配自己的 WASM buffer，调用后立即 copy-out，再释放 buffer。

invoke 的 transport-level outcome 不借用 C pointer。C status 只表达 `OK` 或既有 structured fault；成功时
`p8w_menu_outcome(handle)` 返回 `close`、`keep-open` 或 `removed` enum。无槽、非法 slot/button、被 filter
屏蔽、非 boundary 状态一律返回 `INVALID_STATE`/`BAD_ARGUMENT`，且不得运行 callback。

### 2. Button/filter 与 callback return

menu intent 固定为 `Left=1`、`Right=2`、`X=4`，一次 invoke 必须恰有一个 bit。slot 的高字节 filter
按 `(filter >> 8) & buttonMask` 判断；命中即 fail closed。DOM 的 ArrowLeft/ArrowRight 分别产生 1/2，
Enter、Space、pointer 和 touch activation 产生 4。ArrowUp/ArrowDown 只移动 DOM focus，不调用 guest。

callback 用一个 P8 number 参数在 Runtime-owned Lua root 调用。精确 boolean `true` 对应 `keep-open`；
nil、false 或其他正常返回对应 `close`。如果 callback 在调用期间移除自身，成功 outcome 为 `removed`
并关闭；replace/add/remove 其他条目是合法的。任何 keep-open 成功后都重新 snapshot，DOM 不局部推断
registry 内容。

### 3. Root safety、budget 与 fault containment

invoke 仅允许 callback/custom loop 的 completed frame boundary：`Context.active == nullptr`、
`active_kind == None`、state 为 callback/custom loop、没有 pending request。它不得从 guest coroutine、
boot/init/update/draw、waiting-host、faulted 或 stopped 状态执行。

callback 使用独立 Lua thread 和 registry strong ref，在 `lua_pcall`/resume root 上受与 frame transaction 相同
的 instruction hook、Lua heap limit、host error 和 nested-host-suspend containment。调用开始时重置本次
instruction accounting，phase 记为 `menuitem`。budget、OOM、runtime error、unsupported nested suspend 或
host failure 都把 VM 置为 faulted，释放 active reference，关闭 menu，并作为现有 structured VM fault
上送；Main 不重试 callback。callback 正常返回后 phase 回到 `none`，simulation clock/frame id 不前进，
也不发布 frame/audio transaction。

### 4. Runtime、generation 与 pause authority

RuntimeCore port 只公开 copy-owned `MenuSnapshot` 与 `MenuInvocationOutcome`。`CartSession` 校验当前
generation，并且只允许 ready generation snapshot/invoke；runtime fault 走现有 session fault path。

Runtime Worker 独占 `menuOpen` 状态：

1. `openPauseMenu` 只接受 running session，在已完成的 frame transaction 后暂停 scheduler、清 gameplay
   input/audio queue，取得 snapshot，并原子发布 generation-bound `pause-menu` event。
2. `invokeMenuItem` 只接受同 worker/session generation、menu 已打开且 snapshot 中允许的 slot/intent；
   每个 request exactly-once。keep-open 返回刷新后的完整 snapshot；close/removed 关闭 menu。
3. `closePauseMenu`（Continue/Escape）不调用 guest，关闭 menu 并恢复同 generation 的 running session。

Host lifecycle `pause` 与 menu pause 是不同状态。host pause 可在 menu 打开时关闭 menu并进入普通 paused；
普通 `resume` 只恢复 host pause，不重开 guest menu。reset、cart replacement、run/stop、fault、visibility/
pagehide、Worker termination 和 dispose 都同步清空 menu authority。旧 generation 的 snapshot/outcome 必须
由 Worker 和 Main 双重拒绝，不能重开 DOM、调用 callback、恢复 scheduler 或发布 stale audio/frame。

### 5. DOM boundary

Window 只渲染最新 generation-bound copy DTO。pause menu 是 Canvas 外的 named modal dialog，含 Continue
和最多五个 occupied items；提供 bounded roving focus、Escape、Enter/Space、方向键以及 pointer/touch，
所有 target 至少 44 CSS px。打开时 gameplay keyboard/touch/gamepad 与 rAF pulse 都停用，AudioContext
按现有 pause policy suspend；关闭时清 input edge、把 focus 返回 playfield，并由 Worker 同 generation
恢复 simulation。DOM 永不保存 callback identity，也不成为 menu-open 或 simulation 的 source of truth。

## Consequences

- `menuitem()` callback lifetime、GC 与调用栈仍完全由 VM generation 管理；跨 structured-clone 边界的
  数据固定、有限且 copy-owned。
- callback 可以安全地更新自身菜单；UI 每次依据 VM 的新快照重建，不会和 registry 漂移。
- menu callback 不推进 guest clock，且不能与 frame/host request transaction 并发；可重放与 generation
  isolation 保持成立。
- 支持范围只包含 Continue 与 cart-defined entries，不实现 console settings、reset prompt、remap 或完整
  PICO-8 system menu。

## Evidence

- real-WASM Node：[`phase-7e-menuitem-invocation.test.mjs`](../../tests/runtime/phase-7e-menuitem-invocation.test.mjs)
  覆盖 copy ownership、slot/label/filter/argument/return、replace/remove、instruction budget、fault、
  custom-loop boundary 与 20-generation 零泄漏。
- Runtime/transport：[`phase-7e-menu-runtime.test.mjs`](../../tests/runtime/phase-7e-menu-runtime.test.mjs)
  覆盖 operation allowlist、exactly-once、menu/host pause 分离、generation/reset/stale/fault、watchdog
  recovery 与 dispose fail closed。
- Chrome release artifact：[`run-phase-7e.mjs`](../../tools/browser/run-phase-7e.mjs) 覆盖 keyboard/pointer/
  touch、P8SCII label、focus、keep-open refresh、audio/simulation pause、blur、fault recovery 与 cart
  replacement cleanup。

上述证据关闭 ADR-021 的历史 `P6-KD-01`；PICO-8 system settings/full console menu 仍是 player 产品范围
排除，不是 `menuitem()` API 的残留差异。

## Rejected alternatives

- **把 registry ref 或 callback handle 放进 DTO**：会泄漏 Lua GC/lifetime，并允许 stale generation 调用。
- **在 Main 直接调用 WASM**：破坏 Worker 的 simulation 与 generation authority。
- **复用 host `pause`/`resume`**：无法表达 callback/filter/keep-open，且会混淆 embed lifecycle。
- **让 DOM 缓存并局部修改 slots**：callback 可重写 registry，host 推断会产生错误或 stale 菜单。
- **在任意 Lua yield point invoke**：会形成 nested coroutine/host suspension 和不可恢复的 stack ownership。
