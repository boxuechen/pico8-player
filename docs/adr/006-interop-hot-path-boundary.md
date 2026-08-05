# ADR-006：以可解释基准决定 JS↔WASM hot-path 边界

- 状态：Accepted（Phase 0C；跨浏览器 portability condition 仍开放）
- 日期：2026-08-05
- 决策范围：z8lua WASM 与 TypeScript Runtime 之间的调用/Shared RAM 边界
- 证据：[Phase 0C 完成证据](../14-phase-0c-evidence.md)

## 1. 决策

后续 production bridge 以 raw primitive 与 pointer + byte-length 为默认 ABI
形状；禁止在逐 API hot path 中传 JS object、JSON、Unicode string 或隐式 table
转换。Pico RAM 继续由 WASM context 持有，TS 通过 Phase 0B lease 零复制访问，并且
只使用 canonical address mapper。

Phase 0C 在实际 Google Chrome 150 / Apple M4 Pro 上给出以下结论：

1. **Go：** z8lua WASM→JS primitive import 可作为 production host binding 的
   初始候选。16K `pset`、65,536 组 `peek_poke` 和 4,096 个 8×8 `spr` 的
   p95 分别为 0.090 ms、0.599 ms、0.442 ms，没有触发局部下沉。
2. **Go：** raw Q16.16 保持 `int32` bits；byte string 使用稳定 WASM buffer 的
   pointer + length，不做逐调用编码或 copy。
3. **保持 hybrid：** Shared RAM 是状态一致性与 coarse hardware access 的边界，
   不是“所有 pixel loop 都应写成 JS”的结论。Chrome 中 JS pixel/sprite loop
   并不总是最快，具体 block operation 仍按 profile 选择所在侧。
4. **No-Go：** `p8w0c_bench_*` 不能升级或改名为 production ABI。它只包含为
   microbenchmark 设计的合成 probe，没有 cart/frame/error/host schema 语义。
5. **No-Go：** 当前数据不能宣称三浏览器或 Tier A 性能完成。Firefox 在 runner
   上不可用，Safari 已安装但 Remote Automation 未启用；两者必须使用同一
   DedicatedWorker harness 实测后，才能关闭 portability condition。
6. **No-Go：** 没有证据支持 full-core WASM。只有 fallback ladder 前六级均有
   profile 证据仍不能满足预算时，才能另立 ADR 评估。

这是一项 interop boundary 决策，不是代表 cart 的 8 ms core-tick 验收。完整
VM、graphics、audio 与 scheduler 尚未存在，ordinary 30/60 Hz cart 预算继续作为
后续 Runtime 发布门禁。

## 2. Benchmark contract

四条路径使用相同 LCG 输入、FNV-1a output checksum 与完整 64 KiB RAM hash：

| 路径 | 每个 logical operation 的边界 |
| --- | --- |
| `js_to_wasm_export` | JS 调一次 exported WASM function |
| `wasm_to_js_import` | WASM loop 调一次 primitive JS import，再回 WASM |
| `wasm_control` | loop 与 operation 都留在 WASM，不跨边界 |
| `js_shared_memory` | setup 时用 canonical mapper 解析 window，此后直接访问 shared RAM |

production `-O2` artifact 固定为 16 MiB、禁止 growth。每项 100 次 warmup，30
个样本；单个样本内部放大到目标 100 ms，再换算为 logical frame 时间。统计使用
R-7 quantile，报告 p50/p95/p99、calls/s 与 ns/call。任何 timing 前，四条路径的
checksum/RAM hash 必须一致，buffer identity 必须稳定。

## 3. Fallback ladder 结论

| 级别 | Phase 0C 结论 |
| --- | --- |
| 1. 去 boundary allocation/object conversion | ABI/harness 结构上已应用；Chrome DedicatedWorker 不暴露 `performance.memory`，allocation 数值仍标记 unavailable，后续 Runtime profile 不得据此豁免 |
| 2. raw numeric/string buffer | 已选择并实测；raw `int32` 与 pointer + length 是 production schema 的约束 |
| 3. 批量只读输出 | 本阶段没有 framebuffer/audio transport，`not-applicable`；在 renderer/audio 阶段单独测 |
| 4. memory/pixel primitive 下沉 | pure-WASM control 已测；Chrome 的 import 路径未超预算，当前不下沉 |
| 5. block operation 下沉 | `spr_8x8` control 已测；4K import p95 未超预算，当前不下沉 |
| 6. audio inner loop 下沉 | Phase 0C 无 audio，`not-applicable`；Phase 0F 依据 PCM profile 决定 |
| 7. full-core WASM | Rejected for now；没有阻塞数据支持 |

## 4. 触发重新决策

出现任一条件时重新打开 ADR-006，并从最近的 fallback 层级继续：

- 同一 harness 的 Firefox/Safari 数据不满足专项预算，或 Safari 相对同机
  Chromium 出现数量级退化。
- 固定 performance runner 上 16K `pset` p95 > 5 ms、65,536 组
  `peek_poke` p95 > 4 ms、4,096 `spr` p95 > 8 ms。
- representative cart 的 core tick p95 超预算，profile 指向 interop，而不是
  guest VM、raster、audio、scheduler 或 present。
- 同机 main baseline 的 p50/p95 退化 5%–10% 时告警；超过 10% 且第二次独立
  registered-runner 测量仍复现时失败。
- fixed memory buffer 发生替换/growth，或任一 cross-path checksum/RAM hash 不同。

## 5. 后果

- Phase 0D 可以继续，不需要先把 graphics/runtime core 移进 WASM。
- production host schema 必须把调用方向、raw bits、pointer lifetime、错误与
  ownership 写成显式 contract；不能从 benchmark probe 反推公共 API。
- 浏览器结果 JSON、artifact hash、source revision 与 unavailable/not-run 状态是
  审计证据；截图或手工抄表不能替代。
