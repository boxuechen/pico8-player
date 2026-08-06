# ADR-020: Phase 5 不实现自动 BBS adapter

状态：Deferred
日期：2026-08-06
复核日期：2026-08-06

## Context

Phase 5G 是一个条件决策点，不是 L3 local/multicart 的退出门禁。需要先确认 Lexaloffle 当前
服务条款和官方接口是否允许第三方 Web Player 自动取得 BBS cart，才能考虑 production network
adapter。项目现有 [ADR-018](./018-caller-authorized-cart-resolution.md) 只授权 caller-provided bytes
和 caller-authorized local bundle；cart code 本身没有 URL、文件系统或服务访问权限。

本次复核只使用以下官方页面：

- [Lexaloffle Terms of Use](https://www.lexaloffle.com/info.php?page=tos)，页面标注更新于
  2026-06-22；
- [PICO-8 v0.2.7 manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)；
- [PICO-8 resources](https://www.lexaloffle.com/pico-8.php?page=resources)。

Terms 说明 BBS cart 默认仍属于作者，未经 Lexaloffle 和相关作者许可时，网站与在线服务不应由
自动脚本、第三方客户端、crawler 或其他自动系统访问。手册描述了 PICO-8/SPLORE 对 BBS cart 的
加载与缓存行为，但没有为第三方 Web Player 定义稳定的公共 HTTP cart-download API、授权协议、
redirect/content-type 合同或服务承诺。公开可见和允许自动访问不是同一件事。

## Decision

1. 5G 唯一结论为 **`deferred`**。Phase 5 不新增 BBS resolver、transport、endpoint、网络权限或
   第三方 cart fixture，也不探测未公开接口。
2. Production composition 继续只注入 caller-authorized local bundle resolver；RuntimeCore、z8lua
   bridge、cart codec 和 guest API 不获得 browser/network dependency。
3. BBS cart id、URL 或 guest string 不能触发网络访问。`load("#id")` 不属于本阶段声明的可用路径，
   除非 caller 已把对应 bytes 作为有权使用的 local bundle 显式提供。
4. CI、Chrome gate、corpus、benchmark 和兼容率统计保持完全离线；BBS/第三方 bytes 和结果对已发布
   denominator 的贡献固定为 0。
5. Deferred 不是永久拒绝。只有同时取得 Lexaloffle 与相关作者所需许可，并获得有文档、稳定且适合
   第三方客户端的官方接口后，才能用替代 ADR 重新打开。新的设计仍必须显式 opt-in、固定 origin、
   限制 ref/redirect/content-type/1 MiB bytes、支持 cancellation，并经 `CartLoader` 二次校验。

## Evidence

- Policy/architecture gate：
  [`tests/runtime/phase-5g-bbs-policy.test.mjs`](../../tests/runtime/phase-5g-bbs-policy.test.mjs)。
- 机器结论：
  [`spec/phase-5-l3-multicart-contract.json`](../../spec/phase-5-l3-multicart-contract.json)。
- 测试数据与站点访问边界：
  [`docs/06-testing-compatibility.md`](../06-testing-compatibility.md#13-测试数据版权与-bbs-访问限制)。

## Consequences

- 5H 可以只依据项目原创、本地 bundle corpus 完成 L3 exit，不依赖外部服务可用性、CORS、登录态或
  第三方许可状态。
- 官方 BBS 上存在可玩的 cart 不构成本项目自动下载、再分发或兼容性声明的授权。
- 本阶段不留下不可达 adapter、feature flag 或 endpoint 常量，避免半实现扩大安全与维护边界。

## Rejected alternatives

- **直接复用网站内部 endpoint**：它不是已文档化的第三方接口，并与当前 Terms 的自动访问限制冲突。
- **只抓取带开放许可标记的 cart**：内容许可不自动授予对 Lexaloffle 服务的自动访问许可，也不能证明
  endpoint 稳定。
- **通过 CORS proxy、镜像或浏览器登录态访问**：扩大了 origin、凭据、隐私和分发边界，且属于 5G
  明确排除项。
- **先提交未启用 adapter**：即使 composition root 没有注入，也会形成未经证明的 production network
  surface；Deferred 路径明确禁止这种预留。
