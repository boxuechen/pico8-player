# Phase 0C 完成证据

> 日期：2026-08-05  
> 实现基线：`10caca4fa1dccd7304128f0ace42294900385711`  
> 决策：[ADR-006](./adr/006-interop-hot-path-boundary.md)  
> 原始结果：[chromium-macos-arm64.json](../benchmarks/interop/results/chromium-macos-arm64.json)

## 1. 结论

Phase 0C spike 已完成。它建立了可复现的 Node/browser harness、四路径对照、
机器可读 schema/validator、correctness-first 门禁、统计摘要和同机回归规则。

在本机实际 Google Chrome 上，80/80 case 都满足：

- 四条路径 result checksum 与完整 64 KiB RAM hash 一致。
- 100 warmup、30 sample、100 ms target calibration 全部达到目标。
- 16 MiB WASM buffer identity/byte length 始终不变。
- 关键 bridge-only workload 都低于现有专项预算。

因此 ADR-006 对已测 Chromium 给出 raw primitive/pointer-length hybrid boundary
的 **Go**；但 production ABI 和跨浏览器 Tier A 性能仍是有条件的 **No-Go**，直到
Firefox/Safari 使用同一 harness 取得实测。Phase 0C 没有实现或批准完整 host
API、frame lifecycle、renderer、audio、input、cart codec 或 Player UI。

## 2. 锁定的范围与边界

| 项目 | 结果 |
| --- | --- |
| benchmark ABI | bounded `p8w0c_bench_*`, version `0x00030000` |
| production ABI | 未建立；benchmark symbol 禁止升格 |
| artifact | `z8lua-phase-0c.{mjs,wasm}`，`-O2` |
| memory | 16 MiB fixed，`initial === maximum === 256 pages`，growth disabled |
| Pico RAM | 复用 Phase 0B context/lease/canonical mapper，无第二份 remap switch |
| seed/hash | LCG `0x12345678`；FNV-1a result/RAM hash |
| workload | no-op、raw Q16.16×3、byte string、`peek_poke`、`pset`、`spr_8x8` |
| calls/frame | 必测 1K/16K/64K；sprite 另测 4K 对应已有预算 |
| 排除 | Lua parser/VM/coroutine、render/present、audio、scheduler、cart/player 行为 |

`@/%/$`、wrap 与 remap correctness 已由 Phase 0B 证明。把它们再次放进 Lua loop
会混入 parser/VM cost，不能用于回答纯 interop delta；nested coroutine/host
request 属于后续 control-flow spike。

## 3. 实测环境与 artifact

| 字段 | 值 |
| --- | --- |
| Browser | Google Chrome `150.0.7871.189`, Headless DedicatedWorker |
| OS | macOS/Darwin `25.5.0`, arm64 |
| CPU / RAM | Apple M4 Pro, 14 logical CPU, 48 GiB |
| timer resolution | 约 `0.1 ms`；样本内部放大后再除以 repeats |
| source revision | `10caca4fa1dccd7304128f0ace42294900385711`（测量开始时 clean） |
| WASM bytes | 182,176 |
| WASM SHA-256 | `94d4133e08d6a01bcfdb2762686585f799c8f0ab010415ac5160019c9fde2b73` |
| result SHA-256 | `224388dfca4f471e0700ad344441ea42447ebecac08200fc3c24e70d29e3e2bf` |

本机尚未登记为固定 CI performance runner，因此绝对值是本次架构 spike 证据，
不是可移植硬门禁 baseline。硬门禁仍必须在登记 runner 上与同机 main 比较。

## 4. 关键结果

下表为候选 guest→host 方向 `wasm_to_js_import` 的正式数据；calls/s 由 p50 计算。

| Case | Work/frame | p50 ms | p95 ms | p99 ms | calls/s @ p50 | 专项预算 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| no-op scalar | 16,384 | 0.144 | 0.147 | 0.147 | 113.95 M | boundary reference |
| raw Q16.16 ×3 | 16,384 | 0.236 | 0.247 | 0.249 | 69.55 M | boundary reference |
| byte string 1 KiB | 1,024 | 1.036 | 1.055 | 1.062 | 0.99 M | 1 MiB payload hashing/frame |
| `peek_poke` pair | 65,536 | 0.579 | 0.599 | 0.617 | 113.17 M | ≤ 4 ms |
| `pset` | 16,384 | 0.090 | 0.090 | 0.090 | 183.03 M | ≤ 5 ms |
| `spr_8x8` | 4,096 | 0.433 | 0.442 | 0.443 | 9.46 M | ≤ 8 ms |

对应 pure-WASM control 的 p95 为：no-op 0.021 ms、raw 0.022 ms、1 KiB
byte-string 1.007 ms、`peek_poke` 0.204 ms、`pset` 0.027 ms、`spr_8x8`
0.230 ms。边界成本可见但绝对值没有触发 Chrome 下的 hot-path 下沉。

`js_shared_memory` 是解释性对照，不是预设赢家：相同 case 的 p95 分别为
0.021、0.052、4.392、0.730、0.178、0.736 ms。它证明 shared state 可以在不
复制/remap 分叉的情况下访问，但也说明逐 pixel/block loop 所在侧仍须由 profile
决定。

Chrome DedicatedWorker 没有暴露 `performance.memory`，所以 JS heap/allocation
字段诚实记录为 `unavailable`。ABI 没有逐调用 object/string conversion，但这不
替代后续 representative Runtime 的 allocation profile。

## 5. 浏览器可用性

| Engine | 状态 | 证据/原因 |
| --- | --- | --- |
| Chromium | `measured` | 本机 Google Chrome binary，通过 CDP 等待真实时钟执行完成 |
| Firefox | `unavailable` | `/Applications/Firefox.app` 不存在；未生成替代数据 |
| Safari/WebKit | `not-run` | Safari 26.5 已安装；未改变用户设置。WebDriver session 明确返回必须在 Safari Settings 启用 `Allow remote automation` |
| Node | smoke only | 用于 correctness/validator，不冒充浏览器性能 |

未使用 Playwright WebKit、其他引擎或推算结果冒充 Safari/Firefox。要关闭
ADR-006 portability condition，只需在相应真实浏览器打开同一 loopback harness
并保存通过 validator 的 JSON，不需要更改 benchmark contract。

## 6. 实现与机器门禁

- `benchmarks/interop/case-manifest.json`：case/protocol 的单一事实来源。
- `benchmarks/interop/result.schema.json` + `validate.mjs`：结果结构、correctness、
  sample count、buffer stability 与 cross-path equality。
- `runner.mjs`：Node/DedicatedWorker 共用 frame driver、calibration 与 R-7 统计。
- `compare.mjs`：同机 5% 告警；首次 >10% 为 `repeat-required`，只有独立复测确认
  后才 fail。
- `tools/benchmark/run-chromium.mjs`：真实 Chrome/CDP、临时 profile、无 virtual
  time，自动保存和验证 JSON。
- `tests/benchmark/phase-0c.test.mjs`：bounded ABI、四路径 correctness、forged
  result rejection 与 repeated-regression policy。

实际通过的命令：

```text
pnpm run verify
pnpm run benchmark:interop:chromium
node tools/benchmark/run-chromium.mjs --smoke --output /tmp/p8w-phase0c-chromium-smoke.json
node tools/benchmark/run-node.mjs --output /tmp/p8w-phase0c-node-smoke.json
```

`pnpm run verify` 包含 TypeScript/architecture、Phase 0A/0B regression、Phase 0C
benchmark tests、双构建 reproducibility 与 manifest/artifact hash verification。
从提交 `3fd607e` 执行 `git clone --no-local` 后，使用 Node 22.22.2、pnpm
10.8.0 运行 frozen install 与统一 `pnpm run verify`：16/16 architecture、23/23
Phase 0A/0B、4/4 Phase 0C、双构建 reproducibility 和 6-file manifest 全部通过；
验证后的 clean checkout `git status --porcelain` 为空。

## 7. Fallback 与下一阶段

fallback ladder 的逐级结论见 ADR-006：raw ABI 已选择；batch framebuffer/audio
在本阶段不适用；memory/pixel/block pure-WASM control 已有数据但未触发下沉；
audio 与 full-core WASM 均没有证据支持。下一独立阶段为 Phase 0D lossless
`.p8.png`，不得继续扩张 `p8w0c_bench_*`。
