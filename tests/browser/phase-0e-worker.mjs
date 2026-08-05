import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const modulePromise = createZ8LuaModule();
let module;
const decoder = new TextDecoder();
let handle = 0;
let watchdogFixture = false;
let targetFps = 0;
let completedSlices = 0;

function logicalTimeRaw(slices, fps) {
  return Math.floor((slices * 65_536) / fps) | 0;
}

function withBytes(bytes, call) {
  if (bytes.byteLength === 0) return call(0, 0);
  const pointer = module._p8w_alloc(bytes.byteLength) >>> 0;
  if (pointer === 0) throw new Error("WASM allocation failed");
  try {
    module.HEAPU8.set(bytes, pointer);
    return call(pointer, bytes.byteLength) >>> 0;
  } finally {
    module._p8w_free(pointer);
  }
}

function errorText() {
  const pointer = module._p8w_error_message_ptr(handle) >>> 0;
  const length = module._p8w_error_message_length(handle) >>> 0;
  return decoder.decode(module.HEAPU8.subarray(pointer, pointer + length));
}

function fault(command, code, message) {
  self.postMessage({
    v: 1,
    type: "fault",
    requestId: command.requestId,
    sessionGeneration: command.sessionGeneration,
    error: {
      code,
      message,
      phase: "none",
      recoverable: false,
    },
  });
}

function ready(command, mode, targetFps) {
  self.postMessage({
    v: 1,
    type: "ready",
    requestId: command.requestId,
    sessionGeneration: command.sessionGeneration,
    mode,
    targetFps,
  });
}

function destroy() {
  if (handle !== 0) module._p8w_destroy(handle);
  handle = 0;
  targetFps = 0;
  completedSlices = 0;
}

self.addEventListener("message", async ({ data: command }) => {
  module ??= await modulePromise;
  if (command?.v !== 1) return;
  if (command.type === "loadCart") {
    destroy();
    const source = new Uint8Array(command.p8PngBytes);
    watchdogFixture = decoder.decode(source) === "__phase0e_watchdog_fixture__";
    if (watchdogFixture) {
      ready(command, "callback", 30);
      return;
    }
    handle = module._p8w_create(0) >>> 0;
    const compileStatus = withBytes(source, (pointer, length) =>
      module._p8w_compile(handle, pointer, length),
    );
    const bootStatus =
      compileStatus === 0
        ? module._p8w_boot(
            handle,
            command.instructionBudget ?? 100_000,
            0,
            logicalTimeRaw(1, 30),
          ) >>> 0
        : compileStatus;
    if (bootStatus !== 0 && bootStatus !== 1) {
      fault(command, "E_VM_RUNTIME", errorText());
      return;
    }
    targetFps = module._p8w_target_fps(handle) === 60 ? 60 : 30;
    completedSlices = targetFps / 30;
    ready(command, module._p8w_mode(handle) === 2 ? "custom" : "callback", targetFps);
    return;
  }
  if (command.type === "step") {
    if (watchdogFixture) {
      // Test-only native/host-stall analogue: no VM hook can interrupt JS here.
      while (true) {}
    }
    if (handle === 0) {
      fault(command, "E_INVALID_STATE", "no browser fixture is loaded");
      return;
    }
    const timeRawBeforeStep = logicalTimeRaw(completedSlices + 1, targetFps);
    const status = module._p8w_step(
      handle,
      100_000,
      command.input.buttons,
      timeRawBeforeStep,
    ) >>> 0;
    if (status !== 0 && status !== 1) {
      fault(command, status === 7 ? "E_VM_INSTRUCTION_BUDGET" : "E_VM_RUNTIME", errorText());
      return;
    }
    completedSlices += 1;
    const ram = module._p8w_ram_ptr(handle) >>> 0;
    const packedScreen = module.HEAPU8.slice(ram + 0x6000, ram + 0x8000).buffer;
    const frameId = module.HEAPU8[ram + 0x150] ?? 0;
    self.postMessage(
      {
        v: 1,
        type: "frame",
        requestId: command.requestId,
        sessionGeneration: command.sessionGeneration,
        frameId: frameId - 1,
        completedSlices: String(completedSlices),
        timeRawBeforeStep,
        targetFps,
        packedScreen,
      },
      [packedScreen],
    );
    return;
  }
  if (command.type === "dispose") {
    destroy();
    self.postMessage({
      v: 1,
      type: "disposed",
      requestId: command.requestId,
      sessionGeneration: command.sessionGeneration,
    });
  }
});
