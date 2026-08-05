# ADR-013：Shared Pico RAM 边界与固定 WASM memory

状态：Accepted

日期：2026-08-05

适用范围：Phase 0B bounded spike；production `p8w_*` lifecycle 仍由后续阶段决定

## Context

PICO-8 Base RAM 是一个 64 KiB 地址空间。z8lua 的 `@/%/$`、TypeScript hardware、
未来 graphics 和 memory API 必须观察同一份 bytes。Pinned z8lua 虽然提供
`lua_setpico8memory()`，但其 reader 只接受 lower 32 KiB，并在 multi-byte 读取前
把地址硬截为 `0x7fff`。这不能覆盖 upper RAM、16-bit wrap 或官方手册记载的
GFX/SCREEN 低层 remap。

同时，任何 WASM memory growth 都可能替换 `ArrayBuffer` 并使现有 typed views
失效。普通 cart Lua heap OOM 也必须变成可分类状态，不能依赖 Emscripten abort。

## Decision

1. 每个 Phase 0B context 内嵌一块 `alignas(16)`、连续 65,536-byte RAM。context
   拥有 allocation/pointer 生命周期；后续 RuntimeCore 通过 runtime-neutral
   `PicoMemoryLease` 获得语义所有权，不获得 `WebAssembly.Memory` 或 Emscripten
   module。
2. `create -> destroy` 期间 RAM pointer 和 size 稳定；`reset` 只修改 bytes，不换
   pointer。新 context/reset 的 Phase 0B 初态是全零，再设置 `0x5f54=0x00`、
   `0x5f55=0x60`。cart-run/reset 保留矩阵不属于本 ADR。
3. 唯一 logical→physical address mapper 位于项目 owned 的
   `wasm/bridge/p8w_pico_memory.*`：

   - 所有 logical address 先归一化为 16 bit；
   - `0x0000..0x1fff` 使用 `0x5f54`，`0x6000..0x7fff` 使用 `0x5f55`；
   - 接受手册列出的 `0x00/0x60/0x80/0xa0/0xc0/0xe0` video bases；
   - 非法 base 防御性回退到对应默认 base，这一非法输入行为不升级为官方兼容承诺；
   - 16/32-bit 访问逐 logical byte 重新 map，并在每个 byte 后 16-bit wrap。

4. Ordered patch 0002 只修改 z8lua `lvm.c`，使 `@/%/$` 调用上述 mapper；不在
   z8lua 内复制 remap 表。Phase 0B 的最小 `peek/peek2/peek4`、
   `poke/poke2/poke4`、`memcpy` probe 和 TS binding 也调用同一 mapper。它们是
   conformance probe，不代表完整 PICO host API 已实现。
5. Phase 0B 使用独立 `p8w0b_*` bounded ABI。`p8w0a_*` 只保留为 0A regression，
   两者都不是 Proposed production `p8w_*` ABI。
6. TypeScript 的 `Phase0BMemoryBinding` 只在 adapter 内创建零复制
   `Uint8Array`/`DataView` 和布局 subviews；向外的稳定契约是
   `PicoMemoryLease {buffer, byteOffset, byteLength: 65536, leaseId}`。每次 logical
   access/lease assertion 都检查 canonical WASM mapper、pointer、size 和 buffer
   identity；不实现 view rebuild。
7. Artifact 固定为 16 MiB，即 WebAssembly memory descriptor 的
   `initial=maximum=256` pages；growth 关闭。Phase 0B 默认 Lua heap cap 为 1 MiB，
   测试可显式下调到 32 KiB。allocator 拒绝分配时返回 `P8W_OUT_OF_MEMORY`；
   `ABORTING_MALLOC=0`，普通压力不得变成 host abort。
8. 未来 graphics、host memory API 或优化路径禁止维护第二份 remap 规则。若要把
   mapper 下沉、批量化或改变 invalid-base 行为，必须先更新本 ADR 和同一组
   direct/API/TS conformance。

## Evidence

- [Phase 0B 完成证据](../13-phase-0b-evidence.md)
- `tests/wasm/phase-0b.test.mjs`
- `wasm/patches/0002-shared-pico-memory-reader.patch`
- `wasm/manifest.lock.json`
- PICO-8 v0.2.7 手册的 Memory、Memory Access 与 GFX/SCREEN remapping 章节

## Consequences

- z8lua 和 JS 不再需要逐帧复制 RAM，upper RAM 与 remapped video windows 共享
  同一物理 bytes。
- `DataView` 只适合 physical layout；跨 wrap/remap 的 logical multi-byte 操作必须
  逐 byte 调 canonical mapper，不能直接对 view 做连续读取。
- context 的 C++ allocation 包含 64 KiB RAM；多 context 压力必须持续作为固定
  memory capacity gate。
- 16 MiB/1 MiB 是 Phase 0B artifact 的锁定参数，不自动成为代表 cart corpus 的
  最终 production sizing 结论。
- 完整 cold boot/cart run/reset matrix、Cart ROM load、graphics/audio/input、frame
  lifecycle 和 Player UI 均未由本 ADR 实现或宣称兼容。

## Rejected alternatives

- 在 TypeScript 与 z8lua 各维护一份 mapper：容易让 direct operators 与 host API
  产生两套语义。
- 每帧同步复制 64 KiB：没有必要，且隐藏 ownership 错误。
- 只修 `& 0xffff` 后连续读 raw pointer：无法处理 multi-byte 跨 remap/wrap。
- 开启 memory growth 后重建 views：破坏 v1 lease 的稳定性保证。
- 直接扩张 `p8w0a_*`：会把语言 baseline spike 误当 production ABI 演进。
