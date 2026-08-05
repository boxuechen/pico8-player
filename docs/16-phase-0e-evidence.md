# Phase 0E 完成证据

> 日期：2026-08-05
> 初始实现基线：`033dabb6d766a35ec29a65826a391fc5938006f6`；官方 clock 差分修订与本文同提交
> 决策：[ADR-017](./adr/017-coroutine-frame-slice-and-fault-containment.md)
> ABI：[`spec/abi/p8w-v1.json`](../spec/abi/p8w-v1.json)
> Runtime contract：[`spec/phase-0e-runtime-contract.json`](../spec/phase-0e-runtime-contract.json)
> artifact lock：[`wasm/runtime-v1.manifest.lock.json`](../wasm/runtime-v1.manifest.lock.json)

## 1. 结论

Phase 0E 已完成一个 production-named、bounded 的 coroutine frame-slice vertical
slice。`@pico8-web/runtime-core` 通过 `FrameVmPort` 驱动 concrete
`Z8LuaFrameVm`；callback cart 和 top-level custom `flip()` cart 都只能由 host
显式推进。Runtime 以 committed simulation slice 计算 Q16.16 `time()`，持有 input
snapshot 和 HostRequest transaction；z8lua adapter 持有固定 64 KiB Base RAM、VM
handle、stack/continuation 与错误 buffer。

Window ↔ Worker v1 DTO 只包含 `loadCart/step/hostResponse/dispose` 和对应
`ready/frame/hostRequest/stopped/fault/disposed`。`loadCart` 只消费 Phase 0D 公共
`decodeP8Png`，没有增加 `.p8`、URL/BBS resolver 或通用 CartLoader。renderer、audio、
真实 input frontend、persistence 和 Player UI 继续属于后续 phase。

## 2. 可观察 lifecycle

| Path | 已锁定行为 |
| --- | --- |
| callback boot | 执行 top-level；返回后 `_init()` 一次；`_update60` 优先于 `_update` |
| callback step | 一个 update + 一个 draw；60 次手动 step 精确得到 60/60 |
| draw-only | 30 Hz frame slice；没有 callback 时进入 stopped |
| startup clock | top-level/`_init` 在 `1/30s`；30 Hz boot commit 1 slice，60 Hz boot commit 2 slices |
| custom boot | top-level 首次 `flip()` 建立 boundary 并 commit 30 Hz startup slice；不调用 `_init` |
| custom step | continuation 到下一个 `flip()`；60 次 step 精确到达 60 个新 boundary |
| logical time | step 用 `completedSlices+1` 计算；到达 frame boundary 后 commit，同 slice 不变 |
| input | 每 step 只读取传入的 P1 bits 0..5；不直接读 Window/device |
| framebuffer | `cls/pset` 写 canonical mapped screen RAM；event copy 8192-byte packed 4bpp |

项目原创 callback `.p8.png` fixture 经 Phase 0D codec 后 boot。60 Hz startup 对应
2 slices；第 60 个 host step 以 slice 62 执行，`timeRaw=67720`，commit 后
`completedSlices=62`；
`_init/update/draw` RAM counters 为 `1/60/60`，最终 packed screen SHA-256 为
`9627762b606887336f881c14c4e14c6384f699baece8e96f13c70ee1ba6915b6`。

## 3. 故障与恢复证据

- count hook quantum=1；budget exhaustion 先 poison 再抛错。无限 loop 返回
  `E_VM_INSTRUCTION_BUDGET`，state 为 `FAULTED`，后续 step 返回 invalid state。
- Lua error 保留 stable phase、`@cart.p8` line 与 sanitized trace；测试确认不含本地
  `/Users/...` path。
- root HostRequest 的 embedded-NUL request/response 以 byte length 往返；response
  后继续同一 callback，再完成 draw/frame，completed slice 只增加一次。
- nested `cocreate/coresume` 中的 `flip`/HostRequest 不发出 host-visible request，
  在 root 下一 instruction 被 sentinel 终止，结构化结果为
  `E_FEATURE_UNSUPPORTED { reason: "nested-host-suspend" }`。
- fake Worker unit test 证明 command deadline 会 terminate、generation 1→2、忽略
  generation 1 stale event，并允许 generation 2 新 load。
- 真实 Headless Google Chrome 150 module Worker 先执行 60 个 callback steps，再在
  Worker 内进入 count hook 无法中断的 JS infinite loop；Window 定时器仍触发
  `E_VM_WATCHDOG`、terminate/recreate，generation 从 1 变 2，新 Worker 随后成功
  load 和 step。

Chrome/Chromium 是唯一浏览器门禁；没有运行或承诺 Firefox/WebKit。

## 4. ABI、artifact 与边界

`z8lua-runtime-v1` 只导出 28 个 `p8w_*` operation 和 Emscripten runtime support；
verifier 从 Wasm binary export table 断言不存在 `p8w0a_*`、`p8w0b_*` 或
`p8w0c_bench_*`。Phase 0C benchmark 继续使用单独 `z8lua-phase-0c` artifact，旧
hash/manifest 不因 production runtime 改动而漂移。

production artifact 保持 Emscripten 6.0.5、16 MiB `initial === maximum`、growth/
filesystem/dynamic execution off。runtime manifest 锁定 source、ABI、limits、byte
length 与 SHA-256；repro verifier 对 benchmark 和 runtime 两组 `.mjs/.wasm` 做双
clean build byte comparison。

Package 边界保持：contracts 只拥有 stable DTO/error/input；RuntimeCore 只认识
`FrameVmPort`；z8lua-bridge 对 RuntimeCore 是 type-only edge；Worker composition
root 才实例化 codec/runtime/adapter。async Worker installer 在 WASM promise resolve
前同步注册 listener 并串行 queue，防止首条 `loadCart` 与 module startup race。

## 5. 官方语义与明确限制

官方 0.2.7 手册明确 callback 频率、`time()` 的 simulation-time 性质、`flip()` custom
loop boundary、`cls/pset/btn` 基本语义与 coroutine 的 direct resume behavior。手册
未明确的 startup 偏移已通过官方 BBS Web Player 0.2.7 差分闭合：custom 30 Hz 得到
`[1,2,3,4,5,6,7,8]`；callback 30 Hz 的 top-level、`_init`、前六次 update 得到
`[1,1,2,3,4,5,6,7]`；callback 60 Hz 得到 `[2,2,3,4,5,6,7,8]`。

三个 probe source 和生成的 `.p8.png` 均为项目原创。研究 runner 在隔离 Chrome profile
中打开真实官方 widget，只替换本次 `get_cart.php` response，不上传数据、不修改 BBS；
官方 player/widget 调试下载只留在 gitignored `ref/`。仓库只提交结构化 capture、原创
source 与纯 probe framebuffer 截图：
[`phase-0e-official-clock.json`](./evidence/phase-0e-official-clock.json)。

其他已知限制：custom loop 暂定 30 Hz；没有官方 CPU cost accounting；nested 一般
async host suspension unsupported；`__p8w_probe_host_request` 不是 guest public API；
`cls/pset` 只实现本 slice 所需颜色/边界写入，不代表 graphics conformance 完成。

## 6. 验证命令

```text
pnpm run typecheck
pnpm run test:architecture
pnpm run test:phase-0e
pnpm run verify:wasm
pnpm run verify
```

官方 Web Player 差分是显式、非 hermetic 的研究命令，不放入日常 CI：

```text
node tools/research/capture-official-phase-0e.mjs
node tools/research/capture-official-phase-0e.mjs --callback-startup
node tools/research/capture-official-phase-0e.mjs --callback60-startup
```

本次官方 clock 修订在当前工作树完成 `pnpm run verify`：Phase 0E Node suite 为
11/11，并通过真实 Chrome 60-step + watchdog/recovery gate；
architecture consumer fixture 已只经 package exports 编译新 public API。完整 clean
checkout 从实现基线执行 `git clone --no-local`，在无 `node_modules`/`dist` 的副本中
完成 `pnpm install --frozen-lockfile` 和 `pnpm run verify`：12/12 cart-codec、16/16
architecture、23/23 Phase 0A/0B、4/4 Phase 0C、10/10（初始基线）Phase 0E、两组 Wasm 双 clean
reproducibility、两个 artifact manifest 与真实 Chrome gate 全部通过；验证后 clone
的 `git status --porcelain` 为空。临时 clone 已移入 macOS Trash，可恢复后清理。
