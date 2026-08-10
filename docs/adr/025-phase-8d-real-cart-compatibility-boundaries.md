# ADR-025：Phase 8D real-cart 兼容修复边界

- 状态：Accepted（Phase 8D）
- 日期：2026-08-08
- 部分取代：ADR-022 的默认 hard safety cap 数值；其余 CPU slicing 决策不变

## Context

Phase 8C 的 100-case Chrome fixed-tick 基线产生 48 个 C0，集中为 parse、language 和 timing。
逐项归因表明，大部分结果来自少量可复用语义缺口；另有交互等待、自测预期 fault 和同步 RAM
热点，不能用扩大 watchdog、忽略错误或识别 cart identity 处理。

## Decision

1. z8lua patch 只实现经项目原创最小复现锁定的 PICO-8 语言差异：long comment 后 short-if、
   single-name local compound initialization、函数实参空位和替换 `_ENV` 后的原始环境 fallback。
2. root `flip()` 继续保持既有 custom-loop 语义；在 `_init/_update/_update60/_draw` 中调用时，保存并在
   后续 frame 恢复当前 callback。guest-created coroutine 的 nested suspension 限制不变。
3. audio sample clock 使用统一 60 Hz 基准累计样本；运行中 `_update60` 出现或消失不能重置时钟。
4. 默认 transaction hard safety cap 从 1M 调整为 2M instructions；4M instructions/s soft CPU
   口径、133,333 top-level implicit quantum、budget poison 和 Window watchdog 均不改变。
5. `printh` 只保留 `tostr` 转换并写入有界 null diagnostic sink，不授予文件、clipboard 或 desktop
   权限。`cursor` 的 RAM mutation 仍走 host binding，VM wrapper 返回修改前的 `(x,y)`。
6. RuntimeCore 的 logical RAM fill 只有在范围不跨 16-bit wrap、不覆盖 mapping registers、且映射后的
   首尾连续时才使用一次 `TypedArray.fill`；否则保持逐地址 canonical mapper 路径。
7. qualification 可在仓库外 manifest 为开发者 self-test 显式声明预期 fault code 和人工 basis；只有
   exact match 才记为 CU。observation 仍保留 `fails`、fault 与 matched 标志，production Runtime 不读取
   此元数据。

## Evidence

- 项目原创 parser、VM、callback、audio、API、RAM fill 和 Worker include regressions：
  [`tests/runtime/phase-8d-real-cart-gaps.test.mjs`](../../tests/runtime/phase-8d-real-cart-gaps.test.mjs)。
- qualification schema、fail-closed validation 与 aggregate-only candidate：
  [`tests/compat/phase-6b-corpus-runner.test.mjs`](../../tests/compat/phase-6b-corpus-runner.test.mjs)、
  [`tests/compat/phase-8b-expanded-corpus.test.mjs`](../../tests/compat/phase-8b-expanded-corpus.test.mjs) 和
  [`spec/phase-8-expanded-real-cart-qualification-contract.json`](../../spec/phase-8-expanded-real-cart-qualification-contract.json)。
- Chrome 151 本地复跑在同一最终 WASM hash 下得到 100 CU；第三方 bytes、路径、逐-cart observation 和
  screenshots 均保留在仓库外。

## Consequences

- 修复按 parser/VM/Runtime/qualification 边界分层，没有 cart identity、第三方源码或 `ref/` 依赖。
- CU 只表示本轮未完成 C2；预期 fault 不会被计为 boot，也不会进入公开兼容率。
- 连续 fill 优化解决高频 `cls()` 的 watchdog false negative，同时保留 video remap 正确性。
- 8D 必须在独立提交和完整 verify 后才能关闭并激活 8E。

## Rejected alternatives

- **提高或关闭 Window watchdog**：掩盖同步 host 热点，也削弱 Worker hang containment。
- **把 callback hard cap 改成可恢复 frame yield**：会破坏 callback transaction 原子性。
- **按 cart 名称跳过、自动按失败记 CU**：不可审计且会隐藏真实回归。
- **给 codec 文件系统或 URL 权限**：破坏 caller-authorized composition boundary。
