# 架构决定、风险与未决问题

## 1. ADR 摘要

本表记录当前决定。`Accepted` 表示默认不可在普通实现任务中改变；改变它需要新 ADR、迁移影响和测试证据。

| ID | 状态 | 决定 | 理由 |
| --- | --- | --- | --- |
| ADR-001 | Accepted | 使用 z8lua WASM + TypeScript Runtime | 保留 P8 Lua 语义，同时让 Web hardware 可调试、可测试、可演进 |
| ADR-002 | Accepted | 不使用普通 Lua/Fengari 直接替代 P8 VM | 缺少 P8 syntax、fixed-point 和溢出语义 |
| ADR-003 | Accepted | Pico RAM 分配在 WASM memory，TS 使用零复制 view | z8lua `@/%/$` 与 TS hardware 必须观察同一内存 |
| ADR-004 | Accepted | Runtime 在 Worker，Window 只负责 host/UI | 隔离死循环和不可信 cart，保护交互线程 |
| ADR-005 | [Accepted（Phase 0D）](./adr/005-lossless-p8png.md) | `.p8.png` 从原始 bytes 以 bounded TS codec 无损解码 | Canvas/ImageBitmap/平台 inflate 被架构门禁禁止；raw/legacy/PXA 与恶意输入有回归 |
| ADR-006 | [Accepted](./adr/006-interop-hot-path-boundary.md) | raw primitive/pointer-length 为初始 hybrid ABI；interop 热点以 benchmark 决定是否下沉 | Chrome 实测未触发下沉；Chrome/Chromium 是唯一浏览器门禁，禁止无证据 full-core WASM |
| ADR-007 | Accepted | 首版只接受 caller-provided/local cart bytes | BBS 自动访问受当前服务条款和作者权利约束 |
| ADR-008 | Proposed | API schema 生成 C wrapper 与 TS binding | 减少手写 bridge 的参数/返回值不一致 |
| ADR-009 | Proposed | 首个 renderer 使用 Canvas2D，保留 WebGL adapter | 128 × 128 输出足够小；先优化正确性和可移植性 |
| ADR-010 | Proposed | Worker 生成 PCM chunk，AudioWorklet 消费 | 避免 AudioWorklet 拥有权威游戏状态 |
| ADR-011 | Proposed | 默认 hidden-tab policy 为 pause，不追帧 | 避免恢复时 spiral of death 和无意义电量消耗 |
| ADR-012 | [Accepted](./adr/012-z8lua-source-and-phase-0a-wasm.md) | z8lua 使用 tracked vendored `pico8@8575dfb` + ordered patch manifest；Phase 0A 产物由 pinned Emscripten 重建 | 生产不依赖 `ref/`、移动 head 或网络 fetch；spike ABI 与 production ABI 分离 |
| ADR-013 | [Accepted](./adr/013-shared-pico-ram-boundary.md) | context-owned 64 KiB RAM、唯一 logical mapper、runtime-neutral lease；v1 WASM memory 使用 `initial === maximum`，禁止 growth | 保证 z8lua direct operators、TS/hardware 与 typed views 地址/生命周期一致 |
| ADR-014 | Accepted | 内部 canonical test PCM 使用 22050 Hz mono signed PCM16LE | 固定 deterministic audio golden 格式；不把它宣称为官方公开硬件规格，设备输出另测重采样 |
| ADR-015 | Accepted | 使用 08 定义的四 package DAG + web-player 三 execution domains，并机器阻断非法 import | 让 simulation、VM adapter 与浏览器设备边界成为可执行约束，而非目录命名约定 |
| ADR-016 | Accepted | 使用 pnpm workspace；精确版本在根 `packageManager` 字段 pin | 与既有稳定测试命令一致，并支持 package exports/project references 的单仓库边界 |
| ADR-017 | [Accepted](./adr/017-coroutine-frame-slice-and-fault-containment.md) | host-driven callback/custom frame slice、budget poison + Window watchdog；nested host suspension 明确 unsupported | 保证一次 step 至多一 slice、死循环不冻结 Window，且不伪造一般 nested async 已解决 |

每个 Proposed 项必须在依赖它的生产实现合并前转为 Accepted 或 Rejected。

## 2. 风险登记

| ID | 风险 | 概率 | 影响 | 触发信号 | 缓解与 fallback |
| --- | --- | --- | --- | --- | --- |
| R-01 | WASM→JS 高频 API 调用耗尽帧预算 | 低中（interop spike low；完整 Runtime 未测） | 高 | 16K `pset` 或 sprite stress p95 超预算 | ADR-006 raw ABI；在 Chrome/Chromium 持续 profile；按 ladder 下沉 memory/pixel/block hot paths，最后才评估 full core WASM |
| R-02 | z8lua 与 v0.2.7 仍有语义差异 | 中 | 高 | arithmetic/language conformance 与官方结果不同 | Pin patch set；向上游贡献；维护最小本地 patch 和对应测试 |
| R-03 | 错误构建配置启用 WASM memory growth，使 TS views 失效 | 低中 | 高 | artifact flags 漂移、随机 RAM corruption 或 detached/stale view | v1 固定 `initial === maximum`；CI 检查 flags/buffer identity；未来 growth 必须另立 ADR |
| R-04 | PNG decoder 破坏 low bits 或接受 bomb | 低中（Phase 0D bounded baseline passed） | 高 | cart hash 不一致、超大分配、decode hang | 原始 bytes parser、CRC/维度/长度上限、property/malformed regression、fixture hash 与 manifest |
| R-05 | AudioWorklet queue underrun，尤其移动 Chrome | 高 | 中高 | 爆音、静音、buffer 持续增长 | 帧对齐 PCM、预缓冲、bounded queue、必要时 SAB ring buffer |
| R-06 | fixed-point 值穿越 bridge 时被 JS float 改写 | 中 | 高 | edge arithmetic、fillp、peek4 golden 失败 | raw Q16.16 `int32` ABI、生成 binding、boundary tests |
| R-07 | P8SCII/Unicode 转换破坏 byte string | 高 | 中高 | `ord/sub/print`、emoji/custom font 失败 | 内部 byte string；只在明确 UI boundary 转 Unicode |
| R-08 | CPU budget 与官方 virtual CPU 差异 | 高 | 中高 | 某些 cart 过早中断或永不降帧 | 先做安全 instruction limit；逐步加入 calibrated cost model；记录差异 |
| R-09 | 多 cart `load()` 需要异步 host 数据 | 中 | 高 | cart 同步调用时 VM 无法 await | frame boundary `needsCart` 状态机；caller pre-supply；禁止 Lua 直接 fetch |
| R-10 | fake-08 算法来源存在混合许可证 | 中 | 高 | 复制代码但无法建立 provenance | 每个移植模块记录 source/commit/license；优先独立实现；发布前 NOTICE audit |
| R-11 | BBS 集成违反服务条款或作者权利 | 高（若直接实施） | 高 | 自动 fetch/caching 需求进入 core | 默认禁用；取得书面许可；resolver 分离；只用授权 fixtures |
| R-12 | 浏览器后台/刷新率策略改变模拟速度 | 中 | 中高 | 120Hz 加速、hidden 后追帧、input edge 丢失 | 独立 logical scheduler、bounded catch-up、明确 visibility policy |
| R-13 | Worker fault 恢复后残留 stale frame/audio | 中 | 中 | 新 session 显示旧帧或旧声音 | session generation ID、sequence number、丢弃 stale message、清空 audio queue |
| R-14 | API surface 太大导致“广而不准” | 高 | 中高 | 多数 API 存在无测试 stub | 按 vertical slice + conformance 交付；未知 stub 数作为 release gate |
| R-15 | 上游 z8lua direct `@/%/$` 与 v0.2.7 的 64KiB/remap 语义不完整 | 高 | 高 | upper RAM、跨界读或 GFX/SCREEN remap 与 `peek()` 不一致 | Pin 后维护最小 address-mapper patch；逐 byte multi-width conformance；记录 upstream provenance |
| R-16 | 异步 HostRequest 在 guest nested coroutine 中只 yield 给 guest caller | 已触发（Phase 0E） | 高（L3） | `reload/cstore` 返回错误值、被 `coresume` 吞掉或无法恢复 | root continuation 已通过；nested 固定 `E_FEATURE_UNSUPPORTED:nested-host-suspend`，只允许预供给/同步 cache，见 ADR-017 |
| R-17 | package 边界退化为 deep import、shared utils 或 concrete adapter 反向依赖 | 高 | 高 | cycle、core 出现 DOM global、main import VM、同一 state 多 owner | ADR-015；Phase 0S architecture tests、explicit exports、独立 tsconfig 与 negative fixtures |

## 3. Phase 0 必须回答的未决问题

### Q-01：interop 性能边界在哪里？

状态：**Phase 0C 已回答；Chrome/Chromium-only 浏览器范围已锁定**。
Chrome 150 / Apple M4 Pro 的 16K `pset`、65,536 `peek_poke`、4K `spr_8x8`
import p95 分别为 0.090/0.599/0.442 ms；80/80 correctness 与 fixed-buffer 门禁
通过。其他浏览器引擎不在支持范围，不要求补测，也不伪造数据。完整结果、raw ABI
规则和 fallback 见 [ADR-006](./adr/006-interop-hot-path-boundary.md) 与
[Phase 0C 证据](./14-phase-0c-evidence.md)。

必须测：

- scalar number-only calls。
- raw fixed-point calls。
- byte string calls。
- `pset/peek/poke/spr` 代表调用。
- Chrome/Chromium。

输出：每次调用成本、frame p50/p95/p99、热点下沉阈值和 ADR-006 的最终规则。

### Q-02：固定 z8lua WASM memory 应配置多大？

状态：**Phase 0B artifact 参数已回答，production sizing 仍需代表 cart corpus**。

v1 已决定 `initial === maximum` 并禁止 growth。Phase 0B 锁定 16 MiB linear
memory、默认 1 MiB per-context Lua heap cap，验证 binary descriptor、恶意
allocation、64 concurrent contexts、受控 OOM 与 typed-view identity。该结果足以
关闭 Shared RAM spike，但不以合成压力替代代表 cart 的峰值/余量数据；后续若调整
固定字节数，仍须更新 ADR/manifest，未来允许 growth 属于独立架构变更。

### Q-03：raw fixed-point ABI 如何暴露？

状态：**Phase 0E 已回答**。所有 P8 number 以 signed Q16.16 raw `int32` 过
`p8w_*`；`time()` test 已锁定 59/60 秒为 raw 64443，machine ABI 见
[`spec/abi/p8w-v1.json`](../spec/abi/p8w-v1.json)。optional/multi-return 的完整 API
schema 仍属于 ADR-008，不影响本阶段原始数值决定。

需要确认 z8lua `lua_Number` / `fix32` 在 C wrapper 中取得 raw bits 的稳定方式，并定义：

- `fix` 参数是 `int32 rawBits` 还是 float。
- optional/nil 的编码。
- multi-return 和 table 参数由哪一层处理。

默认答案应是 raw `int32`；任何 float ABI 都必须证明不影响 edge conformance。

### Q-04：API binding 是否生成？

需要用 5–10 个不同签名 API 做 schema prototype，确认：

- C wrapper 生成质量。
- TS type 与 runtime validation。
- string/table/multiple return/error path。
- stack balance tests。

若生成器复杂度高于收益，可以手写 C wrapper，但必须有 machine-readable API inventory 和 stack tests。

### Q-05：PNG inflate 依赖是什么？

状态：**已回答（Phase 0D，2026-08-05）**。

选择项目自有、runtime-neutral 的 bounded TypeScript zlib/DEFLATE decoder，不增加
第三方 runtime dependency，也不使用平台 `DecompressionStream`。它只为锁定的
131,405-byte PNG scanline 输出服务，支持 stored/fixed/dynamic blocks、RFC 1951
literal-only dynamic tree、32 KiB back-reference、zlib header/Adler-32，并在任何
写入前检查精确输出与配置上限。PNG 侧同时限制输入/chunk/IDAT、校验 CRC、支持
filter 0–4。许可证/provenance、fixtures 与错误门禁见
[ADR-005](./adr/005-lossless-p8png.md) 和 [Phase 0D 证据](./15-phase-0d-evidence.md)。

### Q-06：初始 renderer 是 Canvas2D 还是 WebGL？

由 Phase 0F 用同一 RGBA fixture 比较像素结果、nearest-neighbor、resize/context-loss 和 present p95。正确性基线优先 Canvas2D；若超预算或目标浏览器行为不可靠，再选择 WebGL。输出 ADR-009，Renderer interface 必须允许两者共享同一 RGBA/indexed-frame contract。

### Q-07：audio queue 是否需要 SharedArrayBuffer？

由 Phase 0F 先验证 Worker → dedicated `MessagePort` → AudioWorklet 的 transferable PCM + bounded queue，再验证必要时的 Window relay。只有目标浏览器 10 分钟稳态测试证明两者无法消除 underrun 时，才引入 SAB、COOP/COEP 和 ring buffer 的部署成本。输出 ADR-010 和部署前提，不得把三条路径同时留作未定义默认值。

### Q-08：如何校准 CPU？

安全目标与兼容目标分两阶段：

1. Phase 0 必须有 hard instruction budget，防止 Worker 永久挂起。
2. Phase 4 再用 conformance/reference capture 校准 `stat(1)`、built-in cost 和降帧行为。

不得因暂时无法精确模拟 CPU 而移除安全 budget。

### Q-09：z8lua pin 与最小 patch surface 是什么？

状态：**Phase 0A 范围已回答（2026-08-05）**。pin、branch 对比、source supply、
toolchain、base sandbox patch、allowlist、NOTICE、language fixture、100-context 与
artifact hash 见 [ADR-012](./adr/012-z8lua-source-and-phase-0a-wasm.md) 和
[Phase 0A 证据](./12-phase-0a-evidence.md)。`^` 已登记 Known Difference。

Q-09 中的 upper RAM、wrap、multi-byte 和 remap 子项已由 Phase 0B 回答，见
[ADR-013](./adr/013-shared-pico-ram-boundary.md) 与
[Phase 0B 证据](./13-phase-0b-evidence.md)：ordered patch 0002 只改 `lvm.c`，让
`@/%/$` 与项目唯一 mapper 收敛；lower/upper、negative、`0x7fff/0xffff`、
little-endian 和全部文档 video bases 回归通过。interop cost 后续已由
[Phase 0C](./14-phase-0c-evidence.md) 与 ADR-006 回答，不回填或扩张 Phase 0B ABI。

必须分别核对 `pico8` 与 `zepto8` branch，而不是只写仓库 URL。输出至少包括：

- 精确 commit、构建 hash、上游 license 和所启用的 library allowlist。
- `^` 运算、upper RAM、地址 wrap、`@/%/$` multi-byte 和 GFX/SCREEN remap 的 conformance 结果。
- 每个本地 patch 的目的、最小 diff、回归测试与是否已提交 upstream。
- 升级上游时自动重放 patch/conformance 的命令。

已核验的上游代码只能作为风险证据，最终 patch 必须针对项目实际 pin 重新确认。

### Q-10：HostRequest 能否跨所有 coroutine 层级恢复？

状态：**Phase 0E 已回答为 Go with constraints**。root callback continuation 的
byte-string request/response、stack 恢复与一次 slice 已通过；guest-created nested
coroutine 无可靠自然 bubbling，固定返回 `E_FEATURE_UNSUPPORTED`，reason 为
`nested-host-suspend`，且不会把 request 暴露给 host。L3 使用预供给/同步 cache；
一般 nested async 需要未来最小 VM/glue patch 和新 ADR，不使用 Asyncify。

原型必须覆盖：root callback、custom `flip()` loop、guest `cocreate/coresume` 内调用，以及错误被 guest 捕获的路径。只有能保持 Lua stack、continuation 和“一次且仅一次”副作用时，才可宣称一般异步 suspension。否则 L3 使用预加载/同步 repository，不能把 Promise 直接带入 WASM import。

### Q-11：如何机器执行源码边界？

状态：**已回答（Phase 0S，2026-08-05）**。

- TypeScript 7 composite project references 强制 package 与 execution-domain 编译边界。
- 本项目 checker 使用 `@babel/parser` 解析 TypeScript import/global surface，结合 package manifests、tsconfig libs、generated manifest 和 Node `node:test` 执行正反测试。
- `package.json#exports` 同时由 consumer compile、Node ESM resolution 和 deep-import rejection 验证。
- `pnpm run verify` 是本地与 CI 的统一阻断命令；clean install、工具版本、许可证与 15 项门禁证据见 [Phase 0S 完成证据](./11-phase-0s-evidence.md)。

## 4. Fallback ladder

当混合架构遇到性能或兼容阻塞时，按以下顺序升级，不允许直接跳到“全部 WASM”：

1. 去除 JS/WASM boundary allocation 与 object conversion。
2. 改用 raw numeric/string buffer ABI。
3. 批量处理只读输出，例如 frame/audio transfer。
4. 将 `peek/poke/memcpy/pset/pget` 等最热 primitive 放入 WASM。
5. 将 `spr/sspr/map/line` 等 block operation 放入 WASM。
6. 将 audio inner loop 放入 WASM，但保留 TS authoritative orchestration。
7. 只有完整 benchmark、维护成本和兼容数据证明需要，才另立 ADR 评估 full-core WASM。

## 5. 许可证与来源策略

- z8lua pin 必须记录 commit、license 和本地 patch。
- 每次从 fake-08/zepto8 移植算法时，在实现文件或 provenance 清单记录原路径、commit、license 和改动说明。
- 不根据仓库顶层 MIT 声明推断所有内嵌算法都是 MIT。
- 测试 cart 也必须记录作者、来源、许可和是否允许仓库再分发。
- 发布产物必须生成 NOTICE / third-party licenses 清单。

## 6. 新 ADR 模板

```md
# ADR-NNN: <title>

状态：Proposed | Accepted | Rejected | Superseded
日期：YYYY-MM-DD

## Context
要解决的可观察问题和约束。

## Decision
明确选择以及 MUST/MUST NOT。

## Evidence
官方依据、测试、benchmark、prototype 链接。

## Consequences
正面、负面和迁移影响。

## Rejected alternatives
候选方案和拒绝理由。
```
