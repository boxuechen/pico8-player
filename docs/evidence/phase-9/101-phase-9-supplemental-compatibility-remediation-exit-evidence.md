# Phase 9 — Supplemental Compatibility Remediation 完成证据

> 状态：Complete
>
> 目标：把 supplemental 200-cart quick smoke 的 51 个已知失败收敛为通用 PICO-8 v0.2.7 Runtime 修复
>
> 浏览器门禁：Chrome/Chromium desktop only
>
> 内容边界：只归档 aggregate；第三方 bytes、身份、路径、hash、截图与逐-cart 结果均不发布

## 0. 完成结论

Phase 9A–9H 已完成。Phase 8 遗留的 51 个失败被归并为 15 个匿名 root-cause candidate，并以项目原创
real-WASM fixture、通用 Runtime 修复和短 Chrome regression 全部处置完成。production cart-specific
branch、network/host-filesystem authority expansion、open P0/P1 均为 `0`。

唯一一次完整 4×50 requalification 在单一 clean player/WASM/Chrome 环境得到 `199 CU / 1 language
failure`。最后一个 `menuitem()` display-bound 差异修复后，只对该 affected case 做了一次 120-tick
focused delta，结果为 `1/1 CU`。因此 51 个已知失败的最终 disposition 为 `51 resolved / 0 remaining`；
这两个 observation 属于不同 commit，不合并成单环境 `200/200` aggregate，也不发布第三方兼容率。

9H machine manifest：
[`phase-9h-exit.json`](../../../tests/conformance/manifests/phase-9h-exit.json)。

## 1. Work-unit closure

| Unit | 结果 | 主要 gate |
| --- | --- | --- |
| 9A | 51 failures → 15 anonymous candidates；unclassified 0 | freeze / redaction / exact coverage |
| 9B | 13 language candidates、45 baseline cases | original real-WASM regression / focused Chrome |
| 9C | 32M deterministic safety cap 与 Q16.16 numeric-for termination | finite/runaway containment |
| 9D | explicit local bundle 与 empty `load("")` no-op | missing/denied fail-closed |
| 9E | 10 个 representative 全部 CU | production Worker / 120 ticks |
| 9R | 首次 requalification 暴露的 4 个 affected case 全部 CU | generic remediation / local composition |
| 9F | 唯一完整 4×50 得到 199 CU、1 language failure | same environment / screenshot coverage |
| 9S | 16-P8SCII-character menu label prefix；最后 1 case CU | original fixture / focused delta |
| 9G | Phase 9 owner gate 与 focused release gate 通过 | artifact / Chrome lifecycle / cleanup |
| 9H | aggregate-only exit 与文档收口 | privacy / immutable evidence |

## 2. 通用兼容修复

语言侧补齐 parser shorthand、lexical/iteration/value 语义、VM-local helper、typed `stat()`、coercion、
bounded memory/persistence、allocation、`camera()` previous state、absent-value `all()`、bounded `chr()`
varargs 和非致命 `menuitem()` display bound。默认 Lua heap 为 2 MiB，WASM memory 仍固定 16 MiB 且
禁止 growth。

timing 侧固定 `32,000,000` deterministic instruction safety cap，并在 `int64` raw 域结束越过 Q16.16
边界的 numeric `for`；不使用 wall-clock 或 adaptive budget。host 侧只接受 caller-authorized local
bundle，空 `load("")` 同步 no-op，非空 missing/denied ref 继续失败关闭。

所有 production fix 都有项目原创 regression。外部 case 只用于 bounded validation，不成为构建输入或
tracked fixture。

## 3. Requalification 与最终 disposition

| Observation | Cases | Result | Environment claim |
| --- | ---: | --- | --- |
| 唯一完整 4×50 | 200 | 199 CU / 1 language failure | 同一 player commit、WASM、Chrome、production Worker |
| 最后差异 focused delta | 1 | 1 CU / 0 failure | 最终修复后的 clean production commit |
| 已知失败最终处置 | 51 | 51 resolved / 0 remaining | 跨 commit disposition，不是单环境兼容率 |

完整 sweep 之前的一次 attempt 在 175 cases（171 CU / 4 failures）后按 fail-fast policy 中止，随后 9R
先关闭这些差异；它不是 completed full sweep。唯一完成的 sweep 每 case 为 120 logical ticks，并在仓库外
捕获 200 张截图；3 个 local dependency case 仅由仓库外显式 bundle 提供。最后修复只复测 1 个 affected
case。没有第二次 completed full sweep、长 playability、historical matrix 或 600 秒 soak。

CU 只表示 bounded fixed-smoke disposition，不等价于 C2 playability、官方 bit-exact 或面向第三方 corpus
的兼容率。

## 4. Release regression

9G 在不读取 external corpus 的条件下执行：

```text
pnpm run verify:phase-9
pnpm run verify:release
```

两者均通过。release verifier 检查 12 个发布文件；Chrome 151.0.7922.76 的短 player lifecycle 覆盖
shell、keyboard/touch、audio-blocked recovery、production Worker、RAF、Worker teardown 与
AudioContext close。production source change、historical run、long soak 和 external case 均为 `0`。

最终 runtime WASM 为 197,591 bytes，SHA-256
`5550c3c18a689d326a7a108f49e7299c2925937a0b12ab1f92f05b367bdcd46d`。

## 5. 隐私与声明边界

tracked repository、CI 与 release artifact 中第三方 cart bytes、身份、路径、cart hash、截图和逐-cart
result 均为 `0`。BBS crawler、自动下载、任意 URL/host-filesystem resolver、非 Chrome 浏览器、移动端
发布、官方 bit-exact 和公共第三方兼容率仍不在声明范围。

Phase 9 的结论仅为：Phase 8 supplemental quick-smoke 暴露的 51 个已知失败已经通过通用修复和 bounded
Chrome validation 完成处置；它不把本地测试集合升级为产品兼容性分母。
