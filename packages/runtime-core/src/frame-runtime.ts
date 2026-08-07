import type { ParsedCart } from "@pico8-web/cart-codec";
import {
  PICO_CART_DATA_ROM_SIZE,
  type PicoInputSnapshot,
  type PicoCartDataCommit,
  type PicoCartDataSeed,
  type PicoMemoryLease,
  type RuntimeErrorCode,
  type RuntimePhase,
  type SerializedRuntimeError,
} from "@pico8-web/contracts";
import { normalizeInputSnapshot, ZERO_PICO_INPUT } from "./input/l1-input.js";
import type { CanonicalAudioSlice } from "./audio/sfx-synth.js";
import {
  createPicoApiHost,
  type CurrentCartDataContext,
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
      readonly kind: "ready" | "frame";
      readonly mode: FrameVmMode;
      readonly state: FrameVmState;
      readonly targetFps: 0 | 30 | 60;
      readonly consumedInstructions: number;
    }
  | {
      readonly kind: "stopped";
      readonly mode: FrameVmMode;
      readonly state: "stopped";
      readonly targetFps: 0 | 30 | 60;
      readonly consumedInstructions: number;
      readonly message: Uint8Array;
    }
  | {
      readonly kind: "restart";
      readonly mode: FrameVmMode;
      readonly state: "stopped";
      readonly targetFps: 0 | 30 | 60;
      readonly consumedInstructions: number;
      readonly parameter: Uint8Array;
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

export type MenuButtonIntent = 1 | 2 | 4;

export interface MenuItemSnapshot {
  readonly slot: 1 | 2 | 3 | 4 | 5;
  readonly label: Uint8Array;
  /** Encoded PICO-8 index filter bits, restricted to 0xff00. */
  readonly filter: number;
}

export interface MenuSnapshot {
  readonly items: readonly MenuItemSnapshot[];
}

export type VmMenuInvocationOutcome =
  | { readonly kind: "close" | "keep-open" | "removed" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "fault"; readonly error: VmFaultRecord };

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
  setRunParameter(parameter: Uint8Array): void;
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
  snapshotMenuItems(): MenuSnapshot;
  invokeMenuItem(
    slot: MenuItemSnapshot["slot"],
    button: MenuButtonIntent,
    instructionBudget: number,
  ): VmMenuInvocationOutcome;
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
  /** Exact z8lua VM instructions consumed by this committed transaction. */
  readonly cpuInstructions: number;
  /** Q16.16 CPU fraction; 0x00010000 is the calibrated 4M inst/s slice budget. */
  readonly cpuFractionRaw: number;
  /** True only when the Q16.16 CPU fraction is greater than 1.0. */
  readonly slowFrame: boolean;
  /** Packed 4bpp screen bytes copied from Base RAM 0x6000..0x7fff. */
  readonly screen: Uint8Array;
  /** 16-entry display-palette map snapshotted from Base RAM 0x5f10..0x5f1f. */
  readonly displayPalette: Uint8Array;
  readonly devkitFlags: number;
  readonly cartDataCommit?: PicoCartDataCommit;
  /** Canonical PCM committed by this exact logical frame slice. */
  readonly audio: CanonicalAudioSlice;
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
      readonly cpuInstructions: number;
      readonly cpuFractionRaw: number;
      readonly slowFrame: boolean;
      /** Canonical PCM for the 1/30-second startup transaction. */
      readonly audio: CanonicalAudioSlice;
      readonly devkitFlags: number;
      readonly cartDataCommit?: PicoCartDataCommit;
    }
  | { readonly kind: "host-request"; readonly request: RuntimeHostRequest }
  | {
      readonly kind: "stopped";
      readonly message: Uint8Array;
      readonly cartDataCommit?: PicoCartDataCommit;
    }
  | {
      readonly kind: "restart";
      readonly parameter: Uint8Array;
      readonly cartDataCommit?: PicoCartDataCommit;
    };

export type RuntimeStepResult =
  | { readonly kind: "frame"; readonly frame: RuntimeFrame }
  | { readonly kind: "host-request"; readonly request: RuntimeHostRequest }
  | {
      readonly kind: "stopped";
      readonly message: Uint8Array;
      readonly cartDataCommit?: PicoCartDataCommit;
    }
  | {
      readonly kind: "restart";
      readonly parameter: Uint8Array;
      readonly cartDataCommit?: PicoCartDataCommit;
    };

export interface RuntimeMenuInvocationOutcome {
  readonly kind: "close" | "keep-open" | "removed";
  readonly snapshot: MenuSnapshot;
  readonly cartDataCommit?: PicoCartDataCommit;
}

export interface FrameRuntimeOptions {
  /** Safety hard cap for one transaction; independent from the 4M inst/s soft budget. */
  readonly instructionBudget?: number;
  readonly picoApiHost?: PicoApiHost;
  readonly cartDataSeeds?: readonly PicoCartDataSeed[];
  readonly currentCart?: CurrentCartDataContext;
  readonly runParameter?: Uint8Array;
}

interface PendingTransaction {
  readonly operation: "boot" | "step";
  readonly buttons: number;
  readonly timeRaw: number;
  readonly consumedInstructions: number;
  remainingBudget: number;
}

export const PICO_VM_INSTRUCTIONS_PER_SECOND = 4_000_000;
export const PICO_CPU_ONE_RAW = 0x0001_0000;
export const DEFAULT_SAFETY_INSTRUCTION_LIMIT = 1_000_000;
const CART_ROM_BYTES = 0x8000;
const SCREEN_OFFSET = 0x6000;
const SCREEN_BYTES = 0x2000;
const DISPLAY_PALETTE_OFFSET = 0x5f10;
const DISPLAY_PALETTE_BYTES = 16;
const STARTUP_TIME_RAW = Math.floor(65_536 / 30);

export interface PicoCpuSliceBudget {
  readonly floor: number;
  readonly ceiling: number;
}

export interface RuntimeCpuCost {
  readonly cpuInstructions: number;
  readonly cpuFractionRaw: number;
  readonly slowFrame: boolean;
}

export function picoCpuSliceBudget(targetFps: 30 | 60): PicoCpuSliceBudget {
  if (targetFps !== 30 && targetFps !== 60) {
    throw new RangeError("targetFps must be 30 or 60");
  }
  return Object.freeze({
    floor: Math.floor(PICO_VM_INSTRUCTIONS_PER_SECOND / targetFps),
    ceiling: Math.ceil(PICO_VM_INSTRUCTIONS_PER_SECOND / targetFps),
  });
}

export function runtimeCpuCost(
  cpuInstructions: number,
  accountingFps: 30 | 60,
): RuntimeCpuCost {
  if (!Number.isSafeInteger(cpuInstructions) || cpuInstructions < 0 ||
    cpuInstructions > 0xffff_ffff) {
    throw new RangeError("cpuInstructions must be a uint32");
  }
  picoCpuSliceBudget(accountingFps);
  const raw = BigInt(cpuInstructions) * BigInt(accountingFps) * 65_536n /
    BigInt(PICO_VM_INSTRUCTIONS_PER_SECOND);
  const cpuFractionRaw = Number(raw > 0x7fff_ffffn ? 0x7fff_ffffn : raw);
  return Object.freeze({
    cpuInstructions,
    cpuFractionRaw,
    slowFrame: cpuFractionRaw > PICO_CPU_ONE_RAW,
  });
}

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
  readonly #currentCart: CurrentCartDataContext | undefined;
  readonly #runParameter: Uint8Array;
  #state: RuntimeSessionState = "empty";
  #mode: FrameVmMode = "none";
  #targetFps: 0 | 30 | 60 = 0;
  #completedSlices = 0n;
  #frameId = 0;
  #pending: PendingTransaction | undefined;

  constructor(vm: FrameVmPort, options: FrameRuntimeOptions = {}) {
    const budget = options.instructionBudget ?? DEFAULT_SAFETY_INSTRUCTION_LIMIT;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 0xffff_ffff) {
      throw new RangeError("instructionBudget must be a positive uint32");
    }
    this.#vm = vm;
    this.#instructionBudget = budget;
    this.#ram = new PicoRam(vm.memory, vm.logicalMemory);
    if (
      options.picoApiHost !== undefined &&
      (options.cartDataSeeds !== undefined || options.currentCart !== undefined)
    ) {
      throw new TypeError(
        "cartDataSeeds/currentCart cannot be combined with a custom PicoApiHost",
      );
    }
    this.#currentCart = options.currentCart;
    if (
      options.runParameter !== undefined &&
      (!(options.runParameter instanceof Uint8Array) || options.runParameter.byteLength > 4096)
    ) {
      throw new RangeError("runParameter must be a Uint8Array of at most 4096 bytes");
    }
    this.#runParameter = options.runParameter?.slice() ?? new Uint8Array();
    const host = options.picoApiHost ?? createPicoApiHost(
      vm.memory,
      vm.logicalMemory,
      {
        ...(options.cartDataSeeds === undefined
          ? {}
          : { cartDataSeeds: options.cartDataSeeds }),
        ...(options.currentCart === undefined
          ? {}
          : { currentCart: options.currentCart }),
      },
    );
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
    input: PicoInputSnapshot = ZERO_PICO_INPUT,
  ): RuntimeResult<RuntimeBootResult> {
    if (this.#state !== "empty") {
      return { ok: false, error: invalidState("runtime session is not empty") };
    }
    let normalizedInput: PicoInputSnapshot;
    try {
      normalizedInput = normalizeInputSnapshot(input);
    } catch (error) {
      return {
        ok: false,
        error: invalidState(error instanceof Error ? error.message : String(error)),
      };
    }
    if (cart.rom.byteLength !== CART_ROM_BYTES) {
      return { ok: false, error: invalidState("cart ROM must be exactly 0x8000 bytes") };
    }
    let bootRom = cart.rom;
    if (this.#currentCart !== undefined) {
      try {
        const data = this.#currentCart.repository.readData(
          this.#currentCart.identity,
          0,
          PICO_CART_DATA_ROM_SIZE,
        );
        if (!(data instanceof Uint8Array) || data.byteLength !== PICO_CART_DATA_ROM_SIZE) {
          throw new Error("current-cart repository returned an invalid boot snapshot");
        }
        bootRom = cart.rom.slice();
        bootRom.set(data, 0);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "E_INVARIANT",
            message: `current-cart boot snapshot failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            phase: "none",
            recoverable: false,
          },
        };
      }
    }
    this.#vm.resetRam();
    this.#picoApiHost.reset();
    this.#vm.writeCartRom(bootRom);
    this.#vm.setRunParameter(this.#runParameter);
    const compiled = this.#vm.compile(cart.code);
    if (compiled.kind === "fault") return this.#acceptFault(compiled.error);
    const controllers = normalizedInput.controllers;
    this.#picoApiHost.beginTick(normalizedInput, 30);
    const buttons = controllers[0]!;
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
      0,
    );
  }

  step(input: PicoInputSnapshot = ZERO_PICO_INPUT): RuntimeResult<RuntimeStepResult> {
    if (this.#state !== "ready" || this.#targetFps === 0) {
      return { ok: false, error: invalidState("runtime session is not ready to step") };
    }
    let normalizedInput: PicoInputSnapshot;
    try {
      normalizedInput = normalizeInputSnapshot(input);
    } catch (error) {
      return {
        ok: false,
        error: invalidState(error instanceof Error ? error.message : String(error)),
      };
    }
    const timeRaw = logicalTimeRaw(this.#completedSlices + 1n, this.#targetFps);
    const controllers = normalizedInput.controllers;
    this.#picoApiHost.beginTick(normalizedInput, this.#targetFps);
    const buttons = controllers[0]!;
    const outcome = this.#vm.step(this.#instructionBudget, buttons, timeRaw);
    return this.#acceptStepOutcome(
      outcome,
      buttons,
      timeRaw,
      this.#instructionBudget,
      0,
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
        pending.consumedInstructions,
      );
    }
    return this.#acceptStepOutcome(
      outcome,
      pending.buttons,
      pending.timeRaw,
      pending.remainingBudget,
      pending.consumedInstructions,
    );
  }

  snapshotMenuItems(): RuntimeResult<MenuSnapshot> {
    if (this.#state !== "ready") {
      return { ok: false, error: invalidState("runtime session is not ready for menu snapshot") };
    }
    try {
      const snapshot = this.#vm.snapshotMenuItems();
      return {
        ok: true,
        value: {
          items: snapshot.items.map((item) => ({
            slot: item.slot,
            label: item.label.slice(),
            filter: item.filter,
          })),
        },
      };
    } catch (error) {
      return this.#acceptFault({
        code: "E_INVARIANT",
        message: `menu snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
        phase: "menuitem",
      });
    }
  }

  invokeMenuItem(
    slot: MenuItemSnapshot["slot"],
    button: MenuButtonIntent,
  ): RuntimeResult<RuntimeMenuInvocationOutcome> {
    if (this.#state !== "ready") {
      return { ok: false, error: invalidState("runtime session is not ready for menu invocation") };
    }
    const outcome = this.#vm.invokeMenuItem(slot, button, this.#instructionBudget);
    if (outcome.kind === "rejected") {
      return { ok: false, error: invalidState(outcome.message) };
    }
    if (outcome.kind === "fault") return this.#acceptFault(outcome.error);
    const snapshot = this.snapshotMenuItems();
    if (!snapshot.ok) return snapshot;
    const cartDataCommit = this.#takeCartDataCommit();
    if (!cartDataCommit.ok) return cartDataCommit;
    return {
      ok: true,
      value: {
        kind: outcome.kind,
        snapshot: snapshot.value,
        ...(cartDataCommit.value === undefined
          ? {}
          : { cartDataCommit: cartDataCommit.value }),
      },
    };
  }

  copyRam(offset: number, length: number): Uint8Array {
    return this.#vm.copyRam(offset, length);
  }

  /** Copy live logical Base RAM only while a root HostRequest is suspended. */
  copySuspendedLogicalRam(offset: number, length: number): Uint8Array {
    if (this.#state !== "waiting-host" || this.#pending === undefined) {
      throw new Error("logical RAM snapshot requires a suspended host request");
    }
    if (
      !Number.isInteger(offset) || !Number.isInteger(length) ||
      offset < 0 || length < 0 || offset > 0x10000 || length > 0x10000 - offset
    ) {
      throw new RangeError("logical RAM snapshot range is out of bounds");
    }
    return this.#ram.copy(offset, length);
  }

  /** Atomically apply bytes to live logical Base RAM before guest continuation. */
  writeSuspendedLogicalRam(offset: number, bytes: Uint8Array): void {
    if (this.#state !== "waiting-host" || this.#pending === undefined) {
      throw new Error("logical RAM write requires a suspended host request");
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("logical RAM write bytes must be a Uint8Array");
    }
    if (
      !Number.isInteger(offset) || offset < 0 || offset > 0x10000 ||
      bytes.byteLength > 0x10000 - offset
    ) {
      throw new RangeError("logical RAM write range is out of bounds");
    }
    const snapshot = bytes.slice();
    for (let index = 0; index < snapshot.byteLength; index += 1) {
      this.#ram.writeU8(offset + index, snapshot[index]!);
    }
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#picoApiHost.resetAudio();
    this.#vm.destroy();
    this.#pending = undefined;
    this.#state = "disposed";
  }

  #acceptFault<T>(fault: VmFaultRecord): RuntimeResult<T> {
    this.#picoApiHost.resetAudio();
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
    consumedBefore: number,
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
      this.#pending = {
        operation: "boot",
        buttons,
        timeRaw,
        remainingBudget,
        consumedInstructions: consumedBefore + outcome.consumedInstructions,
      };
      this.#state = "waiting-host";
      return {
        ok: true,
        value: {
          kind: "host-request",
          request: { ...outcome.request, operation: "boot" },
        },
      };
    }
    if (outcome.kind === "stopped" || outcome.kind === "restart") {
      this.#picoApiHost.resetAudio();
      const cartDataCommit = this.#takeCartDataCommit();
      if (!cartDataCommit.ok) return cartDataCommit;
      this.#state = "stopped";
      return {
        ok: true,
        value: outcome.kind === "stopped"
          ? {
              kind: "stopped",
              message: outcome.message.slice(),
              ...(cartDataCommit.value === undefined
                ? {}
                : { cartDataCommit: cartDataCommit.value }),
            }
          : {
              kind: "restart",
              parameter: outcome.parameter.slice(),
              ...(cartDataCommit.value === undefined
                ? {}
                : { cartDataCommit: cartDataCommit.value }),
            },
      };
    }
    if (!this.#captureMode(outcome)) {
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
    const targetFps = this.#targetFps as 30 | 60;
    // Startup commits exactly 1/30 second even when a 60 Hz cart establishes
    // two completed logical slices, so its CPU denominator is always 30 Hz.
    const cpuCost = runtimeCpuCost(
      consumedBefore + outcome.consumedInstructions,
      30,
    );
    const audio = this.#picoApiHost.renderAudioSlices(targetFps / 30, targetFps);
    const cartDataCommit = this.#takeCartDataCommit();
    if (!cartDataCommit.ok) return cartDataCommit;
    this.#state = "ready";
    return {
      ok: true,
      value: {
        kind: "ready",
        mode: this.#mode as Exclude<FrameVmMode, "none">,
        targetFps,
        ...cpuCost,
        audio,
        devkitFlags: this.#picoApiHost.devkitFlags,
        ...(cartDataCommit.value === undefined
          ? {}
          : { cartDataCommit: cartDataCommit.value }),
      },
    };
  }

  #acceptStepOutcome(
    outcome: VmOperationOutcome,
    buttons: number,
    timeRaw: number,
    availableBudget: number,
    consumedBefore: number,
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
      this.#pending = {
        operation: "step",
        buttons,
        timeRaw,
        remainingBudget,
        consumedInstructions: consumedBefore + outcome.consumedInstructions,
      };
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
      this.#picoApiHost.resetAudio();
      const cartDataCommit = this.#takeCartDataCommit();
      if (!cartDataCommit.ok) return cartDataCommit;
      this.#pending = undefined;
      this.#state = "stopped";
      return {
        ok: true,
        value: {
          kind: "stopped",
          message: outcome.message.slice(),
          ...(cartDataCommit.value === undefined
            ? {}
            : { cartDataCommit: cartDataCommit.value }),
        },
      };
    }
    if (outcome.kind === "restart") {
      this.#picoApiHost.resetAudio();
      const cartDataCommit = this.#takeCartDataCommit();
      if (!cartDataCommit.ok) return cartDataCommit;
      this.#pending = undefined;
      this.#state = "stopped";
      return {
        ok: true,
        value: {
          kind: "restart",
          parameter: outcome.parameter.slice(),
          ...(cartDataCommit.value === undefined
            ? {}
            : { cartDataCommit: cartDataCommit.value }),
        },
      };
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
    const targetFps = this.#targetFps as 30 | 60;
    const cpuCost = runtimeCpuCost(
      consumedBefore + outcome.consumedInstructions,
      targetFps,
    );
    const audio = this.#picoApiHost.renderAudioSlices(1, targetFps);
    const cartDataCommit = this.#takeCartDataCommit();
    if (!cartDataCommit.ok) return cartDataCommit;
    const frame: RuntimeFrame = {
      frameId: this.#frameId++,
      completedSlices: this.#completedSlices.toString(),
      timeRawBeforeStep: timeRaw,
      targetFps,
      ...cpuCost,
      screen: this.#ram.copy(SCREEN_OFFSET, SCREEN_BYTES),
      displayPalette: this.#ram.copy(DISPLAY_PALETTE_OFFSET, DISPLAY_PALETTE_BYTES),
      devkitFlags: this.#picoApiHost.devkitFlags,
      audio,
      ...(cartDataCommit.value === undefined
        ? {}
        : { cartDataCommit: cartDataCommit.value }),
    };
    this.#state = "ready";
    return { ok: true, value: { kind: "frame", frame } };
  }

  #takeCartDataCommit(): RuntimeResult<PicoCartDataCommit | undefined> {
    try {
      return { ok: true, value: this.#picoApiHost.takeCartDataCommit() };
    } catch (error) {
      return this.#acceptFault({
        code: "E_INVARIANT",
        message: `cartdata commit snapshot failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        phase: "none",
      });
    }
  }
}

export type {
  PicoInputSnapshot,
  RuntimeErrorCode,
  RuntimePhase,
  SerializedRuntimeError,
} from "@pico8-web/contracts";
