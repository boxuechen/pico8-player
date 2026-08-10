# ADR-028 — Phase 9 local host-feature boundary

> 状态：Accepted
>
> 日期：2026-08-10
>
> 决定范围：empty guest load 与 caller-authorized local multicart/data composition

## Context

Phase 9D 包含一个 baseline external cart-data request，以及语言修复后暴露的一个 downstream guest
`load()` request。两个请求本身都属于 Phase 5 已接受的 root HostRequest profile；失败的共同前提是
supplemental manifest 只携带主卡，没有组成显式 local dependency bundle。补齐依赖后，后一条路径又暴露
`load(stat(6))` 在空 launch parameter 下被 bridge 当作 fatal size error。

PICO-8 v0.2.7 手册允许运行中 `load(filename)` 切换 cartridge，并将 external `reload/cstore` 描述为
local cartridge behavior。本项目不据此获得 BBS、URL 或 host filesystem authority；local bytes 与每项
capability 必须由 caller 明确提供。

## Decision

1. `load("")` 是同步 no-op，返回零个 Lua value，不编码 HostRequest、不停止 current session。这覆盖
   optional multicart helper 把空 `stat(6)` 直接转交给 `load()` 的通用模式。
2. 非空 guest load 仍必须是 canonical bounded ref，并解析到 caller-authorized bundle 中显式具有
   `access.load` 的 entry；missing、oversized、URL-like 或 capability-denied ref 继续 fail-closed。
3. external `reload/cstore` 只解析显式 local bundle entry，并分别要求 `reloadData/cstoreData` capability。
   Runtime 不自动创建任意 ref、不访问磁盘，也不从 cart source 或 BBS identity 推断依赖。
4. qualification 可以在仓库外为受影响 case 组成公开依赖 cart 或项目原创空 data target；这些 bytes、
   identity、path、hash 与逐-case mapping 不进入 tracked source、CI 或 release artifact。
5. project regression 必须证明 accepted `cstore→reload` round trip、missing/denied fail-closed 与 empty-load
   no-op。external Chrome gate 只运行 2 个 affected case、每个 120 ticks。

## Consequences

- player core 的网络和 filesystem authority 保持为零；依赖完整性是 caller composition contract 的一部分。
- 单卡文件选择器不会伪装成自动 multicart downloader；需要 multicart 的 embed caller 必须传 local bundle。
- empty load 不再误伤可选 helper；其他 resolver 错误仍是结构化 `E_HOST_REQUEST`。
- supplemental quick-smoke 可以验证完整 local composition，但不把第三方 dependency 纳入仓库。

## Verification

- `pnpm run test:phase-9d`
- `pnpm run verify:phase-9`
- 2 个 caller-authorized affected external case 的 120-tick Chrome quick smoke
