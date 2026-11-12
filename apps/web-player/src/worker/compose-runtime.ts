import type { FrameRuntimeModule } from "@pico8-web/z8lua-bridge";
import type { PlayerHostToRuntime, PlayerRuntimeToHost, SessionEvent } from "../transport/public.js";
import { createSessionController, type SessionBatch, type SessionContext, type SessionControllerOptions } from "../runtime/compose-session.js";

export type PlayerWorkerControllerOptions = SessionControllerOptions;
export interface PlayerWorkerController {
  handle(command: PlayerHostToRuntime): readonly PlayerRuntimeToHost[] | Promise<readonly PlayerRuntimeToHost[]>;
  setEventSink(sink: PlayerWorkerEventSink): void;
  dispose(): void | Promise<void>;
}
export type PlayerWorkerEventSink = (events: readonly PlayerRuntimeToHost[]) => void;

/** All message dispatch and wire correlation live at the Worker boundary. */
export function createPlayerWorkerController(module: FrameRuntimeModule, options: PlayerWorkerControllerOptions = {}): PlayerWorkerController {
  const session = createSessionController(module, options);
  let generation: number | undefined;
  let eventSink: PlayerWorkerEventSink | undefined;

  function dispatch(command: PlayerHostToRuntime, context: SessionContext): SessionBatch {
    switch (command.type) {
      case "input":
        session.input(command.sessionGeneration, command.sequence, command.input);
        return [];
      case "loadCart": return session.loadCart(context, {
        source: new Uint8Array(command.cartBytes),
        ...(command.instructionBudget === undefined ? {} : { instructionBudget: command.instructionBudget }),
        ...(command.localCartBundle === undefined ? {} : { localCartBundle: command.localCartBundle.map(entry => ({
          ref: entry.ref, bytes: new Uint8Array(entry.cartBytes), access: entry.access,
        })) }),
        ...(command.hostCartData === undefined ? {} : { hostCartData: command.hostCartData.map(entry => ({
          id: entry.id, bytes: new Uint8Array(entry.bytes),
        })) }),
      });
      case "step": return session.step(context, command.sequence);
      case "vsync": return session.pulse(context, command.sequence, command.timestampMs);
      case "invokeMenuItem": return session.invokeMenuItem(context, command.slot, command.button);
      default: return session[command.type](context);
    }
  }

  return {
    handle(command) {
      generation ??= command.workerGeneration;
      if (command.workerGeneration !== generation) {
        if (command.type === "input" || command.type === "flushPersistence") return [];
        return [{ v: 1, requestId: command.requestId, workerGeneration: command.workerGeneration,
          sessionGeneration: command.sessionGeneration, type: "fault",
          error: { code: "E_INVALID_STATE", message: "command belongs to another Worker generation", phase: "none", recoverable: false } }];
      }
      const wrap = (events: readonly SessionEvent[]): readonly PlayerRuntimeToHost[] =>
        events.map(event => ({ ...event, v: 1, workerGeneration: command.workerGeneration, requestId: command.requestId }));
      const result = dispatch(command, {
        sessionGeneration: command.sessionGeneration,
        onResume(events) {
          if (eventSink === undefined) throw new Error("Worker background event sink is not installed");
          eventSink(wrap(events));
        },
      });
      return result instanceof Promise ? result.then(wrap) : wrap(result);
    },
    setEventSink(sink) {
      if (typeof sink !== "function") throw new TypeError("Worker event sink must be a function");
      if (eventSink !== undefined && eventSink !== sink) throw new Error("Worker event sink is already installed");
      eventSink = sink;
    },
    dispose() { return session.destroy(); },
  };
}
