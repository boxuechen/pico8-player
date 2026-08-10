# ADR-024：PICO-8 v0.2.7 cart version 与受权 text include

- 状态：Accepted（Phase 8D）
- 日期：2026-08-08
- 取代：ADR-005 中“v0.2.7 最高 cart version 为 42”的单一事实；其余决策不变
- 机器契约：[`spec/cart-codec-contract.json`](../../spec/cart-codec-contract.json)

## 决策

当前 v0.2.7 target 接受 cart version `0..43`，`44+` 仍以
`E_CART_FUTURE_VERSION` fail closed。version 42 继续合法，但不再是当前 target 的上限。

text `.p8` 的 `#include` 由 codec 的同步、非递归 resolver 处理。resolver 只接收 cart
中声明的 opaque specifier，并返回 caller 已授权的 plaintext Lua bytes；codec 不发现
文件、不访问 URL/filesystem，也不从 specifier 推导 authority。未提供 resolver、条目
不存在或 capability 被拒绝时统一返回 `E_CART_INCLUDE_UNRESOLVED`。

Web Player 只从当前 `loadCart` command 携带的 Worker-local bundle 解析 include，且条目
必须显式授予 `include` capability。外部 qualification tooling 可以把 caller 已授权的
本地依赖显式写入仓库外 manifest；production、CI、release artifact 与 tracked fixture
不依赖 `ref/` 或第三方 cart。

## 文本资源段兼容

`gfx`、`gff`、`map` 的十六进制内容按 section 内连续 byte stream 解码。单行可以比标准
导出宽度短，但必须为偶数、合法 hex、不得超过标准单行宽度，section 总 byte 数不得超过
其 ROM 容量。这样保留边界检查，同时接受合法工具链产生的 compact rows。

形如 `__meta:cart_info_start__` 的可识别未知 marker 仍遵循既有
`W_CART_UNKNOWN_SECTION` 规则：从该 marker 到下一个已知/未知 marker 的内容全部忽略，
绝不能回落为前一个资源段的数据。

## 依据与边界

官方 v0.2.7 release 与当前 v43 export/fixture 共同校正 version 上限；官方手册定义 include
相对当前 cart、非递归，并说明导出 `.p8.png` 时会 flatten。独立实现只用于交叉检查文本
资源段的连续 stream 行为，没有复制或导入其源码。

该决策不增加网络、BBS、任意 URL 或 host-filesystem resolver，不支持递归 include，也不
把 filename、cart identity 或第三方内容写进 Runtime 分支。
