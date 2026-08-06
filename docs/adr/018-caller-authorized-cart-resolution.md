# ADR-018: Caller-authorized local cart resolution

状态：Accepted
日期：2026-08-06

## Context

Phase 5 的 L3 local/multicart profile 需要让 guest `load()` 以及带 filename 的
`reload/cstore` 取得当前 cart 之外的 bytes。RuntimeCore 必须保持 browser-neutral，cart
不能借此获得任意 URL、文件系统或 BBS 访问能力。PICO-8 v0.2.7 手册把运行中
`load(filename, breadcrumb, param)` 定义为立即运行目标 cart，并把 external
`reload/cstore` 限制在 local cart data region。

Lexaloffle Terms of Use 在 2026-06-22 更新后仍声明：BBS 内容默认归作者所有，在线服务不得由
automated script、third-party client 或 crawler 访问，除非取得 Lexaloffle 与相关作者许可，或属于
条款列出的 indexing/archive 例外。本阶段没有取得这类授权。

## Decision

1. Phase 5 core profile 只接受 caller-authorized local bundle。Window/caller 显式提供 bytes、
   opaque ref 和 capability；guest 字符串不能自行创造宿主权限。
2. RuntimeCore 拥有 `CartResolverPort`/`CartRepositoryPort` consumer contract、cancellation、
   transaction 和 capability enforcement；它不依赖 `fetch()`、File API、DOM 或 IndexedDB。
3. `@pico8-web/cart-codec` 继续只做同步 bytes decode。include/ref resolution 位于 loader/adapter，
   不能把 I/O 加入 codec。
4. concrete local-bundle resolver 位于 `apps/web-player/src/worker`，仅由 composition root 注入。
   它不得解析任意 URL、遍历宿主目录或读取未由 caller 预供给的文件。
5. capability 至少区分 `load`、`reloadData`、`cstoreData`、`include`。RuntimeCore 与 adapter
   都必须检查；capability 不从扩展名、ref 文本、cart code 或 origin metadata 推断。
6. BBS resolver 保持 Deferred，并且不是 Phase 5 core exit gate。没有新的明确授权和替代 ADR，
   production、tests、CI 与 tools 都不得自动访问 BBS。
7. ADR-017 的 root-only recoverable HostRequest 保持有效。nested suspension 的默认结果仍是
   `nested-host-suspend`，Phase 5F 只能在独立证据和替代 ADR 下扩大。
8. `save/folder/ls/resume/reboot/info/serial` 不因 local resolver 而进入 player 范围。

## Consequences

- ADR-007 的“caller-provided/local bytes”边界被细化为可引用的 caller-authorized local bundle，
  但没有扩展到网络或任意本地文件访问。
- 同一个 cart ref 可以由不同 host adapter 解释，但 core 只观察 copied bytes、identity、capability
  和 versioned request result。
- BBS 集成可以在未来作为独立 app adapter评估，不需要改变 VM、RuntimeCore 或 cart codec。
- 第三方/BBS cart 不进入公开兼容率分母；Phase 5 corpus 继续完全项目原创。

## Rejected alternatives

- **RuntimeCore 直接 fetch ref**：破坏 browser-neutral boundary，并把 guest 字符串变成网络权限。
- **以扩展名或 `#id` 自动授予 capability**：输入文本不是可信授权来源。
- **把 resolver 放入 cart codec**：混合纯 decode 与异步 I/O，破坏确定性单元测试。
- **把 BBS 作为 Phase 5 必经数据源**：违反当前授权边界，并使 CI 与发布不可复现。
- **用 Asyncify 支持所有 nested request**：不解决 coroutine resumer 所有权，且违反 ADR-017。

## Evidence

- [PICO-8 v0.2.7 manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)
- [Lexaloffle Terms of Use](https://www.lexaloffle.com/info.php?page=tos)（页面标注 updated 2026-06-22；本项目于 2026-08-06 复核）
- [`phase-5-l3-corpus.json`](../../tests/conformance/manifests/phase-5-l3-corpus.json)
- [`phase-5-l3-multicart-contract.json`](../../spec/phase-5-l3-multicart-contract.json)
