# Phase 0B 完成证据

日期：2026-08-05

范围：Shared Pico RAM、canonical address mapper、TS zero-copy lease、固定 memory/OOM

ADR：[ADR-013](./adr/013-shared-pico-ram-boundary.md)

## 1. 结论

Phase 0B 已完成。每个 bounded `p8w0b_*` context 拥有连续、16-byte aligned 的
65,536-byte RAM，并把同一 pointer 交给 `lua_setpico8memory()`。z8lua
`@/%/$`、Phase 0B memory probes 与 TypeScript binding 通过同一个项目 owned
mapper 观察同一份 bytes；logical frame 内没有 RAM sync copy。

本阶段没有实现 production `p8w_*` ABI、Cart ROM、完整 memory/graphics API、
cart codec、audio/input/persistence、frame lifecycle、Player UI 或 BBS 行为。

## 2. Ownership 与 ABI 证据

| 项目 | Phase 0B 结果 |
| --- | --- |
| context RAM | `alignas(16) uint8_t[65536]`，pointer 从 create 到 destroy 稳定 |
| ABI | 独立 `p8w0b_*`，version `0x00020000`；`p8w0a_*` 仅回归保留 |
| pointer/size | `_p8w0b_ram_ptr(handle)` / `_p8w0b_ram_size(handle)` |
| VM binding | context 创建时调用 `lua_setpico8memory(state, context->ram)` |
| TS binding | `Phase0BMemoryBinding` 创建 zero-copy `Uint8Array`、`DataView` 和 layout subviews |
| public lease | `PicoMemoryLease` 不暴露 `WebAssembly.Memory` 或 Emscripten module |
| stale safety | generation handle + leaseId + pointer/size/buffer identity assertion |
| phase isolation | `p8w0a_*` / `p8w0b_*` cross-phase handles 受控拒绝，lifecycle/heap counters 分离 |

`reset` 保持 pointer/view identity，清零 64 KiB，再恢复手册记载的 video mapping
默认值 `0x5f54=0x00`、`0x5f55=0x60`。cart-run/reset 保留矩阵需要 Cart ROM 与
Runtime lifecycle，明确留给 Phase 1，不在 Shared RAM 层伪造。

## 3. 地址语义结果

规范依据是 [PICO-8 v0.2.7 User Manual 的 Memory/Remapping 章节](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)；
fake-08/zepto8 只用于候选实现对照。

| Fixture | 结果 |
| --- | --- |
| JS→Lua lower/upper | `0x4300`、`0x8000`、`0xffff` 通过 `@` 与 `peek` 得到相同 byte |
| Lua→JS lower/upper | `poke` 写 `0x4301`、`0x8001`、negative address 后 physical view 同步可见 |
| negative/fraction | `@-1` 与 `@(-0.5)` 归一化到 `0xffff` |
| 16-bit wrap | `%/$/peek2/peek4(0xffff)` 逐 byte 读取 `ffff,0000,0001,0002` |
| `0x7fff` boundary | `%0x7fff` 组合 screen 尾 byte 与 upper RAM `0x8000` |
| remap boundary | `%0x1fff` 组合 remapped GFX 尾 byte 与 unmapped `0x2000` |
| video bases | `0x00/0x60/0x80/0xa0/0xc0/0xe0` 对 GFX/SCREEN 两窗口全部通过 |
| mapper convergence | direct operators、peek/poke、memcpy 与 TS logical read/write 物理地址一致 |

16/32-bit 值显式 little-endian；mapper 对每个 logical byte 重新执行，禁止只翻译
起始地址后连续读取 raw RAM。

## 4. z8lua patch provenance

| 项目 | 值 |
| --- | --- |
| upstream pin | `pico8@8575dfbc524003c869c0aa05e109819302c576f9` |
| ordered patch | `wasm/patches/0002-shared-pico-memory-reader.patch` |
| patch SHA-256 | `d062cbc0ee2af76cbf969cbf4cf727fe9e5a003b3ec0bdcb3640fcb53722cd00` |
| patched inventory | `4d484d095bdd8bd60fa630bf6d95c71bcc7192c24d8e01f231e50666946e5e3d` |
| target/scope | 只修改 `lvm.c` reader，调用 project-owned mapper |
| upstream status | project integration patch；未提交 upstream |

`git apply --check` 已针对精确 upstream checkout 验证 patch 可重放；build 的 source
inventory gate 防止 vendored tree 出现未登记漂移。

## 5. 固定 memory 与 OOM

| Artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `z8lua-phase-0b.mjs` | 8807 | `b161d29cf95a0a1aeb129249197b4832d6ee6b0bf13d5aab73d8b2f38cd07e71` |
| `z8lua-phase-0b.wasm` | 178359 | `697686de9c0b7e85cd4172a82ee9d73fc9c340be042726b131e3b021bf46377b` |

- Wasm binary memory section 为一份 defined memory：`initial=256` pages、
  `maximum=256` pages，即 16,777,216 bytes。
- `wasmMemory.grow(1)` 抛出 `RangeError`；原 `Memory.buffer`、Emscripten `HEAPU8`
  和 Pico views identity 保持不变。
- `ALLOW_MEMORY_GROWTH=0`、`ABORTING_MALLOC=0`；32 MiB host allocation 返回 null，
  不触发 abort。
- 32 KiB Lua heap cap 下的字符串压力返回 `P8W_OUT_OF_MEMORY=6`，lease 仍有效，
  destroy 后 tracked Lua bytes 回到零。
- 64 个同时 context 的 RAM pointer 全部唯一；达到 slot 上限后 create 受控失败，
  全部 destroy 后 live contexts/Lua bytes 均为零。

16 MiB linear memory 与默认 1 MiB Lua cap 是 Phase 0B artifact 参数。代表 cart
corpus 的最终 production sizing 仍需后续数据，不以本次恶意压力替代。

## 6. 自动验证

```text
pnpm run test:wasm
pnpm run test:wasm:repro
node tools/wasm/verify-manifest.mjs
pnpm run verify
```

- Phase 0A regression：14/14 passed。
- Phase 0B Shared RAM：9/9 passed。
- TypeScript public adapter、architecture gates、artifact reproducibility 和 manifest
  在统一 `verify` 中执行。

## 7. 未覆盖与下一阶段

- 没有正版 PICO-8 executable/capture；已实现规则来自 v0.2.7 官方手册的明确
  Memory/remapping 描述。invalid mapping register 的 fallback 只是防御策略，兼容
  状态保持 unknown。
- 完整 cart-run/reset RAM matrix 移到 Phase 1，由 Cart ROM/Runtime lifecycle 和
  获准的 official golden 共同验证。
- Phase 0C 才测 1K/16K/64K interop、`pset/peek/poke/spr` 的浏览器 p50/p95/p99；
  本阶段没有性能结论。
- 浏览器三引擎、graphics/audio/input/persistence/frame lifecycle 与 Player 均未覆盖。
