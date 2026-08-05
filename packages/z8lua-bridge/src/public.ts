import {
  PICO_RAM_SIZE,
  type PicoMemoryLease,
} from "@pico8-web/contracts";
import type {
  FrameVmMode,
  FrameVmPort,
  FrameVmState,
  PicoLogicalMemoryPort,
  PicoApiHost,
  VmFaultRecord,
  VmOperationOutcome,
} from "@pico8-web/runtime-core";
import {
  dispatchPicoHostCall,
  PICO_HOST_CALL_FRAME,
} from "./generated/pico-host-bindings.js";

const INVALID_MAPPED_ADDRESS = 0xffff_ffff;
const moduleIds = new WeakMap<object, number>();
let nextModuleId = 1;
const hostDispatcherState = Symbol("p8w.host-dispatcher-state");
const HOST_DISPATCH_OK = 0;
const HOST_DISPATCH_FAILED = 1;

export type HostBindingState = "unbound" | "bound" | "released";

interface HostBindingSlot {
  state: HostBindingState;
  host: PicoApiHost | undefined;
  error: string | undefined;
}

interface HostDispatcherState {
  nextBindingId: number;
  readonly slots: Map<number, HostBindingSlot>;
  readonly memoryView: DataView;
  readonly scalarArguments: Int32Array;
}

type HostDispatchCallback = (
  bindingId: number,
  callFramePointer: number,
) => number;

/** Minimal Emscripten surface consumed by the Phase 0B memory adapter. */
export interface Phase0BMemoryModule {
  readonly HEAPU8: Uint8Array;
  _p8w0b_ram_ptr(handle: number): number;
  _p8w0b_ram_size(handle: number): number;
  _p8w0b_ram_reset(handle: number): number;
  _p8w0b_map_address(handle: number, logicalAddress: number): number;
}

export interface PicoRamLayout {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly gfx: Uint8Array;
  readonly map: Uint8Array;
  readonly flags: Uint8Array;
  readonly songs: Uint8Array;
  readonly sfx: Uint8Array;
  readonly cartData: Uint8Array;
  readonly screen: Uint8Array;
}

function moduleId(module: object): number {
  const existing = moduleIds.get(module);
  if (existing !== undefined) return existing;
  const assigned = nextModuleId++;
  moduleIds.set(module, assigned);
  return assigned;
}

/**
 * Zero-copy physical views plus logical reads/writes routed through the WASM
 * address mapper used by z8lua direct memory operators.
 */
export class Phase0BMemoryBinding implements PicoRamLayout {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly gfx: Uint8Array;
  readonly map: Uint8Array;
  readonly flags: Uint8Array;
  readonly songs: Uint8Array;
  readonly sfx: Uint8Array;
  readonly cartData: Uint8Array;
  readonly screen: Uint8Array;
  readonly lease: PicoMemoryLease;

  readonly #module: Phase0BMemoryModule;
  readonly #handle: number;

  constructor(module: Phase0BMemoryModule, handle: number) {
    const pointer = module._p8w0b_ram_ptr(handle) >>> 0;
    const size = module._p8w0b_ram_size(handle) >>> 0;
    const buffer = module.HEAPU8.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("Phase 0B requires a non-shared ArrayBuffer");
    }
    if (
      pointer === 0 ||
      size !== PICO_RAM_SIZE ||
      pointer + size > module.HEAPU8.byteLength
    ) {
      throw new RangeError("invalid or stale Phase 0B Pico RAM allocation");
    }

    this.#module = module;
    this.#handle = handle;
    this.bytes = module.HEAPU8.subarray(pointer, pointer + size);
    this.view = new DataView(buffer, pointer, size);
    this.gfx = this.bytes.subarray(0x0000, 0x2000);
    this.map = this.bytes.subarray(0x2000, 0x3000);
    this.flags = this.bytes.subarray(0x3000, 0x3100);
    this.songs = this.bytes.subarray(0x3100, 0x3200);
    this.sfx = this.bytes.subarray(0x3200, 0x4300);
    this.cartData = this.bytes.subarray(0x5e00, 0x5f00);
    this.screen = this.bytes.subarray(0x6000, 0x8000);
    this.lease = Object.freeze({
      buffer,
      byteOffset: pointer,
      byteLength: PICO_RAM_SIZE,
      leaseId: `p8w0b:${moduleId(module)}:${handle >>> 0}:${pointer}`,
    });
  }

  assertBoundLease(leaseId = this.lease.leaseId): void {
    if (
      leaseId !== this.lease.leaseId ||
      this.#module.HEAPU8.buffer !== this.lease.buffer ||
      (this.#module._p8w0b_ram_ptr(this.#handle) >>> 0) !==
        this.lease.byteOffset ||
      (this.#module._p8w0b_ram_size(this.#handle) >>> 0) !== PICO_RAM_SIZE
    ) {
      throw new Error("stale or detached Pico memory lease");
    }
  }

  reset(): void {
    this.assertBoundLease();
    if (this.#module._p8w0b_ram_reset(this.#handle) !== 0) {
      throw new Error("unable to reset Pico RAM");
    }
  }

  mapAddress(logicalAddress: number): number {
    this.assertBoundLease();
    const mapped =
      this.#module._p8w0b_map_address(this.#handle, logicalAddress >>> 0) >>> 0;
    if (mapped === INVALID_MAPPED_ADDRESS || mapped >= PICO_RAM_SIZE) {
      throw new RangeError("unable to map Pico RAM address");
    }
    return mapped;
  }

  readU8(logicalAddress: number): number {
    return this.bytes[this.mapAddress(logicalAddress)]!;
  }

  writeU8(logicalAddress: number, value: number): void {
    this.bytes[this.mapAddress(logicalAddress)] = value & 0xff;
  }

  readI16LE(logicalAddress: number): number {
    const unsigned =
      this.readU8(logicalAddress) |
      (this.readU8(logicalAddress + 1) << 8);
    return (unsigned << 16) >> 16;
  }

  readI32LE(logicalAddress: number): number {
    return this.readU8(logicalAddress) |
      (this.readU8(logicalAddress + 1) << 8) |
      (this.readU8(logicalAddress + 2) << 16) |
      (this.readU8(logicalAddress + 3) << 24);
  }

  writeI32LE(logicalAddress: number, raw: number): void {
    this.writeU8(logicalAddress, raw);
    this.writeU8(logicalAddress + 1, raw >>> 8);
    this.writeU8(logicalAddress + 2, raw >>> 16);
    this.writeU8(logicalAddress + 3, raw >>> 24);
  }
}

export type { PicoMemoryLease } from "@pico8-web/contracts";

/** Production-named v1 ABI surface. Phase 0C benchmark symbols are excluded. */
export interface FrameRuntimeModule {
  readonly HEAPU8: Uint8Array;
  p8wHostCall?: HostDispatchCallback;
  _p8w_abi_version(): number;
  _p8w_create(luaHeapLimit: number): number;
  _p8w_destroy(handle: number): number;
  _p8w_bind_host(handle: number, bindingId: number): number;
  _p8w_compile(handle: number, sourcePointer: number, sourceLength: number): number;
  _p8w_boot(handle: number, budget: number, buttons: number, timeRaw: number): number;
  _p8w_step(handle: number, budget: number, buttons: number, timeRaw: number): number;
  _p8w_complete_host_request(
    handle: number,
    requestId: number,
    responsePointer: number,
    responseLength: number,
    isError: number,
    budget: number,
  ): number;
  _p8w_state(handle: number): number;
  _p8w_mode(handle: number): number;
  _p8w_target_fps(handle: number): number;
  _p8w_yield_reason(handle: number): number;
  _p8w_phase(handle: number): number;
  _p8w_consumed_instructions(handle: number): number;
  _p8w_pending_request_id(handle: number): number;
  _p8w_pending_request_ptr(handle: number): number;
  _p8w_pending_request_length(handle: number): number;
  _p8w_error_status(handle: number): number;
  _p8w_error_line(handle: number): number;
  _p8w_error_message_ptr(handle: number): number;
  _p8w_error_message_length(handle: number): number;
  _p8w_error_trace_ptr(handle: number): number;
  _p8w_error_trace_length(handle: number): number;
  _p8w_ram_ptr(handle: number): number;
  _p8w_ram_size(handle: number): number;
  _p8w_ram_reset(handle: number): number;
  _p8w_map_address(handle: number, logicalAddress: number): number;
  _p8w_alloc(size: number): number;
  _p8w_free(pointer: number): void;
}

export interface Z8LuaFrameVmOptions {
  readonly luaHeapLimit?: number;
}

const FRAME_ABI_VERSION = 0x0001_0002;
const STATUS_OK = 0;
const STATUS_YIELDED = 1;
const STATUS_INVALID_HANDLE = 2;
const STATUS_INVALID_STATE = 3;
const STATUS_BAD_ARGUMENT = 4;
const STATUS_LOAD_ERROR = 5;
const STATUS_RUNTIME_ERROR = 6;
const STATUS_BUDGET = 7;
const STATUS_OOM = 8;
const STATUS_UNSUPPORTED = 9;
const STATUS_HOST_ERROR = 10;
const STATUS_STOPPED = 11;
const STATUS_HOST_API_ERROR = 13;
const YIELD_FRAME_END = 1;
const YIELD_FLIP = 2;
const YIELD_HOST_REQUEST = 3;
const CART_ROM_BYTES = 0x8000;
const CART_ROM_RUNTIME_BYTES = 0x4300;

const TextDecoderConstructor = (
  globalThis as unknown as {
    TextDecoder: new (
      label: string,
      options: { readonly fatal: boolean },
    ) => { decode(input: Uint8Array): string };
  }
).TextDecoder;
const textDecoder = new TextDecoderConstructor("utf-8", { fatal: false });

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dispatcherState(module: FrameRuntimeModule): HostDispatcherState {
  const carrier = module as FrameRuntimeModule & Record<PropertyKey, unknown>;
  const existing = carrier[hostDispatcherState] as HostDispatcherState | undefined;
  if (existing !== undefined) return existing;
  if (module.p8wHostCall !== undefined) {
    throw new Error("frame runtime module already owns a foreign host dispatcher");
  }
  const state: HostDispatcherState = {
    nextBindingId: 1,
    slots: new Map(),
    memoryView: new DataView(module.HEAPU8.buffer),
    scalarArguments: new Int32Array(PICO_HOST_CALL_FRAME.SCALAR_CAPACITY),
  };
  const callback: HostDispatchCallback = (
    bindingId,
    callFramePointer,
  ) => {
    const slot = state.slots.get(bindingId >>> 0);
    if (slot === undefined || slot.state !== "bound" || slot.host === undefined) {
      if (slot !== undefined) slot.error = `host binding ${bindingId >>> 0} is ${slot.state}`;
      return HOST_DISPATCH_FAILED;
    }
    try {
      const pointer = callFramePointer >>> 0;
      if (
        pointer === 0 ||
        pointer + PICO_HOST_CALL_FRAME.BYTE_SIZE > module.HEAPU8.byteLength ||
        state.memoryView.getUint32(pointer, true) !== PICO_HOST_CALL_FRAME.BYTE_SIZE
      ) {
        throw new RangeError("host dispatch received an invalid call frame");
      }
      const scalarCount = state.memoryView.getUint32(
        pointer + PICO_HOST_CALL_FRAME.SCALAR_COUNT,
        true,
      );
      if (scalarCount > PICO_HOST_CALL_FRAME.SCALAR_CAPACITY) {
        throw new RangeError("host dispatch scalar count exceeds call-frame capacity");
      }
      for (let index = 0; index < PICO_HOST_CALL_FRAME.SCALAR_CAPACITY; index += 1) {
        state.scalarArguments[index] = state.memoryView.getInt32(
          pointer + PICO_HOST_CALL_FRAME.SCALAR_SLOTS + index * 4,
          true,
        );
      }
      const bytePointer = state.memoryView.getUint32(
        pointer + PICO_HOST_CALL_FRAME.BYTE_BUFFER_POINTER,
        true,
      );
      const byteLength = state.memoryView.getUint32(
        pointer + PICO_HOST_CALL_FRAME.BYTE_BUFFER_LENGTH,
        true,
      );
      if (
        (bytePointer === 0 && byteLength !== 0) ||
        bytePointer + byteLength > module.HEAPU8.byteLength
      ) {
        throw new RangeError("host dispatch received an invalid byte-string view");
      }
      const byteString = bytePointer === 0
        ? undefined
        : module.HEAPU8.subarray(bytePointer, bytePointer + byteLength);
      const result = dispatchPicoHostCall(
        slot.host,
        state.memoryView.getUint32(pointer + PICO_HOST_CALL_FRAME.OPERATION_ID, true),
        state.memoryView.getUint32(pointer + PICO_HOST_CALL_FRAME.PRESENCE_BITS, true),
        state.scalarArguments,
        byteString,
      );
      state.memoryView.setInt32(pointer + PICO_HOST_CALL_FRAME.RESULT, result | 0, true);
      slot.error = undefined;
      return HOST_DISPATCH_OK;
    } catch (error) {
      slot.error = safeErrorMessage(error);
      return HOST_DISPATCH_FAILED;
    }
  };
  Object.defineProperty(carrier, hostDispatcherState, { value: state });
  module.p8wHostCall = callback;
  return state;
}

/** Session-local, exactly-once host slot backed by a module-local dispatcher. */
export class PicoApiHostRouter {
  readonly bindingId: number;
  readonly #module: FrameRuntimeModule;
  readonly #dispatcher: HostDispatcherState;
  readonly #slot: HostBindingSlot;

  constructor(module: FrameRuntimeModule) {
    const state = dispatcherState(module);
    const bindingId = state.nextBindingId++;
    if (bindingId === 0 || bindingId > 0xffff_ffff) {
      throw new Error("frame runtime host binding ids are exhausted");
    }
    this.bindingId = bindingId >>> 0;
    this.#module = module;
    this.#dispatcher = state;
    this.#slot = { state: "unbound", host: undefined, error: undefined };
    state.slots.set(this.bindingId, this.#slot);
  }

  get state(): HostBindingState {
    return this.#slot.state;
  }

  assertModule(module: FrameRuntimeModule): void {
    if (module !== this.#module) throw new Error("host router belongs to a different WASM module");
  }

  bind(host: PicoApiHost): void {
    if (this.#slot.state !== "unbound") {
      throw new Error(`host router cannot bind from ${this.#slot.state}`);
    }
    this.#slot.host = host;
    this.#slot.error = undefined;
    this.#slot.state = "bound";
  }

  release(): void {
    if (this.#slot.state === "released") return;
    this.#slot.host = undefined;
    this.#slot.error = undefined;
    this.#slot.state = "released";
    this.#dispatcher.slots.delete(this.bindingId);
  }

  consumeError(): string | undefined {
    const error = this.#slot.error;
    this.#slot.error = undefined;
    return error;
  }
}

export function createPicoApiHostRouter(module: FrameRuntimeModule): PicoApiHostRouter {
  return new PicoApiHostRouter(module);
}

function frameState(raw: number): FrameVmState {
  return (
    [
      "empty",
      "compiled",
      "booting",
      "callback-loop",
      "custom-loop",
      "waiting-host",
      "faulted",
      "stopped",
    ] as const
  )[raw] ?? "faulted";
}

function frameMode(raw: number): FrameVmMode {
  return (["none", "callback", "custom"] as const)[raw] ?? "none";
}

function runtimePhase(raw: number): VmFaultRecord["phase"] {
  return (
    [
      "none",
      "compile",
      "boot",
      "init",
      "update",
      "update60",
      "draw",
      "custom-loop",
      "host-call",
    ] as const
  )[raw] ?? "none";
}

function failureCode(status: number): VmFaultRecord["code"] {
  switch (status) {
    case STATUS_LOAD_ERROR:
      return "E_VM_SYNTAX";
    case STATUS_RUNTIME_ERROR:
      return "E_VM_RUNTIME";
    case STATUS_BUDGET:
      return "E_VM_INSTRUCTION_BUDGET";
    case STATUS_OOM:
      return "E_VM_OOM";
    case STATUS_UNSUPPORTED:
      return "E_FEATURE_UNSUPPORTED";
    case STATUS_HOST_ERROR:
      return "E_HOST_REQUEST";
    case STATUS_HOST_API_ERROR:
      return "E_HOST_API";
    case STATUS_INVALID_HANDLE:
    case STATUS_INVALID_STATE:
    case STATUS_BAD_ARGUMENT:
      return "E_INVALID_STATE";
    default:
      return "E_INVARIANT";
  }
}

function checkedUint32(name: string, value: number, positive = false): number {
  if (
    !Number.isInteger(value) ||
    value < (positive ? 1 : 0) ||
    value > 0xffff_ffff
  ) {
    throw new RangeError(`${name} must be ${positive ? "a positive " : "an "}uint32`);
  }
  return value >>> 0;
}

function checkedTimeRaw(value: number): number {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError("timeRaw must be a signed Q16.16 int32");
  }
  return value | 0;
}

function checkedButtons(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0x3f) {
    throw new RangeError("buttons must be a six-bit P1 bitmask");
  }
  return value;
}

/** Adapter-owned stable view over the production frame runtime's Base RAM. */
class FrameRuntimeMemoryBinding implements PicoLogicalMemoryPort {
  readonly bytes: Uint8Array;
  readonly lease: PicoMemoryLease;
  readonly #module: FrameRuntimeModule;
  readonly #handle: number;

  constructor(module: FrameRuntimeModule, handle: number) {
    const pointer = module._p8w_ram_ptr(handle) >>> 0;
    const size = module._p8w_ram_size(handle) >>> 0;
    const buffer = module.HEAPU8.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("frame runtime requires a non-shared ArrayBuffer");
    }
    if (pointer === 0 || size !== PICO_RAM_SIZE || pointer + size > module.HEAPU8.byteLength) {
      throw new RangeError("invalid or stale frame runtime Pico RAM allocation");
    }
    this.#module = module;
    this.#handle = handle;
    this.bytes = module.HEAPU8.subarray(pointer, pointer + size);
    this.lease = Object.freeze({
      buffer,
      byteOffset: pointer,
      byteLength: PICO_RAM_SIZE,
      leaseId: `p8w:${moduleId(module)}:${handle >>> 0}:${pointer}`,
    });
  }

  assertBound(): void {
    if (
      this.#module.HEAPU8.buffer !== this.lease.buffer ||
      (this.#module._p8w_ram_ptr(this.#handle) >>> 0) !== this.lease.byteOffset ||
      (this.#module._p8w_ram_size(this.#handle) >>> 0) !== PICO_RAM_SIZE
    ) {
      throw new Error("stale or detached frame runtime Pico RAM lease");
    }
  }

  get memoryLeaseId(): string {
    return this.lease.leaseId;
  }

  mapAddress(logicalAddress: number): number {
    this.assertBound();
    if (!Number.isInteger(logicalAddress) || !Number.isSafeInteger(logicalAddress)) {
      throw new RangeError("logical Pico RAM address must be a safe integer");
    }
    const mapped = this.#module._p8w_map_address(
      this.#handle,
      logicalAddress >>> 0,
    ) >>> 0;
    if (mapped === INVALID_MAPPED_ADDRESS || mapped >= PICO_RAM_SIZE) {
      throw new RangeError("unable to map frame runtime Pico RAM address");
    }
    return mapped;
  }
}

type FrameOperation = "compile" | "boot" | "step" | "complete-host";

export class Z8LuaFrameVm implements FrameVmPort {
  readonly memory: PicoMemoryLease;
  readonly logicalMemory: PicoLogicalMemoryPort;
  readonly #module: FrameRuntimeModule;
  readonly #binding: FrameRuntimeMemoryBinding;
  readonly #hostRouter: PicoApiHostRouter;
  #handle: number;

  constructor(
    module: FrameRuntimeModule,
    hostRouter: PicoApiHostRouter,
    options: Z8LuaFrameVmOptions = {},
  ) {
    hostRouter.assertModule(module);
    if ((module._p8w_abi_version() >>> 0) !== FRAME_ABI_VERSION) {
      hostRouter.release();
      throw new Error("unsupported p8w frame runtime ABI version");
    }
    const heapLimit = options.luaHeapLimit ?? 0;
    if (!Number.isInteger(heapLimit) || heapLimit < 0 || heapLimit > 0xffff_ffff) {
      hostRouter.release();
      throw new RangeError("luaHeapLimit must be a uint32");
    }
    const handle = module._p8w_create(heapLimit) >>> 0;
    if (handle === 0) {
      hostRouter.release();
      throw new Error("unable to create z8lua frame VM");
    }
    try {
      this.#module = module;
      this.#handle = handle;
      this.#hostRouter = hostRouter;
      this.#binding = new FrameRuntimeMemoryBinding(module, handle);
      this.memory = this.#binding.lease;
      this.logicalMemory = this.#binding;
    } catch (error) {
      module._p8w_destroy(handle);
      hostRouter.release();
      throw error;
    }
  }

  get hostBindingState(): HostBindingState {
    return this.#hostRouter.state;
  }

  bindHost(host: PicoApiHost): void {
    this.#assertLive();
    if (host.memoryLeaseId !== this.memory.leaseId) {
      throw new Error("PicoApiHost is bound to a different memory lease");
    }
    this.#hostRouter.bind(host);
    const status = this.#module._p8w_bind_host(
      this.#handle,
      this.#hostRouter.bindingId,
    ) >>> 0;
    if (status !== STATUS_OK) {
      this.#hostRouter.release();
      throw new Error(`unable to bind PicoApiHost: p8w status ${status}`);
    }
  }

  resetRam(): void {
    this.#assertLive();
    if (this.#module._p8w_ram_reset(this.#handle) !== STATUS_OK) {
      throw new Error("unable to reset frame runtime Pico RAM");
    }
  }

  writeCartRom(rom: Uint8Array): void {
    this.#assertLive();
    if (!(rom instanceof Uint8Array) || rom.byteLength !== CART_ROM_BYTES) {
      throw new RangeError("cart ROM must be exactly 0x8000 bytes");
    }
    this.#binding.bytes.set(rom.subarray(0, CART_ROM_RUNTIME_BYTES), 0);
  }

  copyRam(offset: number, length: number): Uint8Array {
    this.#assertLive();
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > PICO_RAM_SIZE
    ) {
      throw new RangeError("Pico RAM copy range is out of bounds");
    }
    return this.#binding.bytes.slice(offset, offset + length);
  }

  compile(source: Uint8Array): VmOperationOutcome {
    this.#assertLive();
    const status = this.#withBytes(source, (pointer, length) =>
      this.#module._p8w_compile(this.#handle, pointer, length),
    );
    return this.#outcome(status, "compile");
  }

  boot(instructionBudget: number, buttons: number, timeRaw: number): VmOperationOutcome {
    this.#assertLive();
    return this.#outcome(
      this.#module._p8w_boot(
        this.#handle,
        checkedUint32("instructionBudget", instructionBudget, true),
        checkedButtons(buttons),
        checkedTimeRaw(timeRaw),
      ),
      "boot",
    );
  }

  step(instructionBudget: number, buttons: number, timeRaw: number): VmOperationOutcome {
    this.#assertLive();
    return this.#outcome(
      this.#module._p8w_step(
        this.#handle,
        checkedUint32("instructionBudget", instructionBudget, true),
        checkedButtons(buttons),
        checkedTimeRaw(timeRaw),
      ),
      "step",
    );
  }

  completeHostRequest(
    requestId: number,
    response: Uint8Array,
    isError: boolean,
    instructionBudget: number,
  ): VmOperationOutcome {
    this.#assertLive();
    const status = this.#withBytes(response, (pointer, length) =>
      this.#module._p8w_complete_host_request(
        this.#handle,
        checkedUint32("requestId", requestId, true),
        pointer,
        length,
        isError ? 1 : 0,
        checkedUint32("instructionBudget", instructionBudget, true),
      ),
    );
    return this.#outcome(status, "complete-host");
  }

  destroy(): void {
    if (this.#handle === 0) return;
    const handle = this.#handle;
    this.#handle = 0;
    try {
      if (this.#module._p8w_destroy(handle) !== STATUS_OK) {
        throw new Error("unable to destroy z8lua frame VM");
      }
    } finally {
      this.#hostRouter.release();
    }
  }

  #assertLive(): void {
    if (this.#handle === 0) throw new Error("z8lua frame VM is destroyed");
    this.#binding.assertBound();
  }

  #withBytes(bytes: Uint8Array, call: (pointer: number, length: number) => number): number {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("expected Uint8Array");
    if (bytes.byteLength === 0) return call(0, 0) >>> 0;
    const pointer = this.#module._p8w_alloc(bytes.byteLength) >>> 0;
    if (pointer === 0 || pointer + bytes.byteLength > this.#module.HEAPU8.byteLength) {
      if (pointer !== 0) this.#module._p8w_free(pointer);
      throw new Error("unable to allocate bridge byte buffer");
    }
    try {
      this.#module.HEAPU8.set(bytes, pointer);
      return call(pointer, bytes.byteLength) >>> 0;
    } finally {
      this.#module._p8w_free(pointer);
    }
  }

  #copyBytes(pointer: number, length: number): Uint8Array {
    const start = pointer >>> 0;
    const size = length >>> 0;
    if (size === 0) return new Uint8Array();
    if (start === 0 || start + size > this.#module.HEAPU8.byteLength) {
      throw new Error("bridge returned an invalid byte range");
    }
    return this.#module.HEAPU8.slice(start, start + size);
  }

  #text(pointer: number, length: number): string {
    return textDecoder.decode(this.#copyBytes(pointer, length));
  }

  #fault(status: number): VmFaultRecord {
    const bridgeMessage = this.#text(
      this.#module._p8w_error_message_ptr(this.#handle),
      this.#module._p8w_error_message_length(this.#handle),
    );
    const message = status === STATUS_HOST_API_ERROR
      ? (this.#hostRouter.consumeError() ?? bridgeMessage) || `p8w status ${status}`
      : bridgeMessage || `p8w status ${status}`;
    const trace = this.#text(
      this.#module._p8w_error_trace_ptr(this.#handle),
      this.#module._p8w_error_trace_length(this.#handle),
    );
    const line = this.#module._p8w_error_line(this.#handle) | 0;
    const code = failureCode(status);
    return {
      code,
      message,
      phase: runtimePhase(this.#module._p8w_phase(this.#handle) >>> 0),
      ...(line < 0 ? {} : { line }),
      ...(trace.length === 0 ? {} : { trace }),
      ...(code === "E_FEATURE_UNSUPPORTED" && message === "nested-host-suspend"
        ? { details: { reason: "nested-host-suspend" } }
        : {}),
    };
  }

  #outcome(statusValue: number, operation: FrameOperation): VmOperationOutcome {
    const status = statusValue >>> 0;
    const state = frameState(this.#module._p8w_state(this.#handle) >>> 0);
    const mode = frameMode(this.#module._p8w_mode(this.#handle) >>> 0);
    const rawFps = this.#module._p8w_target_fps(this.#handle) >>> 0;
    const targetFps: 0 | 30 | 60 = rawFps === 30 || rawFps === 60 ? rawFps : 0;
    const consumedInstructions =
      this.#module._p8w_consumed_instructions(this.#handle) >>> 0;
    const base = { mode, state, targetFps, consumedInstructions };
    const reason = this.#module._p8w_yield_reason(this.#handle) >>> 0;

    if (status === STATUS_STOPPED) return { ...base, kind: "stopped" };
    if (status !== STATUS_OK && status !== STATUS_YIELDED) {
      return {
        ...base,
        kind: "fault",
        state: "faulted",
        error: this.#fault(status),
      };
    }
    if (status === STATUS_YIELDED && reason === YIELD_HOST_REQUEST) {
      return {
        ...base,
        kind: "host-request",
        state: "waiting-host",
        request: {
          id: this.#module._p8w_pending_request_id(this.#handle) >>> 0,
          bytes: this.#copyBytes(
            this.#module._p8w_pending_request_ptr(this.#handle),
            this.#module._p8w_pending_request_length(this.#handle),
          ),
        },
      };
    }
    if (
      (operation === "step" || operation === "complete-host") &&
      (reason === YIELD_FRAME_END || reason === YIELD_FLIP)
    ) {
      return { ...base, kind: "frame" };
    }
    if (operation === "step" && reason !== YIELD_FRAME_END && reason !== YIELD_FLIP) {
      return {
        ...base,
        kind: "fault",
        state: "faulted",
        error: {
          code: "E_INVARIANT",
          message: "VM step returned without a frame boundary",
          phase: runtimePhase(this.#module._p8w_phase(this.#handle) >>> 0),
        },
      };
    }
    return { ...base, kind: "ready" };
  }
}
