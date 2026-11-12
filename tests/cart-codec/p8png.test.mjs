import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import {
  CART_CODEC_ERROR_CODES,
  CartCodecError,
  DEFAULT_P8PNG_LIMITS,
  P8PNG_CODE_OFFSET,
  P8PNG_HEIGHT,
  P8PNG_PAYLOAD_BYTES,
  P8PNG_USED_PAYLOAD_BYTES,
  P8PNG_WIDTH,
  decodeP8Png,
} from "@pico8-web/cart-codec";
import {
  chunkOffsets,
  corruptByte,
  makeChunk,
  makeLiteralOnlyDynamicPng,
  makeP8Png,
  makePxaLiteralCode,
} from "../fixtures/p8png/fixture-builder.mjs";

let fixtureManifest;

before(async () => {
  fixtureManifest = JSON.parse(
    await readFile(new URL("../fixtures/p8png/manifest.json", import.meta.url), "utf8"),
  );
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function throwsCode(code) {
  return (error) => error instanceof CartCodecError && error.code === code;
}

test("machine-readable contract constants and error inventory are stable", async () => {
  const contract = JSON.parse(
    await readFile(new URL("../../spec/cart-codec-contract.json", import.meta.url), "utf8"),
  );
  assert.equal(P8PNG_WIDTH, contract.png.width);
  assert.equal(P8PNG_HEIGHT, contract.png.height);
  assert.equal(P8PNG_PAYLOAD_BYTES, contract.payload.totalBytes);
  assert.equal(P8PNG_USED_PAYLOAD_BYTES, contract.payload.usedBytes);
  assert.equal(P8PNG_CODE_OFFSET, contract.payload.codeOffset);
  assert.deepEqual(CART_CODEC_ERROR_CODES, contract.errorCodes);
  assert.deepEqual(DEFAULT_P8PNG_LIMITS, contract.defaultLimits);
});

test("project-owned raw/legacy/PXA vectors decode byte-exact across stored/fixed/dynamic DEFLATE", () => {
  const expectedBlockTypes = { stored: 0, fixed: 1, dynamic: 2 };
  for (const vector of fixtureManifest.vectors) {
    const fixture = makeP8Png(vector);
    assert.equal(fixture.deflateBlockType, expectedBlockTypes[vector.zlibMode], vector.id);
    const decoded = decodeP8Png(fixture.png);
    assert.equal(decoded.format, "p8.png");
    assert.equal(decoded.width, 160);
    assert.equal(decoded.height, 205);
    assert.equal(decoded.version, vector.cartVersion);
    assert.equal(decoded.codeCompression, vector.compression);
    assert.deepEqual(decoded.rom, fixture.rom, `${vector.id} ROM`);
    assert.deepEqual(decoded.code, fixture.code, `${vector.id} source`);
    assert.equal(decoded.identity.contentSha256, sha256(fixture.png));
    assert.deepEqual(decoded.warnings, []);
    assert.equal(sha256(decoded.rom), vector.romSha256, `${vector.id} ROM hash`);
    assert.equal(sha256(decoded.code), vector.luaSha256, `${vector.id} source hash`);
    assert.ok(decoded.pngChunkCount >= 4);
    assert.ok(decoded.pngIdatBytes > 0);
  }
});

test("all PNG filters and split IDAT preserve low-bit payload independently of channel high bits", () => {
  const vector = fixtureManifest.vectors[0];
  const referenceFixture = makeP8Png(vector);
  const reference = decodeP8Png(referenceFixture.png);
  assert.equal(reference.pngChunkCount, 6, "IHDR + tEXt + three IDAT + IEND");
  for (let highBitsVariant = 1; highBitsVariant <= 16; highBitsVariant += 1) {
    const decoded = decodeP8Png(makeP8Png(vector, { highBitsVariant }).png);
    assert.deepEqual(decoded.rom, reference.rom, `high-bit variant ${highBitsVariant}`);
    assert.deepEqual(decoded.code, reference.code);
  }
});

test("decoder returns caller-owned snapshots and never exposes reserved payload bytes", () => {
  const vector = fixtureManifest.vectors[0];
  const first = decodeP8Png(makeP8Png(vector, { highBitsVariant: 1 }).png);
  const second = decodeP8Png(makeP8Png(vector, { highBitsVariant: 2 }).png);
  assert.notEqual(first.rom, second.rom);
  assert.notEqual(first.code, second.code);
  first.rom[0] ^= 0xff;
  assert.notEqual(first.rom[0], second.rom[0]);
  assert.equal("payload" in first, false);
  assert.equal("reservedPayload" in first, false);
});

test("signature, truncation, chunk length, CRC, order and critical chunks fail closed", () => {
  const vector = fixtureManifest.vectors[0];
  const fixture = makeP8Png(vector);
  assert.throws(() => decodeP8Png(corruptByte(fixture.png, 0)), throwsCode("E_CART_PNG_SIGNATURE"));
  assert.throws(() => decodeP8Png(fixture.png.subarray(0, fixture.png.length - 1)), throwsCode("E_CART_PNG_TRUNCATED"));

  const firstIdat = chunkOffsets(fixture.png).find(({ type }) => type === "IDAT");
  assert.ok(firstIdat);
  assert.throws(
    () => decodeP8Png(corruptByte(fixture.png, firstIdat.dataOffset)),
    throwsCode("E_CART_PNG_CRC"),
  );

  const critical = makeP8Png(vector, {
    insertChunk: { index: 1, chunk: makeChunk("ABCD", Uint8Array.of(1)) },
  });
  assert.throws(() => decodeP8Png(critical.png), throwsCode("E_CART_PNG_CRITICAL_CHUNK"));

  const separatedIdat = makeP8Png(vector, {
    insertChunk: { index: 3, chunk: makeChunk("tEXt", Uint8Array.of(1)) },
  });
  assert.throws(() => decodeP8Png(separatedIdat.png), throwsCode("E_CART_PNG_ORDER"));
});

test("IHDR profile is exactly 160x205 RGBA8 non-interlaced", () => {
  const vector = fixtureManifest.vectors[0];
  assert.throws(
    () => decodeP8Png(makeP8Png(vector, { ihdr: { width: 159 } }).png),
    throwsCode("E_CART_PNG_DIMENSIONS"),
  );
  for (const ihdr of [{ bitDepth: 16 }, { colorType: 2 }, { compression: 1 }, { filter: 1 }, { interlace: 1 }]) {
    assert.throws(
      () => decodeP8Png(makeP8Png(vector, { ihdr }).png),
      throwsCode("E_CART_PNG_FORMAT"),
    );
  }
});

test("zlib header, Adler-32 and scanline filter corruption remain distinguishable", () => {
  const vector = fixtureManifest.vectors[0];
  const badHeader = makeP8Png(vector, {
    mutateZlib(bytes) {
      const result = bytes.slice();
      result[0] ^= 1;
      return result;
    },
  });
  assert.throws(() => decodeP8Png(badHeader.png), throwsCode("E_CART_PNG_ZLIB"));

  const presetDictionary = makeP8Png(vector, {
    mutateZlib(bytes) {
      const result = bytes.slice();
      result[1] = 0x20;
      return result;
    },
  });
  assert.throws(() => decodeP8Png(presetDictionary.png), throwsCode("E_CART_PNG_ZLIB"));

  const badAdler = makeP8Png(vector, {
    mutateZlib(bytes) {
      const result = bytes.slice();
      result[result.length - 1] ^= 1;
      return result;
    },
  });
  assert.throws(() => decodeP8Png(badAdler.png), throwsCode("E_CART_PNG_ZLIB"));

  const reservedDeflateBlock = makeP8Png(vector, {
    mutateZlib(bytes) {
      const result = bytes.slice();
      result[2] = ((result[2] ?? 0) & ~6) | 6;
      return result;
    },
  });
  assert.throws(
    () => decodeP8Png(reservedDeflateBlock.png),
    throwsCode("E_CART_PNG_DEFLATE"),
  );

  const badStoredLength = makeP8Png(vector, {
    mutateZlib(bytes) {
      const result = bytes.slice();
      result[5] ^= 1;
      return result;
    },
  });
  assert.throws(() => decodeP8Png(badStoredLength.png), throwsCode("E_CART_PNG_DEFLATE"));
  assert.throws(
    () => decodeP8Png(makeP8Png(vector, { invalidFilter: true }).png),
    throwsCode("E_CART_PNG_FILTER"),
  );
});

test("input, chunk, IDAT, inflate and code limits are enforced before unbounded growth", () => {
  const vector = fixtureManifest.vectors[0];
  const fixture = makeP8Png(vector);
  assert.throws(
    () => decodeP8Png(fixture.png, { limits: { maximumInputBytes: fixture.png.length - 1 } }),
    throwsCode("E_CART_INPUT_TOO_LARGE"),
  );
  assert.throws(
    () => decodeP8Png(fixture.png, { limits: { maximumChunks: 1 } }),
    throwsCode("E_CART_PNG_CHUNK_LIMIT"),
  );
  assert.throws(
    () => decodeP8Png(fixture.png, { limits: { maximumIdatBytes: 1 } }),
    throwsCode("E_CART_PNG_IDAT_LIMIT"),
  );
  assert.throws(
    () => decodeP8Png(fixture.png, { limits: { maximumInflatedBytes: 1 } }),
    throwsCode("E_CART_PNG_INFLATE_LIMIT"),
  );
  assert.throws(
    () => decodeP8Png(fixture.png, { limits: { maximumCodeBytes: 5 } }),
    throwsCode("E_CART_CODE_TOO_LARGE"),
  );
  assert.throws(
    () => decodeP8Png(fixture.png, { limits: { maximumChunks: 0 } }),
    throwsCode("E_CART_LIMITS"),
  );

  const compressedBomb = makeP8Png(fixtureManifest.vectors[2], {
    inflateSuffixBytes: 1_000_000,
  });
  assert.ok(compressedBomb.png.length < DEFAULT_P8PNG_LIMITS.maximumInputBytes);
  assert.throws(
    () => decodeP8Png(compressedBomb.png),
    throwsCode("E_CART_PNG_INFLATE_LIMIT"),
  );
});

test("future cart versions and corrupt legacy/PXA code streams fail with structured errors", () => {
  const raw = fixtureManifest.vectors[0];
  assert.throws(
    () => decodeP8Png(makeP8Png(raw, { cartVersion: 44 }).png),
    throwsCode("E_CART_FUTURE_VERSION"),
  );

  const legacy = fixtureManifest.vectors[1];
  const badLegacy = Uint8Array.from([
    0x3a, 0x63, 0x3a, 0,
    0, 2, 0, 0,
    0x3c, 0,
  ]);
  assert.throws(
    () => decodeP8Png(makeP8Png(legacy, { codeBlockOverride: badLegacy }).png),
    throwsCode("E_CART_CODE_CORRUPT"),
  );

  const pxa = fixtureManifest.vectors[2];
  const badPxa = Uint8Array.from([
    0, 0x70, 0x78, 0x61,
    0, 1, 0x3d, 1,
  ]);
  assert.throws(
    () => decodeP8Png(makeP8Png(pxa, { codeBlockOverride: badPxa }).png),
    throwsCode("E_CART_CODE_CORRUPT"),
  );
});

test("raw NUL termination, cart version zero and PXA literal sequences preserve byte boundaries", () => {
  const raw = fixtureManifest.vectors[0];
  const rawCodeBlock = Uint8Array.from([0x61, 0x62, 0x63, 0, 0x64, 0x65, 0x66]);
  const decodedRaw = decodeP8Png(makeP8Png(raw, {
    cartVersion: 0,
    codeBlockOverride: rawCodeBlock,
  }).png, { limits: { maximumCartVersion: 0 } });
  assert.deepEqual(decodedRaw.code, Uint8Array.from([0x61, 0x62, 0x63]));
  assert.equal(decodedRaw.compressedCodeBytes, 4);
  assert.equal(decodedRaw.version, 0);

  const pxa = fixtureManifest.vectors[2];
  const literalSource = Uint8Array.from([0xff, 0x20, 0x7e, 0x0a]);
  const decodedPxa = decodeP8Png(makeP8Png(pxa, {
    codeBlockOverride: makePxaLiteralCode(literalSource),
  }).png);
  assert.equal(decodedPxa.codeCompression, "pxa");
  assert.deepEqual(decodedPxa.code, literalSource);
});

test("RFC 1951 dynamic literal-only blocks may declare no distance codes", () => {
  const decoded = decodeP8Png(makeLiteralOnlyDynamicPng());
  assert.equal(decoded.version, 0);
  assert.equal(decoded.codeCompression, "raw");
  assert.equal(decoded.code.length, 0);
  assert.deepEqual(decoded.rom, new Uint8Array(0x8000));
});

test("public decoder has no ambient filesystem, DOM, Canvas, image or network dependency", async () => {
  const output = await readFile(
    new URL("../../packages/cart-codec/dist/public.js", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "node:", "document", "window", "fetch(", "Canvas", "ImageBitmap", "createImageBitmap",
    "DecompressionStream",
  ]) {
    assert.equal(output.includes(forbidden), false, forbidden);
  }
});
