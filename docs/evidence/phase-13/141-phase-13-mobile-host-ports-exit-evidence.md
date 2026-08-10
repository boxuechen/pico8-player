# Phase 13 — Mobile Host Ports 完成证据

> 状态：Complete
>
> 主浏览器门禁：Chrome/Chromium desktop
>
> 下游门禁：`pico8-mobile` iOS Simulator

## 完成结论

Embed API v2 在 v1 bytes-first 权威上增加了 opt-in `hosted` shell、copy-owned 外部输入、
宿主 `cartdata()` `hydrate/write/flush` adapter、可等待 persistence flush 与
`inactive/background/active` lifecycle。无 adapter 的默认 Web profile 仍使用完整 DOM shell、内置输入和
Worker IndexedDB；RuntimeCore 仍保持 browser-neutral，本仓库没有引入 Capacitor 或原生文件系统代码。

## Bounded verification

| Gate | 结果 |
| --- | --- |
| 13A activation contract | 2/2 |
| 13B hosted input | 7 focused + 14 affected owner tests |
| 13C host persistence/lifecycle | 6 focused + 16 architecture tests |
| 13D artifact tests | 2/2 |
| 13D focused Chrome | 1 run；API 2，4 frames，5 writes，2 adapter flushes，background written |
| Hosted shell | app-owned toolbar/touch chrome hidden |
| Portable artifact | `0.2.0-alpha.1`；16 files；standalone verifier passed |
| Deterministic package | SHA-256 `70868ea0414ca365d911f61619bfe7a6abe2dc1fd09c53705169cf9f1ea4b154` |
| Downstream mobile Node / Chrome | 20 / 3 passed |
| Downstream Vite / Capacitor | simulator local-corpus build / `cap sync ios` passed |
| Downstream iOS Simulator | unsigned Debug build；`BUILD SUCCEEDED` |
| External corpus / Top 200 compatibility runs | 0 / 0 |
| Historical matrix / long soak | 0 / 0 |
| Physical-device runs / publication | 0 / 0 |

Focused Chrome 只使用项目自有最小 cart：宿主先 hydrate 值 `3`，运行后持久化最终值 `7`，
background flush 返回 written。下游移动 focused flow 另验证原生 Store 的 checksum/原子替换/损坏隔离/重试、
Pocket8 输入、Open 内存 handoff、Saving/Saved UI 和 Saved Data 列表。

## 边界

- artifact 只在本地 vendoring 给 `pico8-mobile`；没有 tag、npm、GitHub Release、网站或 push。
- 没有执行外部 cart corpus、Top 200、历史矩阵、长时 soak 或逐 cart 兼容性验证。
- Web Player 的产品门禁仍是 desktop Chrome/Chromium；下游 Simulator build 不构成 WebKit 或真机兼容承诺。
