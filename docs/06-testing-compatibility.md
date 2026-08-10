# 测试、兼容性与发布门禁

本文只维护当前质量口径、默认验证入口和仍然有效的 Known Differences。已完成阶段的执行日志、
环境 hash、逐阶段数字与长测结果只保存在 [`docs/evidence/`](./evidence/) 和对应 exit manifest 中。

## 1. 当前发布口径

当前产品是 **PICO-8 v0.2.7 L3 local/multicart Web Player on Chrome/Chromium desktop**：

- 接受 caller-provided `.p8` / `.p8.png` bytes，以及 caller-authorized local bundle。
- cart code 运行在可终止的 production Worker；Canvas、AudioContext 和 DOM 只存在于 app adapter。
- 支持 root `load/run/stop`、local multicart、external local `reload/cstore`、cart-defined pause menu、
  keyboard/touch/gamepad、audio、persistence 与 structured recovery。
- 不自动访问 BBS，不解析任意 URL 或宿主文件系统，不发布第三方 cart 内容。
- Chrome/Chromium desktop 是唯一浏览器 gate。

当前机器 inventory 共 113 项：`101 compatible`、`5 partial`、`7 unsupported`、
`required unknown=0`。唯一权威数据源是
[`spec/pico-api-inventory.yaml`](../spec/pico-api-inventory.yaml)；文档不维护第二份 API 清单。

当前真实 cart 证据支持以下有界结论：

- canonical fixed smoke：`100/100` 完成，playability disposition 为 `100 CU`。
- representative playability：`10/10 C2`。
- supplemental known-failure disposition：`51 resolved / 0 remaining`。
- 唯一完整 supplemental 同环境运行是 `199 CU / 1 failure`；最终差异另以 `1/1 CU` focused delta
  关闭，二者不合并为单环境兼容率。

这些结果表明绝大多数主流 cart 可以启动和运行，但不构成 official bit-exact、完整通关率、BBS 成功率
或任意第三方 corpus 的公开兼容率。当前结论见
[`Phase 9 exit evidence`](./evidence/phase-9/101-phase-9-supplemental-compatibility-remediation-exit-evidence.md)。

## 2. 兼容语义

### 2.1 API 状态

- `compatible`：在当前 profile 内有行为证据，可计入支持。
- `partial`：只支持参数、selector 或宿主效果子集，不计入完全支持。
- `unsupported`：明确不实现或属于 Player 范围外。
- `unknown`：证据不足；required 项不得以 unknown 发布。

实现存在不等于兼容。只有机器 inventory 中的 conformance status 可以形成 API 覆盖声明。

### 2.2 Cart disposition

| 等级 | 含义 |
| --- | --- |
| C3 Verified | 固定 trace 下 framebuffer/RAM 精确、audio 在容限内，关键流程有官方参考 |
| C2 Playable | 至少 15 分钟或完整关键流程可玩，无 crash、软锁或关键输入/存档丢失 |
| C1 Boots | 能进入交互，但存在影响玩法、视听或进度的已知差异 |
| C0 Fails | 无法解析/启动、崩溃、挂死、主要输入失效或核心流程不可达 |
| CU | fixed smoke 已完成，但没有足够 playability evidence 升级到 C1–C3 |

CU 可以证明 bounded smoke 未暴露故障，但不能当作 C2、通关或可玩率。只有明确、合法且同环境的
corpus 才能计算：

```text
playable_rate = (C2 + C3) / (C0 + C1 + C2 + C3)
```

CU 不进入分母。报告必须给出 corpus、revision、player/WASM/Chrome 环境和验证时长，禁止只报百分比。

## 3. 默认验证入口

| 场景 | 命令 | 预算与用途 |
| --- | --- | --- |
| 日常改动 | `pnpm run verify` | 默认 quick gate；architecture、codec 与最新 exit integrity |
| 当前测试别名 | `pnpm test` | 与 quick gate 相同 |
| Phase 9 owner integrity | `pnpm run verify:phase-9` | 已关闭阶段的快速完整性入口，不读外部 corpus |
| Focused release | `pnpm run verify:release` | release artifact + 短 Chrome player lifecycle |
| 完整 release 诊断 | `pnpm run test:release` | 含历史 600 秒 30/60 Hz Chrome gate；仅按需手动运行 |
| 历史全集 | `pnpm run test:historical` / `pnpm run verify:historical` | 仅诊断已观察到的跨阶段回归 |

验证必须与改动风险成比例：

- 文档/机器合同：owner test + `pnpm run verify`。
- browser-neutral RuntimeCore：最小原创 regression + affected package/owner tests。
- WASM/ABI：real-WASM regression、manifest/reproducibility，再运行 quick gate。
- Canvas/Audio/Worker/lifecycle：affected Chrome gate + focused release。
- scheduler、audio transport 或资源 ownership：只有 active phase 明确要求时才运行长 soak。
- external cart：只运行受影响的少量 case；不得把完整 corpus 当作每次修改的回归套件。

失败必须先最小化成项目原创 fixture。生产修复不得按 cart identity、路径、hash 或标题分支。

## 4. 测试边界

### 4.1 分层

- `tests/architecture/`：package、execution domain、exports、generated-source 与 `ref/` quarantine。
- `tests/cart-codec/`：`.p8` / `.p8.png`、compression、limits、byte ownership。
- `tests/runtime/`：RuntimeCore、z8lua bridge、host API、scheduler 与 resource regression。
- `tests/conformance/`：project-authored carts、exit manifests 和跨模块行为。
- `tests/browser/` / `tools/browser/`：Chrome production path、DOM、Canvas、audio 和 lifecycle。
- `tests/artifact/` / `tools/release/`：release allowlist、MIME/CSP、stable keys 与 reproducibility。

`spec/` 拥有机器契约，`docs/adr/` 拥有 accepted decisions，`docs/evidence/` 只保存不可变历史结果。
测试不得从 `ref/`、tracked third-party cart 或 ignored local observation 读取默认输入。

### 4.2 确定性

行为测试固定以下输入：

- cart bytes/version、player revision、runtime WASM 和 Chrome build。
- logical clock、FPS profile、PRNG seed、input trace 与 persistence namespace。
- AudioContext sample rate、Canvas backing size、DPR 和 capability policy。
- 每个 case 使用 fresh VM/session；除专门测试 replacement 外，不跨 case 共享 RAM、palette、input、
  audio queue 或 IndexedDB state。

逻辑时间来自 committed simulation slices，不能用宿主 wall clock 替代。浏览器刷新率不得直接改变
游戏速度；Worker、frame、audio 和 host request 的 stale generation 必须失败关闭。

### 4.3 Oracle

优先级为：官方手册 → 合法 official observation/golden → project machine contract → 带 provenance 的
参考实现。参考实现不是规范。行为差异必须有最小输入、精确 observable 和稳定 tolerance；不能只断言
“没有抛异常”，也不能通过放宽全局 tolerance 掩盖回归。

## 5. Chrome 与 release gate

当前只支持 Google Chrome stable 和 Chromium/headless desktop。Firefox、Safari/WebKit、iOS Safari、
Android release 与其他引擎不在承诺内；增加浏览器属于产品范围变更。

Focused release gate 至少覆盖：

- 从 tracked source 重建并验证 15-file release artifact、6 个 stable runtime keys、MIME、CSP、
  combined notices、deterministic archive/checksum 和 nested base path。
- local file choose/drop、player state/ARIA、keyboard/touch、mute/fullscreen 与 audio unlock。
- fault 后重新加载、pagehide/dispose、Worker/RAF/AudioContext teardown。
- production Worker path、128×128 Canvas backing 与非 cross-origin-isolated 环境。
- zero network cart authority；不得读取 BBS、`ref/` 或 external corpus。

完整 600 秒 gate 仅用于 scheduler/audio/resource ownership 的相关回归或 release 明确要求；短 diagnostic
不能冒充完整 gate，完整 gate 也不应成为日常默认验证。

## 6. Published Known Differences

| ID | API / 模式 | 当前影响与边界 |
| --- | --- | --- |
| `P4-KD-02` | `stat()` selector subset | inventory 列出的 deterministic selector 有类型值；其他 selector 返回 false |
| `P4-KD-03` | timed P8SCII | delay control 不暂停 guest；使用 logical frame 驱动文字时间 |
| `P4-KD-05` | fractional power edges | z8lua floating path 不承诺 official bit-exact |
| `P4-KD-06` | advanced screen/bitplane modes | 超出 standard packed 4bpp profile |
| `P5-KD-01` | guest-created coroutine 内的 host suspension | `flip/run/stop/load`、external `reload/cstore` 与 HostRequest 仅 root 可恢复；nested 调用 fail-closed 且无外部副作用 |
| `P6-KD-02` | nested custom-loop implicit quantum | CPU 会计继续，但 frame commit 等待 Runtime-owned root 返回；不返回则命中 hard cap |

当前 5 个 partial API 是 `flip`、`printh`、`stat`、`print`、`extcmd`。7 个 unsupported API 是
`save`、`folder`、`ls`、`resume`、`reboot`、`info`、`serial`；它们主要属于 console、文件系统或
非 Player 平台能力。精确 mode、evidence 和 note 只见 machine inventory。

<a id="13-测试数据版权与-bbs-访问限制"></a>

## 7. 外部 cart、BBS 与隐私

- 默认入口只接受 caller-provided bytes 或 caller-authorized local bundle。
- 不实现 BBS crawler、自动下载、任意 URL resolver、公共镜像或宿主文件系统 fallback。
- `ref/` 只用于隔离阅读，不能成为 build/test input。
- 第三方 cart bytes、身份、路径、cart/screenshot hash、截图和逐-case observation 不进入 tracked repo、
  CI、release artifact 或公开报告。
- tracked evidence 只能保存无法反推单个 cart 的 aggregate、环境事实和项目自有 fixture 结果。
- 获得内容与服务访问授权之前，不得把本地研究转换成自动服务访问或再分发。

Terms 与来源登记见 [`10-reference-sources.md`](./10-reference-sources.md) 和
[ADR-020](./adr/020-phase-5-bbs-adapter.md)。

## 8. Definition of Done

### 8.1 功能或兼容 bug

- 有官方依据、accepted decision 或明确 profile 行为。
- 先有项目原创最小复现，覆盖正常、边界、错误和 fresh-session recovery。
- 更新唯一 owner 的 machine contract、inventory、ADR 或 living doc；不复制到多个入口。
- 运行 affected owner tests；公共契约或 production behavior 改变后运行 `pnpm run verify`。
- 浏览器 adapter 改动通过 affected Chrome gate；资源 ownership 改动证明 teardown。
- 没有 cart-specific branch、authority expansion、未授权 fixture 或隐式兼容率变化。

### 8.2 Release

- release artifact、focused Chrome lifecycle、current exit integrity 和 clean checkout 通过。
- open P0/P1 为 0；P2/P3 均有 Known Difference 或明确 remediation plan。
- API inventory、浏览器范围、内容边界和 release notes 一致。
- 只在风险相关时执行完整 soak/historical gate，不用冗余运行掩盖验证策略。
- 发布到 npm、网站、registry 或 GitHub Release 必须由用户另行明确授权。

## 9. 兼容问题最小记录

新的兼容问题只需记录：

1. player/WASM/Chrome revision 与 cart 输入来源权限。
2. 最小项目原创复现和官方预期依据。
3. 首个可观察差异：fault code、RAM/frame/audio/input/host request 或 resource state。
4. 严重度 P0–P3、受影响 profile、workaround 与 owner。
5. focused regression、是否需要更新 inventory/Known Differences，以及明确的验证预算。

原始第三方 cart、截图和逐-case日志始终保存在仓库外。
