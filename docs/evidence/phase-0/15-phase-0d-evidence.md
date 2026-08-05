# Phase 0D 完成证据

> 日期：2026-08-05
> 实现基线：`6fd43f221325163ddc819a8b6cb3f83741aa2474`
> 决策：[ADR-005](../../adr/005-lossless-p8png.md)
> 机器契约：[`spec/cart-codec-contract.json`](../../../spec/cart-codec-contract.json)
> 锁定清单：[`packages/cart-codec/manifest.lock.json`](../../../packages/cart-codec/manifest.lock.json)

## 1. 结论

Phase 0D 已完成一个 bounded、runtime-neutral、lossless 的 `.p8.png` decoder。
`@pico8-web/cart-codec` 现在公开 `decodeP8Png(Uint8Array)`、typed result/options、
stable constants 与 `CartCodecError`；它从原始 bytes 得到独立 32 KiB Cart ROM 与
Lua/P8SCII byte source，不依赖 DOM、Canvas、image decoder、network、filesystem、
WASM 或平台 inflate。

本阶段只完成 bytes→ROM/source。`.p8` text cart、label presenter、CartLoader、
Base RAM load/reset/reload/cstore、z8lua execution、BBS resolver 与 Player UI 均未被
实现或暗中加入 codec。下一独立阶段是 Phase 0E coroutine frame slice。

浏览器范围同时收敛为 **仅 Chrome/Chromium**：它是后续 browser/release 唯一
阻断引擎。新的 Phase 0C runner 只写 Chromium/Node availability；旧结果中的
Firefox/WebKit 字段保留为历史原始数据，不是待补测项，也不形成支持声明。

## 2. 锁定 contract

| 项目 | Phase 0D contract |
| --- | --- |
| PNG | signature + bounded chunks + CRC32；160×205 RGBA8、method 0、non-interlaced |
| IDAT | 连续 chunk 拼接；默认合计 ≤ 262,144 bytes |
| zlib/DEFLATE | header/FDICT/Adler-32；stored/fixed/dynamic；bounded 32 KiB backref |
| scanlines | 精确 131,405 bytes；filter 0/1/2/3/4 |
| payload | 32,800 pixels/bytes；RGBA low-bit formula byte-exact |
| consumed payload | ROM `0x0000..0x7fff` + version `0x8000`；reserved 31 bytes 不暴露 |
| target version | PICO-8 0.2.7 cart version ≤ 42，future version fail closed |
| code | ROM offset `0x4300`；raw NUL、legacy `:c:\0`、current `\0pxa` |
| public ownership | 每次调用返回独立 snapshots；无 live internal/payload view |
| 默认 input/chunk 上限 | 1 MiB / 128 chunks；调用者只可进一步配置 bounded limits |
| code 输出上限 | 默认 65,535 bytes；header/bit/distance/length/write 全部先验检查 |

22 个 `E_CART_*` code 区分 argument/limits、PNG signature/truncation/chunk/CRC/order/
format、zlib/DEFLATE/inflate/filter、payload/version 和 code corruption/size。错误不以
任意 `Error.message` 作为机器协议。

## 3. 有效向量与 byte-exact 证据

fixtures 全部由本项目 deterministic generator 在内存中构造，不包含官方或第三方
cart 内容：

| Vector | PNG/DEFLATE | filter/IDAT | code | ROM SHA-256 | Lua SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `raw-stored-filter-cycle` | stored | filter 0–4 cycle / 3 IDAT | raw + NUL | `9eacb718…d793` | `bc7b9934…e207` |
| `legacy-fixed-backref` | fixed Huffman | Paeth / 1 IDAT | legacy overlapping backref | `fda649e6…e9a7` | `76b99ab4…51c3e` |
| `pxa-dynamic-mtf-backref` | dynamic Huffman | Sub / 3 IDAT | PXA MTF + backref | `41497214…988d` | `bbb59da3…e1c2c` |

额外手工 bitstream 覆盖 RFC 1951 literal-only dynamic tree（distance code length 0）；
PXA 另有 literal sequence；raw 覆盖 embedded NUL termination、version 0 与 byte
boundary。16 组 RGBA high-bit property vector 在保持 channel low bits 时得到相同
ROM/source，证明 payload 不受展示色值影响。

## 4. 失败、资源与架构门禁

自动 regression 覆盖：

- signature、truncated chunk、伪造 length、CRC、IHDR/order、unknown critical chunk、
  non-consecutive IDAT 与 IEND trailing bytes。
- 非 160×205、非 RGBA8、非 method 0、interlaced、filter byte >4。
- zlib header/FDICT、Adler-32、reserved DEFLATE block、stored LEN/NLEN、invalid
  Huffman/repeat/symbol/back-reference、trailing compressed bytes。
- input/chunk/IDAT/inflate/code/version limits；一个在小 PNG 中压缩 1,000,000-byte
  suffix 的 bomb 在写出第 131,406 byte 前以 `E_CART_PNG_INFLATE_LIMIT` 失败。
- corrupt/truncated legacy/PXA header、bitstream、distance/length；code output cap。
- architecture negative fixture 阻断 `document`、Canvas、ImageBitmap、
  `createImageBitmap` 与 `DecompressionStream`；package checker 也已阻断
  Window/network/File/`ref` import 与非法 DAG edge。
- consumer fixture 只通过 package root import typed API；deep import 仍失败。

decoder 只分配固定 RGBA/scanline/payload/ROM/code buffers；IDAT 总量和 chunk 数在
拼接前累计检查。DEFLATE/PXA/legacy 没有按攻击者声明执行无界 grow。

## 5. 来源与许可证

规范/事实来源：

- [PICO-8 0.2.7 manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)：cart
  格式与 32 KiB / compressed-code 上限。
- [zep 的官方 BBS 格式说明](https://www.lexaloffle.com/bbs/?pid=41282)：160×205
  pixels，以及 RGBA 各 channel 最低两位组成一个 payload byte。
- [W3C PNG 3rd Edition](https://www.w3.org/TR/png-3/)、[RFC 1950](https://www.rfc-editor.org/rfc/rfc1950.html)、
  [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951.html)：PNG/filter/zlib/DEFLATE contract。

本地 fake-08 `814991a…/source/cart.cpp` 与 zepto8
`b2929a4…/src/pico8/{cart,code}.cpp` 仅用于格式交叉检查。production/test graph 不读
`ref/`，实现与 fixtures 没有复制或翻译参考源码。Phase 0D 没有增加第三方 runtime
dependency；source/contract/fixture hashes 与交叉检查用途由 manifest verifier 锁定。

## 6. 可复现命令

实现基线实际通过：

```text
pnpm run test:cart-codec
pnpm run test:architecture
pnpm run test:public-exports
pnpm run test:benchmark
pnpm run verify
pnpm run benchmark:interop:chromium -- --smoke --output /tmp/p8w-phase0d-chromium-scope-smoke.json
```

结果为 12/12 cart-codec、16/16 architecture、23/23 Phase 0A/0B WASM、4/4
Phase 0C regression、consumer TypeScript compile、双构建 reproducibility 与两个
manifest verifier 全部通过。cart manifest 同时核对 5 个 production source、
contract/fixture hashes、dependency surface 和 `ref/` 隔离。

真实 Headless Chrome 150 DedicatedWorker smoke 为 32/32 cases correctness passed；
结果 availability 只有 `chromium: measured` 与 `node: not-run`，证明 runner 已按新
范围停止探测/报告其他引擎。`/tmp` smoke 只作本任务验证，不作为新的性能 baseline。

从文档提交 `209200e13157d9cef2b43cd6c63d383b31b27270` 执行
`git clone --no-local` 后，使用 `.node-version` 指定的 Node 22.22.2 与 pnpm 10.8.0
完成 frozen install 和统一 `pnpm run verify`：12/12 cart-codec、16/16
architecture、23/23 Phase 0A/0B、4/4 Phase 0C、双构建 reproducibility 与两个
manifest verifier 全部通过；验证后的 clean checkout `git status --porcelain` 为空。
