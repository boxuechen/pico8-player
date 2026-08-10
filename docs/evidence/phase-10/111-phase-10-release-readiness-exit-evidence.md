# Phase 10 — Release Readiness 完成证据

> 状态：Complete
>
> 候选：`0.1.0-rc.1`
>
> 发布边界：本地静态 release candidate；未创建 remote、tag、npm、网站或其他外部发布

## 完成结论

Phase 10A–10F 已完成。当前 Web Player 已从高兼容度实现收口为可重复构建、可校验、可解压后独立
验证的本地 Chrome/Chromium release candidate。project-owned source 继续 `UNLICENSED`，artifact
完整包含项目 license、RuntimeCore + WASM combined notices 和 release notes。

机器 exit manifest：
[`phase-10f-exit.json`](../../../tests/conformance/manifests/phase-10f-exit.json)。

## Release artifact

| 项目 | 结果 |
| --- | --- |
| Product / API version | `0.1.0-rc.1` / `1` |
| Static directory | 15 tracked-by-manifest files + manifest |
| Stable runtime keys | `main`, `worker`, `worklet`, `wasm`, `styles`, `demo` |
| Archive | `pico8-web-player-0.1.0-rc.1.tar.gz` |
| Archive files | 16 |
| Archive bytes / SHA-256 | `195086` / `674b7a1ba872f5171cb3e04764a1299495805d6d2cc67a474cb00049bba0115c` |
| Standalone verify | unpacked `node verify.mjs` pass |
| Reproducibility | two fresh directory/archive builds byte-exact |

release directory 加入 `LICENSE`、`RELEASE_NOTES.md` 与 standalone `verify.mjs`；combined
`THIRD_PARTY_NOTICES.md` 由 RuntimeCore 和 WASM 两个 tracked owner 确定性生成。archive 使用固定
mtime、uid/gid、mode、排序和 neutral gzip header；`SHA256SUMS` 锁定压缩包。

## Bounded validation

```text
pnpm run test:phase-10c  # 4/4
pnpm run test:phase-10d  # quick 49/49 + focused Chrome + project suites 27/27
pnpm run test:phase-10e  # local RC 2/2
```

Chrome 151.0.7922.76 的 focused gate 覆盖 production Worker、nested base path、CSP/MIME、keyboard、
touch、audio unlock、fault recovery 与 teardown；最终 Worker terminated、AudioContext closed、active RAF
为 0。验证读取的 external corpus、historical matrix 和 long soak 均为 0。

project-owned bounded suites 覆盖 text cart、generated `.p8.png`、audio、input、persistence 与 local
multicart。Phase 8/9 的第三方 corpus 没有重新运行，也没有进入 release artifact 或新 evidence。

## 声明与交付边界

- API inventory 维持 `101 compatible / 5 partial / 7 unsupported / required unknown 0`。
- 5 个 partial 与 7 个 unsupported 继续由 living compatibility profile 发布；Phase 10 不改变 Runtime 行为。
- project code 和 compiled artifact 不授予再分发许可；第三方权利不受项目 `UNLICENSED` 声明限制。
- 本阶段只生成 gitignored 本地 artifact 和本地 Git commits；remote、tag、npm、网站和公开 release 为 0。
- BBS crawler、arbitrary URL、host filesystem、非 Chrome 浏览器与 public third-party compatibility rate 仍不在范围。
