# ADR-030 — `menuitem()` 的 16-character display boundary 不得成为 cart-fatal admission gate

> 状态：Accepted
>
> 日期：2026-08-10
>
> 决定范围：VM-local `menuitem()` label admission 与 fixed snapshot

## Context

PICO-8 v0.2.7 手册规定 `menuitem(index, [label], [callback])` 的 label “should be a string up to 16
characters long”。ADR-021/023 把它错误收紧为超过 16 bytes 就抛出 Lua argument error。Phase 9F 唯一一次
完整 4×50 requalification 因此得到 199 CU、1 个 language failure：一个 caller-authorized official BBS
observation 在初始化时传入更长 label，当前 player 在显示菜单前就使整个 cart fault。

P8 cart source 进入 VM 前已经转换为单字节 P8SCII，因此当前 fixed snapshot 中一个 display character 对应
一个 byte。手册定义的是显示范围，并未要求把超长输入升级为 cart-fatal error；五槽 registry、callback
ownership 和跨 Worker copy codec 仍必须保持有界。

## Decision

1. `menuitem()` 继续要求有效的 `1..5` slot、string label 与 function callback；这些类型错误仍 fail closed。
2. label registration 不因长度超过 16 P8SCII characters 抛错。bridge 在 VM-local registry 中只保留前
   16 bytes 作为 display label，callback 和 filter 同一次原子注册。
3. ADR-023 的 104-byte snapshot codec 不变：每槽仍为 16-byte copy-owned label，TypeScript/Worker/Main
   transport 不获得可变长度或 borrowed pointer。
4. 行为由项目原创 17-character real-WASM fixture 锁定：cart boot、16-character snapshot 与 callback
   invocation 必须全部成功。不得复制第三方代码或按 cart identity 分支。
5. 外部验证只复测 9F 的唯一 affected case、120 logical ticks；禁止第二次 supplemental sweep、长
   playability、historical/soak 或 authority expansion。

## Consequences

- 超长菜单 label 不再阻止 cart 启动；玩家看到稳定的 16-character 前缀。
- registry 与 snapshot 大小、callback GC lifetime、generation isolation 和 DOM boundary 均不改变。
- 这是一项 forgiving admission compatibility，不扩大网络、filesystem、BBS resolver 或 app capability。
- 9F 的 199/200 单环境 aggregate 保持原样；9S 的单 case delta 另行记录，不伪装成新的单提交 200-case
  aggregate。

## Verification

- `pnpm run test:phase-9s`
- `pnpm run test:phase-6e`
- `pnpm run test:wasm:repro`
- 唯一 caller-authorized affected external case 的 120-tick Chrome focused smoke
