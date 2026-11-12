import type { PlayerLocalCartSource } from "../transport/runtime-port.js";
import { PICO_EMPTY_INPUT } from "@pico8-web/contracts";
import { CartCodecError, decodeCart } from "@pico8-web/cart-codec";
import {
  PICO_CONTROLLER_COUNT,
  PICO_DEVKIT_KEYPRESS_BATCH_LIMIT,
  PICO_HOST_REQUEST_MAX_BYTES,
  type PicoCartDataCommit,
  type PicoCartDataSeed,
  type PicoDevkitInputBatch,
  type PicoInputSnapshot,
  type SerializedRuntimeError,
} from "@pico8-web/contracts";
import {
  CartCancellationSource,
  CartLoader,
  CartResolutionError,
  CartSession,
  decodeExternalCartDataRequest,
  decodeGuestCartLoadRequest,
  isExternalCartDataRequestPayload,
  isGuestCartRequestPayload,
  normalizeCstoreRange,
  normalizeReloadRange,
  type CartDataPersistencePort,
  type CanonicalAudioSlice,
  FrameScheduler,
  FrameSliceRuntime,
  type CartSessionBootResult,
  type CartSessionHostRequest,
  type CartSessionMenuSnapshot,
  type CartSessionStepResult,
  type RootHostRequestCompletion,
  type RootHostRequestHandlerPort,
  type RuntimeBootResult,
  type RuntimeResult,
  type RuntimeStepResult,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
  type FrameRuntimeModule,
} from "@pico8-web/z8lua-bridge";

import { CartRepositoryAdapter } from "./adapters/cart-repository-adapter.js";
import { LocalCartBundleResolver } from "./adapters/host-cart-resolver-adapter.js";
import type { PcmOutput } from "./audio-transport.js";
import type {
  PlayerRuntimeState,
  SessionEvent,
} from "../transport/public.js";

function invariant(message: string): SerializedRuntimeError {
  return {
    code: "E_INVARIANT",
    message,
    phase: "none",
    recoverable: false,
  };
}

export type SessionBatch = readonly SessionEvent[] | Promise<readonly SessionEvent[]>;
export interface SessionContext {
  readonly sessionGeneration: number;
  /** Completion of a suspended guest operation, delivered only to this call. */
  readonly onResume: (events: readonly SessionEvent[]) => void;
}
interface SessionFrameContext extends SessionContext { readonly sequence: number; }
interface SessionMenuContext extends SessionContext {
  readonly slot: 1 | 2 | 3 | 4 | 5;
  readonly button: 1 | 2 | 4;
}
export interface SessionLoadOptions {
  readonly source: Uint8Array;
  readonly instructionBudget?: number;
  readonly localCartBundle?: readonly PlayerLocalCartSource[];
  readonly hostCartData?: readonly PicoCartDataSeed[];
}
export interface SessionController {
  input(generation: number, sequence: number, input: PicoInputSnapshot): void;
  loadCart(context: SessionContext, load: SessionLoadOptions): SessionBatch;
  reset(context: SessionContext): SessionBatch;
  start(context: SessionContext): SessionBatch;
  pause(context: SessionContext): SessionBatch;
  resume(context: SessionContext): SessionBatch;
  stop(context: SessionContext): SessionBatch;
  openPauseMenu(context: SessionContext): SessionBatch;
  closePauseMenu(context: SessionContext): SessionBatch;
  invokeMenuItem(context: SessionContext, slot: 1 | 2 | 3 | 4 | 5, button: 1 | 2 | 4): SessionBatch;
  step(context: SessionContext, sequence: number): SessionBatch;
  pulse(context: SessionContext, sequence: number, timestampMs: number): SessionBatch;
  flushPersistence(context: SessionContext): SessionBatch;
  dispose(context: SessionContext): SessionBatch;
  destroy(): Promise<void>;
}

export interface SessionControllerOptions {
  readonly audioTransport?: PcmOutput;
  readonly persistence?: CartDataPersistencePort;
  readonly hostRequestHandler?: RootHostRequestHandlerPort;
  /** Fixed per-VM diagnostic override; zero/undefined selects the 2 MiB production default. */
  readonly luaHeapLimit?: number;
}

type SessionLifecycle =
  | "empty"
  | "ready"
  | "running"
  | "waiting-host"
  | "paused"
  | "menu-open"
  | "stopped"
  | "faulted"
  | "disposed";

interface PendingRootHostRequest {
  readonly kind: "host";
  readonly sessionGeneration: number;
  readonly runtimeGeneration: number;
  readonly requestId: number;
  readonly cancellation: CartCancellationSource;
  readonly emit: (events: readonly SessionEvent[]) => void;
  readonly resume: (
    response: Uint8Array,
    isError: boolean,
  ) => readonly SessionEvent[];
}

interface PendingGuestLoad {
  readonly kind: "load";
  readonly sessionGeneration: number;
  readonly requestId: number;
  readonly cancellation: CartCancellationSource;
  readonly continueRunning: boolean;
}

interface PendingExternalCartData {
  readonly kind: "cart-data";
  readonly sessionGeneration: number;
  readonly runtimeGeneration: number;
  readonly requestId: number;
  readonly cancellation: CartCancellationSource;
  readonly emit: (events: readonly SessionEvent[]) => void;
  readonly resume: PendingRootHostRequest["resume"];
}

function saturatingAddInt32(left: number, right: number): number {
  const result = left + right;
  return Math.max(-0x8000_0000, Math.min(0x7fff_ffff, result)) | 0;
}

function playerBase(context: SessionContext) {
  return {
    sessionGeneration: context.sessionGeneration,
  };
}

function playerBaseForGeneration(
  context: SessionContext,
  generation: number,
) {
  return { ...playerBase(context), sessionGeneration: generation };
}

function playerLifecycleError(
  message: string,
  recoverable = false,
): SerializedRuntimeError {
  return {
    code: "E_INVALID_STATE",
    message,
    phase: "none",
    recoverable,
  };
}

function isSerializedRuntimeError(value: unknown): value is SerializedRuntimeError {
  return value !== null && typeof value === "object" &&
    "code" in value && typeof value.code === "string" &&
    "message" in value && typeof value.message === "string" &&
    "phase" in value && typeof value.phase === "string" &&
    "recoverable" in value && typeof value.recoverable === "boolean";
}

/** Shared session composition: decode -> CartSession -> scheduler -> events. */
export function createSessionController(
  module: FrameRuntimeModule,
  options: SessionControllerOptions = {},
): SessionController {
  const audioTransport = options.audioTransport;
  const persistence = options.persistence;
  const hostRequestHandler = options.hostRequestHandler;
  const luaHeapLimit = options.luaHeapLimit;
  const cartRepository = new CartRepositoryAdapter();
  let localCartResolver = new LocalCartBundleResolver([]);
  let cartLoader = new CartLoader(localCartResolver, cartRepository);
  const localPersistenceDiagnostics: SerializedRuntimeError[] = [];
  let cartDataSeeds: readonly PicoCartDataSeed[] = [];
  let hostPersistence = false;
  const pendingHostCartDataCommits: PicoCartDataCommit[] = [];
  let audioSequence = 0;
  let nextAudioSample = 0n;
  let instructionBudget: number | undefined;
  const scheduler = new FrameScheduler({ maximumCatchUpTicks: 5 });
  function createSession(): CartSession {
    return new CartSession({ createRuntime(context) {
      const router = createPicoApiHostRouter(module);
      const vm = new Z8LuaFrameVm(module, router, {
        ...(luaHeapLimit === undefined ? {} : { luaHeapLimit }),
      });
      try {
        return new FrameSliceRuntime(vm, {
          ...(instructionBudget === undefined ? {} : { instructionBudget }),
          cartDataSeeds,
          currentCart: {
            identity: context.cart.identity,
            repository: cartRepository,
          },
          runParameter: context.runParameter,
        });
      } catch (error) {
        vm.destroy();
        throw error;
      }
    } });
  }
  let session = createSession();
  let lifecycle: SessionLifecycle = "empty";
  let sessionGeneration = 0;
  let inputSequence = -1;
  let inputControllers: readonly number[] = new Array<number>(PICO_CONTROLLER_COUNT).fill(0);
  let inputMouseXRaw = 0;
  let inputMouseYRaw = 0;
  let inputMouseButtons = 0;
  let pendingWheelRaw = 0;
  let pendingMovementXRaw = 0;
  let pendingMovementYRaw = 0;
  const pendingKeypresses: number[] = [];
  let mode: "none" | "callback" | "custom" = "none";
  let targetFps: 0 | 30 | 60 = 0;
  let devkitFlags = 0;
  let pendingRequest: PendingRootHostRequest | PendingGuestLoad | PendingExternalCartData | undefined;
  let activeMenuSnapshot: CartSessionMenuSnapshot | undefined;
  const externalCstoreTargetIdentities = new Set<string>();
  let breadcrumbDepth = 0;

  function clearPendingDevkitEvents(): void {
    pendingWheelRaw = 0;
    pendingMovementXRaw = 0;
    pendingMovementYRaw = 0;
    pendingKeypresses.length = 0;
  }

  function clearInputState(): void {
    inputControllers = new Array<number>(PICO_CONTROLLER_COUNT).fill(0);
    inputMouseXRaw = 0;
    inputMouseYRaw = 0;
    inputMouseButtons = 0;
    clearPendingDevkitEvents();
  }

  function simulationInput(includePendingEvents: boolean): PicoInputSnapshot {
    return {
      controllers: inputControllers,
      devkit: includePendingEvents ? {
        mouseXRaw: inputMouseXRaw,
        mouseYRaw: inputMouseYRaw,
        mouseButtons: inputMouseButtons,
        wheelRaw: pendingWheelRaw,
        movementXRaw: pendingMovementXRaw,
        movementYRaw: pendingMovementYRaw,
        keypresses: pendingKeypresses.slice(),
      } : {
        ...PICO_EMPTY_INPUT.devkit,
        mouseXRaw: inputMouseXRaw,
        mouseYRaw: inputMouseYRaw,
        mouseButtons: inputMouseButtons,
      },
    };
  }

  function beginAudioGeneration(generation: number): void {
    audioSequence = 0;
    nextAudioSample = 0n;
    audioTransport?.beginGeneration(generation, audioSequence, nextAudioSample);
  }

  function resetAudioQueue(generation: number): void {
    if (audioTransport === undefined) return;
    if (audioTransport.sessionGeneration !== generation) {
      beginAudioGeneration(generation);
    } else {
      audioTransport.reset(audioSequence, nextAudioSample);
    }
  }

  function sendAudio(slice: CanonicalAudioSlice): void {
    const firstSample = BigInt(slice.firstSample);
    if (firstSample !== nextAudioSample) {
      audioTransport?.reset(audioSequence, firstSample);
      nextAudioSample = firstSample;
    }
    const pcm16le = slice.pcm16le.slice().buffer;
    audioTransport?.send({
      sequence: audioSequence,
      firstSample,
      frameCount: slice.frameCount,
      pcm16le,
    });
    audioSequence = (audioSequence + 1) >>> 0;
    nextAudioSample = firstSample + BigInt(slice.frameCount);
  }

  function recordPersistenceFailure(
    code: "E_PERSISTENCE_READ" | "E_PERSISTENCE_WRITE",
    message: string,
    error?: unknown,
  ): void {
    if (localPersistenceDiagnostics.length >= 32) {
      localPersistenceDiagnostics.shift();
    }
    localPersistenceDiagnostics.push({
      code,
      message,
      phase: "none",
      recoverable: true,
      ...(error === undefined ? {} : {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      }),
    });
  }

  function enqueueCartDataCommit(commit: PicoCartDataCommit): void {
    cartDataSeeds = [
      ...cartDataSeeds
        .filter((seed) => seed.id !== commit.id)
        .map((seed) => ({ id: seed.id, bytes: seed.bytes.slice() })),
      { id: commit.id, bytes: commit.bytes.slice() },
    ];
    if (hostPersistence) {
      pendingHostCartDataCommits.push({
        id: commit.id,
        revision: commit.revision,
        bytes: commit.bytes.slice(),
      });
      return;
    }
    if (persistence === undefined) return;
    try {
      persistence.enqueue(commit);
    } catch (error) {
      recordPersistenceFailure(
        "E_PERSISTENCE_WRITE",
        "Unable to queue committed cartdata for durable storage",
        error,
      );
    }
  }

  function takePersistenceEvents(
    context: SessionContext,
  ): readonly SessionEvent[] {
    const commits = pendingHostCartDataCommits.splice(0).map((commit) => ({
      ...playerBase(context),
      type: "cartdata-commit" as const,
      id: commit.id,
      revision: commit.revision,
      bytes: commit.bytes.slice().buffer,
    }));
    if (persistence === undefined || hostPersistence) {
      const local = localPersistenceDiagnostics.splice(0).map((error) => ({
        ...playerBase(context),
        type: "diagnostic" as const,
        error,
      }));
      return [...commits, ...local];
    }
    let diagnostics: readonly SerializedRuntimeError[] = [];
    try {
      diagnostics = persistence.takeDiagnostics();
    } catch (error) {
      recordPersistenceFailure(
        "E_PERSISTENCE_READ",
        "Unable to read persistence diagnostics",
        error,
      );
    }
    const combined = [...localPersistenceDiagnostics.splice(0), ...diagnostics];
    return [...commits, ...combined.map((error) => ({
      ...playerBase(context),
      type: "diagnostic" as const,
      error,
    }))];
  }

  async function flushPersistence(): ReturnType<CartDataPersistencePort["flush"]> {
    // Host mode only acknowledges the Worker drain. The facade must also await
    // the host adapter before reporting durability to its caller.
    if (hostPersistence) return { durable: true };
    if (persistence === undefined) {
      return { durable: false, message: "No durable persistence adapter is configured" };
    }
    try {
      const result = await persistence.flush();
      return result ?? { durable: false, message: "Persistence adapter did not confirm durability" };
    } catch (error) {
      recordPersistenceFailure(
        "E_PERSISTENCE_WRITE",
        "Unable to durably flush committed cartdata",
        error,
      );
      return { durable: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async function hydratePersistence(): Promise<void> {
    if (persistence === undefined) return;
    try {
      cartDataSeeds = await persistence.hydrate();
    } catch (error) {
      cartDataSeeds = [];
      recordPersistenceFailure(
        "E_PERSISTENCE_READ",
        "Unable to hydrate cartdata; using an empty durable mirror",
        error,
      );
    }
  }

  function useHostPersistence(
    records: readonly PicoCartDataSeed[],
  ): void {
    const ids = new Set<string>();
    if (records.length > 4096) throw new RangeError("host cartdata exceeds 4096 records");
    cartDataSeeds = records.map((record) => {
      if (!/^[a-z0-9_-]{1,64}$/u.test(record.id) || ids.has(record.id) ||
        !(record.bytes instanceof Uint8Array) || record.bytes.byteLength !== 256) {
        throw new RangeError("host cartdata contains an invalid record");
      }
      ids.add(record.id);
      return { id: record.id, bytes: record.bytes.slice() };
    });
    hostPersistence = true;
  }

  function fault(
    context: SessionContext,
    error: SerializedRuntimeError,
  ): SessionEvent {
    cancelPendingRequest();
    activeMenuSnapshot = undefined;
    lifecycle = "faulted";
    scheduler.pause();
    clearInputState();
    devkitFlags = 0;
    resetAudioQueue(context.sessionGeneration);
    return { ...playerBase(context), type: "fault", error };
  }

  function state(
    context: SessionContext,
    next: PlayerRuntimeState,
  ): SessionEvent {
    return {
      ...playerBase(context),
      type: "state",
      state: next,
      mode,
      targetFps,
      devkitFlags,
    };
  }

  function pauseMenuEvent(
    context: SessionContext,
    open: boolean,
    outcome: "opened" | "keep-open" | "closed" | "removed",
    snapshot?: CartSessionMenuSnapshot,
  ): SessionEvent {
    return {
      ...playerBase(context),
      type: "pause-menu",
      open,
      outcome,
      items: (snapshot?.items ?? []).map((item) => ({
        slot: item.slot,
        label: item.label.slice().buffer,
        filter: item.filter,
      })),
    };
  }

  function stateForGeneration(
    context: SessionContext,
    generation: number,
    next: PlayerRuntimeState,
  ): SessionEvent {
    return state({ ...context, sessionGeneration: generation }, next);
  }

  function cancelPendingRequest(): void {
    const pending = pendingRequest;
    pendingRequest = undefined;
    pending?.cancellation.cancel();
  }

  function guestLoadFault(
    context: SessionContext,
    pending: PendingGuestLoad,
    error: unknown,
  ): void {
    if (pendingRequest !== pending) return;
    pendingRequest = undefined;
    session.stop();
    const serialized: SerializedRuntimeError = error instanceof CartCodecError
      ? {
          code: "E_CART_PARSE",
          message: `${error.code}: ${error.message}`,
          phase: "host-call",
          recoverable: false,
          details: {
            cartCodecCode: error.code,
            ...(error.offset === undefined ? {} : { byteOffset: error.offset }),
          },
        }
      : error instanceof CartResolutionError
        ? {
            code: "E_HOST_REQUEST",
            message: error.message,
            phase: "host-call",
            recoverable: false,
            details: { cartResolutionCode: error.code },
          }
        : isSerializedRuntimeError(error)
          ? error
          : {
              code: "E_HOST_REQUEST",
              message: error instanceof Error ? error.message : String(error),
              phase: "host-call",
              recoverable: false,
            };
    context.onResume([fault(context, serialized)]);
  }

  async function completeGuestLoad(
    context: SessionContext,
    pending: PendingGuestLoad,
    request: ReturnType<typeof decodeGuestCartLoadRequest>,
  ): Promise<void> {
    try {
      await flushPersistence();
      const current = session.cart?.identity;
      const loaded = await cartLoader.load(
        request.ref,
        { ...(current === undefined ? {} : { current }), purpose: "load" },
        pending.cancellation.token,
      );
      if (
        pendingRequest !== pending || pending.cancellation.token.cancelled ||
        pending.sessionGeneration !== sessionGeneration
      ) return;

      const staged = createSession();
      const boot = staged.load(loaded.cart, request.parameter ?? new Uint8Array());
      if (!boot.ok) {
        staged.dispose();
        guestLoadFault(context, pending, boot.error);
        return;
      }
      if (boot.value.kind !== "ready") {
        staged.dispose();
        guestLoadFault(context, pending, {
          code: "E_FEATURE_UNSUPPORTED",
          message: "a load target must boot directly into callback or custom mode",
          phase: "host-call",
          recoverable: false,
        } satisfies SerializedRuntimeError);
        return;
      }
      if (sessionGeneration >= 0xffff_ffff) {
        staged.dispose();
        guestLoadFault(context, pending, invariant("session generation space is exhausted"));
        return;
      }

      const previousSessionGeneration = sessionGeneration;
      const nextSessionGeneration = previousSessionGeneration + 1;
      const oldSession = session;
      const oldDisposed = oldSession.dispose();
      if (!oldDisposed.ok) {
        staged.dispose();
        guestLoadFault(context, pending, oldDisposed.error);
        return;
      }
      pendingRequest = undefined;
      session = staged;
      sessionGeneration = nextSessionGeneration;
      externalCstoreTargetIdentities.clear();
      if (request.breadcrumb !== undefined) breadcrumbDepth++;
      inputSequence = -1;
      clearInputState();
      mode = boot.value.mode;
      targetFps = boot.value.targetFps;
      devkitFlags = boot.value.devkitFlags;
      scheduler.reset();
      scheduler.configure(targetFps);
      lifecycle = pending.continueRunning ? "running" : "ready";
      if (pending.continueRunning) scheduler.start();

      const breadcrumb = request.breadcrumb?.slice() ?? new Uint8Array();
      context.onResume([{
        ...playerBaseForGeneration(context, nextSessionGeneration),
        type: "session-replaced",
        previousSessionGeneration,
        nextSessionGeneration,
        cartRef: loaded.ref,
        breadcrumb: breadcrumb.buffer,
        breadcrumbDepth: breadcrumbDepth,
      }]);
      beginAudioGeneration(nextSessionGeneration);
      sendAudio(boot.value.audio);
      context.onResume([
        stateForGeneration(
          context,
          nextSessionGeneration,
          pending.continueRunning ? "running" : "ready",
        ),
      ]);
    } catch (error) {
      guestLoadFault(context, pending, error);
    }
  }

  function suspendGuestLoad(
    context: SessionContext,
    request: CartSessionHostRequest,
    continueRunning: boolean,
  ): readonly SessionEvent[] {
    if (
      pendingRequest !== undefined
    ) {
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: "root HostRequest violates the bounded single-pending contract",
        phase: "host-call",
        recoverable: false,
      })];
    }
    let decoded: ReturnType<typeof decodeGuestCartLoadRequest>;
    try {
      decoded = decodeGuestCartLoadRequest(request.bytes);
    } catch (error) {
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: error instanceof Error ? error.message : String(error),
        phase: "host-call",
        recoverable: false,
        details: { guestRequestKind: "load", malformed: true },
      })];
    }
    scheduler.pause();
    lifecycle = "waiting-host";
    const pending: PendingGuestLoad = {
      kind: "load",
      sessionGeneration,
      requestId: request.id,
      cancellation: new CartCancellationSource(),
      continueRunning,
    };
    pendingRequest = pending;
    void completeGuestLoad(context, pending, decoded);
    return [state(context, "waiting-host")];
  }

  function externalCartDataIsCurrent(pending: PendingExternalCartData): boolean {
    return pendingRequest === pending &&
      !pending.cancellation.token.cancelled &&
      pending.sessionGeneration === sessionGeneration &&
      pending.runtimeGeneration === session.generation;
  }

  function failExternalCartData(
    pending: PendingExternalCartData,
  ): void {
    if (!externalCartDataIsCurrent(pending)) return;
    pendingRequest = undefined;
    pending.emit(pending.resume(new Uint8Array(), true));
  }

  async function completeExternalCartData(
    pending: PendingExternalCartData,
    request: ReturnType<typeof decodeExternalCartDataRequest>,
    range: ReturnType<typeof normalizeReloadRange> | ReturnType<typeof normalizeCstoreRange>,
    cstoreSnapshot: Uint8Array | undefined,
  ): Promise<void> {
    try {
      const current = session.cart?.identity;
      const loaded = await cartLoader.load(
        request.ref,
        {
          ...(current === undefined ? {} : { current }),
          purpose: request.operation,
        },
        pending.cancellation.token,
      );
      if (!externalCartDataIsCurrent(pending)) return;

      if (request.operation === "reload") {
        const bytes = cartRepository.readData(
          loaded.cart.identity,
          range.source,
          range.length,
        );
        if (!externalCartDataIsCurrent(pending)) return;
        const written = session.writeSuspendedLogicalRam(
          pending.runtimeGeneration,
          range.destination,
          bytes,
        );
        if (!written.ok) throw written.error;
      } else {
        if (cstoreSnapshot === undefined || cstoreSnapshot.byteLength !== range.length) {
          throw new Error("external cstore snapshot invariant failed");
        }
        if (range.length !== 0) {
          const target = loaded.cart.identity.contentSha256;
          if (
            !externalCstoreTargetIdentities.has(target) &&
            externalCstoreTargetIdentities.size >= 64
          ) {
            throw new RangeError("external cstore reached its 64-target execution limit");
          }
          cartRepository.writeDataOverlay(
            loaded.cart.identity,
            range.destination,
            cstoreSnapshot,
          );
          externalCstoreTargetIdentities.add(target);
        }
      }

      if (!externalCartDataIsCurrent(pending)) return;
      pendingRequest = undefined;
      pending.emit(pending.resume(new Uint8Array(), false));
    } catch {
      failExternalCartData(pending);
    }
  }

  function suspendExternalCartData(
    context: SessionContext,
    hostRequest: CartSessionHostRequest,
    resume: PendingRootHostRequest["resume"],
  ): readonly SessionEvent[] {
    if (
      pendingRequest !== undefined
    ) {
      session.stop();
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: "root HostRequest violates the bounded single-pending contract",
        phase: "host-call",
        recoverable: false,
      })];
    }

    try {
      const request = decodeExternalCartDataRequest(hostRequest.bytes);
      const range = request.operation === "reload"
        ? normalizeReloadRange(
            request.destinationRaw,
            request.sourceRaw,
            request.lengthRaw,
          )
        : normalizeCstoreRange(
            request.destinationRaw,
            request.sourceRaw,
            request.lengthRaw,
          );
      const cstoreSnapshot = request.operation === "cstore"
        ? session.copySuspendedLogicalRam(
            hostRequest.generation,
            range.source,
            range.length,
          )
        : undefined;
      if (cstoreSnapshot !== undefined && !cstoreSnapshot.ok) {
        throw cstoreSnapshot.error;
      }

      scheduler.pause();
      lifecycle = "waiting-host";
      const pending: PendingExternalCartData = {
      kind: "cart-data",
        sessionGeneration,
        runtimeGeneration: hostRequest.generation,
        requestId: hostRequest.id,
        cancellation: new CartCancellationSource(),
        resume,
        emit: context.onResume,
      };
      pendingRequest = pending;
      void completeExternalCartData(
        pending,
        request,
        range,
        cstoreSnapshot?.value,
      );
      return [state(context, "waiting-host")];
    } catch (error) {
      session.stop();
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: error instanceof Error ? error.message : String(error),
        phase: "host-call",
        recoverable: false,
        details: { externalCartDataMalformedOrOutOfRange: true },
      })];
    }
  }

  function completePendingHostRequest(
    pending: PendingRootHostRequest,
    completion: RootHostRequestCompletion | undefined,
  ): void {
    if (
      pendingRequest !== pending || pending.cancellation.token.cancelled ||
      pending.sessionGeneration !== sessionGeneration
    ) return;
    pendingRequest = undefined;

    const valid = completion !== undefined &&
      completion.generation === pending.runtimeGeneration &&
      completion.requestId === pending.requestId &&
      completion.bytes instanceof Uint8Array &&
      completion.bytes.byteLength <= PICO_HOST_REQUEST_MAX_BYTES &&
      typeof completion.isError === "boolean";
    const response = valid ? completion.bytes.slice() : new Uint8Array();
    const events = pending.resume(response, valid ? completion.isError : true);
    pending.emit(events);
  }

  function suspendHostRequest(
    context: SessionContext,
    request: CartSessionHostRequest,
    resume: PendingRootHostRequest["resume"],
  ): readonly SessionEvent[] {
    if (isGuestCartRequestPayload(request.bytes)) {
      return suspendGuestLoad(context, request, lifecycle === "running");
    }
    if (isExternalCartDataRequestPayload(request.bytes)) {
      return suspendExternalCartData(context, request, resume);
    }
    if (hostRequestHandler === undefined) {
      return [unsupportedHostRequest(context)];
    }
    if (
      request.bytes.byteLength > PICO_HOST_REQUEST_MAX_BYTES ||
      pendingRequest !== undefined
    ) {
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: "root HostRequest violates the bounded single-pending contract",
        phase: "host-call",
        recoverable: false,
      })];
    }

    scheduler.pause();
    lifecycle = "waiting-host";
    const cancellation = new CartCancellationSource();
    const pending: PendingRootHostRequest = {
      kind: "host",
      sessionGeneration,
      runtimeGeneration: request.generation,
      requestId: request.id,
      cancellation,
      resume,
      emit: context.onResume,
    };
    pendingRequest = pending;
    const handlerRequest = Object.freeze({
      generation: request.generation,
      requestId: request.id,
      operation: request.operation,
      bytes: request.bytes.slice(),
    });
    void Promise.resolve()
      .then(() => hostRequestHandler.handle(handlerRequest, cancellation.token))
      .then(
        (completion) => completePendingHostRequest(pending, completion),
        () => completePendingHostRequest(pending, undefined),
      );
    return [state(context, "waiting-host")];
  }

  function unsupportedHostRequest(
    context: SessionContext,
  ): SessionEvent {
    session.stop();
    return fault(context, {
      code: "E_FEATURE_UNSUPPORTED",
      message: "cart host requests are not supported by the player",
      phase: "host-call",
      recoverable: false,
    });
  }

  function acceptBoot(
    context: SessionContext,
    result: RuntimeResult<CartSessionBootResult>,
    continueRunning = false,
  ): readonly SessionEvent[] {
    activeMenuSnapshot = undefined;
    let current = result;
    const events: SessionEvent[] = [];
    for (let restartCount = 0; restartCount <= 8; restartCount += 1) {
      if (!current.ok) return [...events, fault(context, current.error)];
      if (current.value.kind === "host-request") {
        const request = current.value.request;
        return [...events, ...suspendHostRequest(context, request, (response, isError) =>
          acceptBoot(
            context,
            session.completeHostRequest(
              request.generation,
              request.id,
              response,
              isError,
            ) as RuntimeResult<CartSessionBootResult>,
            continueRunning,
          ))];
      }
      if (current.value.cartDataCommit !== undefined) {
        enqueueCartDataCommit(current.value.cartDataCommit);
      }
      if (current.value.kind === "stopped") {
        scheduler.pause();
        clearInputState();
        lifecycle = "stopped";
        mode = "none";
        targetFps = 0;
        devkitFlags = 0;
        resetAudioQueue(context.sessionGeneration);
        events.push(runtimeControlEvent(context, "stop", current.value.message));
        events.push(state(context, "stopped"));
        return events;
      }
      if (current.value.kind === "restart") {
        events.push(runtimeControlEvent(context, "run", current.value.parameter));
        if (restartCount === 8) {
          events.push(fault(context, {
            code: "E_VM_INSTRUCTION_BUDGET",
            message: "guest run restart limit exceeded in one host context",
            phase: "none",
            recoverable: false,
            details: { restartCount: restartCount + 1 },
          }));
          return events;
        }
        externalCstoreTargetIdentities.clear();
        current = session.restart(current.value.parameter);
        continue;
      }
      beginAudioGeneration(context.sessionGeneration);
      sendAudio(current.value.audio);
      mode = current.value.mode;
      targetFps = current.value.targetFps;
      devkitFlags = current.value.devkitFlags;
      scheduler.configure(targetFps);
      if (continueRunning) {
        scheduler.start();
        lifecycle = "running";
        events.push(state(context, "running"));
        return events;
      }
      lifecycle = "ready";
      events.push(state(context, "ready"));
      return events;
    }
    return [...events, fault(context, invariant("unreachable guest restart loop"))];
  }

  function runtimeControlEvent(
    context: SessionContext,
    control: "run" | "stop",
    payload: Uint8Array,
  ): SessionEvent {
    return {
      ...playerBase(context),
      type: "runtime-control",
      control,
      payload: payload.slice().buffer,
    };
  }

  function acceptInput(context: { readonly sessionGeneration: number; readonly sequence: number; readonly input: PicoInputSnapshot }): void {
    if (
      context.sessionGeneration !== sessionGeneration ||
      context.sequence <= inputSequence ||
      lifecycle !== "running"
    ) return;
    inputSequence = context.sequence;
    inputControllers = context.input.controllers.slice();
    const devkit = context.input.devkit;
    inputMouseXRaw = devkit.mouseXRaw;
    inputMouseYRaw = devkit.mouseYRaw;
    inputMouseButtons = devkit.mouseButtons;
    pendingWheelRaw = saturatingAddInt32(pendingWheelRaw, devkit.wheelRaw);
    pendingMovementXRaw = saturatingAddInt32(pendingMovementXRaw, devkit.movementXRaw);
    pendingMovementYRaw = saturatingAddInt32(pendingMovementYRaw, devkit.movementYRaw);
    for (const byte of devkit.keypresses) {
      if (pendingKeypresses.length >= PICO_DEVKIT_KEYPRESS_BATCH_LIMIT) break;
      pendingKeypresses.push(byte);
    }
  }

  function frameEvent(
    context: SessionContext,
    result: Extract<CartSessionStepResult, { readonly kind: "frame" }>,
  ): SessionEvent {
    sendAudio(result.frame.audio);
    const packedScreen = result.frame.screen.slice().buffer;
    const displayPalette = result.frame.displayPalette.slice().buffer;
    devkitFlags = result.frame.devkitFlags;
    if (result.frame.cartDataCommit !== undefined) {
      enqueueCartDataCommit(result.frame.cartDataCommit);
    }
    return {
      ...playerBase(context),
      type: "frame",
      frameId: result.frame.frameId,
      completedSlices: result.frame.completedSlices,
      timeRawBeforeStep: result.frame.timeRawBeforeStep,
      targetFps: result.frame.targetFps,
      cpuInstructions: result.frame.cpuInstructions,
      cpuFractionRaw: result.frame.cpuFractionRaw,
      slowFrame: result.frame.slowFrame,
      devkitFlags,
      packedScreen,
      displayPalette,
    };
  }

  function heartbeatEvent(
    context: SessionFrameContext,
    tickCount: number,
    droppedTicks: number,
  ): SessionEvent {
    return {
      ...playerBase(context),
      type: "heartbeat",
      vsyncSequence: context.sequence,
      tickCount,
      droppedTicks,
    };
  }

  function acceptCompletedStep(
    context: SessionContext,
    result: Exclude<CartSessionStepResult, { readonly kind: "host-request" }>,
  ): SessionEvent[] {
    const events: SessionEvent[] = [];
    if (result.kind === "stopped") {
      if (result.cartDataCommit !== undefined) {
        enqueueCartDataCommit(result.cartDataCommit);
      }
      scheduler.pause();
      lifecycle = "stopped";
      clearInputState();
      devkitFlags = 0;
      resetAudioQueue(context.sessionGeneration);
      events.push(runtimeControlEvent(context, "stop", result.message));
      events.push(state(context, "stopped"));
    } else if (result.kind === "restart") {
      if (result.cartDataCommit !== undefined) {
        enqueueCartDataCommit(result.cartDataCommit);
      }
      clearInputState();
      events.push(runtimeControlEvent(context, "run", result.parameter));
      externalCstoreTargetIdentities.clear();
      events.push(...acceptBoot(context, session.restart(result.parameter), true));
    } else {
      events.push(frameEvent(context, result));
    }
    return events;
  }

  function acceptVsyncHostCompletion(
    context: SessionFrameContext,
    result: RuntimeResult<CartSessionStepResult>,
    executedBefore: number,
    droppedTicks: number,
  ): readonly SessionEvent[] {
    if (!result.ok) return [fault(context, result.error)];
    if (result.value.kind === "host-request") {
      const request = result.value.request;
      return suspendHostRequest(context, request, (response, isError) =>
        acceptVsyncHostCompletion(
          context,
          session.completeHostRequest(
            request.generation,
            request.id,
            response,
            isError,
          ) as RuntimeResult<CartSessionStepResult>,
          executedBefore,
          droppedTicks,
        ));
    }

    const executedTicks = executedBefore + 1;
    if (result.value.kind === "frame") {
      scheduler.resume();
      lifecycle = "running";
    }
    const events = acceptCompletedStep(context, result.value);
    events.push(heartbeatEvent(context, executedTicks, droppedTicks));
    return events;
  }

  function handleTicks(
    context: SessionFrameContext,
    decide: () => { tickCount: number; droppedTicks: number; discontinuity: boolean },
  ): readonly SessionEvent[] {
    if (lifecycle !== "running") {
      return [heartbeatEvent(context, 0, 0)];
    }
    const decision = decide();
    const events: SessionEvent[] = [];
    if (decision.discontinuity) {
      events.push({
        ...playerBase(context),
        type: "diagnostic",
        error: {
          code: "E_TIME_DISCONTINUITY",
          message: decision.droppedTicks > 0
            ? "simulation backlog exceeded the catch-up limit and was dropped"
            : "non-monotonic wall-clock pulse reset the scheduler anchor",
          phase: "none",
          recoverable: true,
          details: { droppedTicks: decision.droppedTicks },
        },
      });
    }
    let executedTicks = 0;
    for (let index = 0; index < decision.tickCount; index += 1) {
      const result = session.step(simulationInput(index === 0));
      if (index === 0) clearPendingDevkitEvents();
      if (!result.ok) {
        events.push(fault(context, result.error));
        return events;
      }
      if (result.value.kind === "host-request") {
        const request = result.value.request;
        return [...events, ...suspendHostRequest(context, request, (response, isError) =>
          acceptVsyncHostCompletion(
            context,
            session.completeHostRequest(
              request.generation,
              request.id,
              response,
              isError,
            ) as RuntimeResult<CartSessionStepResult>,
            executedTicks,
            decision.droppedTicks,
          ))];
      }
      executedTicks += 1;
      events.push(...acceptCompletedStep(context, result.value));
      if (result.value.kind !== "frame") break;
    }
    events.push(heartbeatEvent(context, executedTicks, decision.droppedTicks));
    return events;
  }

  function generationFault(
    context: SessionContext,
    message: string,
  ): readonly SessionEvent[] {
    return [{ ...playerBase(context), type: "fault", error: playerLifecycleError(message) }];
  }

  function loadCartSync(context: SessionContext, load: SessionLoadOptions): readonly SessionEvent[] {
    if (context.sessionGeneration <= sessionGeneration) {
      return generationFault(context, "loadCart requires a new session generation");
    }
    cancelPendingRequest();
    activeMenuSnapshot = undefined;
    sessionGeneration = context.sessionGeneration;
    instructionBudget = load.instructionBudget;
    scheduler.reset();
    inputSequence = -1;
    clearInputState();
    devkitFlags = 0;
    if (load.hostCartData !== undefined) useHostPersistence(load.hostCartData);
    let nextResolver: LocalCartBundleResolver | undefined;
    try {
      nextResolver = new LocalCartBundleResolver(
        (load.localCartBundle ?? []).map((entry) => ({
          ref: entry.ref,
          bytes: entry.bytes,
          access: entry.access,
        })),
      );
      const cart = decodeCart(load.source, {
        p8: {
          includeResolver(specifier) {
            try {
              return nextResolver?.resolveImmediate(specifier, "include").bytes;
            } catch (error) {
              if (error instanceof CartResolutionError) return undefined;
              throw error;
            }
          },
        },
      });
      localCartResolver.dispose();
      localCartResolver = nextResolver;
      nextResolver = undefined;
      cartLoader = new CartLoader(localCartResolver, cartRepository);
      breadcrumbDepth = 0;
      externalCstoreTargetIdentities.clear();
      cartRepository.registerCart(cart);
      return acceptBoot(context, session.load(cart));
    } catch (error) {
      nextResolver?.dispose();
      if (session.cart !== undefined) session.stop();
      if (error instanceof CartCodecError) {
        return [fault(context, {
          code: "E_CART_PARSE",
          message: `${error.code}: ${error.message}`,
          phase: "none",
          recoverable: true,
          details: {
            cartCodecCode: error.code,
            ...(error.offset === undefined ? {} : { byteOffset: error.offset }),
          },
        })];
      }
      return [fault(context, invariant(
        error instanceof Error ? error.message : String(error),
      ))];
    }
  }

  function releaseResources(generation: number) {
    cancelPendingRequest();
    activeMenuSnapshot = undefined;
    scheduler.reset();
    clearInputState();
    const result = session.dispose();
    localCartResolver.dispose();
    cartRepository.dispose();
    externalCstoreTargetIdentities.clear();
    lifecycle = "disposed";
    mode = "none";
    targetFps = 0;
    devkitFlags = 0;
    if (generation > 0) resetAudioQueue(generation);
    return result;
  }

  function disposeSync(context: SessionContext): readonly SessionEvent[] {
    const result = releaseResources(context.sessionGeneration);
    return result.ok ? [state(context, "disposed")] : [fault(context, result.error)];
  }

  function resetSync(context: SessionContext): readonly SessionEvent[] {
    if (lifecycle === "disposed" || context.sessionGeneration <= sessionGeneration) {
      return generationFault(context, "reset requires a new session generation");
    }
    cancelPendingRequest();
    activeMenuSnapshot = undefined;
    sessionGeneration = context.sessionGeneration;
    scheduler.reset();
    inputSequence = -1;
    clearInputState();
    devkitFlags = 0;
    externalCstoreTargetIdentities.clear();
    return acceptBoot(context, session.reset());
  }

  function startSync(context: SessionContext): readonly SessionEvent[] {
    if (lifecycle !== "ready") {
      return generationFault(context, "start requires a ready session");
    }
    scheduler.start();
    lifecycle = "running";
    return [state(context, "running")];
  }

  function openPauseMenuSync(context: SessionContext): readonly SessionEvent[] {
    if (lifecycle !== "running") {
      return generationFault(context, "openPauseMenu requires a running session");
    }
    scheduler.pause();
    clearInputState();
    resetAudioQueue(context.sessionGeneration);
    const snapshot = session.snapshotMenuItems(session.generation);
    if (!snapshot.ok) return [fault(context, snapshot.error)];
    activeMenuSnapshot = snapshot.value;
    lifecycle = "menu-open";
    return [pauseMenuEvent(context, true, "opened", snapshot.value)];
  }

  function closePauseMenuSync(context: SessionContext): readonly SessionEvent[] {
    if (lifecycle !== "menu-open" || activeMenuSnapshot === undefined) {
      return generationFault(context, "closePauseMenu requires an open pause menu");
    }
    activeMenuSnapshot = undefined;
    clearInputState();
    scheduler.resume();
    lifecycle = "running";
    return [
      pauseMenuEvent(context, false, "closed"),
      state(context, "running"),
    ];
  }

  function invokeMenuItemSync(context: SessionMenuContext): readonly SessionEvent[] {
    const snapshot = activeMenuSnapshot;
    if (lifecycle !== "menu-open" || snapshot === undefined ||
      snapshot.generation !== session.generation) {
      return generationFault(context, "invokeMenuItem requires the active pause menu");
    }
    const item = snapshot.items.find(({ slot }) => slot === context.slot);
    if (item === undefined || ((item.filter >> 8) & context.button) !== 0) {
      return generationFault(context, "menu item intent is missing or filtered");
    }
    const invoked = session.invokeMenuItem(
      snapshot.generation,
      context.slot,
      context.button,
    );
    if (!invoked.ok) {
      return invoked.error.code === "E_INVALID_STATE"
        ? generationFault(context, invoked.error.message)
        : [fault(context, invoked.error)];
    }
    if (invoked.value.cartDataCommit !== undefined) {
      enqueueCartDataCommit(invoked.value.cartDataCommit);
    }
    if (invoked.value.kind === "keep-open") {
      activeMenuSnapshot = invoked.value.snapshot;
      return [pauseMenuEvent(
        context,
        true,
        "keep-open",
        invoked.value.snapshot,
      )];
    }
    activeMenuSnapshot = undefined;
    clearInputState();
    scheduler.resume();
    lifecycle = "running";
    return [
      pauseMenuEvent(
        context,
        false,
        invoked.value.kind === "removed" ? "removed" : "closed",
      ),
      state(context, "running"),
    ];
  }

  function pauseSync(context: SessionContext): readonly SessionEvent[] {
    if (lifecycle !== "running" && lifecycle !== "paused" && lifecycle !== "menu-open") {
      return generationFault(context, "pause requires a running session");
    }
    const closedMenu = lifecycle === "menu-open";
    scheduler.pause();
    lifecycle = "paused";
    clearInputState();
    activeMenuSnapshot = undefined;
    return [
      ...(closedMenu ? [pauseMenuEvent(context, false, "closed")] : []),
      state(context, "paused"),
    ];
  }

  function resumeSync(context: SessionContext): readonly SessionEvent[] {
    if (lifecycle !== "paused" && lifecycle !== "running") {
      return generationFault(context, "resume requires a paused session");
    }
    scheduler.resume();
    lifecycle = "running";
    return [state(context, "running")];
  }

  function stopSync(context: SessionContext): readonly SessionEvent[] {
    cancelPendingRequest();
    const stopped = session.stop();
    scheduler.reset();
    clearInputState();
    activeMenuSnapshot = undefined;
    devkitFlags = 0;
    if (!stopped.ok) return [fault(context, stopped.error)];
    lifecycle = "stopped";
    resetAudioQueue(context.sessionGeneration);
    return [state(context, "stopped")];
  }

  function current(context: SessionContext, action: () => readonly SessionEvent[]): readonly SessionEvent[] {
    return context.sessionGeneration !== sessionGeneration || sessionGeneration === 0
      ? generationFault(context, "operation belongs to a stale or missing session")
      : action();
  }

  function perform(
    context: SessionContext,
    action: () => readonly SessionEvent[],
    policy: "normal" | "load" | "reset" | "pause" | "stop" | "dispose" = "normal",
    hostCartData?: readonly PicoCartDataSeed[],
  ): SessionBatch {
    if (persistence === undefined) return action();
    return (async () => {
      if ((policy === "load" || policy === "reset") &&
        context.sessionGeneration > sessionGeneration && lifecycle !== "disposed") {
        await flushPersistence();
        if (hostCartData !== undefined) useHostPersistence(hostCartData);
        else if (!(policy === "reset" && hostPersistence)) {
          hostPersistence = false;
          await hydratePersistence();
        }
      }
      const events = action();
      if (policy === "dispose") {
        try { await persistence.dispose(); }
        catch (error) { recordPersistenceFailure("E_PERSISTENCE_WRITE", "Unable to dispose cartdata persistence cleanly", error); }
      } else if (policy === "pause" || policy === "stop" ||
        events.some(event => event.type === "fault" || event.type === "runtime-control")) {
        await flushPersistence();
      }
      return [...takePersistenceEvents(context), ...events];
    })();
  }

  return {
    input(generation, sequence, input) { acceptInput({ sessionGeneration: generation, sequence, input }); },
    loadCart(context, load) { return perform(context, () => loadCartSync(context, load), "load", load.hostCartData); },
    reset(context) { return perform(context, () => resetSync(context), "reset"); },
    dispose(context) { return perform(context, () => disposeSync(context), "dispose"); },
    start(context) { return perform(context, () => current(context, () => startSync(context))); },
    pause(context) { return perform(context, () => current(context, () => pauseSync(context)), "pause"); },
    resume(context) { return perform(context, () => current(context, () => resumeSync(context))); },
    stop(context) { return perform(context, () => current(context, () => stopSync(context)), "stop"); },
    openPauseMenu(context) { return perform(context, () => current(context, () => openPauseMenuSync(context))); },
    closePauseMenu(context) { return perform(context, () => current(context, () => closePauseMenuSync(context))); },
    invokeMenuItem(context, slot, button) {
      return perform(context, () => current(context, () => invokeMenuItemSync({ ...context, slot, button })));
    },
    pulse(context, sequence, timestampMs) {
      return perform(context, () => current(context, () => handleTicks(
        { ...context, sequence }, () => scheduler.pulse(timestampMs),
      )));
    },
    step(context, sequence) {
      return perform(context, () => current(context, () => handleTicks(
        { ...context, sequence }, () => ({ tickCount: 1, droppedTicks: 0, discontinuity: false }),
      )));
    },
    flushPersistence(context) {
      if (persistence === undefined) return [
        ...takePersistenceEvents(context),
        { ...playerBase(context), type: "persistence-flushed", durable: hostPersistence },
      ];
      return flushPersistence().then(result => [
        ...takePersistenceEvents(context),
        { ...playerBase(context), type: "persistence-flushed", ...result },
      ]);
    },
    async destroy() {
      releaseResources(sessionGeneration);
      try { await persistence?.dispose(); } catch { /* Forced teardown has no caller. */ }
    },
  };
}
