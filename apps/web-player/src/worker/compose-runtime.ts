import { CartCodecError, decodeCart, decodeP8Png } from "@pico8-web/cart-codec";
import type { SerializedRuntimeError } from "@pico8-web/contracts";
import {
  CartSession,
  type CanonicalAudioSlice,
  FrameScheduler,
  FrameSliceRuntime,
  type CartSessionBootResult,
  type CartSessionStepResult,
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
  handle(command: PlayerHostToRuntime): readonly PlayerRuntimeToHost[];
  dispose(): void;
}

export interface PlayerWorkerControllerOptions {
  readonly audioTransport?: WorkerPcmTransport;
}

type PlayerWorkerLifecycle =
  | "empty"
  | "ready"
  | "running"
  | "paused"
  | "stopped"
  | "faulted"
  | "disposed";

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
  let audioSequence = 0;
  let nextAudioSample = 0n;
  let instructionBudget: number | undefined;
  const scheduler = new FrameScheduler({ maximumCatchUpTicks: 5 });
  const session = new CartSession({
    createRuntime() {
      const router = createPicoApiHostRouter(module);
      const vm = new Z8LuaFrameVm(module, router);
      try {
        return new FrameSliceRuntime(vm, {
          ...(instructionBudget === undefined ? {} : { instructionBudget }),
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
  let inputButtons = 0;
  let mode: "none" | "callback" | "custom" = "none";
  let targetFps: 0 | 30 | 60 = 0;

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

  function fault(
    command: PlayerHostToRuntime,
    error: SerializedRuntimeError,
  ): PlayerRuntimeToHost {
    lifecycle = "faulted";
    scheduler.pause();
    inputButtons = 0;
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
    };
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
  ): PlayerRuntimeToHost {
    if (!result.ok) return fault(command, result.error);
    if (result.value.kind === "host-request") {
      return unsupportedHostRequest(command);
    }
    beginAudioGeneration(command.sessionGeneration);
    sendAudio(result.value.audio);
    mode = result.value.mode;
    targetFps = result.value.targetFps;
    scheduler.configure(targetFps);
    lifecycle = "ready";
    return state(command, "ready");
  }

  function acceptInput(command: PlayerRuntimeInputCommand): void {
    if (
      command.workerGeneration !== workerGeneration ||
      command.sessionGeneration !== sessionGeneration ||
      command.sequence <= inputSequence ||
      lifecycle === "disposed" || lifecycle === "faulted"
    ) return;
    inputSequence = command.sequence;
    inputButtons = command.input.buttons;
  }

  function frameEvent(
    command: PlayerRuntimeControlCommand,
    result: Extract<CartSessionStepResult, { readonly kind: "frame" }>,
  ): PlayerRuntimeToHost {
    sendAudio(result.frame.audio);
    const packedScreen = result.frame.screen.slice().buffer;
    const displayPalette = result.frame.displayPalette.slice().buffer;
    return {
      ...playerBase(command),
      type: "frame",
      frameId: result.frame.frameId,
      completedSlices: result.frame.completedSlices,
      timeRawBeforeStep: result.frame.timeRawBeforeStep,
      targetFps: result.frame.targetFps,
      packedScreen,
      displayPalette,
    };
  }

  function handleVsync(
    command: Extract<PlayerRuntimeControlCommand, { readonly type: "vsync" }>,
  ): readonly PlayerRuntimeToHost[] {
    if (lifecycle !== "running") {
      return [{
        ...playerBase(command),
        type: "heartbeat",
        vsyncSequence: command.sequence,
        tickCount: 0,
        droppedTicks: 0,
      }];
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
      const result = session.step({ buttons: inputButtons });
      if (!result.ok) {
        events.push(fault(command, result.error));
        return events;
      }
      if (result.value.kind === "host-request") {
        events.push(unsupportedHostRequest(command));
        return events;
      }
      executedTicks += 1;
      if (result.value.kind === "stopped") {
        scheduler.pause();
        lifecycle = "stopped";
        inputButtons = 0;
        events.push(state(command, "stopped"));
        break;
      }
      events.push(frameEvent(command, result.value));
    }
    events.push({
      ...playerBase(command),
      type: "heartbeat",
      vsyncSequence: command.sequence,
      tickCount: executedTicks,
      droppedTicks: decision.droppedTicks,
    });
    return events;
  }

  function generationFault(
    command: PlayerRuntimeControlCommand,
    message: string,
  ): readonly PlayerRuntimeToHost[] {
    return [{ ...playerBase(command), type: "fault", error: playerLifecycleError(message) }];
  }

  return {
    handle(command) {
      if (command.type === "input") {
        acceptInput(command);
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
        sessionGeneration = command.sessionGeneration;
        instructionBudget = command.instructionBudget;
        scheduler.reset();
        inputSequence = -1;
        inputButtons = 0;
        try {
          return [acceptBoot(command, session.load(decodeCart(new Uint8Array(command.cartBytes))))];
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
        scheduler.reset();
        inputButtons = 0;
        const result = session.dispose();
        lifecycle = "disposed";
        mode = "none";
        targetFps = 0;
        resetAudioQueue(command.sessionGeneration);
        return result.ok ? [state(command, "disposed")] : [fault(command, result.error)];
      }
      if (command.type === "reset") {
        if (lifecycle === "disposed" || command.sessionGeneration <= sessionGeneration) {
          return generationFault(command, "reset requires a new session generation");
        }
        sessionGeneration = command.sessionGeneration;
        scheduler.reset();
        inputSequence = -1;
        inputButtons = 0;
        return [acceptBoot(command, session.reset())];
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
        inputButtons = 0;
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
      const stopped = session.stop();
      scheduler.reset();
      inputButtons = 0;
      if (!stopped.ok) return [fault(command, stopped.error)];
      lifecycle = "stopped";
      resetAudioQueue(command.sessionGeneration);
      return [state(command, "stopped")];
    },
    dispose() {
      scheduler.reset();
      inputButtons = 0;
      session.dispose();
      lifecycle = "disposed";
      if (sessionGeneration > 0) resetAudioQueue(sessionGeneration);
    },
  };
}
