# C/C++ bridge

- `p8w_frame_runtime.*`：生产 `p8w_*` ABI、VM 生命周期、callback/custom-loop、host suspension、指令与内存上限。
- `p8w_pico_memory.*`：Pico RAM 的统一逻辑地址映射；Lua 内存操作与 TypeScript adapter 使用同一映射。
- `p8w_pico8_compat.*`：VM-local table/string/random helpers；Lua table/function 不穿过 ABI。
- `generated/`：由 `spec/abi/pico-host-api-v1.json` 生成的 host descriptors。

Graphics/audio/input/session 状态由 TypeScript RuntimeCore 拥有。ABI 见 [spec/abi](../../spec/abi/README.md)，来源与构建见 [WASM 指南](../README.md)。
