import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import {
  dispatchPicoHostCall,
  PICO_HOST_CALL_FRAME,
} from "../../packages/z8lua-bridge/dist/generated/pico-host-bindings.js";

const modulePromise = createZ8LuaModule();
let module;
const decoder = new TextDecoder();
let handle = 0;
let watchdogFixture = false;
let targetFps = 0;
let completedSlices = 0;
let nextBindingId = 0;
let bindingId = 0;
let picoApiHost;
let hostButtons = 0;
const scalarArguments = new Int32Array(PICO_HOST_CALL_FRAME.SCALAR_CAPACITY);

function q16Integer(raw) {
  return raw >> 16;
}

function createBrowserGateHost(ram) {
  const screenBase = () => {
    const configured = ram[0x5f55];
    return [0x00, 0x60, 0x80, 0xa0, 0xc0, 0xe0].includes(configured)
      ? configured << 8
      : 0x6000;
  };
  return {
    cls(colorRaw) {
      const color = colorRaw === undefined ? 0 : q16Integer(colorRaw) & 0x0f;
      ram.fill(color | (color << 4), screenBase(), screenBase() + 0x2000);
    },
    pset(xRaw, yRaw, colorRaw) {
      const x = q16Integer(xRaw);
      const y = q16Integer(yRaw);
      if (x < 0 || x >= 128 || y < 0 || y >= 128) return;
      const color = colorRaw === undefined ? 6 : q16Integer(colorRaw) & 0x0f;
      const address = screenBase() + y * 64 + (x >> 1);
      const shift = (x & 1) << 2;
      ram[address] = (ram[address] & ~(0x0f << shift)) | (color << shift);
    },
    btn(buttonRaw, playerRaw) {
      if (buttonRaw === undefined) return hostButtons & 0x3f;
      const button = q16Integer(buttonRaw);
      const player = playerRaw === undefined ? 0 : q16Integer(playerRaw);
      return player === 0 && button >= 0 && button < 6 &&
        (hostButtons & (1 << button)) !== 0 ? 1 : 0;
    },
  };
}

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
  bindingId = 0;
  picoApiHost = undefined;
  hostButtons = 0;
  targetFps = 0;
  completedSlices = 0;
}

self.addEventListener("message", async ({ data: command }) => {
  module ??= await modulePromise;
  module.p8wHostCall ??= (requestedBindingId, callFramePointer) => {
    if (requestedBindingId !== bindingId || picoApiHost === undefined) return 1;
    try {
      const pointer = callFramePointer >>> 0;
      const view = new DataView(module.HEAPU8.buffer);
      if (
        pointer === 0 ||
        pointer + PICO_HOST_CALL_FRAME.BYTE_SIZE > module.HEAPU8.byteLength ||
        view.getUint32(pointer, true) !== PICO_HOST_CALL_FRAME.BYTE_SIZE
      ) return 1;
      for (let index = 0; index < PICO_HOST_CALL_FRAME.SCALAR_CAPACITY; index += 1) {
        scalarArguments[index] = view.getInt32(
          pointer + PICO_HOST_CALL_FRAME.SCALAR_SLOTS + index * 4,
          true,
        );
      }
      const bytePointer = view.getUint32(
        pointer + PICO_HOST_CALL_FRAME.BYTE_BUFFER_POINTER,
        true,
      );
      const byteLength = view.getUint32(
        pointer + PICO_HOST_CALL_FRAME.BYTE_BUFFER_LENGTH,
        true,
      );
      if ((bytePointer === 0 && byteLength !== 0) ||
          bytePointer + byteLength > module.HEAPU8.byteLength) return 1;
      const result = dispatchPicoHostCall(
        picoApiHost,
        view.getUint32(pointer + PICO_HOST_CALL_FRAME.OPERATION_ID, true),
        view.getUint32(pointer + PICO_HOST_CALL_FRAME.PRESENCE_BITS, true),
        scalarArguments,
        bytePointer === 0
          ? undefined
          : module.HEAPU8.subarray(bytePointer, bytePointer + byteLength),
      );
      view.setInt32(pointer + PICO_HOST_CALL_FRAME.RESULT, result, true);
      return 0;
    } catch {
      return 1;
    }
  };
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
    bindingId = ++nextBindingId;
    const ramPointer = module._p8w_ram_ptr(handle) >>> 0;
    picoApiHost = createBrowserGateHost(
      module.HEAPU8.subarray(ramPointer, ramPointer + 0x1_0000),
    );
    if ((module._p8w_bind_host(handle, bindingId) >>> 0) !== 0) {
      fault(command, "E_INVARIANT", "browser fixture could not bind PicoApiHost");
      return;
    }
    hostButtons = 0;
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
    hostButtons = command.input.controllers[0];
    const status = module._p8w_step(
      handle,
      100_000,
      command.input.controllers[0],
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
