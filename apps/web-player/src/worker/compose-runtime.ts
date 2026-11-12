import { CartCodecError, decodeP8Png } from "@pico8-web/cart-codec";
import type { SerializedRuntimeError } from "@pico8-web/contracts";
import { FrameSliceRuntime, type RuntimeResult, type RuntimeBootResult, type RuntimeStepResult } from "@pico8-web/runtime-core";
import { createPicoApiHostRouter, Z8LuaFrameVm, type FrameRuntimeModule } from "@pico8-web/z8lua-bridge";
import type { Phase0EHostToRuntime, Phase0ERuntimeToHost, PlayerHostToRuntime, PlayerRuntimeToHost } from "../transport/public.js";

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


import { createSessionController } from "../runtime/compose-session.js";
import type { SessionControllerOptions } from "../runtime/compose-session.js";
export type PlayerWorkerControllerOptions = SessionControllerOptions;
export interface PlayerWorkerController {
  handle(command: PlayerHostToRuntime): readonly PlayerRuntimeToHost[] | Promise<readonly PlayerRuntimeToHost[]>;
  setEventSink(sink: PlayerWorkerEventSink): void;
  dispose(): void | Promise<void>;
}
export type PlayerWorkerEventSink = (events: readonly PlayerRuntimeToHost[]) => void;
export function createPlayerWorkerController(module: FrameRuntimeModule, options: PlayerWorkerControllerOptions = {}): PlayerWorkerController {
  const session = createSessionController(module, options);
  let generation: number | undefined;
  const wrap = (events: readonly import("../transport/public.js").SessionEvent[]): readonly PlayerRuntimeToHost[] =>
    events.map(event => ({ ...event, v: 1, workerGeneration: generation! }));
  return {
    handle(command) {
      generation ??= command.workerGeneration;
      if (command.workerGeneration !== generation) {
        if (command.type === "input" || command.type === "flushPersistence") return [];
        return [{ v: 1, requestId: command.requestId, workerGeneration: command.workerGeneration,
          sessionGeneration: command.sessionGeneration, type: "fault",
          error: { code: "E_INVALID_STATE", message: "command belongs to another Worker generation", phase: "none", recoverable: false } }];
      }
      const { v: _version, workerGeneration: _worker, ...action } = command;
      const result = session.handle(action);
      return result instanceof Promise ? result.then(wrap) : wrap(result);
    },
    setEventSink(sink) { session.setEventSink(events => sink(wrap(events))); },
    dispose() { return session.dispose(); },
  };
}
