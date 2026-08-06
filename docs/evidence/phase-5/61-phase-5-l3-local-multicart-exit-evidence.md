# Phase 5 — L3 Local / Multicart 完成证据

> 状态：Complete
> 阶段输入基线：Phase 4 exit；activation baseline commit `56a9137`
> 目标：PICO-8 v0.2.7 L3 local/multicart project profile
> 浏览器门禁：Google Chrome / Chromium desktop only
> 资产策略：project-authored local carts only；无网络、BBS、第三方或 `ref/` test dependency

## 0. 完成结论与声明边界

Phase 5A–5H 已完成，机器合同关闭。可发布声明严格为：

> **PICO-8 v0.2.7 L3 local/multicart project profile on Chrome/Chromium desktop.**

它表示 6 个项目原创 L3 corpus lane 在 Node real-WASM 和 Chrome production Worker 路径均为
`C3`，playable rate 为 `6/6 = 100%`；caller-authorized local bundle、root guest `load()`、atomic
cart swap、external local `reload/cstore`、fault recovery、100 次连续 replacement 与 30 分钟
Chrome mixed soak 门禁通过。它不表示 official bit-exact、任意第三方/BBS cart、自动网络访问、
任意 URL/宿主文件系统、Firefox/WebKit/mobile 或 nested guest-coroutine host suspension 已兼容。

L3 profile 发布 5 项 Known Differences：`P4-KD-02/03/05/06` 从 L2 profile 继承，
`P5-KD-01` 将 root-only ownership 扩展到所有需要 host suspension 的 L3 surface。guest-created
coroutine 中统一返回不可被 guest 吞掉的 `E_FEATURE_UNSUPPORTED` / `nested-host-suspend`，且不产生
resolver、repository、overlay、swap、frame、audio 或 persistence 副作用。`P4-CL-01` 的 28 项
accepted-unverified VM builtin coverage limitation 继续有效。BBS adapter 经 ADR-020 明确为
**Deferred**，不属于 core exit gate。

## 1. Work-unit closure

| Unit | 完成结果 | 主要 gate |
| --- | --- | --- |
| 5A Activation / Capability / Corpus | ADR-018、caller-authorized local profile、6-case 原创 corpus | baseline/provenance/hash |
| 5B CartLoader / Resolver / Repository | browser-neutral ports、local bundle resolver、identity repository | access/limits/cancellation |
| 5C Root HostRequest Pipeline | bounded root suspension、request/generation race gate | real-WASM + Chrome |
| 5D Guest `load()` / Atomic Swap | staged fresh session、exact replacement handshake | callback/custom rollback |
| 5E External `reload/cstore` | resume-before-RAM、call-point snapshot、identity COW overlay | Node/Chrome local data |
| 5F Coroutine / L3 Policy | ADR-019 accepted root-only；28-case nested matrix | zero side effects/recovery |
| 5G Optional BBS Adapter | ADR-020 Deferred；production network capability 不变 | official-source policy review |
| 5H Exit / Resources | 6/6 C3、100 swaps、1800 秒 mixed soak、aggregate hash gate | full repository verify |

5H machine manifest：
[`phase-5h-exit.json`](../../../tests/conformance/manifests/phase-5h-exit.json)，SHA-256
`a66aec36c1ea2a9a488a2aa6a8b0053f4e50ee852c6aa8e764ff0bb83b0ccd08`。

受理输入的完整 SHA-256 锁如下；5H aggregate test 会逐项重算：

| 输入 | SHA-256 |
| --- | --- |
| `tests/conformance/phase-5/exit-config.json` | `9c0c788e34ce5056aba8c448a26fb98a83f9fe935b98762e1b3c79ac9ea8692a` |
| `phase-5-l3-corpus.json` | `a9169678bbb29a103f36485c3e8694a5003cc6c4400900775f1a17d935a2cba8` |
| ADR-018 | `34dcfb5dfc41aad5c6ac62d67363834892bc57455a840febca41bf35f17ce100` |
| ADR-019 | `99138ee6811ed8293a84324591c158b1fad115c96c0f65665721eccf2a25b969` |
| ADR-020 | `c595006c2112febd7df18bf66236454e0559910873f8362a434647b192541808` |
| Node L3 exit result | `565e49e3e6c270a330304c5d2ae67ae6dcc083c6b6dbcb631d2454e65fa85740` |
| Chrome L3 exit result | `2c9feba41e75f32933ee5cd8a8cfd64e22938d1ef7f88e0963948b46edf8093b` |
| `wasm/runtime-v1.manifest.lock.json` | `1d1dffbc214ac92c3d7c97609d31ef3a94a5e55bfa497a2d5788b3cb59461519` |

## 2. Project corpus 与 cross-path agreement

Phase 5 corpus 是仓库内 6 个原创 case，覆盖 root callback/custom `load()`、local external
`reload/cstore`、resolver failure/cancellation race 和 nested-suspension policy。Node real-WASM 与
Chrome production Worker 对每个 case 的 classification 和 cross-oracle SHA-256 完全一致。

| 指标 | 结果 |
| --- | --- |
| C0 / C1 / C2 / C3 / CU | `0 / 0 / 0 / 6 / 0` |
| Playable denominator / numerator | `6 / 6` |
| Playable rate | `100%`（门槛 `≥95%`） |
| Open P0 / P1 | `0 / 0` |
| Node reviewed result | SHA-256 `565e49e3…5740` |
| Chrome reviewed result | SHA-256 `2c9feba4…093b` |

该分母不包含 BBS、第三方或用户本地 external corpus；不能用 `100%` 推断这些 cart 的成功率。

## 3. Atomic swap、failure 与 stale-output gate

- Node 和 Chrome 均完成 `100/100` 次 guest cart replacement，generation 精确从 `1` 到 `101`，
  replacement handshake 恰好 `100` 次且序列严格为 old→next。
- frame/runtime、audio、input、request、persistence 的 stale commit 全部为 `0`；Node dispose 后 live
  WASM context 为 `0`，Chrome 终止前为当前 session 所需的 `1`。
- staged target boot failure 返回 `E_VM_RUNTIME`、replacement handshake 为 `0`，随后 fresh session
  recovery 成功；resolver failure、cancellation 与 late completion 均未提交旧 generation 输出。
- local external `reload/cstore` 不改变 Player session generation；`reload` 在 guest continuation 前提交
  RAM，`cstore` 使用调用点 snapshot 并只写目标 identity overlay。

## 4. Chrome 30-minute resource gate

正式 evidence 运行于 Apple M4 Pro / macOS 25.5.0 / arm64、Google Chrome 150.0.7871.189：

| 指标 | 结果 |
| --- | --- |
| Requested / actual soak | `1800 s / 1800.0644 s` |
| Measured / total cycles | `2332 / 2339`（含 warmup） |
| 每类 guest load/custom/reload/cstore/fault/recovery/frame | `2339` |
| Fixed WASM / default Lua heap | `16 MiB / 1 MiB`；无 memory growth |
| CDP retained heap delta | `+100,076 B`（门槛 `≤1,048,576 B`） |
| Stale commits / Worker errors / pending requests | `0 / 0 / 0` |
| Workers created / terminated | `1 / 1` |
| Audio transport messages / port released | `32,968 / true` |

Raw artifact：
[`chromium-macos-arm64-l3-exit.json`](../../../benchmarks/phase-5/results/chromium-macos-arm64-l3-exit.json)，
SHA-256 `2c9feba41e75f32933ee5cd8a8cfd64e22938d1ef7f88e0963948b46edf8093b`。

受审 artifacts 记录 source revision `8ffa0faf4de427f712a9dae47f1ac34347dabfdb-dirty`；`dirty` 表示 5H
runner、manifest 与证据在独立提交前运行。每个实际 production source、runner 和 runtime artifact
另有文件级 SHA-256，因此结果不依赖未说明的工作树内容。

## 5. Policy、Known Difference 与 deferred scope

- ADR-018：只有 caller 提供 bytes 或 caller-authorized local bundle 能赋予 cart identity/capability；
  cart string 不构成 URL、网络或文件系统权限。
- L3 profile 继续公开 `P4-KD-02`（`stat()` selector subset）、`P4-KD-03`（timed P8SCII delay）、
  `P4-KD-05`（fractional power edge）和 `P4-KD-06`（advanced screen/bitplane mode）；
  `P4-KD-01` 已由更完整的 `P5-KD-01` 取代，`P4-KD-04` 则已由 caller-authorized local external
  `reload/cstore` 实现关闭。
- ADR-019 / `P5-KD-01`：nested guest-coroutine host suspension 保持 root-only，严重度 P2；规避方式是
  只从 root callback/custom loop 调用相关 API。
- `P4-CL-01` 的 28 项已实现 z8lua builtin 仍缺 official edge vectors，因此继续排除在
  official-compatible 和 bit-exact 声明外。
- ADR-020：复核 Lexaloffle Terms、PICO-8 v0.2.7 手册和 resources 页面后选择 Deferred；没有新增
  BBS adapter、endpoint 或 transport，第三方/BBS bytes 和发布分母贡献均为 `0`。

## 6. 可复现命令

```text
pnpm run test:phase-5h
pnpm run test:phase-5h:chrome
pnpm run test:browser:chromium
pnpm run evidence:phase-5h
pnpm run verify
```

普通 `verify` 运行 10 秒 Chrome smoke，并 hash-lock 受审 1800 秒 artifact；只有显式
`evidence:phase-5h` 会重新生成 30 分钟结果。Phase 5 关闭后，本文件、5H manifest 和 reviewed raw
artifacts 不随普通功能任务重写。
