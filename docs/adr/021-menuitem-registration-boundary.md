# ADR-021: `menuitem()` 保持 VM-local registration boundary

状态：Partially superseded by ADR-023 and ADR-030
日期：2026-08-07

## Context

PICO-8 v0.2.7 的 `menuitem(index, [label], [callback])` 允许 cart 在暂停菜单的 `1..5` 槽位
注册、替换或移除 callback；label 的显示范围最多 16 characters，index 的 `0xff00` 位还可声明 callback 的
button filter。完整行为同时需要一个 PICO-8 pause-menu UI、焦点/输入路由和在原 Lua generation 中
调用 closure。

当前 web player 已有的 `pause` 是 host lifecycle policy：它停止 scheduler、清理输入并维护
AudioContext/Worker 生命周期。它不是 PICO-8 pause menu，也没有取得或执行 guest Lua function 的
authority。把 Lua registry ref 通过 Worker/Main DTO 传给 TypeScript 会破坏 VM ownership、GC lifetime、
generation isolation 和 structured-clone boundary。

Phase 6 的本地真实卡带发现，有 cart 只在初始化时注册菜单项；缺失 global 会让这些 cart 在使用菜单
之前就启动失败。因此需要支持 official registration surface，同时精确公开 UI/invocation 尚未实现。

## Decision

1. `menuitem()` 由 `p8w_pico8_compat.*` 在当前 `lua_State` 内实现，不新增 host binding、RuntimeCore
   port、Worker/Main transport、DOM capability 或 host pause 状态转换。
2. 每个 VM generation 创建一个 private registry table，固定只有五个槽位。槽位存放原始 byte label、
   Lua callback 强引用和 `0xff00` button filter；任何 Lua function pointer、registry ref 或 closure
   都不得离开 WASM VM。
3. index 必须是整数；其低字节必须为 `1..5`，高字节保留为 button filter。label 必须为 string，callback
   必须为 function。原先“超过 16 bytes 直接报错”的 admission 规则已由 ADR-030 替代。
4. 同 slot 注册会原子替换旧 entry；省略/nil label 或 callback 会移除 entry。旧 callback 在没有其他
   强引用时可由 Lua GC 回收；销毁 VM 会连同整个 registry 一并释放。
5. 当前 profile **不提供** PICO-8 pause-menu UI，也没有 guest/host 路径触发 callback。注册成功不是
   完整菜单兼容；该差异以 `P6-KD-01` 发布。
6. 将来实现 UI/invocation 必须以替代 ADR 定义 versioned menu snapshot、输入/filter 语义、同 generation
   callback dispatch、暂停期间时钟/音频行为、fault containment 和 stale-generation rejection。不得复用
   host lifecycle `pause` 命令或暴露原始 Lua handle。

## Evidence

- Node real-WASM registration、replacement/removal、validation、weak-reference GC 与 20-generation cleanup：
  [`tests/runtime/phase-6e-menuitem.test.mjs`](../../tests/runtime/phase-6e-menuitem.test.mjs)。
- Chrome production Worker/WASM project gate：
  [`tests/compat/run-phase-6e-project-smoke.mjs`](../../tests/compat/run-phase-6e-project-smoke.mjs)。
- 机器结论：
  [`spec/phase-6-real-cart-qualification-contract.json`](../../spec/phase-6-real-cart-qualification-contract.json)。

## Consequences

- 只依赖注册 side effect、从不需要打开菜单的 cart 可以继续启动；真实卡带不再因 missing global fault。
- registry 的容量、callback lifetime 和 generation cleanup 都由 Lua VM/GC 约束，不产生跨边界 handle
  leak 或 stale callback。
- 依赖玩家打开 PICO-8 pause menu、选择条目、接收 button bitfield 或 callback 返回 true 的 cart 仍不
  完整兼容，必须保持 `CU/C0` 直到对应交互被验证，不能仅凭启动成功升级等级。

## Rejected alternatives

- **静默 JS no-op**：会掩盖注册/参数错误，也无法保证 callback lifetime，形成假兼容。
- **把 callback registry ref 放进 Worker DTO**：structured clone 不能表达 Lua closure，并会把 GC 与
  generation authority 泄漏给 TypeScript。
- **把 host pause 按钮当 PICO-8 菜单**：两者的 UI、输入、时钟和 callback 语义不同，会破坏已接受的
  lifecycle policy。
- **在 6E 同时实现完整 DOM 菜单**：真实 corpus 只证明 registration 是启动 blocker；完整交互需要
  独立设计和人工 input oracle，超出本 work unit 的证据范围。
