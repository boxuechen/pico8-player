# `@pico8-player/cart-codec`

Runtime-neutral decoding of PICO-8 0.2.7 text `.p8` and lossless `.p8.png`
bytes. The public surface is deliberately one-way and synchronous:

```ts
decodeCart(input: Uint8Array, options?: CartDecodeOptions): ParsedCart
decodeP8(input: Uint8Array, options?: P8DecodeOptions): DecodedP8Cart
decodeP8Png(input: Uint8Array, options?: P8PngDecodeOptions): DecodedP8PngCart
```

Both formats share `ParsedCart`: raw-input SHA-256 identity, format/version,
caller-owned 32 KiB Cart ROM and Lua/P8SCII snapshots, immutable warnings and
bounded decode metadata. Use `version` and `code`; historical `cartVersion`/`luaSource` aliases have been removed. Failures are `CartCodecError` values with
stable `E_CART_*` codes and original-input byte offsets where applicable.

This package owns text header/section parsing, strict UTF-8→P8SCII conversion,
gfx/map/gff/music/sfx packing, PNG chunks/CRC, bounded zlib/DEFLATE, scanline
unfiltering, RGBA low-bit extraction and raw/legacy/PXA code decoding. Format
detection checks byte magic. The package does not own files, URLs, BBS access,
DOM/image/Canvas decoding, include resolution, Runtime state, WASM or cart
loading. The machine-readable profile and limits are in
`spec/cart-codec-contract.json`; source/provenance locking is in
`manifest.lock.json`.

The returned typed arrays are independent snapshots, but TypeScript cannot
make their elements immutable. Consumers must treat them as read-only or copy
them when creating mutable overlays.
