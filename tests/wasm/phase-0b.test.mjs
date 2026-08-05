import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { Phase0BMemoryBinding } from "@pico8-web/z8lua-bridge";
import createZ8LuaPhase0BModule from "../../wasm/dist/z8lua-phase-0b.mjs";

const STATUS = {
  OK: 0,
  INVALID_HANDLE: 1,
  OUT_OF_MEMORY: 6,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let module;

before(async () => {
  module = await createZ8LuaPhase0BModule();
});

function copiedBytes(pointer, length) {
  return Uint8Array.from(module.HEAPU8.subarray(pointer, pointer + length));
}

function lastError(handle) {
  return decoder.decode(
    copiedBytes(
      module._p8w0b_last_error_ptr(handle),
      module._p8w0b_last_error_length(handle),
    ),
  );
}

function run(handle, source, budget = 1_000_000) {
  const bytes = encoder.encode(source);
  const pointer = module._p8w0b_alloc(bytes.length);
  assert.ok(bytes.length === 0 || pointer !== 0, "source allocation must succeed");
  try {
    module.HEAPU8.set(bytes, pointer);
    const status = module._p8w0b_run(handle, pointer, bytes.length, budget);
    return {
      status,
      error: lastError(handle),
      rawResults: Array.from(
        { length: module._p8w0b_result_count(handle) },
        (_, index) => module._p8w0b_result_number_bits(handle, index) >>> 0,
      ),
    };
  } finally {
    module._p8w0b_free(pointer);
  }
}

function readVarUint(bytes, cursor) {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[cursor.offset++];
    assert.notEqual(byte, undefined, "truncated Wasm LEB128");
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
    assert.ok(shift < 35, "invalid Wasm u32 LEB128");
  }
}

function definedMemoryLimits(bytes) {
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const sectionId = bytes[cursor.offset++];
    const sectionLength = readVarUint(bytes, cursor);
    const sectionEnd = cursor.offset + sectionLength;
    if (sectionId === 5) {
      assert.equal(readVarUint(bytes, cursor), 1, "one defined memory expected");
      const flags = readVarUint(bytes, cursor);
      const initial = readVarUint(bytes, cursor);
      const maximum = (flags & 1) === 0 ? undefined : readVarUint(bytes, cursor);
      assert.equal(cursor.offset, sectionEnd);
      return { flags, initial, maximum };
    }
    cursor.offset = sectionEnd;
  }
  throw new Error("Wasm memory section not found");
}

test("Phase 0B exposes a stable, aligned 64 KiB zero-copy lease", () => {
  assert.equal(module._p8w0b_abi_version(), 0x00020000);
  const handle = module._p8w0b_create(0);
  assert.notEqual(handle, 0);
  const pointer = module._p8w0b_ram_ptr(handle);
  const memory = new Phase0BMemoryBinding(module, handle);
  try {
    assert.equal(pointer % 16, 0);
    assert.equal(module._p8w0b_ram_size(handle), 0x10000);
    assert.equal(memory.bytes.length, 0x10000);
    assert.equal(memory.view.byteLength, 0x10000);
    assert.equal(memory.lease.byteOffset, pointer);
    assert.equal(memory.lease.byteLength, 0x10000);
    assert.equal(memory.lease.buffer, module.HEAPU8.buffer);
    assert.equal(memory.bytes.buffer, module.HEAPU8.buffer);
    assert.equal(memory.gfx.buffer, memory.bytes.buffer);
    assert.equal(memory.screen.byteOffset, pointer + 0x6000);
    assert.equal(memory.bytes[0x5f54], 0x00);
    assert.equal(memory.bytes[0x5f55], 0x60);
    memory.assertBoundLease();
    assert.throws(() => memory.assertBoundLease("wrong-lease"), /stale/u);

    const originalBytes = memory.bytes;
    memory.bytes[0x4300] = 0xaa;
    memory.reset();
    assert.equal(module._p8w0b_ram_ptr(handle), pointer);
    assert.equal(memory.bytes, originalBytes);
    assert.equal(memory.bytes[0x4300], 0);
    assert.equal(memory.bytes[0x5f55], 0x60);
  } finally {
    assert.equal(module._p8w0b_destroy(handle), STATUS.OK);
  }
  assert.throws(() => memory.assertBoundLease(), /stale/u);
});

test("Phase 0A and Phase 0B bounded ABIs reject each other's handles", () => {
  const phase0aHandle = module._p8w0a_create();
  const phase0bHandle = module._p8w0b_create(0);
  assert.notEqual(phase0aHandle, 0);
  assert.notEqual(phase0bHandle, 0);
  try {
    assert.equal(module._p8w0a_live_contexts(), 1);
    assert.equal(module._p8w0b_live_contexts(), 1);
    assert.equal(module._p8w0b_ram_ptr(phase0aHandle), 0);
    assert.equal(
      module._p8w0a_run(phase0bHandle, 0, 0, 1),
      STATUS.INVALID_HANDLE,
    );
    assert.equal(
      module._p8w0b_run(phase0aHandle, 0, 0, 1),
      STATUS.INVALID_HANDLE,
    );
    assert.equal(module._p8w0a_destroy(phase0bHandle), STATUS.INVALID_HANDLE);
    assert.equal(module._p8w0b_destroy(phase0aHandle), STATUS.INVALID_HANDLE);
  } finally {
    assert.equal(module._p8w0a_destroy(phase0aHandle), STATUS.OK);
    assert.equal(module._p8w0b_destroy(phase0bHandle), STATUS.OK);
  }
  assert.equal(module._p8w0a_live_contexts(), 0);
  assert.equal(module._p8w0b_live_contexts(), 0);
  assert.equal(module._p8w0a_live_lua_bytes(), 0);
  assert.equal(module._p8w0b_live_lua_bytes(), 0);
});

test("JS physical views and Lua direct/API reads alias lower and upper RAM", () => {
  const handle = module._p8w0b_create(0);
  const memory = new Phase0BMemoryBinding(module, handle);
  try {
    memory.view.setUint8(0x4300, 0x12);
    memory.bytes[0x8000] = 0x34;
    memory.bytes[0xffff] = 0x56;
    let result = run(
      handle,
      "return @0x4300,peek(0x4300),@0x8000,peek(0x8000),@-1,peek(-1)",
    );
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.rawResults, [
      0x00120000,
      0x00120000,
      0x00340000,
      0x00340000,
      0x00560000,
      0x00560000,
    ]);

    result = run(
      handle,
      "poke(0x4301,0xab) poke(0x8001,0xcd) poke(-2,0xef) return @0x4301,@0x8001,@0xfffe",
    );
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.rawResults, [0x00ab0000, 0x00cd0000, 0x00ef0000]);
    assert.equal(memory.bytes[0x4301], 0xab);
    assert.equal(memory.view.getUint8(0x4301), 0xab);
    assert.equal(memory.bytes[0x8001], 0xcd);
    assert.equal(memory.bytes[0xfffe], 0xef);

    memory.writeU8(0x1_4302, 0x77);
    assert.equal(memory.bytes[0x4302], 0x77);
    assert.equal(memory.readU8(-0x10000 + 0x4302), 0x77);
  } finally {
    assert.equal(module._p8w0b_destroy(handle), STATUS.OK);
  }
});

test("negative addresses, 16-bit wrap, and little-endian multi-byte reads are bytewise", () => {
  const handle = module._p8w0b_create(0);
  const memory = new Phase0BMemoryBinding(module, handle);
  try {
    memory.writeI32LE(0xffff, 0x12345678);
    memory.bytes[0x7fff] = 0xcd;
    memory.bytes[0x8000] = 0xab;
    const result = run(
      handle,
      "return @(-0.5),%0xffff,peek2(0xffff),$0xffff,peek4(0xffff),%0x7fff",
    );
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.rawResults, [
      0x00780000,
      0x56780000,
      0x56780000,
      0x12345678,
      0x12345678,
      0xabcd0000,
    ]);
    assert.equal(memory.readI16LE(0xffff), 0x5678);
    assert.equal(memory.readI32LE(0xffff) >>> 0, 0x12345678);
  } finally {
    assert.equal(module._p8w0b_destroy(handle), STATUS.OK);
  }
});

test("GFX/SCREEN remap is shared by direct operators, memory APIs, memcpy, and TS", () => {
  const handle = module._p8w0b_create(0);
  const memory = new Phase0BMemoryBinding(module, handle);
  try {
    memory.bytes[0x5f54] = 0x80;
    memory.bytes[0x5f55] = 0xc0;
    memory.bytes[0x8000] = 0xa1;
    memory.bytes[0x8001] = 0xb2;
    memory.bytes[0x9fff] = 0xc3;
    memory.bytes[0x2000] = 0xd4;

    assert.equal(memory.mapAddress(0), 0x8000);
    assert.equal(memory.mapAddress(0x6000), 0xc000);
    assert.equal(module._p8w0b_map_address(handle, 0x1_0000), 0x8000);

    let result = run(
      handle,
      "return @0,peek(0),%0x1fff,peek2(0x1fff)",
    );
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.rawResults, [
      0x00a10000,
      0x00a10000,
      0xd4c30000,
      0xd4c30000,
    ]);

    result = run(
      handle,
      "poke(1,0xee) memcpy(0x6000,0,2) return @1,peek(0x6000),peek(0x6001)",
    );
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.rawResults, [0x00ee0000, 0x00a10000, 0x00ee0000]);
    assert.equal(memory.bytes[0x8001], 0xee);
    assert.equal(memory.bytes[0xc000], 0xa1);
    assert.equal(memory.bytes[0xc001], 0xee);
    assert.equal(memory.readU8(0x6001), 0xee);

    memory.bytes[0x5f55] = 0x00;
    memory.writeU8(0x6000, 0x44);
    assert.equal(memory.bytes[0], 0x44);
    result = run(handle, "return @0,peek(0x6000)");
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.rawResults, [0x00a10000, 0x00440000]);
  } finally {
    assert.equal(module._p8w0b_destroy(handle), STATUS.OK);
  }
});

test("all documented GFX/SCREEN video bases resolve through the canonical mapper", () => {
  const handle = module._p8w0b_create(0);
  const memory = new Phase0BMemoryBinding(module, handle);
  try {
    for (const base of [0x00, 0x60, 0x80, 0xa0, 0xc0, 0xe0]) {
      memory.bytes[0x5f54] = base;
      memory.bytes[0x5f55] = base;
      assert.equal(memory.mapAddress(0x0123), (base << 8) + 0x0123);
      assert.equal(memory.mapAddress(0x6123), (base << 8) + 0x0123);
    }
    memory.bytes[0x5f54] = 0x20;
    memory.bytes[0x5f55] = 0x40;
    assert.equal(memory.mapAddress(0x0123), 0x0123);
    assert.equal(memory.mapAddress(0x6123), 0x6123);
  } finally {
    assert.equal(module._p8w0b_destroy(handle), STATUS.OK);
  }
});

test("Wasm memory descriptor has equal initial and maximum limits", async () => {
  const bytes = await readFile(
    new URL("../../wasm/dist/z8lua-phase-0b.wasm", import.meta.url),
  );
  assert.deepEqual(definedMemoryLimits(bytes), {
    flags: 1,
    initial: 256,
    maximum: 256,
  });
});

test("fixed memory rejects growth and heap pressure without detaching views", () => {
  const wasmMemory = module.wasmMemory;
  const buffer = wasmMemory.buffer;
  const heap = module.HEAPU8;
  assert.equal(buffer.byteLength, 16_777_216);
  assert.throws(() => wasmMemory.grow(1), RangeError);
  assert.equal(wasmMemory.buffer, buffer);
  assert.equal(module.HEAPU8, heap);
  assert.equal(module.HEAPU8.buffer, buffer);

  assert.doesNotThrow(() => {
    assert.equal(module._p8w0b_alloc(32 * 1024 * 1024), 0);
  });
  assert.equal(module.HEAPU8.buffer, buffer);

  const handle = module._p8w0b_create(32 * 1024);
  assert.notEqual(handle, 0);
  const memory = new Phase0BMemoryBinding(module, handle);
  const leaseBuffer = memory.lease.buffer;
  try {
    const result = run(
      handle,
      "local s='0123456789abcdef' for i=1,16 do s=s..s end return #s",
      2_000_000,
    );
    assert.equal(result.status, STATUS.OUT_OF_MEMORY, result.error);
    assert.match(result.error, /memory|__p8w_out_of_memory__/u);
    assert.equal(memory.lease.buffer, leaseBuffer);
    memory.assertBoundLease();
  } finally {
    assert.equal(module._p8w0b_destroy(handle), STATUS.OK);
  }
  assert.equal(module.HEAPU8.buffer, buffer);
});

test("bounded multi-context lifecycle releases handles and Lua heap", () => {
  const handles = Array.from({ length: 64 }, () => module._p8w0b_create(0));
  assert.ok(handles.every((handle) => handle !== 0));
  assert.equal(new Set(handles).size, handles.length);
  assert.equal(module._p8w0b_create(0), 0);
  const pointers = handles.map((handle) => module._p8w0b_ram_ptr(handle));
  assert.equal(new Set(pointers).size, pointers.length);
  for (const handle of handles) {
    assert.equal(module._p8w0b_destroy(handle), STATUS.OK);
  }
  assert.equal(module._p8w0b_live_contexts(), 0);
  assert.equal(module._p8w0b_live_lua_bytes(), 0);
  assert.equal(module._p8w0b_ram_ptr(handles[0]), 0);
  assert.equal(module._p8w0b_destroy(handles[0]), STATUS.INVALID_HANDLE);
});
