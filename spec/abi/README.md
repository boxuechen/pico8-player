# WASM ABI

`p8w-v1.json` 是生产 VM ABI（当前 `0x00010004`）；`pico-host-api-v1.json` 定义同步 host call 的 80-byte frame、presence bits、最多 12 个 scalar slots 与一个 byte string。

运行 `pnpm run generate:host-bindings` 生成 TypeScript/C++ bindings；`generated-bindings.manifest.json` 锁定输入和生成物 hash。不要手写或从 TypeScript 反推 ABI。

Q16.16 使用 raw int32；字符串使用 pointer + length，只在同步调用期间借用。Pico RAM 固定 64 KiB，lease 在 VM destroy 后失效。WASM 构建和可复现约束见 [指南](../../wasm/README.md)。

`p8w_log_snapshot` (ABI 0x00010005) copies 66,572 bytes: little-endian u32 codec version (1), count (0–64), last sequence, then 64 fixed 1040-byte records. Each record contains u32 sequence, i32 attempted frame (-1 for boot), u32 byte length (0–1024), u32 truncated flag, and 1024 byte payload. Only count records are occupied; retained payload totals at most 8192 bytes. Reading does not consume entries.
