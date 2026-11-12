import {
  isAudioPortAttachmentEnvelope,
  isPlayerHostToRuntime,
  type PlayerRuntimeToHost,
} from "../transport/public.js";
import type {
  PlayerWorkerController,
} from "./compose-runtime.js";
import type {
  RuntimeAudioMessagePort,
  PcmOutput,
} from "../runtime/audio-transport.js";

export interface RuntimeWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  postMessage(
    message: PlayerRuntimeToHost,
    transfer?: readonly ArrayBuffer[],
  ): void;
}

function postPlayerResponse(
  scope: RuntimeWorkerScope,
  response: PlayerRuntimeToHost,
): void {
  const transfer = response.type === "frame"
    ? [response.packedScreen, response.displayPalette]
    : response.type === "cartdata-commit"
      ? [response.bytes]
    : response.type === "runtime-control"
      ? [response.payload]
    : response.type === "session-replaced"
      ? [response.breadcrumb]
      : response.type === "pause-menu"
        ? response.items.map((item) => item.label)
      : [];
  scope.postMessage(response, transfer);
}

function isWorkerAudioPort(value: unknown): value is RuntimeAudioMessagePort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeAudioMessagePort>;
  return (
    typeof candidate.postMessage === "function" &&
    typeof candidate.close === "function"
  );
}

function attachAudioPort(
  value: unknown,
  audioTransport: PcmOutput,
): boolean {
  if (!isAudioPortAttachmentEnvelope(value)) return false;
  const port = (value as { readonly port?: unknown }).port;
  if (!isWorkerAudioPort(port)) return true;
  audioTransport.attach(port, value.sessionGeneration);
  return true;
}

/** Worker bootstrap with serialized command execution. */
export function installPlayerRuntimeWorker(
  scope: RuntimeWorkerScope,
  controller: Promise<PlayerWorkerController> | PlayerWorkerController,
  audioTransport?: PcmOutput,
): void {
  let queue = Promise.resolve();
  let activeController: PlayerWorkerController | undefined;
  let handlingCommand = false;
  const bufferedBackgroundEvents: PlayerRuntimeToHost[][] = [];
  const controllerPromise = Promise.resolve(controller);

  function postBackgroundEvents(responses: readonly PlayerRuntimeToHost[]): void {
    if (handlingCommand) {
      bufferedBackgroundEvents.push([...responses]);
      return;
    }
    for (const response of responses) postPlayerResponse(scope, response);
  }

  function flushBackgroundEvents(): void {
    for (const responses of bufferedBackgroundEvents.splice(0)) {
      for (const response of responses) postPlayerResponse(scope, response);
    }
  }

  async function getController(): Promise<PlayerWorkerController> {
    const active = activeController ?? await controllerPromise;
    if (activeController === undefined) {
      activeController = active;
      active.setEventSink(postBackgroundEvents);
    }
    return active;
  }

  scope.addEventListener("message", (event) => {
    if (audioTransport !== undefined && attachAudioPort(event.data, audioTransport)) return;
    if (!isPlayerHostToRuntime(event.data)) return;
    const command = event.data;
    queue = queue.then(async () => {
      try {
        const active = await getController();
        handlingCommand = true;
        const responses = await active.handle(command);
        for (const response of responses) postPlayerResponse(scope, response);
        handlingCommand = false;
        flushBackgroundEvents();
        if (
          command.type === "dispose" &&
          responses.some((response) => response.type === "state" && response.state === "disposed")
        ) {
          audioTransport?.dispose();
        }
      } catch (error) {
        handlingCommand = false;
        bufferedBackgroundEvents.length = 0;
        postPlayerResponse(scope, {
          v: 1,
          type: "fault",
          requestId: command.requestId,
          workerGeneration: command.workerGeneration,
          sessionGeneration: command.sessionGeneration,
          error: {
            code: "E_INVARIANT",
            message: `Runtime Worker bootstrap failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            phase: "none",
            recoverable: false,
          },
        });
      }
    });
  });
}
