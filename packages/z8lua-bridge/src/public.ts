import {
  PICO_RAM_SIZE,
  type PicoMemoryLease,
} from "@pico8-web/contracts";
import type {
  VmLogSnapshot,
  FrameVmMode,
  FrameVmPort,
  FrameVmState,
  MenuButtonIntent,
  MenuItemSnapshot,
  MenuSnapshot,
  PicoLogicalMemoryPort,
  PicoApiHost,
  VmFaultRecord,
  VmOperationOutcome,
  VmMenuInvocationOutcome,
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
  error: HostDispatchFailure | undefined;
}

interface HostDispatchFailure {
  readonly message: string;
  readonly code?: "E_FEATURE_UNSUPPORTED";
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

function moduleId(module: object): number {
  const existing = moduleIds.get(module);
  if (existing !== undefined) return existing;
  const assigned = nextModuleId++;
  moduleIds.set(module, assigned);
  return assigned;
}

export type { PicoMemoryLease } from "@pico8-web/contracts";

/** Runtime v1 ABI surface. */
export interface FrameRuntimeModule {
  readonly HEAPU8: Uint8Array;
  p8wHostCall?: HostDispatchCallback;
  _p8w_abi_version(): number;
  _p8w_create(luaHeapLimit: number): number;
  _p8w_destroy(handle: number): number;
  _p8w_bind_host(handle: number, bindingId: number): number;
  _p8w_set_run_parameter(
    handle: number,
    parameterPointer: number,
    parameterLength: number,
  ): number;
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
  _p8w_log_snapshot(handle: number, destination: number, capacity: number): number;
  _p8w_menu_snapshot(handle: number, destination: number, capacity: number): number;
  _p8w_menu_invoke(
    handle: number,
    slot: number,
    buttonMask: number,
    budget: number,
  ): number;
  _p8w_menu_outcome(handle: number): number;
  _p8w_state(handle: number): number;
  _p8w_mode(handle: number): number;
  _p8w_target_fps(handle: number): number;
  _p8w_yield_reason(handle: number): number;
  _p8w_phase(handle: number): number;
  _p8w_consumed_instructions(handle: number): number;
  _p8w_lua_live_bytes(handle: number): number;
  _p8w_lua_heap_limit(handle: number): number;
  _p8w_live_contexts(): number;
  _p8w_pending_request_id(handle: number): number;
  _p8w_pending_request_ptr(handle: number): number;
  _p8w_pending_request_length(handle: number): number;
  _p8w_control_bytes_ptr(handle: number): number;
  _p8w_control_bytes_length(handle: number): number;
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

const FRAME_ABI_VERSION = 0x0001_0005;
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
const STATUS_RESTART = 14;
const MENU_OUTCOME_CLOSE = 1;
const MENU_OUTCOME_KEEP_OPEN = 2;
const MENU_OUTCOME_REMOVED = 3;
const MENU_SNAPSHOT_BYTES = 104;
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
      if (slot !== undefined) {
        slot.error = { message: `host binding ${bindingId >>> 0} is ${slot.state}` };
      }
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
      slot.error = {
        message: safeErrorMessage(error),
        ...(error instanceof Error && error.name === "PicoFeatureUnsupportedError"
          ? { code: "E_FEATURE_UNSUPPORTED" as const }
          : {}),
      };
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
    return this.consumeFailure()?.message;
  }

  consumeFailure(): HostDispatchFailure | undefined {
    const failure = this.#slot.error;
    this.#slot.error = undefined;
    return failure;
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
      "menuitem",
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

  get liveLuaBytes(): number {
    this.#assertLive();
    return this.#module._p8w_lua_live_bytes(this.#handle) >>> 0;
  }

  get luaHeapLimit(): number {
    this.#assertLive();
    return this.#module._p8w_lua_heap_limit(this.#handle) >>> 0;
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

  setRunParameter(parameter: Uint8Array): void {
    this.#assertLive();
    if (!(parameter instanceof Uint8Array) || parameter.byteLength > 4096) {
      throw new RangeError("run parameter must be a Uint8Array of at most 4096 bytes");
    }
    const status = this.#withBytes(parameter, (pointer, length) =>
      this.#module._p8w_set_run_parameter(this.#handle, pointer, length)
    );
    if (status !== STATUS_OK) {
      throw new Error(`unable to set run parameter: p8w status ${status}`);
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

  snapshotLogs(): VmLogSnapshot {
    this.#assertLive();
    const size = 12 + 64 * 1040;
    const pointer = this.#module._p8w_alloc(size) >>> 0;
    if (pointer === 0) throw new Error("unable to allocate log snapshot");
    try {
      const status = this.#module._p8w_log_snapshot(this.#handle, pointer, size);
      if (status !== STATUS_OK) throw new Error(`log snapshot rejected: ${status}`);
      const bytes = this.#module.HEAPU8.slice(pointer, pointer + size);
      const view = new DataView(bytes.buffer);
      const count = view.getUint32(4, true);
      if (view.getUint32(0, true) !== 1 || count > 64) throw new Error("invalid log snapshot");
      const entries = [];
      for (let i = 0; i < count; i++) {
        const offset = 12 + i * 1040, length = view.getUint32(offset + 8, true);
        if (length > 1024) throw new Error("invalid log length");
        const frame = view.getInt32(offset + 4, true);
        entries.push({ sequence: view.getUint32(offset, true), frameId: frame < 0 ? null : frame,
          bytes: bytes.slice(offset + 16, offset + 16 + length), truncated: view.getUint32(offset + 12, true) !== 0 });
      }
      return { sequence: view.getUint32(8, true), entries };
    } finally { this.#module._p8w_free(pointer); }
  }

  snapshotMenuItems(): MenuSnapshot {
    this.#assertLive();
    const pointer = this.#module._p8w_alloc(MENU_SNAPSHOT_BYTES) >>> 0;
    if (pointer === 0 || pointer + MENU_SNAPSHOT_BYTES > this.#module.HEAPU8.byteLength) {
      if (pointer !== 0) this.#module._p8w_free(pointer);
      throw new Error("unable to allocate menu snapshot buffer");
    }
    let bytes: Uint8Array;
    try {
      const status = this.#module._p8w_menu_snapshot(
        this.#handle,
        pointer,
        MENU_SNAPSHOT_BYTES,
      ) >>> 0;
      if (status !== STATUS_OK) {
        throw new Error(`menu snapshot rejected: p8w status ${status}`);
      }
      bytes = this.#module.HEAPU8.slice(pointer, pointer + MENU_SNAPSHOT_BYTES);
    } finally {
      this.#module._p8w_free(pointer);
    }
    if (bytes[0] !== 1 || bytes[1] !== 5 || bytes[2] !== 20 || bytes[3] !== 0) {
      throw new Error("unsupported or malformed menu snapshot codec");
    }
    const items: MenuItemSnapshot[] = [];
    for (let index = 0; index < 5; index += 1) {
      const offset = 4 + index * 20;
      const occupied = bytes[offset];
      const length = bytes[offset + 1]!;
      const filter = bytes[offset + 2]! | (bytes[offset + 3]! << 8);
      if ((occupied !== 0 && occupied !== 1) || length > 16 ||
        (occupied === 0 && (length !== 0 || filter !== 0))) {
        throw new Error("malformed menu snapshot slot record");
      }
      if (occupied === 1) {
        items.push({
          slot: (index + 1) as MenuItemSnapshot["slot"],
          label: bytes.slice(offset + 4, offset + 4 + length),
          filter,
        });
      }
    }
    return { items };
  }

  invokeMenuItem(
    slot: MenuItemSnapshot["slot"],
    button: MenuButtonIntent,
    instructionBudget: number,
  ): VmMenuInvocationOutcome {
    this.#assertLive();
    const status = this.#module._p8w_menu_invoke(
      this.#handle,
      slot,
      button,
      checkedUint32("instructionBudget", instructionBudget, true),
    ) >>> 0;
    if (status === STATUS_INVALID_STATE || status === STATUS_BAD_ARGUMENT) {
      return { kind: "rejected", message: `menu invocation rejected: p8w status ${status}` };
    }
    if (status !== STATUS_OK) return { kind: "fault", error: this.#fault(status) };
    const outcome = this.#module._p8w_menu_outcome(this.#handle) >>> 0;
    if (outcome === MENU_OUTCOME_CLOSE) return { kind: "close" };
    if (outcome === MENU_OUTCOME_KEEP_OPEN) return { kind: "keep-open" };
    if (outcome === MENU_OUTCOME_REMOVED) return { kind: "removed" };
    return {
      kind: "fault",
      error: {
        code: "E_INVARIANT",
        message: `unknown menu invocation outcome ${outcome}`,
        phase: "menuitem",
      },
    };
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
    const hostFailure = status === STATUS_HOST_API_ERROR
      ? this.#hostRouter.consumeFailure()
      : undefined;
    const message = status === STATUS_HOST_API_ERROR
      ? (hostFailure?.message ?? bridgeMessage) || `p8w status ${status}`
      : bridgeMessage || `p8w status ${status}`;
    const trace = this.#text(
      this.#module._p8w_error_trace_ptr(this.#handle),
      this.#module._p8w_error_trace_length(this.#handle),
    );
    const line = this.#module._p8w_error_line(this.#handle) | 0;
    const code = hostFailure?.code ?? failureCode(status);
    const oomDetails = code === "E_VM_OOM"
      ? {
          liveLuaBytes: this.#module._p8w_lua_live_bytes(this.#handle) >>> 0,
          luaHeapLimit: this.#module._p8w_lua_heap_limit(this.#handle) >>> 0,
        }
      : undefined;
    return {
      code,
      message,
      phase: runtimePhase(this.#module._p8w_phase(this.#handle) >>> 0),
      ...(line < 0 ? {} : { line }),
      ...(trace.length === 0 ? {} : { trace }),
      ...(code === "E_FEATURE_UNSUPPORTED" && message === "nested-host-suspend"
        ? { details: { reason: "nested-host-suspend" } }
        : oomDetails === undefined ? {} : { details: oomDetails }),
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

    if (status === STATUS_STOPPED) {
      return {
        ...base,
        kind: "stopped",
        state: "stopped",
        message: this.#copyBytes(
          this.#module._p8w_control_bytes_ptr(this.#handle),
          this.#module._p8w_control_bytes_length(this.#handle),
        ),
      };
    }
    if (status === STATUS_RESTART) {
      return {
        ...base,
        kind: "restart",
        state: "stopped",
        parameter: this.#copyBytes(
          this.#module._p8w_control_bytes_ptr(this.#handle),
          this.#module._p8w_control_bytes_length(this.#handle),
        ),
      };
    }
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
