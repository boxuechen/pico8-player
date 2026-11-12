import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  CART_CODEC_ERROR_CODES,
  CartCodecError,
  DEFAULT_P8_LIMITS,
  P8_SECTION_NAMES,
  decodeCart,
  decodeP8,
} from "@pico8-web/cart-codec";
import {
  allSectionsFixture,
  makeP8Bytes,
  repeated,
} from "../fixtures/p8/fixture-builder.mjs";
import {
  makeP8Png,
} from "../fixtures/p8png/fixture-builder.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function throwsCode(code, offset) {
  return (error) =>
    error instanceof CartCodecError &&
    error.code === code &&
    (offset === undefined || error.offset === offset);
}

test("text machine contract constants and error inventory are stable", async () => {
  const contract = JSON.parse(
    await readFile(new URL("../../spec/cart-codec-contract.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(DEFAULT_P8_LIMITS, contract.text.defaultLimits);
  assert.deepEqual(P8_SECTION_NAMES, contract.text.sections);
  assert.deepEqual(CART_CODEC_ERROR_CODES, contract.errorCodes);
  assert.equal(contract.parsedCart.romBytes, 0x8000);
});

test("LF, CRLF, mixed endings and BOM preserve code bytes while identity tracks exact input", () => {
  const lfBytes = makeP8Bytes({ sections: [{ name: "lua", lines: ["a=1", " b=2"] }] });
  const crlfBytes = makeP8Bytes({
    lineEnding: "\r\n",
    bom: true,
    sections: [{ name: "lua", lines: ["a=1", " b=2"] }],
  });
  const mixedText =
    "pico-8 cartridge // http://www.pico-8.com\r\nversion 42\n__lua__\r\na=1\n b=2";
  const mixedBytes = new TextEncoder().encode(mixedText);

  const lf = decodeP8(lfBytes);
  const crlf = decodeP8(crlfBytes);
  const mixed = decodeP8(mixedBytes);
  assert.deepEqual(lf.code, new TextEncoder().encode("a=1\n b=2\n"));
  assert.deepEqual(crlf.code, lf.code);
  assert.deepEqual(mixed.code, new TextEncoder().encode("a=1\n b=2"));
  assert.equal(lf.lineEndings, "lf");
  assert.equal(crlf.lineEndings, "crlf");
  assert.equal(mixed.lineEndings, "mixed");
  assert.equal(lf.identity.contentSha256, sha256(lfBytes));
  assert.equal(crlf.identity.contentSha256, sha256(crlfBytes));
  assert.notEqual(lf.identity.contentSha256, crlf.identity.contentSha256);
});

test("P8SCII conversion is byte-oriented and does not normalize Unicode", () => {
  const source = 'x="¹▮○█⬇️あア◝"';
  const decoded = decodeP8(makeP8Bytes({
    sections: [{ name: "lua", lines: [source] }],
  }));
  assert.deepEqual(
    decoded.code,
    Uint8Array.from([
      0x78, 0x3d, 0x22,
      0x01, 0x10, 0x7f, 0x80, 0x83, 0x9a, 0xcc, 0xff,
      0x22, 0x0a,
    ]),
  );
});

test("all text sections pack byte-exact into the 32 KiB ROM", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../fixtures/p8/manifest.json", import.meta.url), "utf8"),
  );
  const configurations = [
    { lineEnding: "\n", bom: false },
    { lineEnding: "\r\n", bom: true },
  ];
  for (const [index, configuration] of configurations.entries()) {
    const input = allSectionsFixture(configuration);
    const decoded = decodeP8(input);
    const vector = manifest.vectors[index];
    assert.equal(decoded.rom.length, 0x8000);
    assert.equal(decoded.rom[0], 0x21, "gfx pixel nibbles are low-first");
    assert.equal(decoded.rom[0x1000], 0x03, "map2 is ORed with gfx2");
    assert.equal(decoded.rom[0x2000], 0x7f);
    assert.equal(decoded.rom[0x3000], 0xab);
    assert.deepEqual(decoded.rom.slice(0x3100, 0x3104), Uint8Array.of(0x81, 0x82, 0x83, 0x84));
    assert.deepEqual(decoded.rom.slice(0x3200, 0x3202), Uint8Array.of(0xff, 0xff));
    assert.deepEqual(decoded.rom.slice(0x3240, 0x3244), Uint8Array.of(1, 16, 2, 3));
    assert.equal(decoded.rom[0x4300], 0, "text code never aliases the ROM code container");
    assert.deepEqual(decoded.code, new TextEncoder().encode("a=1" + configuration.lineEnding.replace("\r", "")));
    assert.equal(sha256(input), vector.inputSha256);
    assert.equal(sha256(decoded.rom), vector.romSha256);
    assert.equal(sha256(decoded.code), vector.codeSha256);
  }
});

test("missing sections retain canonical empty audio slots and label data never overwrites gfx", () => {
  const missing = decodeP8(makeP8Bytes({ sections: [{ name: "lua", lines: [] }] }));
  const expected = new Uint8Array(0x8000);
  for (let row = 0; row < 64; row += 1) {
    expected.set([0x41, 0x42, 0x43, 0x44], 0x3100 + row * 4);
    expected[0x3200 + row * 68 + 65] = 16;
  }
  assert.deepEqual(missing.rom, expected);

  const labelOnly = decodeP8(makeP8Bytes({
    sections: [{ name: "label", lines: [repeated("v", 128)] }],
  }));
  assert.deepEqual(labelOnly.rom, expected);
});

test("unknown sections warn at the original byte offset and cannot become Lua", () => {
  const text =
    "pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\na=1\n__future__\nevil()\n__gfx__\n";
  const input = new TextEncoder().encode(text);
  const decoded = decodeP8(input);
  const markerOffset = text.indexOf("__future__");
  assert.deepEqual(decoded.code, new TextEncoder().encode("a=1\n"));
  assert.deepEqual(decoded.warnings, [{
    code: "W_CART_UNKNOWN_SECTION",
    message: "Unknown text cart section __future__ was ignored",
    offset: markerOffset,
    section: "future",
  }]);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.identity), true);
  assert.equal(Object.isFrozen(decoded.warnings), true);
  assert.equal(Object.isFrozen(decoded.warnings[0]), true);
});

test("tool metadata markers with punctuation remain unknown sections", () => {
  const decoded = decodeP8(makeP8Bytes({
    sections: [
      { name: "gfx", lines: ["00"] },
      { name: "meta:cart_info_start", lines: ["not gfx data"] },
    ],
  }));
  assert.equal(decoded.rom[0], 0);
  assert.equal(decoded.warnings[0]?.section, "meta:cart_info_start");
});

test("known duplicate sections and non-empty preamble fail structurally", () => {
  const duplicate = makeP8Bytes({
    sections: [{ name: "lua", lines: [] }, { name: "lua", lines: [] }],
  });
  assert.throws(() => decodeP8(duplicate), throwsCode("E_CART_TEXT_SECTION"));
  assert.throws(
    () => decodeP8(makeP8Bytes({ preamble: ["not ignored"] })),
    throwsCode("E_CART_TEXT_SECTION"),
  );
});

test("header, version and future-version failures retain stable codes and offsets", () => {
  assert.throws(
    () => decodeP8(new TextEncoder().encode("not a cart\nversion 42\n")),
    throwsCode("E_CART_TEXT_HEADER", 0),
  );
  const malformed = new TextEncoder().encode(
    "pico-8 cartridge // http://www.pico-8.com\nversion x\n",
  );
  assert.throws(() => decodeP8(malformed), throwsCode("E_CART_TEXT_VERSION", 42));
  const current = makeP8Bytes({ version: 43 });
  assert.equal(decodeP8(current).version, 43);
  const future = makeP8Bytes({ version: 44 });
  assert.throws(() => decodeP8(future), throwsCode("E_CART_FUTURE_VERSION", 50));
  assert.equal(decodeP8(future, { limits: { maximumCartVersion: 44 } }).version, 44);
});

test("row width, alphabet, field bit width and row capacity never truncate", () => {
  assert.throws(
    () => decodeP8(makeP8Bytes({ sections: [{ name: "gfx", lines: ["0"] }] })),
    throwsCode("E_CART_TEXT_ROW"),
  );
  assert.throws(
    () => decodeP8(makeP8Bytes({ sections: [{ name: "gff", lines: [`z${repeated("0", 255)}`] }] })),
    throwsCode("E_CART_TEXT_ROW"),
  );
  assert.throws(
    () => decodeP8(makeP8Bytes({ sections: [{ name: "music", lines: ["10 01020304"] }] })),
    throwsCode("E_CART_TEXT_ROW"),
  );
  assert.throws(
    () => decodeP8(makeP8Bytes({ sections: [{ name: "sfx", lines: [`0040000040f00${repeated("0", 155)}`] }] })),
    throwsCode("E_CART_TEXT_ROW"),
  );
  assert.throws(
    () => decodeP8(makeP8Bytes({
      sections: [{ name: "gfx", lines: Array.from({ length: 129 }, () => repeated("0", 128)) }],
    })),
    throwsCode("E_CART_TEXT_CAPACITY"),
  );
});

test("hex sections accept bounded half-width rows and pack them sequentially", () => {
  const decoded = decodeP8(makeP8Bytes({
    sections: [{ name: "gfx", lines: ["12", "34"] }],
  }));
  assert.deepEqual(decoded.rom.slice(0, 2), Uint8Array.of(0x21, 0x43));
});

test("include, malformed UTF-8, unmapped Unicode and lone CR fail at byte boundaries", () => {
  const include = makeP8Bytes({ sections: [{ name: "lua", lines: ["  #include sibling.lua"] }] });
  const includeOffset = new TextDecoder().decode(include).indexOf("#include");
  assert.throws(
    () => decodeP8(include),
    throwsCode("E_CART_INCLUDE_UNRESOLVED", includeOffset),
  );
  const resolved = decodeP8(include, {
    includeResolver(specifier) {
      assert.equal(specifier, "sibling.lua");
      return new TextEncoder().encode("x=1\ny=2");
    },
  });
  assert.deepEqual(resolved.code, new TextEncoder().encode("x=1\ny=2\n"));

  const validPrefix = makeP8Bytes({
    sections: [{ name: "lua", lines: [] }],
  });
  const malformed = Uint8Array.from([...validPrefix, 0xc3]);
  assert.throws(
    () => decodeP8(malformed),
    throwsCode("E_CART_TEXT_ENCODING", malformed.length - 1),
  );
  assert.throws(
    () => decodeP8(makeP8Bytes({ sections: [{ name: "lua", lines: ["é"] }] })),
    throwsCode("E_CART_TEXT_ENCODING"),
  );
  const loneCr = new TextEncoder().encode(
    "pico-8 cartridge // http://www.pico-8.com\rversion 42\n",
  );
  assert.throws(() => decodeP8(loneCr), throwsCode("E_CART_TEXT_LINE_ENDING", 41));
});

test("input, code, line and option limits reject before unbounded growth", () => {
  const input = makeP8Bytes({ sections: [{ name: "lua", lines: ["abcdef"] }] });
  assert.throws(
    () => decodeP8(input, { limits: { maximumInputBytes: input.length - 1 } }),
    throwsCode("E_CART_INPUT_TOO_LARGE"),
  );
  assert.throws(
    () => decodeP8(input, { limits: { maximumCodeBytes: 3 } }),
    throwsCode("E_CART_CODE_TOO_LARGE"),
  );
  assert.throws(
    () => decodeP8(input, { limits: { maximumLines: 2 } }),
    throwsCode("E_CART_TEXT_CAPACITY"),
  );
  assert.throws(
    () => decodeP8(input, { limits: { maximumLines: 0 } }),
    throwsCode("E_CART_LIMITS"),
  );
});

test("decodeCart detects bytes magic and both formats share ParsedCart fields", async () => {
  const textInput = makeP8Bytes();
  const text = decodeCart(textInput);
  assert.equal(text.format, "p8");

  const pngManifest = JSON.parse(
    await readFile(new URL("../fixtures/p8png/manifest.json", import.meta.url), "utf8"),
  );
  const pngInput = makeP8Png(pngManifest.vectors[0]).png;
  const png = decodeCart(pngInput);
  assert.equal(png.format, "p8.png");
  assert.equal(png.identity.contentSha256, sha256(pngInput));
  assert.deepEqual(png.warnings, []);
  assert.equal(Object.isFrozen(png.warnings), true);

  assert.throws(
    () => decodeCart(Uint8Array.of(1, 2, 3)),
    throwsCode("E_CART_FORMAT", 0),
  );
});

test("decoded byte arrays are independent snapshots with no retained input alias", () => {
  const input = allSectionsFixture();
  const first = decodeP8(input);
  const second = decodeP8(input);
  assert.notEqual(first.rom, second.rom);
  assert.notEqual(first.code, second.code);
  const originalRom = second.rom[0];
  const originalCode = second.code[0];
  first.rom[0] ^= 0xff;
  first.code[0] ^= 0xff;
  input.fill(0);
  assert.equal(second.rom[0], originalRom);
  assert.equal(second.code[0], originalCode);
});

test("all cart-codec production output remains browser-neutral and ref-free", async () => {
  const directory = new URL("../../packages/cart-codec/dist/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".js"));
  const output = (await Promise.all(names.map((name) => readFile(new URL(name, directory), "utf8")))).join("\n");
  for (const forbidden of [
    "node:", "document", "window", "fetch(", "Canvas", "ImageBitmap", "createImageBitmap",
    "DecompressionStream", "FileReader", "/ref/", "../ref/",
  ]) {
    assert.equal(output.includes(forbidden), false, forbidden);
  }
});
