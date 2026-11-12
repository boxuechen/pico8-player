# Phase 14 — Presented Startup Lifecycle 完成证据

> 状态：Complete
>
> 浏览器门禁：Chrome/Chromium desktop only
>
> 机器合同：[`spec/phase-14-presented-startup-lifecycle-contract.json`](../../../spec/phase-14-presented-startup-lifecycle-contract.json)

## 完成结论

Embed API v2 的 `start()` 现在以当前 `sessionGeneration` 的首个 accepted Canvas frame 作为成功
barrier。Worker `running` acknowledgement、stale generation frame 或尚未被 presenter 接受的 frame
均不能单独放行；首帧前 fault/stop/dispose/deadline 会 fail closed，已获 acknowledgement 的 runtime
在 deadline 后进入 stop，而不会向宿主谎报可见运行。

同一 facade 的项目自有 cart A 运行后 stop/load cart B，session generation 从 `1` 前进到 `2`，
Canvas 首像素从 PICO palette color 2 变为 color 8。随后 dispose 并在同一 host root 创建 fresh
facade，color 3 首帧正常可见。`pico8-mobile` 和 official runtime 均未修改；这个结果只适用于
Open/Web Player backend 路径，不修复 official runtime 的 `Pico8Kill` 或其他外部全局状态。

## Bounded verification

| Gate | 结果 |
| --- | --- |
| Activation contract | 1/1 |
| Focused Node | 7/7；current/stale/presenter/deadline/dispose + Embed owner lifecycle |
| Focused Chrome | 1 run；Google Chrome 151.0.7922.76 |
| Presented frames | cart A / cart B / fresh facade = `1 / 1 / 1` before each `start()` resolve |
| Canvas first pixel | A `[126,37,83,255]`；B `[255,0,77,255]`；fresh `[0,135,81,255]` |
| Resource teardown | 2/2 Workers terminated；2/2 AudioContexts closed；active RAF `0` |
| Visual check | cart B pink frame visible；temporary screenshot reviewed and not tracked |
| External corpus / Top 200 | 0 / 0 |
| Historical matrix / long soak | 0 / 0 |
| Firefox / WebKit / mobile mutation | 0 / 0 / 0 |

本阶段只改 Window embed facade readiness；WASM source/artifact、RuntimeCore、Worker protocol、cart
authority 和 API version 都未改变。由于本机全局 Emscripten 是 `6.0.6-git`、仓库锁定 `6.0.5`，
未放松工具链锁；focused gate 使用已锁定的现有 WASM artifact 重新组合 main-only release 后运行。
