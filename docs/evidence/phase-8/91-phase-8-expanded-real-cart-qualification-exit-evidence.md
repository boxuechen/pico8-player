# Phase 8 — Expanded Real-cart Qualification 完成证据

> 状态：Complete
>
> 目标：PICO-8 v0.2.7 RC profile 的本地真实 cart 扩展验证
>
> 浏览器门禁：Chrome/Chromium desktop only
>
> 内容边界：只归档 aggregate；第三方 bytes、身份、路径、hash、截图与逐-cart结果均不发布

## 0. 完成结论

Phase 8A–8H 已完成。正式 100-cart canonical corpus 在 production Chrome fixed smoke 中得到
`100 CU`，65 个 source/export format pair 全部完成定性，10 个代表 case 全部达到 C2。开放
P0/P1 为 `0/0`，release artifact、Chrome lifecycle、资源回收、确定性与 tracked-input privacy
门禁无回归。

另一个 caller-authorized、local-only 的 supplemental 200-cart snapshot 完成了 120-tick quick smoke，
聚合结果为 `149 boots / 51 fails`。这 51 个失败是后续兼容修复 backlog，不改变 Phase 8 的正式
denominator，也不能表述为公开第三方兼容率。

## 1. Work-unit closure

| Unit | 结果 | 主要 gate |
| --- | --- | --- |
| 8A | Phase 7 baseline 与外部 corpus policy | contract / privacy |
| 8B | 100 canonical、65 pair 的仓库外 deterministic tooling | quarantine / aggregate-only |
| 8C | 100-case 初始 Chrome smoke 与失败聚类 | fixed tick / screenshot |
| 8D | parser、language、CPU、timing 通用修复 | original regression / 100 CU |
| 8E | 65 个 format pair 与 multicart 风险定性 | decode / runtime parity |
| 8F | 10-case C2 与 supplemental 200-cart quick smoke | input / visual / real audio / persistence |
| 8G | release regression requalification | artifact / Chrome lifecycle / cleanup |
| 8H | aggregate-only exit 与文档收口 | privacy / clean tracked input |

8H machine manifest：
[`phase-8h-exit.json`](../../../tests/conformance/manifests/phase-8h-exit.json)。

## 2. 正式 qualification

| Gate | 结果 |
| --- | --- |
| Canonical smoke | `100/100` classified；`99 boots + 1 expected self-test fault`；`100 CU` |
| Failure clusters | `0` |
| Format pairs | `65/65` complete；`9 matched / 56 source-content divergent` |
| Same-content runtime defects | `0` |
| Representative C2 | `10/10`；critical-flow `8`，900 秒 duration `2` |
| Real audio | `4` 个 AudioContext/AudioWorklet case，underrun/overrun/drop/discontinuity 均为 `0` |
| Persistence | `1` 个新实例 reload case 通过 |
| Screenshot review | canonical `4`、C2 `10`；原图均位于仓库外 |
| Open P0 / P1 | `0 / 0` |

CU 只表示 fixed-smoke disposition，不等价于 C2 可玩性。format pair 的 56 个 divergence 来自 source/export
内容本身不同；运行时风险均已定性，不能把它们误报成 runtime failure。

## 3. Supplemental 失败 backlog

supplemental quick smoke 共 `200/200` 完成，结果为：

- language：`45`
- timing：`5`
- unsupported-host-feature：`1`

它们进入下一阶段的兼容修复队列。修复必须按共享根因、项目原创最小复现和官方 v0.2.7 行为推进，
禁止按 cart identity 分支。只有阶段末进行一次 4×50 requalification；日常开发只选少量代表 case 做
短 Chrome 回归。

## 4. Release regression

`3c932fe0068b517e629817e9dfc5c641071e37b7` 的完整 `pnpm run verify` 已覆盖 release build、
production Worker、7G 完整 Chrome gate 与 7H exit：600 秒 30/60 Hz soak 的 dropped tick、audio
underrun/overrun/discontinuity 均为 `0`，Worker 全部释放。8G 随后只做 bounded requalification：

```text
pnpm run test:phase-8f
pnpm run build:release
pnpm run build:player-worker
node tools/release/verify-release.mjs
pnpm run test:phase-7h
pnpm run test:architecture
```

全部通过。这里复用了同一 source revision 已完成的完整 Chrome soak，没有重复读取外部 corpus，也没有
用 diagnostic gate 冒充完整 gate。

## 5. Aggregate locks 与隐私

| Local-only aggregate | SHA-256 |
| --- | --- |
| canonical corpus fingerprint | `941bcc486bbf18fa22936d4ff9f6d9a8f3eb00f3eb76b35619687c89cb30e33c` |
| format-pair aggregate | `87add5b7f2588e07402f4b5f98856346fb1a1901327d36f2edc5267973ac0763` |
| supplemental quick-smoke aggregate | `54c352ff737973e944a773afe8396e30b012915ac40d5c3a0252932553505a7b` |
| representative C2 aggregate | `9fbae1f3bbb6d63eabf81feaf691b7ef469916ae674c1d872f3ffcc721bf49f3` |
| runtime WASM | `608cb76400a125f975a71ec8ea44c67078d1c9764ef52855fec08a52e21f2700` |

这些 hash 只绑定不可反推单个 cart 的 aggregate 或项目构建产物。tracked repository、CI 与 release
artifact 中第三方 cart bytes、身份、路径、cart hash、截图和逐-cart结果均为 `0`；BBS crawler、任意
URL/host-filesystem resolver、非 Chrome 浏览器和公共 cart 镜像仍不在范围。
