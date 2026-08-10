# Phase 12 — `pal(table)` compatibility 完成证据

> 状态：Complete
>
> 兼容范围：Chrome/Chromium-only PICO-8 v0.2.7 player
>
> 第三方内容：tracked bytes / screenshots / per-cart results 均为 0

## 完成结论

`pal(table[, p])` 的 dedicated WASM wrapper 现在只向 host dispatch numeric entry，并忽略
1..16 中的非数值 entry。数值字符串仍遵循 Lua numeric coercion。因此
`pal(split(""))` 保持 palette 不变并继续执行，不再转为 `E_VM_RUNTIME`。ABI、
host operation inventory、RuntimeCore palette ownership 和 gallery authority 未改变。

## Bounded verification

| Gate | 结果 |
| --- | --- |
| Activation contract | 2/2 |
| Focused real-WASM regression | 1/1；inline project-owned source |
| Existing palette owner tests | 5/5 |
| Focused Node total | 8/8 |
| Runtime manifest / release verifier | pass / 15 files + 6 stable keys |
| Deterministic release package | 16 files；SHA-256 `6e1b6809bf4e0d4f3c5d950b45974ba0876cca1f9371c90367e51b6061f96a61` |
| Focused Chrome | 1 run；target cart loaded and remained Running |
| Caller-authorized targeted diagnostic | 129 logical ticks；0 VM faults |
| External corpus automated runs | 0 |
| Historical matrix / long soak | 0 / 0 |

定向诊断只读取调用者明确指定的本地 cart，结果不作为 corpus 兼容率。原始 cart、
标题、路径、hash、frame 和截图都没有进入仓库或 evidence。WASM runtime artifact
仍为 197591 bytes，新 SHA-256 为
`c36199f46a906e37cc26db1aeac0fd34698737d902a7d9dcb4ed2303059e8253`。
