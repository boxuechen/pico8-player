import type { CartFormat, ParsedCart } from "@pico8-web/cart-codec";
import {
  PICO_CART_ROM_SIZE,
  PICO_RAM_SIZE,
  type CartIdentity,
  type PicoCartDataCommit,
  type PicoInputSnapshot,
  type SerializedRuntimeError,
} from "@pico8-web/contracts";

import type {
  RuntimeBootResult,
  RuntimeHostRequest,
  RuntimeResult,
  RuntimeSessionState,
  RuntimeStepResult,
} from "../frame-runtime.js";
import { ZERO_PICO_INPUT } from "../input/l1-input.js";

export type CartSessionState =
  | "empty"
  | "loading"
  | "ready"
  | "waiting-host"
  | "faulted"
  | "stopped"
  | "disposed";

export interface CartSessionCartMetadata {
  readonly identity: CartIdentity;
  readonly format: CartFormat;
  readonly version: number;
}

/** RuntimeCore-owned port for one generation's complete frame runtime graph. */
export interface CartSessionRuntimePort {
  readonly state: RuntimeSessionState;
  boot(
    cart: Pick<ParsedCart, "rom" | "code">,
    input?: PicoInputSnapshot,
  ): RuntimeResult<RuntimeBootResult>;
  step(input?: PicoInputSnapshot): RuntimeResult<RuntimeStepResult>;
  completeHostRequest(
    requestId: number,
    response: Uint8Array,
    isError?: boolean,
  ): RuntimeResult<RuntimeBootResult | RuntimeStepResult>;
  copyRam(offset: number, length: number): Uint8Array;
  copySuspendedLogicalRam?(offset: number, length: number): Uint8Array;
  writeSuspendedLogicalRam?(offset: number, bytes: Uint8Array): void;
  dispose(): void;
}

export interface CartSessionRuntimeContext {
  readonly generation: number;
  readonly cart: CartSessionCartMetadata;
  /** Copy-owned parameter exposed to the fresh execution through stat(6). */
  readonly runParameter: Uint8Array;
}

export interface CartSessionOptions {
  /** Must return a fresh runtime/router/VM/RAM object graph for every call. */
  readonly createRuntime: (context: CartSessionRuntimeContext) => CartSessionRuntimePort;
}

export interface CartSessionHostRequest extends RuntimeHostRequest {
  readonly generation: number;
}

export type CartSessionBootResult =
  | {
      readonly kind: "ready";
      readonly generation: number;
      readonly mode: Extract<RuntimeBootResult, { kind: "ready" }>["mode"];
      readonly targetFps: 30 | 60;
      readonly cpuInstructions: number;
      readonly cpuFractionRaw: number;
      readonly slowFrame: boolean;
      readonly audio: Extract<RuntimeBootResult, { kind: "ready" }>["audio"];
      readonly devkitFlags: number;
      readonly cartDataCommit?: PicoCartDataCommit;
    }
  | { readonly kind: "host-request"; readonly request: CartSessionHostRequest }
  | {
      readonly kind: "stopped";
      readonly generation: number;
      readonly message: Uint8Array;
      readonly cartDataCommit?: PicoCartDataCommit;
    }
  | {
      readonly kind: "restart";
      readonly generation: number;
      readonly parameter: Uint8Array;
      readonly cartDataCommit?: PicoCartDataCommit;
    };

export type CartSessionStepResult =
  | {
      readonly kind: "frame";
      readonly generation: number;
      readonly frame: Extract<RuntimeStepResult, { kind: "frame" }>["frame"];
    }
  | { readonly kind: "host-request"; readonly request: CartSessionHostRequest }
  | {
      readonly kind: "stopped";
      readonly generation: number;
      readonly message: Uint8Array;
      readonly cartDataCommit?: PicoCartDataCommit;
    }
  | {
      readonly kind: "restart";
      readonly generation: number;
      readonly parameter: Uint8Array;
      readonly cartDataCommit?: PicoCartDataCommit;
    };

export interface CartSessionStopResult {
  readonly kind: "stopped";
  readonly generation: number;
}

export interface CartSessionDisposeResult {
  readonly kind: "disposed";
  readonly generation: number;
}

interface CartRunSnapshot extends CartSessionCartMetadata {
  readonly rom: Uint8Array;
  readonly code: Uint8Array;
}

interface PendingHostRequest {
  readonly generation: number;
  readonly id: number;
  readonly operation: "boot" | "step";
}

interface SuspendedLogicalRamPort extends CartSessionRuntimePort {
  copySuspendedLogicalRam(offset: number, length: number): Uint8Array;
  writeSuspendedLogicalRam(offset: number, bytes: Uint8Array): void;
}

const MAX_GENERATION = 0xffff_ffff;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function lifecycleError(
  code: "E_INVALID_STATE" | "E_INVARIANT",
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): SerializedRuntimeError {
  return {
    code,
    message,
    phase: "none",
    recoverable: false,
    ...(details === undefined ? {} : { details }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid<T>(
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): RuntimeResult<T> {
  return { ok: false, error: lifecycleError("E_INVALID_STATE", message, details) };
}

function snapshotCart(cart: ParsedCart): CartRunSnapshot {
  if (!(cart.rom instanceof Uint8Array) || cart.rom.byteLength !== PICO_CART_ROM_SIZE) {
    throw new RangeError("cart ROM must be exactly 0x8000 bytes");
  }
  if (!(cart.code instanceof Uint8Array)) {
    throw new TypeError("cart code must be a Uint8Array");
  }
  if (!SHA256_PATTERN.test(cart.identity.contentSha256)) {
    throw new RangeError("cart identity must be a lower-case SHA-256 digest");
  }
  if (cart.format !== "p8" && cart.format !== "p8.png") {
    throw new RangeError("cart format must be p8 or p8.png");
  }
  if (!Number.isInteger(cart.version) || cart.version < 0 || cart.version > 0xff) {
    throw new RangeError("cart version must be a uint8");
  }
  const identity = Object.freeze({ contentSha256: cart.identity.contentSha256 });
  return {
    identity,
    format: cart.format,
    version: cart.version,
    rom: cart.rom.slice(),
    code: cart.code.slice(),
  };
}

function metadataOf(cart: CartRunSnapshot): CartSessionCartMetadata {
  return Object.freeze({
    identity: cart.identity,
    format: cart.format,
    version: cart.version,
  });
}

function copyCartDataCommit(commit: PicoCartDataCommit): PicoCartDataCommit {
  return Object.freeze({
    id: commit.id,
    bytes: commit.bytes.slice(),
    revision: commit.revision,
  });
}

function copyRunParameter(parameter: Uint8Array): Uint8Array {
  if (!(parameter instanceof Uint8Array) || parameter.byteLength > 4096) {
    throw new RangeError("run parameter must be a Uint8Array of at most 4096 bytes");
  }
  return parameter.slice();
}

function isRuntimePort(value: unknown): value is CartSessionRuntimePort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CartSessionRuntimePort>;
  return typeof candidate.boot === "function" &&
    typeof candidate.step === "function" &&
    typeof candidate.completeHostRequest === "function" &&
    typeof candidate.copyRam === "function" &&
    typeof candidate.dispose === "function";
}

/**
 * Owns cart identity and generation lifecycle without importing browser or VM
 * adapter implementations. Every load/reset transaction replaces its runtime.
 */
export class CartSession {
  readonly #createRuntime: CartSessionOptions["createRuntime"];
  readonly #usedRuntimes = new WeakSet<object>();
  #state: CartSessionState = "empty";
  #generation = 0;
  #cart: CartRunSnapshot | undefined;
  #runtime: CartSessionRuntimePort | undefined;
  #pendingRequest: PendingHostRequest | undefined;
  #lastError: SerializedRuntimeError | undefined;

  constructor(options: CartSessionOptions) {
    if (typeof options?.createRuntime !== "function") {
      throw new TypeError("CartSession requires a createRuntime factory");
    }
    this.#createRuntime = options.createRuntime;
  }

  get state(): CartSessionState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  get cart(): CartSessionCartMetadata | undefined {
    return this.#cart === undefined ? undefined : metadataOf(this.#cart);
  }

  get lastError(): SerializedRuntimeError | undefined {
    return this.#lastError;
  }

  load(
    cart: ParsedCart,
    parameter: Uint8Array = new Uint8Array(),
  ): RuntimeResult<CartSessionBootResult> {
    if (this.#state === "disposed") {
      return invalid("cart session is disposed");
    }
    if (this.#state === "loading") {
      return invalid("cart session is already loading");
    }
    let snapshot: CartRunSnapshot;
    try {
      snapshot = snapshotCart(cart);
    } catch (error) {
      return invalid(errorMessage(error));
    }
    let runParameter: Uint8Array;
    try {
      runParameter = copyRunParameter(parameter);
    } catch (error) {
      return invalid(errorMessage(error));
    }
    return this.#start(snapshot, runParameter);
  }

  reset(): RuntimeResult<CartSessionBootResult> {
    if (this.#state === "disposed") {
      return invalid("cart session is disposed");
    }
    if (this.#state === "loading") {
      return invalid("cart session is already loading");
    }
    if (this.#cart === undefined) {
      return invalid("cart session has no cart to reset");
    }
    return this.#start(this.#cart, new Uint8Array());
  }

  /** Start a fresh execution of the retained cart with a guest run() parameter. */
  restart(parameter: Uint8Array = new Uint8Array()): RuntimeResult<CartSessionBootResult> {
    if (this.#state === "disposed") {
      return invalid("cart session is disposed");
    }
    if (this.#state === "loading") {
      return invalid("cart session is already loading");
    }
    if (this.#cart === undefined) {
      return invalid("cart session has no cart to restart");
    }
    let snapshot: Uint8Array;
    try {
      snapshot = copyRunParameter(parameter);
    } catch (error) {
      return invalid(errorMessage(error));
    }
    return this.#start(this.#cart, snapshot);
  }

  step(input: PicoInputSnapshot = ZERO_PICO_INPUT): RuntimeResult<CartSessionStepResult> {
    const runtime = this.#runtime;
    if (this.#state !== "ready" || runtime === undefined) {
      return invalid("cart session is not ready to step");
    }
    let result: RuntimeResult<RuntimeStepResult>;
    try {
      result = runtime.step(input);
    } catch (error) {
      return this.#faultCurrent(lifecycleError(
        "E_INVARIANT",
        `runtime step threw: ${errorMessage(error)}`,
      ));
    }
    if (!result.ok) {
      if (result.error.code === "E_INVALID_STATE") return result;
      return this.#faultCurrent(result.error);
    }
    return this.#acceptStepResult(result.value);
  }

  completeHostRequest(
    generation: number,
    requestId: number,
    response: Uint8Array,
    isError = false,
  ): RuntimeResult<CartSessionBootResult | CartSessionStepResult> {
    if (generation !== this.#generation) {
      return invalid("host response belongs to a stale generation", {
        activeGeneration: this.#generation,
        responseGeneration: generation,
      });
    }
    const runtime = this.#runtime;
    const pending = this.#pendingRequest;
    if (this.#state !== "waiting-host" || runtime === undefined || pending === undefined) {
      return invalid("cart session has no pending host request");
    }
    if (requestId !== pending.id) {
      return invalid("host response request id does not match the pending request", {
        pendingRequestId: pending.id,
        responseRequestId: requestId,
      });
    }
    if (!(response instanceof Uint8Array)) {
      return invalid("host response must be a Uint8Array");
    }
    let result: RuntimeResult<RuntimeBootResult | RuntimeStepResult>;
    try {
      result = runtime.completeHostRequest(requestId, response, isError);
    } catch (error) {
      return this.#faultCurrent(lifecycleError(
        "E_INVARIANT",
        `host completion threw: ${errorMessage(error)}`,
      ));
    }
    if (!result.ok) {
      if (result.error.code === "E_INVALID_STATE") {
        return this.#faultCurrent(lifecycleError(
          "E_INVARIANT",
          "active runtime rejected a validated host completion",
        ));
      }
      return this.#faultCurrent(result.error);
    }
    if (pending.operation === "boot") {
      if (result.value.kind === "frame") {
        return this.#faultCurrent(lifecycleError(
          "E_INVARIANT",
          "boot host completion returned a step outcome",
        ));
      }
      return this.#acceptBootResult(result.value);
    }
    if (result.value.kind === "ready") {
      return this.#faultCurrent(lifecycleError(
        "E_INVARIANT",
        "step host completion returned a boot outcome",
      ));
    }
    return this.#acceptStepResult(result.value);
  }

  copyRam(offset: number, length: number): RuntimeResult<Uint8Array> {
    const runtime = this.#runtime;
    if (
      (this.#state !== "ready" && this.#state !== "waiting-host") ||
      runtime === undefined
    ) {
      return invalid("cart session has no readable active RAM");
    }
    if (
      !Number.isInteger(offset) || !Number.isInteger(length) ||
      offset < 0 || length < 0 || offset + length > PICO_RAM_SIZE
    ) {
      return invalid("RAM copy range is outside the 64 KiB address space");
    }
    try {
      return { ok: true, value: runtime.copyRam(offset, length).slice() };
    } catch (error) {
      return this.#faultCurrent(lifecycleError(
        "E_INVARIANT",
        `RAM copy threw: ${errorMessage(error)}`,
      ));
    }
  }

  copySuspendedLogicalRam(
    generation: number,
    offset: number,
    length: number,
  ): RuntimeResult<Uint8Array> {
    const checked = this.#validateSuspendedRamAccess(generation, offset, length);
    if (!checked.ok) return checked;
    try {
      return {
        ok: true,
        value: checked.value.copySuspendedLogicalRam(offset, length).slice(),
      };
    } catch (error) {
      return this.#faultCurrent(lifecycleError(
        "E_INVARIANT",
        `suspended logical RAM snapshot threw: ${errorMessage(error)}`,
      ));
    }
  }

  writeSuspendedLogicalRam(
    generation: number,
    offset: number,
    bytes: Uint8Array,
  ): RuntimeResult<void> {
    if (!(bytes instanceof Uint8Array)) {
      return invalid("suspended logical RAM write requires a Uint8Array");
    }
    const checked = this.#validateSuspendedRamAccess(
      generation,
      offset,
      bytes.byteLength,
    );
    if (!checked.ok) return checked;
    try {
      checked.value.writeSuspendedLogicalRam(offset, bytes.slice());
      return { ok: true, value: undefined };
    } catch (error) {
      return this.#faultCurrent(lifecycleError(
        "E_INVARIANT",
        `suspended logical RAM write threw: ${errorMessage(error)}`,
      ));
    }
  }

  stop(): RuntimeResult<CartSessionStopResult> {
    if (this.#state === "disposed") return invalid("cart session is disposed");
    if (this.#state === "loading") return invalid("cart session is loading");
    if (this.#cart === undefined) return invalid("cart session has no cart to stop");
    if (this.#state === "stopped") {
      return { ok: true, value: { kind: "stopped", generation: this.#generation } };
    }
    const teardownError = this.#releaseRuntime();
    if (teardownError !== undefined) return this.#enterFault(teardownError);
    this.#pendingRequest = undefined;
    this.#state = "stopped";
    return { ok: true, value: { kind: "stopped", generation: this.#generation } };
  }

  dispose(): RuntimeResult<CartSessionDisposeResult> {
    if (this.#state === "disposed") {
      return { ok: true, value: { kind: "disposed", generation: this.#generation } };
    }
    const teardownError = this.#releaseRuntime();
    this.#pendingRequest = undefined;
    this.#cart = undefined;
    this.#state = "disposed";
    if (teardownError !== undefined) {
      this.#lastError = teardownError;
      return { ok: false, error: teardownError };
    }
    return { ok: true, value: { kind: "disposed", generation: this.#generation } };
  }

  #validateSuspendedRamAccess(
    generation: number,
    offset: number,
    length: number,
  ): RuntimeResult<SuspendedLogicalRamPort> {
    if (generation !== this.#generation) {
      return invalid("logical RAM access belongs to a stale generation", {
        activeGeneration: this.#generation,
        accessGeneration: generation,
      });
    }
    const runtime = this.#runtime;
    if (this.#state !== "waiting-host" || runtime === undefined || this.#pendingRequest === undefined) {
      return invalid("logical RAM access requires a suspended host request");
    }
    if (
      typeof runtime.copySuspendedLogicalRam !== "function" ||
      typeof runtime.writeSuspendedLogicalRam !== "function"
    ) {
      return invalid("active runtime does not expose suspended logical RAM access");
    }
    if (
      !Number.isInteger(offset) || !Number.isInteger(length) ||
      offset < 0 || length < 0 || offset > PICO_RAM_SIZE || length > PICO_RAM_SIZE - offset
    ) {
      return invalid("logical RAM access range is outside the 64 KiB address space");
    }
    return { ok: true, value: runtime as SuspendedLogicalRamPort };
  }

  #start(
    cart: CartRunSnapshot,
    runParameter: Uint8Array,
  ): RuntimeResult<CartSessionBootResult> {
    if (this.#generation >= MAX_GENERATION) {
      return this.#faultCurrent(lifecycleError(
        "E_INVARIANT",
        "cart session generation space is exhausted",
      ));
    }
    this.#generation += 1;
    this.#state = "loading";
    this.#lastError = undefined;
    this.#pendingRequest = undefined;
    const teardownError = this.#releaseRuntime();
    this.#cart = cart;
    if (teardownError !== undefined) return this.#enterFault(teardownError);

    const metadata = metadataOf(cart);
    let runtime: CartSessionRuntimePort;
    try {
      const context = Object.freeze({
        generation: this.#generation,
        cart: metadata,
        runParameter: runParameter.slice(),
      });
      const candidate: unknown = this.#createRuntime(context);
      if (!isRuntimePort(candidate)) {
        throw new TypeError("runtime factory returned an invalid runtime port");
      }
      if (this.#usedRuntimes.has(candidate)) {
        throw new Error("runtime factory reused an object from an earlier generation");
      }
      runtime = candidate;
      this.#usedRuntimes.add(runtime);
    } catch (error) {
      return this.#enterFault(lifecycleError(
        "E_INVARIANT",
        `runtime factory failed: ${errorMessage(error)}`,
      ));
    }

    this.#runtime = runtime;
    let result: RuntimeResult<RuntimeBootResult>;
    try {
      result = runtime.boot(
        { rom: cart.rom.slice(), code: cart.code.slice() },
        ZERO_PICO_INPUT,
      );
    } catch (error) {
      return this.#faultCurrent(lifecycleError(
        "E_INVARIANT",
        `runtime boot threw: ${errorMessage(error)}`,
      ));
    }
    if (!result.ok) return this.#faultCurrent(result.error);
    return this.#acceptBootResult(result.value);
  }

  #acceptBootResult(result: RuntimeBootResult): RuntimeResult<CartSessionBootResult> {
    if (result.kind === "host-request") {
      if (result.request.operation !== "boot") {
        return this.#faultCurrent(lifecycleError(
          "E_INVARIANT",
          "runtime boot yielded a step host request",
        ));
      }
      this.#state = "waiting-host";
      return { ok: true, value: this.#decorateHostRequest(result.request) };
    }
    if (result.kind === "stopped" || result.kind === "restart") {
      const teardownError = this.#releaseRuntime();
      if (teardownError !== undefined) return this.#enterFault(teardownError);
      this.#pendingRequest = undefined;
      this.#state = "stopped";
      return {
        ok: true,
        value: result.kind === "stopped"
          ? {
              kind: "stopped",
              generation: this.#generation,
              message: result.message.slice(),
              ...(result.cartDataCommit === undefined
                ? {}
                : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }),
            }
          : {
              kind: "restart",
              generation: this.#generation,
              parameter: result.parameter.slice(),
              ...(result.cartDataCommit === undefined
                ? {}
                : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }),
            },
      };
    }
    this.#pendingRequest = undefined;
    this.#state = "ready";
    return {
      ok: true,
      value: {
        kind: "ready",
        generation: this.#generation,
        mode: result.mode,
        targetFps: result.targetFps,
        cpuInstructions: result.cpuInstructions,
        cpuFractionRaw: result.cpuFractionRaw,
        slowFrame: result.slowFrame,
        audio: result.audio,
        devkitFlags: result.devkitFlags,
        ...(result.cartDataCommit === undefined
          ? {}
          : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }),
      },
    };
  }

  #acceptStepResult(result: RuntimeStepResult): RuntimeResult<CartSessionStepResult> {
    if (result.kind === "host-request") {
      if (result.request.operation !== "step") {
        return this.#faultCurrent(lifecycleError(
          "E_INVARIANT",
          "runtime step yielded a boot host request",
        ));
      }
      this.#state = "waiting-host";
      return { ok: true, value: this.#decorateHostRequest(result.request) };
    }
    if (result.kind === "stopped") {
      const teardownError = this.#releaseRuntime();
      if (teardownError !== undefined) return this.#enterFault(teardownError);
      this.#pendingRequest = undefined;
      this.#state = "stopped";
      return {
        ok: true,
        value: {
          kind: "stopped",
          generation: this.#generation,
          message: result.message.slice(),
          ...(result.cartDataCommit === undefined
            ? {}
            : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }),
        },
      };
    }
    if (result.kind === "restart") {
      const teardownError = this.#releaseRuntime();
      if (teardownError !== undefined) return this.#enterFault(teardownError);
      this.#pendingRequest = undefined;
      this.#state = "stopped";
      return {
        ok: true,
        value: {
          kind: "restart",
          generation: this.#generation,
          parameter: result.parameter.slice(),
          ...(result.cartDataCommit === undefined
            ? {}
            : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }),
        },
      };
    }
    this.#pendingRequest = undefined;
    this.#state = "ready";
    return {
      ok: true,
      value: {
        kind: "frame",
        generation: this.#generation,
        frame: {
          ...result.frame,
          screen: result.frame.screen.slice(),
          ...(result.frame.cartDataCommit === undefined
            ? {}
            : { cartDataCommit: copyCartDataCommit(result.frame.cartDataCommit) }),
        },
      },
    };
  }

  #decorateHostRequest(request: RuntimeHostRequest): {
    readonly kind: "host-request";
    readonly request: CartSessionHostRequest;
  } {
    this.#pendingRequest = {
      generation: this.#generation,
      id: request.id,
      operation: request.operation,
    };
    return {
      kind: "host-request",
      request: {
        generation: this.#generation,
        id: request.id,
        bytes: request.bytes.slice(),
        operation: request.operation,
      },
    };
  }

  #faultCurrent<T>(error: SerializedRuntimeError): RuntimeResult<T> {
    // Teardown is best-effort once the VM has already supplied the primary
    // fault. A secondary dispose failure must not erase its code/phase/trace.
    this.#releaseRuntime();
    return this.#enterFault(error);
  }

  #enterFault<T>(error: SerializedRuntimeError): RuntimeResult<T> {
    this.#pendingRequest = undefined;
    this.#lastError = error;
    this.#state = "faulted";
    return { ok: false, error };
  }

  #releaseRuntime(): SerializedRuntimeError | undefined {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime === undefined) return undefined;
    try {
      runtime.dispose();
      return undefined;
    } catch (error) {
      return lifecycleError(
        "E_INVARIANT",
        `runtime dispose threw: ${errorMessage(error)}`,
      );
    }
  }
}
