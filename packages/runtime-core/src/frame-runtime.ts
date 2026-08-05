import type { ParsedCart } from "@pico8-web/cart-codec";
import {
  type PicoInputSnapshot,
  type PicoMemoryLease,
  type RuntimeErrorCode,
  type RuntimePhase,
  type SerializedRuntimeError,
} from "@pico8-web/contracts";
import { normalizeButtons } from "./input/l1-input.js";
import {
  createPicoApiHost,
  type PicoApiHost,
} from "./pico-api/pico-api-host.js";
import { PicoRam } from "./memory/pico-ram.js";

export type FrameVmMode = "none" | "callback" | "custom";
export type FrameVmState =
  | "empty"
  | "compiled"
  | "booting"
  | "callback-loop"
  | "custom-loop"
  | "waiting-host"
  | "faulted"
  | "stopped";

export interface VmFaultRecord {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly phase: RuntimePhase;
  readonly line?: number;
  readonly trace?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface VmHostRequest {
  readonly id: number;
  readonly bytes: Uint8Array;
}

export type VmOperationOutcome =
  | {
      readonly kind: "ready" | "frame" | "stopped";
      readonly mode: FrameVmMode;
      readonly state: FrameVmState;
      readonly targetFps: 0 | 30 | 60;
      readonly consumedInstructions: number;
    }
  | {
      readonly kind: "host-request";
      readonly mode: FrameVmMode;
      readonly state: "waiting-host";
      readonly targetFps: 0 | 30 | 60;
      readonly consumedInstructions: number;
      readonly request: VmHostRequest;
    }
  | {
      readonly kind: "fault";
      readonly mode: FrameVmMode;
      readonly state: "faulted";
      readonly targetFps: 0 | 30 | 60;
      readonly consumedInstructions: number;
      readonly error: VmFaultRecord;
    };

/** Runtime-neutral VM port. The concrete z8lua/Emscripten adapter lives elsewhere. */
export interface PicoLogicalMemoryPort {
  readonly memoryLeaseId: string;
  mapAddress(logicalAddress: number): number;
}

export interface FrameVmPort {
  readonly memory: PicoMemoryLease;
  readonly logicalMemory: PicoLogicalMemoryPort;
  readonly hostBindingState: "unbound" | "bound" | "released";
  bindHost(host: PicoApiHost): void;
  resetRam(): void;
  writeCartRom(rom: Uint8Array): void;
  copyRam(offset: number, length: number): Uint8Array;
  compile(source: Uint8Array): VmOperationOutcome;
  boot(instructionBudget: number, buttons: number, timeRaw: number): VmOperationOutcome;
  step(instructionBudget: number, buttons: number, timeRaw: number): VmOperationOutcome;
  completeHostRequest(
    requestId: number,
    response: Uint8Array,
    isError: boolean,
    instructionBudget: number,
  ): VmOperationOutcome;
  destroy(): void;
}

export type RuntimeSessionState =
  | "empty"
  | "ready"
  | "waiting-host"
  | "faulted"
  | "stopped"
  | "disposed";

export interface RuntimeFrame {
  /** Zero-based host-published frame index; startup does not publish frame 0. */
  readonly frameId: number;
  /** Committed target-rate clock slices, including the 1/30-second startup epoch. */
  readonly completedSlices: string;
  /** Guest clock for this transaction; equals logicalTimeRaw(completedSlices, targetFps). */
  readonly timeRawBeforeStep: number;
  readonly targetFps: 30 | 60;
  /** Packed 4bpp screen bytes copied from Base RAM 0x6000..0x7fff. */
  readonly screen: Uint8Array;
  /** 16-entry display-palette map snapshotted from Base RAM 0x5f10..0x5f1f. */
  readonly displayPalette: Uint8Array;
}

export interface RuntimeHostRequest {
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly operation: "boot" | "step";
}

export type RuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SerializedRuntimeError };

export type RuntimeBootResult =
  | {
      readonly kind: "ready";
      readonly mode: Exclude<FrameVmMode, "none">;
      readonly targetFps: 30 | 60;
    }
  | { readonly kind: "host-request"; readonly request: RuntimeHostRequest };

export type RuntimeStepResult =
  | { readonly kind: "frame"; readonly frame: RuntimeFrame }
  | { readonly kind: "host-request"; readonly request: RuntimeHostRequest }
  | { readonly kind: "stopped" };

export interface FrameRuntimeOptions {
  readonly instructionBudget?: number;
  readonly picoApiHost?: PicoApiHost;
}

interface PendingTransaction {
  readonly operation: "boot" | "step";
  readonly buttons: number;
  readonly timeRaw: number;
  remainingBudget: number;
}

const DEFAULT_INSTRUCTION_BUDGET = 1_000_000;
const CART_ROM_BYTES = 0x8000;
const SCREEN_OFFSET = 0x6000;
const SCREEN_BYTES = 0x2000;
const DISPLAY_PALETTE_OFFSET = 0x5f10;
const DISPLAY_PALETTE_BYTES = 16;
const STARTUP_TIME_RAW = Math.floor(65_536 / 30);

function invalidState(message: string): SerializedRuntimeError {
  return {
    code: "E_INVALID_STATE",
    message,
    phase: "none",
    recoverable: false,
  };
}

function serializeFault(record: VmFaultRecord): SerializedRuntimeError {
  return {
    code: record.code,
    message: record.message,
    phase: record.phase,
    ...(record.line === undefined ? {} : { line: record.line }),
    ...(record.trace === undefined ? {} : { trace: record.trace }),
    recoverable: record.code === "E_VM_SYNTAX",
    ...(record.details === undefined ? {} : { details: record.details }),
  };
}

/** Exact signed Q16.16 logical time derived from completed simulation slices. */
export function logicalTimeRaw(completedSlices: bigint, targetFps: 30 | 60): number {
  if (completedSlices < 0n) throw new RangeError("completedSlices must be non-negative");
  const raw = (completedSlices * 65_536n) / BigInt(targetFps);
  return Number(BigInt.asIntN(32, raw)) | 0;
}

export class FrameSliceRuntime {
  readonly #vm: FrameVmPort;
  readonly #picoApiHost: PicoApiHost;
  readonly #ram: PicoRam;
  readonly #instructionBudget: number;
  #state: RuntimeSessionState = "empty";
  #mode: FrameVmMode = "none";
  #targetFps: 0 | 30 | 60 = 0;
  #completedSlices = 0n;
  #frameId = 0;
  #pending: PendingTransaction | undefined;

  constructor(vm: FrameVmPort, options: FrameRuntimeOptions = {}) {
    const budget = options.instructionBudget ?? DEFAULT_INSTRUCTION_BUDGET;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 0xffff_ffff) {
      throw new RangeError("instructionBudget must be a positive uint32");
    }
    this.#vm = vm;
    this.#instructionBudget = budget;
    this.#ram = new PicoRam(vm.memory, vm.logicalMemory);
    const host = options.picoApiHost ?? createPicoApiHost(vm.memory, vm.logicalMemory);
    if (host.memoryLeaseId !== vm.memory.leaseId) {
      throw new Error("PicoApiHost is bound to a different memory lease");
    }
    vm.bindHost(host);
    this.#picoApiHost = host;
  }

  get state(): RuntimeSessionState {
    return this.#state;
  }

  get mode(): FrameVmMode {
    return this.#mode;
  }

  get completedSlices(): bigint {
    return this.#completedSlices;
  }

  boot(
    cart: Pick<ParsedCart, "rom" | "code">,
    input: PicoInputSnapshot = { buttons: 0 },
  ): RuntimeResult<RuntimeBootResult> {
    if (this.#state !== "empty") {
      return { ok: false, error: invalidState("runtime session is not empty") };
    }
    let buttons: number;
    try {
      buttons = normalizeButtons(input);
    } catch (error) {
      return {
        ok: false,
        error: invalidState(error instanceof Error ? error.message : String(error)),
      };
    }
    if (cart.rom.byteLength !== CART_ROM_BYTES) {
      return { ok: false, error: invalidState("cart ROM must be exactly 0x8000 bytes") };
    }
    this.#vm.resetRam();
    this.#picoApiHost.reset();
    this.#vm.writeCartRom(cart.rom);
    const compiled = this.#vm.compile(cart.code);
    if (compiled.kind === "fault") return this.#acceptFault(compiled.error);
    this.#picoApiHost.beginTick({ buttons }, 30);
    const outcome = this.#vm.boot(
      this.#instructionBudget,
      buttons,
      STARTUP_TIME_RAW,
    );
    return this.#acceptBootOutcome(
      outcome,
      buttons,
      STARTUP_TIME_RAW,
      this.#instructionBudget,
    );
  }

  step(input: PicoInputSnapshot = { buttons: 0 }): RuntimeResult<RuntimeStepResult> {
    if (this.#state !== "ready" || this.#targetFps === 0) {
      return { ok: false, error: invalidState("runtime session is not ready to step") };
    }
    let buttons: number;
    try {
      buttons = normalizeButtons(input);
    } catch (error) {
      return {
        ok: false,
        error: invalidState(error instanceof Error ? error.message : String(error)),
      };
    }
    const timeRaw = logicalTimeRaw(this.#completedSlices + 1n, this.#targetFps);
    this.#picoApiHost.beginTick({ buttons }, this.#targetFps);
    const outcome = this.#vm.step(this.#instructionBudget, buttons, timeRaw);
    return this.#acceptStepOutcome(
      outcome,
      buttons,
      timeRaw,
      this.#instructionBudget,
    );
  }

  completeHostRequest(
    requestId: number,
    response: Uint8Array,
    isError = false,
  ): RuntimeResult<RuntimeBootResult | RuntimeStepResult> {
    const pending = this.#pending;
    if (this.#state !== "waiting-host" || pending === undefined) {
      return { ok: false, error: invalidState("no host request is pending") };
    }
    const outcome = this.#vm.completeHostRequest(
      requestId,
      response,
      isError,
      pending.remainingBudget,
    );
    if (pending.operation === "boot") {
      return this.#acceptBootOutcome(
        outcome,
        pending.buttons,
        pending.timeRaw,
        pending.remainingBudget,
      );
    }
    return this.#acceptStepOutcome(
      outcome,
      pending.buttons,
      pending.timeRaw,
      pending.remainingBudget,
    );
  }

  copyRam(offset: number, length: number): Uint8Array {
    return this.#vm.copyRam(offset, length);
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#vm.destroy();
    this.#pending = undefined;
    this.#state = "disposed";
  }

  #acceptFault<T>(fault: VmFaultRecord): RuntimeResult<T> {
    this.#pending = undefined;
    this.#state = "faulted";
    return { ok: false, error: serializeFault(fault) };
  }

  #captureMode(outcome: VmOperationOutcome): boolean {
    this.#mode = outcome.mode;
    this.#targetFps = outcome.targetFps;
    return outcome.mode !== "none" && outcome.targetFps !== 0;
  }

  #acceptBootOutcome(
    outcome: VmOperationOutcome,
    buttons: number,
    timeRaw: number,
    availableBudget: number,
  ): RuntimeResult<RuntimeBootResult> {
    if (outcome.kind === "fault") return this.#acceptFault(outcome.error);
    if (outcome.kind === "host-request") {
      const remainingBudget = availableBudget - outcome.consumedInstructions;
      if (remainingBudget <= 0) {
        return this.#acceptFault({
          code: "E_VM_INSTRUCTION_BUDGET",
          message: "instruction budget exhausted before host response",
          phase: "host-call",
        });
      }
      this.#pending = { operation: "boot", buttons, timeRaw, remainingBudget };
      this.#state = "waiting-host";
      return {
        ok: true,
        value: {
          kind: "host-request",
          request: { ...outcome.request, operation: "boot" },
        },
      };
    }
    if (outcome.kind === "stopped" || !this.#captureMode(outcome)) {
      this.#state = "stopped";
      return {
        ok: false,
        error: invalidState("cart stopped before establishing a frame loop"),
      };
    }
    this.#pending = undefined;
    // Official startup runs top-level/_init at 1/30 s. Express that epoch in
    // target-rate slices so completedSlices remains the source of logical time.
    this.#completedSlices = BigInt(this.#targetFps / 30);
    this.#state = "ready";
    return {
      ok: true,
      value: {
        kind: "ready",
        mode: this.#mode as Exclude<FrameVmMode, "none">,
        targetFps: this.#targetFps as 30 | 60,
      },
    };
  }

  #acceptStepOutcome(
    outcome: VmOperationOutcome,
    buttons: number,
    timeRaw: number,
    availableBudget: number,
  ): RuntimeResult<RuntimeStepResult> {
    if (outcome.kind === "fault") return this.#acceptFault(outcome.error);
    if (outcome.kind === "host-request") {
      const remainingBudget = availableBudget - outcome.consumedInstructions;
      if (remainingBudget <= 0) {
        return this.#acceptFault({
          code: "E_VM_INSTRUCTION_BUDGET",
          message: "instruction budget exhausted before host response",
          phase: "host-call",
        });
      }
      this.#pending = { operation: "step", buttons, timeRaw, remainingBudget };
      this.#state = "waiting-host";
      return {
        ok: true,
        value: {
          kind: "host-request",
          request: { ...outcome.request, operation: "step" },
        },
      };
    }
    if (outcome.kind === "stopped") {
      this.#pending = undefined;
      this.#state = "stopped";
      return { ok: true, value: { kind: "stopped" } };
    }
    if (outcome.kind !== "frame" || !this.#captureMode(outcome)) {
      return this.#acceptFault({
        code: "E_INVARIANT",
        message: "VM step did not complete exactly one frame slice",
        phase: "none",
      });
    }
    this.#pending = undefined;
    this.#completedSlices += 1n;
    const frame: RuntimeFrame = {
      frameId: this.#frameId++,
      completedSlices: this.#completedSlices.toString(),
      timeRawBeforeStep: timeRaw,
      targetFps: this.#targetFps as 30 | 60,
      screen: this.#ram.copy(SCREEN_OFFSET, SCREEN_BYTES),
      displayPalette: this.#ram.copy(DISPLAY_PALETTE_OFFSET, DISPLAY_PALETTE_BYTES),
    };
    this.#state = "ready";
    return { ok: true, value: { kind: "frame", frame } };
  }
}

export type {
  PicoInputSnapshot,
  RuntimeErrorCode,
  RuntimePhase,
  SerializedRuntimeError,
} from "@pico8-web/contracts";
