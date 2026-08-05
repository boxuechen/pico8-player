# ADR-008：由 machine schema 生成同步 Host API bindings

- 状态：Accepted
- 日期：2026-08-06
- 决策范围：z8lua Lua stack wrapper 与 TypeScript `PicoApiHost` dispatch
- 证据：`pnpm run test:phase-1a`、`spec/abi/generated-bindings.manifest.json`

## Context

PICO API 会逐阶段扩张；手工维护 C operation id/arity/result policy 与 TS dispatch 容易产生
签名漂移。但 schema 若提前列出尚未实现的 API，又会制造虚假 public capability。Phase 1A
因此同时需要真实 production slice 和 5–10 个异构签名 prototype 来决定是否生成。

## Decision

接受单向生成：

```text
spec/abi/pico-host-api-v1.json
  -> tools/wasm/generate-host-bindings.mjs
  -> C descriptor header + TS dispatcher + hash manifest
```

- production schema 只包含当前实际注册的 API；未实现 API 不得作为占位 stub 加入。
- capability prototype 独立放在 `pico-host-binding-prototype.json`，`runtimeExposed=false`；
  它当前验证 12 种 arity/optional/scalar/string/result 形状，但不生成 production guest globals。
- schema 只描述薄 ABI：operation id、guest/host name、raw argument presence 和 result kind。
  PICO hardware 语义仍由 RuntimeCore typed `PicoApiHost` 拥有。
- generated files 带 generator header，由 manifest 锁 hash；architecture test 同时审计 TS 与
  C/C++ generated roots。生成方向不可逆转。

## Evidence

真实 `cls/pset/btn` 经过 compiled z8lua/WASM 调用 TS，专项测试覆盖 raw Q16.16、optional
presence、integer/boolean return、host failure、20,002 次 stack-balance/hot-path 调用、
exactly-once binding 和 stale isolation。既有 Phase 0C benchmark 继续作为 boundary baseline。

Phase 2A 在相同生成方向上把 ABI minor 升至 `0x00010002`：schema v2 同时生成 80-byte
call-frame layout、12-slot descriptor 与 TS decoder，capability prototype 覆盖 12 scalar 和一个
byte-string 参数；production Base RAM API 继续使用 dedicated C wrapper，不伪装成 host binding。

Phase 2B 在不改变 frame layout/minor 的前提下加入 descriptor boolean mask 与 raw Q16.16 result
kind。production schema append operation id `10..18`；`pal(table,[p])` 是 bounded C wrapper，最多
展开 16 次同一个 typed operation `13`，不把一般 Lua table 宣称为 ABI capability。

## Consequences

- 新增 binding 必须先更新 production schema、重新生成、实现 typed host 语义并补测试。
- generator 能力不足时先扩 prototype；禁止直接手改 generated wrapper 绕过。
- byte-string argument 的 pointer/length lowering 已由 Phase 2A schema/prototype 与 bounded-view
  tests 覆盖；首次 production consumer 仍须补 guest lifetime/embedded-NUL behavior。byte-string
  result、multi-return 与一般 table lowering 尚未证明，首次需要时必须扩 schema、prototype 和测试。
- `flip()` 等控制流 API 与 direct-memory primitive 不因采用生成器而强制迁移。

## Rejected alternatives

- 永久手工维护 C/TS 两份签名：漂移无法由 typecheck 单独发现。
- 从 TS implementation 反向抽 schema：事实源方向错误，无法独立审计 ABI。
- 预生成完整 PICO API stub：会把目标架构误报成当前兼容能力。
