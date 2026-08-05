import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";
import { Worker } from "node:worker_threads";

import createZ8LuaPhase0BModule from "../../wasm/dist/z8lua-phase-0b.mjs";

const STATUS = {
  OK: 0,
  INVALID_HANDLE: 1,
  BAD_ARGUMENT: 2,
  LOAD_ERROR: 3,
  RUNTIME_ERROR: 4,
  BUDGET_EXCEEDED: 5,
};

const LUA_TYPE = {
  NONE: -1,
  NIL: 0,
  BOOLEAN: 1,
  NUMBER: 3,
  STRING: 4,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let module;

before(async () => {
  module = await createZ8LuaPhase0BModule();
});

function copyBytes(pointer, length) {
  return Uint8Array.from(module.HEAPU8.subarray(pointer, pointer + length));
}

function lastError(handle) {
  const length = module._p8w0a_last_error_length(handle);
  const pointer = module._p8w0a_last_error_ptr(handle);
  return decoder.decode(copyBytes(pointer, length));
}

function readResult(handle, index) {
  const type = module._p8w0a_result_type(handle, index);
  switch (type) {
    case LUA_TYPE.NIL:
      return { type, value: null };
    case LUA_TYPE.BOOLEAN:
      return { type, value: module._p8w0a_result_boolean(handle, index) !== 0 };
    case LUA_TYPE.NUMBER:
      return {
        type,
        raw: module._p8w0a_result_number_bits(handle, index) | 0,
      };
    case LUA_TYPE.STRING: {
      const length = module._p8w0a_result_string_length(handle, index);
      const pointer = module._p8w0a_result_string_ptr(handle, index);
      return { type, bytes: copyBytes(pointer, length) };
    }
    default:
      return { type };
  }
}

function run(handle, source, budget = 1_000_000) {
  const bytes = encoder.encode(source);
  const pointer = module._p8w0a_alloc(bytes.length);
  assert.ok(bytes.length === 0 || pointer !== 0, "source allocation must succeed");
  try {
    module.HEAPU8.set(bytes, pointer);
    const status = module._p8w0a_run(handle, pointer, bytes.length, budget);
    const count = module._p8w0a_result_count(handle);
    return {
      status,
      error: lastError(handle),
      results: Array.from({ length: count }, (_, index) =>
        readResult(handle, index),
      ),
    };
  } finally {
    module._p8w0a_free(pointer);
  }
}

function raw(result) {
  assert.equal(result.type, LUA_TYPE.NUMBER);
  return result.raw >>> 0;
}

function stringValue(result) {
  assert.equal(result.type, LUA_TYPE.STRING);
  return decoder.decode(result.bytes);
}

test("ES module instantiates inside a Worker", async () => {
  const message = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./phase-0a-worker.mjs", import.meta.url), {
      type: "module",
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
  assert.deepEqual(message, { abiVersion: 0x00010000, memoryBytes: 16_777_216 });
});

test("WASM import surface contains no filesystem, WASI, or host API", async () => {
  const bytes = await readFile(
    new URL("../../wasm/dist/z8lua-phase-0b.wasm", import.meta.url),
  );
  const compiled = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(compiled).map(
    ({ module: namespace, name, kind }) => `${namespace}:${name}:${kind}`,
  );
  assert.deepEqual(imports, [
    "env:_abort_js:function",
    "env:emscripten_date_now:function",
    "env:emscripten_resize_heap:function",
  ]);
});

test("opaque handles reject stale and invalid access", () => {
  assert.equal(module._p8w0a_abi_version(), 0x00010000);
  const handle = module._p8w0a_create();
  assert.notEqual(handle, 0);
  assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  assert.equal(module._p8w0a_destroy(handle), STATUS.INVALID_HANDLE);
  assert.equal(module._p8w0a_result_type(handle, 0), LUA_TYPE.NONE);
});

test("context slots are bounded and fully released", () => {
  const handles = Array.from({ length: 64 }, () => module._p8w0a_create());
  assert.ok(handles.every((handle) => handle !== 0));
  assert.equal(new Set(handles).size, handles.length);
  assert.equal(module._p8w0a_create(), 0);
  assert.equal(module._p8w0a_live_contexts(), 64);
  for (const handle of handles) {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
  assert.equal(module._p8w0a_live_contexts(), 0);
  assert.equal(module._p8w0a_live_lua_bytes(), 0);
});

test("P8 shorthand and compound assignment execute", () => {
  const handle = module._p8w0a_create();
  try {
    const result = run(
      handle,
      ["local x=1", "if (true) x += 2", "?x", "return x"].join("\n"),
    );
    assert.equal(result.status, STATUS.OK, result.error);
    assert.equal(result.results.length, 1);
    assert.equal(raw(result.results[0]), 0x00030000);
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("Q16.16 overflow and division by zero are bit-exact", () => {
  const handle = module._p8w0a_create();
  try {
    const result = run(
      handle,
      "return 0x7fff.ffff + 0x0.0001, 1/0, -1/0, 0/0",
    );
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.results.map(raw), [
      0x80000000,
      0x7fffffff,
      0x80000001,
      0x7fffffff,
    ]);
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("PICO trigonometry has deterministic raw results", () => {
  const handle = module._p8w0a_create();
  try {
    const result = run(handle, "return sin(0), sin(0.25), cos(0)");
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.results.map(raw), [0x00000000, 0xffff0000, 0x00010000]);
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("coroutine yield and completion preserve values and status", () => {
  const handle = module._p8w0a_create();
  try {
    const result = run(
      handle,
      [
        "local co=coroutine.create(function()",
        "  coroutine.yield(0x1.8000)",
        "  return 0x2.4000",
        "end)",
        "local ok1,a=coroutine.resume(co)",
        "local status1=coroutine.status(co)",
        "local ok2,b=coroutine.resume(co)",
        "return ok1,a,status1,ok2,b,coroutine.status(co)",
      ].join("\n"),
    );
    assert.equal(result.status, STATUS.OK, result.error);
    assert.equal(result.results[0].value, true);
    assert.equal(raw(result.results[1]), 0x00018000);
    assert.equal(stringValue(result.results[2]), "suspended");
    assert.equal(result.results[3].value, true);
    assert.equal(raw(result.results[4]), 0x00024000);
    assert.equal(stringValue(result.results[5]), "dead");
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("Lua byte strings preserve embedded NUL across the baseline ABI", () => {
  const handle = module._p8w0a_create();
  try {
    const result = run(handle, "return chr(65,0,66)");
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(result.results[0].bytes, Uint8Array.of(65, 0, 66));
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("guest library allowlist excludes privileged and non-PICO surfaces", () => {
  const handle = module._p8w0a_create();
  try {
    const forbidden = [
      "debug",
      "eris",
      "io",
      "os",
      "package",
      "require",
      "dofile",
      "loadfile",
      "load",
      "loadstring",
      "collectgarbage",
      "math",
      "bit32",
    ];
    const allowed = ["coroutine", "table", "string", "sin", "type", "print"];
    const expression = [...forbidden, ...allowed]
      .map((name) => `type(${name})`)
      .join(",");
    const result = run(handle, `return ${expression}`);
    assert.equal(result.status, STATUS.OK, result.error);
    assert.deepEqual(
      result.results.map(stringValue),
      [
        ...forbidden.map(() => "nil"),
        "table",
        "table",
        "table",
        "function",
        "function",
        "function",
      ],
    );
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("instruction budget turns an infinite loop into a controlled error", () => {
  const handle = module._p8w0a_create();
  try {
    const exhausted = run(handle, "while true do end", 2_000);
    assert.equal(exhausted.status, STATUS.BUDGET_EXCEEDED);
    assert.match(exhausted.error, /__p8w_instruction_budget_exceeded__/u);

    const caught = run(
      handle,
      "pcall(function() while true do end end) return 1",
      2_000,
    );
    assert.equal(caught.status, STATUS.BUDGET_EXCEEDED);

    const nested = run(
      handle,
      [
        "local co=coroutine.create(function() while true do end end)",
        "coroutine.resume(co)",
        "return 1",
      ].join("\n"),
      2_000,
    );
    assert.equal(nested.status, STATUS.BUDGET_EXCEEDED);
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("load and runtime errors remain distinguishable", () => {
  const handle = module._p8w0a_create();
  try {
    const loadError = run(handle, "this is not lua !!!");
    assert.equal(loadError.status, STATUS.LOAD_ERROR);
    assert.match(loadError.error, /phase-0a-fixture\.p8/u);

    const runtimeError = run(handle, "error('fixture boom')");
    assert.equal(runtimeError.status, STATUS.RUNTIME_ERROR);
    assert.match(runtimeError.error, /fixture boom/u);

    assert.equal(
      module._p8w0a_run(handle, 0, 0, 0),
      STATUS.BAD_ARGUMENT,
    );
    assert.equal(module._p8w0a_result_count(handle), 0);
    assert.match(lastError(handle), /invalid source buffer/u);
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("known power baseline is stable but not promoted to official conformance", () => {
  const handle = module._p8w0a_create();
  try {
    const result = run(handle, "return 2^0.5");
    assert.equal(result.status, STATUS.OK, result.error);
    assert.equal(raw(result.results[0]), 92_681);
  } finally {
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
  }
});

test("100 create/run/destroy cycles leave no observable session or Lua heap", () => {
  const memoryBytes = module.HEAPU8.byteLength;
  for (let index = 0; index < 100; ++index) {
    const handle = module._p8w0a_create();
    assert.notEqual(handle, 0);
    const result = run(handle, `return ${index}`);
    assert.equal(result.status, STATUS.OK, result.error);
    assert.equal(raw(result.results[0]), (index << 16) >>> 0);
    assert.equal(module._p8w0a_destroy(handle), STATUS.OK);
    assert.equal(module._p8w0a_live_contexts(), 0);
    assert.equal(module._p8w0a_live_lua_bytes(), 0);
    assert.equal(module.HEAPU8.byteLength, memoryBytes);
  }
});
