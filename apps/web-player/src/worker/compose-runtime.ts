import { CartCodecError, decodeCart, decodeP8Png } from "@pico8-web/cart-codec";
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
  CartSession,
  type CartDataPersistencePort,
  type CanonicalAudioSlice,
  FrameScheduler,
  FrameSliceRuntime,
  type CartSessionBootResult,
  type CartSessionHostRequest,
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

import type {
  Phase0EHostToRuntime,
  Phase0ERuntimeToHost,
} from "../transport/public.js";
import { CartRepositoryAdapter } from "./adapters/cart-repository-adapter.js";
import type { WorkerPcmTransport } from "./audio-transport.js";
import type {
  PlayerHostToRuntime,
  PlayerRuntimeControlCommand,
  PlayerRuntimeInputCommand,
  PlayerRuntimeState,
  PlayerRuntimeToHost,
} from "../transport/public.js";

export interface Phase0EWorkerController {
  handle(command: Phase0EHostToRuntime): Phase0ERuntimeToHost;
  dispose(): void;
}

function invariant(message: string): SerializedRuntimeError {
  return {
    code: "E_INVARIANT",
    message,
    phase: "none",
    recoverable: false,
  };
}

function eventBase(command: Phase0EHostToRuntime) {
  return {
    v: 1 as const,
    requestId: command.requestId,
    sessionGeneration: command.sessionGeneration,
  };
}

export function createPhase0EWorkerController(
  module: FrameRuntimeModule,
): Phase0EWorkerController {
  let runtime: FrameSliceRuntime | undefined;

  function fault(
    command: Phase0EHostToRuntime,
    error: SerializedRuntimeError,
  ): Phase0ERuntimeToHost {
    return { ...eventBase(command), type: "fault", error };
  }

  function translateResult(
    command: Phase0EHostToRuntime,
    result: RuntimeResult<RuntimeBootResult | RuntimeStepResult>,
  ): Phase0ERuntimeToHost {
    if (!result.ok) return fault(command, result.error);
    const value = result.value;
    if (value.kind === "ready") {
      return {
        ...eventBase(command),
        type: "ready",
        mode: value.mode,
        targetFps: value.targetFps,
      };
    }
    if (value.kind === "host-request") {
      const bytes = value.request.bytes.slice().buffer;
      return {
        ...eventBase(command),
        type: "hostRequest",
        hostRequestId: value.request.id,
        operation: value.request.operation,
        bytes,
      };
    }
    if (value.kind === "stopped") {
      return { ...eventBase(command), type: "stopped" };
    }
    if (value.kind === "restart") {
      return fault(command, {
        code: "E_FEATURE_UNSUPPORTED",
        message: "guest run is only supported by the production player controller",
        phase: "none",
        recoverable: false,
      });
    }
    const packedScreen = value.frame.screen.buffer.slice(
      value.frame.screen.byteOffset,
      value.frame.screen.byteOffset + value.frame.screen.byteLength,
    ) as ArrayBuffer;
    return {
      ...eventBase(command),
      type: "frame",
      frameId: value.frame.frameId,
      completedSlices: value.frame.completedSlices,
      timeRawBeforeStep: value.frame.timeRawBeforeStep,
      targetFps: value.frame.targetFps,
      packedScreen,
    };
  }

  return {
    handle(command) {
      try {
        if (command.type === "loadCart") {
          runtime?.dispose();
          const cart = decodeP8Png(new Uint8Array(command.p8PngBytes));
          const hostRouter = createPicoApiHostRouter(module);
          const vm = new Z8LuaFrameVm(module, hostRouter);
          try {
            runtime = new FrameSliceRuntime(vm, {
              ...(command.instructionBudget === undefined
                ? {}
                : { instructionBudget: command.instructionBudget }),
            });
          } catch (error) {
            vm.destroy();
            throw error;
          }
          return translateResult(command, runtime.boot(cart));
        }
        if (runtime === undefined) {
          return fault(command, {
            code: "E_INVALID_STATE",
            message: "no cart session is loaded",
            phase: "none",
            recoverable: false,
          });
        }
        if (command.type === "step") {
          return translateResult(command, runtime.step(command.input));
        }
        if (command.type === "hostResponse") {
          return translateResult(
            command,
            runtime.completeHostRequest(
              command.hostRequestId,
              new Uint8Array(command.bytes),
              command.isError,
            ),
          );
        }
        runtime.dispose();
        runtime = undefined;
        return { ...eventBase(command), type: "disposed" };
      } catch (error) {
        if (error instanceof CartCodecError) {
          return fault(command, {
            code: "E_INVARIANT",
            message: `${error.code}: ${error.message}`,
            phase: "none",
            recoverable: true,
          });
        }
        return fault(
          command,
          invariant(error instanceof Error ? error.message : String(error)),
        );
      }
    },
    dispose() {
      runtime?.dispose();
      runtime = undefined;
    },
  };
}

export interface PlayerWorkerController {
  handle(
    command: PlayerHostToRuntime,
  ): readonly PlayerRuntimeToHost[] | Promise<readonly PlayerRuntimeToHost[]>;
  setEventSink(sink: PlayerWorkerEventSink): void;
  dispose(): void | Promise<void>;
}

export type PlayerWorkerEventSink = (
  events: readonly PlayerRuntimeToHost[],
) => void;

export interface PlayerWorkerControllerOptions {
  readonly audioTransport?: WorkerPcmTransport;
  readonly persistence?: CartDataPersistencePort;
  readonly hostRequestHandler?: RootHostRequestHandlerPort;
  /** Fixed per-VM diagnostic override; zero/undefined selects the 1 MiB production default. */
  readonly luaHeapLimit?: number;
}

type PlayerWorkerLifecycle =
  | "empty"
  | "ready"
  | "running"
  | "waiting-host"
  | "paused"
  | "stopped"
  | "faulted"
  | "disposed";

interface PendingRootHostRequest {
  readonly workerGeneration: number;
  readonly sessionGeneration: number;
  readonly runtimeGeneration: number;
  readonly requestId: number;
  readonly cancellation: CartCancellationSource;
  readonly resume: (
    response: Uint8Array,
    isError: boolean,
  ) => readonly PlayerRuntimeToHost[];
}

const ZERO_DEVKIT_INPUT: PicoDevkitInputBatch = Object.freeze({
  mouseXRaw: 0,
  mouseYRaw: 0,
  mouseButtons: 0,
  wheelRaw: 0,
  movementXRaw: 0,
  movementYRaw: 0,
  keypresses: Object.freeze([]),
});

function saturatingAddInt32(left: number, right: number): number {
  const result = left + right;
  return Math.max(-0x8000_0000, Math.min(0x7fff_ffff, result)) | 0;
}

function playerBase(command: PlayerHostToRuntime) {
  return {
    v: 1 as const,
    requestId: command.requestId,
    workerGeneration: command.workerGeneration,
    sessionGeneration: command.sessionGeneration,
  };
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

/** Stable Phase 1E composition: decode -> CartSession -> scheduler -> events. */
export function createPlayerWorkerController(
  module: FrameRuntimeModule,
  options: PlayerWorkerControllerOptions = {},
): PlayerWorkerController {
  const audioTransport = options.audioTransport;
  const persistence = options.persistence;
  const hostRequestHandler = options.hostRequestHandler;
  const luaHeapLimit = options.luaHeapLimit;
  const cartRepository = new CartRepositoryAdapter();
  const localPersistenceDiagnostics: SerializedRuntimeError[] = [];
  let cartDataSeeds: readonly PicoCartDataSeed[] = [];
  let audioSequence = 0;
  let nextAudioSample = 0n;
  let instructionBudget: number | undefined;
  const scheduler = new FrameScheduler({ maximumCatchUpTicks: 5 });
  const session = new CartSession({
    createRuntime(context) {
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
    },
  });
  let lifecycle: PlayerWorkerLifecycle = "empty";
  let workerGeneration = 0;
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
  let eventSink: PlayerWorkerEventSink | undefined;
  let pendingHostRequest: PendingRootHostRequest | undefined;

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
        ...ZERO_DEVKIT_INPUT,
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
    command: PlayerHostToRuntime,
  ): readonly PlayerRuntimeToHost[] {
    if (persistence === undefined) return [];
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
    return combined.map((error) => ({
      ...playerBase(command),
      type: "diagnostic" as const,
      error,
    }));
  }

  async function flushPersistence(): Promise<void> {
    if (persistence === undefined) return;
    try {
      await persistence.flush();
    } catch (error) {
      recordPersistenceFailure(
        "E_PERSISTENCE_WRITE",
        "Unable to durably flush committed cartdata",
        error,
      );
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

  function fault(
    command: PlayerHostToRuntime,
    error: SerializedRuntimeError,
  ): PlayerRuntimeToHost {
    cancelPendingHostRequest();
    lifecycle = "faulted";
    scheduler.pause();
    clearInputState();
    devkitFlags = 0;
    resetAudioQueue(command.sessionGeneration);
    return { ...playerBase(command), type: "fault", error };
  }

  function state(
    command: PlayerHostToRuntime,
    next: PlayerRuntimeState,
  ): PlayerRuntimeToHost {
    return {
      ...playerBase(command),
      type: "state",
      state: next,
      mode,
      targetFps,
      devkitFlags,
    };
  }

  function setEventSink(sink: PlayerWorkerEventSink): void {
    if (typeof sink !== "function") {
      throw new TypeError("Player Worker event sink must be a function");
    }
    if (eventSink !== undefined && eventSink !== sink) {
      throw new Error("Player Worker event sink is already installed");
    }
    eventSink = sink;
  }

  function emitBackground(events: readonly PlayerRuntimeToHost[]): void {
    if (events.length === 0) return;
    if (eventSink === undefined) {
      throw new Error("Player Worker background event sink is not installed");
    }
    eventSink(events);
  }

  function cancelPendingHostRequest(): void {
    const pending = pendingHostRequest;
    if (pending === undefined) return;
    pendingHostRequest = undefined;
    pending.cancellation.cancel();
  }

  function completePendingHostRequest(
    pending: PendingRootHostRequest,
    completion: RootHostRequestCompletion | undefined,
  ): void {
    if (
      pendingHostRequest !== pending || pending.cancellation.token.cancelled ||
      pending.workerGeneration !== workerGeneration ||
      pending.sessionGeneration !== sessionGeneration
    ) return;
    pendingHostRequest = undefined;

    const valid = completion !== undefined &&
      completion.generation === pending.runtimeGeneration &&
      completion.requestId === pending.requestId &&
      completion.bytes instanceof Uint8Array &&
      completion.bytes.byteLength <= PICO_HOST_REQUEST_MAX_BYTES &&
      typeof completion.isError === "boolean";
    const response = valid ? completion.bytes.slice() : new Uint8Array();
    const events = pending.resume(response, valid ? completion.isError : true);
    emitBackground(events);
  }

  function suspendHostRequest(
    command: PlayerRuntimeControlCommand,
    request: CartSessionHostRequest,
    resume: PendingRootHostRequest["resume"],
  ): readonly PlayerRuntimeToHost[] {
    if (hostRequestHandler === undefined) {
      return [unsupportedHostRequest(command)];
    }
    if (
      request.bytes.byteLength > PICO_HOST_REQUEST_MAX_BYTES ||
      pendingHostRequest !== undefined
    ) {
      return [fault(command, {
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
      workerGeneration,
      sessionGeneration,
      runtimeGeneration: request.generation,
      requestId: request.id,
      cancellation,
      resume,
    };
    pendingHostRequest = pending;
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
    return [state(command, "waiting-host")];
  }

  function unsupportedHostRequest(
    command: PlayerHostToRuntime,
  ): PlayerRuntimeToHost {
    session.stop();
    return fault(command, {
      code: "E_FEATURE_UNSUPPORTED",
      message: "cart host requests are not supported by the Phase 1E player",
      phase: "host-call",
      recoverable: false,
    });
  }

  function acceptBoot(
    command: PlayerRuntimeControlCommand,
    result: RuntimeResult<CartSessionBootResult>,
    continueRunning = false,
  ): readonly PlayerRuntimeToHost[] {
    let current = result;
    const events: PlayerRuntimeToHost[] = [];
    for (let restartCount = 0; restartCount <= 8; restartCount += 1) {
      if (!current.ok) return [...events, fault(command, current.error)];
      if (current.value.kind === "host-request") {
        const request = current.value.request;
        return [...events, ...suspendHostRequest(command, request, (response, isError) =>
          acceptBoot(
            command,
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
        resetAudioQueue(command.sessionGeneration);
        events.push(runtimeControlEvent(command, "stop", current.value.message));
        events.push(state(command, "stopped"));
        return events;
      }
      if (current.value.kind === "restart") {
        events.push(runtimeControlEvent(command, "run", current.value.parameter));
        if (restartCount === 8) {
          events.push(fault(command, {
            code: "E_VM_INSTRUCTION_BUDGET",
            message: "guest run restart limit exceeded in one host command",
            phase: "none",
            recoverable: false,
            details: { restartCount: restartCount + 1 },
          }));
          return events;
        }
        current = session.restart(current.value.parameter);
        continue;
      }
      beginAudioGeneration(command.sessionGeneration);
      sendAudio(current.value.audio);
      mode = current.value.mode;
      targetFps = current.value.targetFps;
      devkitFlags = current.value.devkitFlags;
      scheduler.configure(targetFps);
      if (continueRunning) {
        scheduler.start();
        lifecycle = "running";
        events.push(state(command, "running"));
        return events;
      }
      lifecycle = "ready";
      events.push(state(command, "ready"));
      return events;
    }
    return [...events, fault(command, invariant("unreachable guest restart loop"))];
  }

  function runtimeControlEvent(
    command: PlayerRuntimeControlCommand,
    control: "run" | "stop",
    payload: Uint8Array,
  ): PlayerRuntimeToHost {
    return {
      ...playerBase(command),
      type: "runtime-control",
      control,
      payload: payload.slice().buffer,
    };
  }

  function acceptInput(command: PlayerRuntimeInputCommand): void {
    if (
      command.workerGeneration !== workerGeneration ||
      command.sessionGeneration !== sessionGeneration ||
      command.sequence <= inputSequence ||
      lifecycle === "disposed" || lifecycle === "faulted"
    ) return;
    inputSequence = command.sequence;
    inputControllers = command.input.controllers.slice();
    const devkit = command.input.devkit;
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
    command: PlayerRuntimeControlCommand,
    result: Extract<CartSessionStepResult, { readonly kind: "frame" }>,
  ): PlayerRuntimeToHost {
    sendAudio(result.frame.audio);
    const packedScreen = result.frame.screen.slice().buffer;
    const displayPalette = result.frame.displayPalette.slice().buffer;
    devkitFlags = result.frame.devkitFlags;
    if (result.frame.cartDataCommit !== undefined) {
      enqueueCartDataCommit(result.frame.cartDataCommit);
    }
    return {
      ...playerBase(command),
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
    command: Extract<PlayerRuntimeControlCommand, { readonly type: "vsync" }>,
    tickCount: number,
    droppedTicks: number,
  ): PlayerRuntimeToHost {
    return {
      ...playerBase(command),
      type: "heartbeat",
      vsyncSequence: command.sequence,
      tickCount,
      droppedTicks,
    };
  }

  function acceptVsyncHostCompletion(
    command: Extract<PlayerRuntimeControlCommand, { readonly type: "vsync" }>,
    result: RuntimeResult<CartSessionStepResult>,
    executedBefore: number,
    droppedTicks: number,
  ): readonly PlayerRuntimeToHost[] {
    if (!result.ok) return [fault(command, result.error)];
    if (result.value.kind === "host-request") {
      const request = result.value.request;
      return suspendHostRequest(command, request, (response, isError) =>
        acceptVsyncHostCompletion(
          command,
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
    const events: PlayerRuntimeToHost[] = [];
    if (result.value.kind === "stopped") {
      if (result.value.cartDataCommit !== undefined) {
        enqueueCartDataCommit(result.value.cartDataCommit);
      }
      scheduler.pause();
      lifecycle = "stopped";
      clearInputState();
      devkitFlags = 0;
      resetAudioQueue(command.sessionGeneration);
      events.push(runtimeControlEvent(command, "stop", result.value.message));
      events.push(state(command, "stopped"));
    } else if (result.value.kind === "restart") {
      if (result.value.cartDataCommit !== undefined) {
        enqueueCartDataCommit(result.value.cartDataCommit);
      }
      clearInputState();
      events.push(runtimeControlEvent(command, "run", result.value.parameter));
      events.push(...acceptBoot(command, session.restart(result.value.parameter), true));
    } else {
      scheduler.resume();
      lifecycle = "running";
      events.push(frameEvent(command, result.value));
    }
    events.push(heartbeatEvent(command, executedTicks, droppedTicks));
    return events;
  }

  function handleVsync(
    command: Extract<PlayerRuntimeControlCommand, { readonly type: "vsync" }>,
  ): readonly PlayerRuntimeToHost[] {
    if (lifecycle !== "running") {
      return [heartbeatEvent(command, 0, 0)];
    }
    const decision = scheduler.pulse(command.timestampMs);
    const events: PlayerRuntimeToHost[] = [];
    if (decision.discontinuity) {
      events.push({
        ...playerBase(command),
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
        events.push(fault(command, result.error));
        return events;
      }
      if (result.value.kind === "host-request") {
        const request = result.value.request;
        return [...events, ...suspendHostRequest(command, request, (response, isError) =>
          acceptVsyncHostCompletion(
            command,
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
      if (result.value.kind === "stopped") {
        if (result.value.cartDataCommit !== undefined) {
          enqueueCartDataCommit(result.value.cartDataCommit);
        }
        scheduler.pause();
        lifecycle = "stopped";
        clearInputState();
        devkitFlags = 0;
        resetAudioQueue(command.sessionGeneration);
        events.push(runtimeControlEvent(command, "stop", result.value.message));
        events.push(state(command, "stopped"));
        break;
      }
      if (result.value.kind === "restart") {
        if (result.value.cartDataCommit !== undefined) {
          enqueueCartDataCommit(result.value.cartDataCommit);
        }
        clearInputState();
        events.push(runtimeControlEvent(command, "run", result.value.parameter));
        events.push(...acceptBoot(
          command,
          session.restart(result.value.parameter),
          true,
        ));
        break;
      }
      events.push(frameEvent(command, result.value));
    }
    events.push(heartbeatEvent(command, executedTicks, decision.droppedTicks));
    return events;
  }

  function generationFault(
    command: PlayerRuntimeControlCommand,
    message: string,
  ): readonly PlayerRuntimeToHost[] {
    return [{ ...playerBase(command), type: "fault", error: playerLifecycleError(message) }];
  }

  function handleSync(command: PlayerHostToRuntime): readonly PlayerRuntimeToHost[] {
    if (command.type === "input") {
      acceptInput(command);
      return [];
    }
    if (command.type === "flushPersistence") {
      if (workerGeneration === 0) workerGeneration = command.workerGeneration;
      return [];
    }
    if (workerGeneration === 0) workerGeneration = command.workerGeneration;
    if (command.workerGeneration !== workerGeneration) {
      return generationFault(command, "command belongs to another Worker generation");
    }
    if (command.type === "loadCart") {
      if (command.sessionGeneration <= sessionGeneration) {
        return generationFault(command, "loadCart requires a new session generation");
      }
      cancelPendingHostRequest();
      sessionGeneration = command.sessionGeneration;
      instructionBudget = command.instructionBudget;
      scheduler.reset();
      inputSequence = -1;
      clearInputState();
      devkitFlags = 0;
      try {
        const cart = decodeCart(new Uint8Array(command.cartBytes));
        cartRepository.registerCart(cart);
        return acceptBoot(command, session.load(cart));
      } catch (error) {
        if (session.cart !== undefined) session.stop();
        if (error instanceof CartCodecError) {
          return [fault(command, {
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
        return [fault(command, invariant(
          error instanceof Error ? error.message : String(error),
        ))];
      }
    }
    if (command.type === "dispose") {
      cancelPendingHostRequest();
      scheduler.reset();
      clearInputState();
      const result = session.dispose();
      cartRepository.dispose();
      lifecycle = "disposed";
      mode = "none";
      targetFps = 0;
      devkitFlags = 0;
      resetAudioQueue(command.sessionGeneration);
      return result.ok ? [state(command, "disposed")] : [fault(command, result.error)];
    }
    if (command.type === "reset") {
      if (lifecycle === "disposed" || command.sessionGeneration <= sessionGeneration) {
        return generationFault(command, "reset requires a new session generation");
      }
      cancelPendingHostRequest();
      sessionGeneration = command.sessionGeneration;
      scheduler.reset();
      inputSequence = -1;
      clearInputState();
      devkitFlags = 0;
      return acceptBoot(command, session.reset());
    }
    if (command.sessionGeneration !== sessionGeneration || sessionGeneration === 0) {
      return generationFault(command, "command belongs to a stale or missing session");
    }
    if (command.type === "vsync") return handleVsync(command);
    if (command.type === "start") {
      if (lifecycle !== "ready") {
        return generationFault(command, "start requires a ready session");
      }
      scheduler.start();
      lifecycle = "running";
      return [state(command, "running")];
    }
    if (command.type === "pause") {
      if (lifecycle !== "running" && lifecycle !== "paused") {
        return generationFault(command, "pause requires a running session");
      }
      scheduler.pause();
      lifecycle = "paused";
      clearInputState();
      return [state(command, "paused")];
    }
    if (command.type === "resume") {
      if (lifecycle !== "paused" && lifecycle !== "running") {
        return generationFault(command, "resume requires a paused session");
      }
      scheduler.resume();
      lifecycle = "running";
      return [state(command, "running")];
    }
    cancelPendingHostRequest();
    const stopped = session.stop();
    scheduler.reset();
    clearInputState();
    devkitFlags = 0;
    if (!stopped.ok) return [fault(command, stopped.error)];
    lifecycle = "stopped";
    resetAudioQueue(command.sessionGeneration);
    return [state(command, "stopped")];
  }

  function disposeSync(): void {
    cancelPendingHostRequest();
    scheduler.reset();
    clearInputState();
    devkitFlags = 0;
    session.dispose();
    cartRepository.dispose();
    lifecycle = "disposed";
    if (sessionGeneration > 0) resetAudioQueue(sessionGeneration);
  }

  function isValidGenerationReplacement(command: PlayerHostToRuntime): boolean {
    if (command.type !== "loadCart" && command.type !== "reset") return false;
    return (workerGeneration === 0 || command.workerGeneration === workerGeneration) &&
      command.sessionGeneration > sessionGeneration && lifecycle !== "disposed";
  }

  async function handlePersistent(
    command: PlayerHostToRuntime,
  ): Promise<readonly PlayerRuntimeToHost[]> {
    if (command.type === "flushPersistence") {
      if (workerGeneration === 0) workerGeneration = command.workerGeneration;
      if (command.workerGeneration !== workerGeneration) return [];
      await flushPersistence();
      return takePersistenceEvents(command);
    }
    if (isValidGenerationReplacement(command)) {
      await flushPersistence();
      await hydratePersistence();
    }
    const events = handleSync(command);
    const hasFault = events.some((event) => event.type === "fault");
    const hasGuestControl = events.some((event) => event.type === "runtime-control");
    if (command.type === "dispose") {
      try {
        await persistence!.dispose();
      } catch (error) {
        recordPersistenceFailure(
          "E_PERSISTENCE_WRITE",
          "Unable to dispose cartdata persistence cleanly",
          error,
        );
      }
    } else if (
      command.type === "pause" || command.type === "stop" || hasFault || hasGuestControl
    ) {
      await flushPersistence();
    }
    return [...takePersistenceEvents(command), ...events];
  }

  if (persistence === undefined) {
    return { handle: handleSync, setEventSink, dispose: disposeSync };
  }
  return {
    handle: handlePersistent,
    setEventSink,
    async dispose() {
      disposeSync();
      try {
        await persistence.dispose();
      } catch {
        // No host command exists to receive diagnostics during forced teardown.
      }
    },
  };
}
