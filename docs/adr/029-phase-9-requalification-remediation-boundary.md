# ADR-029 — Phase 9 requalification remediation boundary

> 状态：Accepted
>
> 日期：2026-08-10
>
> 决定范围：`camera()` previous-state return、absent-value `all()` 与 supplemental multicart composition

## Context

Phase 9F 的第一次 supplemental requalification attempt 在 175 个 case 后停止，并把 4 个新 failure
收敛为两个 language root cause 和一个 local composition gap。companion cart 成功解析后又暴露 bounded
large-`chr()` root cause。两个 graphics-heavy case 都先以无参数
`camera()` 读取并 reset 当前坐标；另一个 case 的 trailing empty split 最终把零返回值传给 `all()`。
host case 则明确属于 multi-cart，需要 caller 提供 companion cart。

PICO-8 v0.2.7 手册定义了 `camera([x,y])` 的 set/reset、`split()` 保留 empty element、运行中
`load(filename)` 切换 cartridge 的行为。caller-authorized official BBS observations 进一步表明
`camera()` 返回调用前的 signed coordinate pair，且 absent-value iteration 必须像 nil 一样为空；第三方
身份、bytes、路径和逐-case observation 按仓库策略只保留在仓库外。

## Decision

1. `camera([x,y])` 继续由 generated host binding 独占 draw-state RAM mutation；VM-local wrapper 在调用前
   读取 `0x5f28/0x5f2a` 的 signed 16-bit 值，host mutation 成功后返回旧 x/y。`camera()` reset 到 `0,0`
   并同样返回旧值。
2. `all()` 对 absent argument 使用与 explicit nil 相同的 empty iterator。table、string、deletion 与
   invalid non-nil type 行为不变。
3. `chr()` 接受至多 8,192 个 byte-coerced value，与既有 `peek()` memory-vector 上限一致；结果按显式
   byte length 构造，保留 embedded NUL。超过边界时 fail closed，不静默截断。
4. 三个 language root cause 分别由项目原创 real-WASM fixture 锁定；不得复制第三方代码或按 cart
   identity 分支。
5. multi-cart dependency 只通过仓库外 caller-authorized local bundle 注入，并显式要求 `access.load`。
   Runtime 不发现 BBS dependency、不访问任意 URL/filesystem，也不推断 capability。
6. 9R 只聚焦复测 4 个 affected case；不运行 supplemental full sweep、long playability、historical 或
   soak。全部 CU 后才恢复 9F。

## Consequences

- graphics RAM ownership 与 RuntimeCore/browser boundary 不变；只补齐同步 Lua return contract。
- absent value 不再被 `luaL_checktype` 误判为 invalid table，explicit invalid non-nil value 仍 fail closed。
- local multicart composition 继续由 embed caller 负责；player 没有新增网络或 host-filesystem authority。
- 失败的 9F attempt 与后续完整 requalification 分开计数，不伪装成一次绿色运行。

## Verification

- `pnpm run test:phase-9r`
- `pnpm run test:wasm:repro`
- 4 个 caller-authorized affected external case 的 120-tick Chrome focused smoke
