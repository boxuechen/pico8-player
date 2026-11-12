import type { FrameRuntimeModule } from "@pico8-web/z8lua-bridge";
import type { PlayerHostToRuntime, PlayerRuntimeToHost } from "../transport/public.js";
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
