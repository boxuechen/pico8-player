# ADR-005：从原始 bytes 以 bounded TS codec 无损解码 `.p8.png`

- 状态：Accepted（Phase 0D）
- 日期：2026-08-05
- 决策范围：`.p8.png` PNG/cart payload/code source 解码
- 证据：[Phase 0D 完成证据](../evidence/phase-0/15-phase-0d-evidence.md)
- 机器契约：[`spec/cart-codec-contract.json`](../../spec/cart-codec-contract.json)

## 1. 决策

`@pico8-web/cart-codec` 从 caller 提供的 `Uint8Array` 直接解码 `.p8.png`，公共入口
为 `decodeP8Png()`。实现使用项目自有 TypeScript PNG、zlib/DEFLATE 与 cart code
decoder；不使用 Canvas、`<img>`、`ImageBitmap`、`DecompressionStream`、DOM、
network、filesystem 或第三方 runtime decoder。

支持 profile 被刻意锁窄为：

- PNG `160×205`、bit depth 8、color type 6（RGBA）、compression/filter method 0、
  non-interlaced；支持 scanline filter 0–4 和任意连续 IDAT 分割。
- PNG signature、chunk bounds/order/type/CRC32、IHDR/PLTE/IDAT/IEND、zlib
  header/Adler-32、stored/fixed/dynamic DEFLATE 和 32 KiB window back-reference。
- RFC 1951 合法的 literal-only dynamic block 可以声明没有 distance code；一旦该
  block 使用 length symbol 则结构化失败。
- 每 pixel 从原始 RGBA bytes 提取
  `((a&3)<<6)|((r&3)<<4)|((g&3)<<2)|(b&3)`。32,800 pixels 对应
  `0x8020` payload bytes；只消费 32 KiB ROM 与 offset `0x8000` 的 cart version，
  31 个 reserved bytes 不进入公共结果。
- code block 位于 ROM `0x4300..0x7fff`，支持 raw NUL termination、legacy
  `:c:\0` 与 current `\0pxa`；输出保持 `Uint8Array`，不做 Unicode 转换。

官方手册明确 `.p8.png` 是 cart 格式，并给出 32 KiB cart、15,360-byte compressed
code 上限；官方 BBS 中 zep 说明 160×205 pixels 与每个 RGBA channel 最低两位的
payload 编码。PNG/zlib/DEFLATE 的通用结构分别以 W3C PNG 3rd Edition、RFC 1950
与 RFC 1951 为准。

## 2. API 与所有权

```ts
decodeP8Png(
  input: Uint8Array,
  options?: P8PngDecodeOptions,
): DecodedP8PngCart
```

返回值包括固定 32 KiB `rom`、解压后的 `luaSource`、cart version、code compression
mode 与审计 metadata。`rom`/`luaSource` 是每次调用独立的 caller-owned snapshot；
TypeScript 无法冻结 typed-array 元素，consumer 必须把它们当只读数据或显式 copy。
codec 不返回完整 payload、reserved bytes、label image、live internal buffer 或
CartLoader/Runtime state。

失败使用 `CartCodecError` 和稳定的 `E_CART_*` code，offset/details 只含安全的
结构化诊断。未知 critical chunk、future cart version、CRC/order/format 错误、
invalid back-reference 和输出超限都 fail closed。

## 3. 资源上限

默认上限是 API contract，不是实现提示：

| 资源 | 默认上限 |
| --- | ---: |
| 原始输入 | 1,048,576 bytes |
| PNG chunks | 128 |
| IDAT 合计 | 262,144 bytes |
| inflate 输出 | 精确且最多 131,405 bytes |
| code 输出 | 65,535 bytes |
| cart version | 42（PICO-8 0.2.7 target） |

inflate 在开始前按 IHDR 计算固定输出，分配精确容量；任何 literal/stored copy 或
back-reference 越界都在写入前失败。PXA/legacy 同样先检查 header、bit read、
distance、length 与 configured output limit。调用者可以进一步收紧上限，但不能
绕过格式固定尺寸。

## 4. 边界与非目标

Phase 0D 只负责 lossless bytes→ROM/source：

- 不实现 `.p8` text parser、include、section packing 或 `.p8.rom` loader。
- 不读取 File/URL/BBS，不依据 filename/media type 猜格式。
- 不实例化 z8lua、不写 Pico RAM、不定义 cold boot/reset/reload/cstore。
- 不显示 label、画面或 UI，不包含 Canvas fallback。
- 不把 `fake-08`/`zepto8` 变成规范 oracle 或 production dependency。

未来 `.p8` 与 CartLoader 必须作为该 package 的独立 public layer 增量实现；
RuntimeCore 只能消费公共 export，禁止 deep import PNG/code internals。

## 5. 来源、实现与许可证

production codec 和 synthetic fixtures 均为项目原创；Phase 0D 没有引入新第三方
runtime code 或 dependency。格式细节曾与本地锁定的 fake-08
`814991a…/source/cart.cpp`（MIT component）和 zepto8
`b2929a4…/src/pico8/{cart,code}.cpp`（WTFPL-2.0）交叉检查，但没有复制、翻译或
import 其源码。精确登记由 `packages/cart-codec/manifest.lock.json` 机器验证。

## 6. 被拒绝的方案

- **Canvas/image decoder：Rejected。** 色彩管理或 alpha premultiply 可破坏最低位；
  还会把 pure codec 绑定 DOM。
- **平台 `DecompressionStream`：Rejected。** 增加平台边界，难以执行精确输出与
  DEFLATE 错误分类，也不利于 pure Node/property tests。
- **第三方 PNG library：Rejected for Phase 0D。** 锁定 profile 很小，项目自有
  bounded 实现减少 dependency/license surface；若未来扩展 PNG profile，必须以
  新 ADR 重新评估。
- **WASM decoder：Rejected for Phase 0D。** 当前 workload 固定且不在帧热路径，
  没有性能证据支持新增 WASM ABI/构建面。

## 7. 重新打开条件

出现以下任一情况时重新打开 ADR-005：官方导出的 0.2.7 cart 使用当前拒绝的合法
PNG/DEFLATE 形式；授权 differential 显示 payload/code byte mismatch；fuzz 找到
hang/OOB/无界资源；Chrome/Chromium profile 证明 TS codec 是实际装载瓶颈；或产品
需要写 cart、显示 label、支持其他 PICO-8/cart version。不得以悄悄放宽 parser
profile 或错误上限代替 ADR。
