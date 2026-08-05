# `@pico8-web/cart-codec`

Runtime-neutral, lossless decoding of PICO-8 0.2.7 `.p8.png` bytes. The Phase
0D public surface is deliberately one-way:

```ts
decodeP8Png(input: Uint8Array, options?: P8PngDecodeOptions): DecodedP8PngCart
```

It returns a caller-owned 32 KiB Cart ROM snapshot, decoded Lua/P8SCII bytes,
cart version and bounded decode metadata. Failures are `CartCodecError` values
with stable `E_CART_*` codes.

This package owns PNG chunks/CRC, bounded zlib/DEFLATE, scanline unfiltering,
RGBA low-bit extraction and raw/legacy/PXA code decoding. It does not own
files, URLs, BBS access, DOM/image/Canvas decoding, Runtime state, WASM or cart
loading. The machine-readable profile and limits are in
`spec/cart-codec-contract.json`; source/provenance locking is in
`manifest.lock.json`.

The returned typed arrays are independent snapshots, but TypeScript cannot
make their elements immutable. Consumers must treat them as read-only or copy
them when creating mutable overlays.
