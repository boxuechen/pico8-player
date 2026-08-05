import {
  isAudioPortAttachmentEnvelope,
  isPlayerHostToRuntime,
  isPhase0EHostToRuntime,
  type PlayerRuntimeToHost,
  type Phase0ERuntimeToHost,
} from "../transport/public.js";
import type {
  Phase0EWorkerController,
  PlayerWorkerController,
} from "./compose-runtime.js";
import type {
  WorkerAudioMessagePort,
  WorkerPcmTransport,
} from "./audio-transport.js";

export interface RuntimeWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  postMessage(
    message: Phase0ERuntimeToHost | PlayerRuntimeToHost,
    transfer?: readonly ArrayBuffer[],
  ): void;
}

function postPlayerResponse(
  scope: RuntimeWorkerScope,
  response: PlayerRuntimeToHost,
): void {
  const transfer = response.type === "frame" ? [response.packedScreen] : [];
  scope.postMessage(response, transfer);
}

function isWorkerAudioPort(value: unknown): value is WorkerAudioMessagePort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkerAudioMessagePort>;
  return (
    typeof candidate.postMessage === "function" &&
    typeof candidate.close === "function"
  );
}

function attachAudioPort(
  value: unknown,
  audioTransport: WorkerPcmTransport,
): boolean {
  if (!isAudioPortAttachmentEnvelope(value)) return false;
  const port = (value as { readonly port?: unknown }).port;
  if (!isWorkerAudioPort(port)) return true;
  audioTransport.attach(port, value.sessionGeneration);
  return true;
}

function postResponse(
  scope: RuntimeWorkerScope,
  response: Phase0ERuntimeToHost,
): void {
  const transfer =
    response.type === "frame"
      ? [response.packedScreen]
      : response.type === "hostRequest"
        ? [response.bytes]
        : [];
  scope.postMessage(response, transfer);
}

export function installPhase0ERuntimeWorker(
  scope: RuntimeWorkerScope,
  controller: Phase0EWorkerController,
): void {
  scope.addEventListener("message", (event) => {
    if (!isPhase0EHostToRuntime(event.data)) return;
    postResponse(scope, controller.handle(event.data));
  });
}

/**
 * Registers the message listener before async WASM startup. Commands are then
 * serialized through the eventual controller, so the first load cannot race
 * module instantiation and disappear.
 */
export function installPhase0EAsyncRuntimeWorker(
  scope: RuntimeWorkerScope,
  controller: Promise<Phase0EWorkerController>,
): void {
  let queue = Promise.resolve();
  scope.addEventListener("message", (event) => {
    if (!isPhase0EHostToRuntime(event.data)) return;
    const command = event.data;
    queue = queue.then(async () => {
      postResponse(scope, (await controller).handle(command));
    });
  });
}

export function installPhase0FAsyncRuntimeWorker(
  scope: RuntimeWorkerScope,
  controller: Promise<Phase0EWorkerController>,
  audioTransport: WorkerPcmTransport,
): void {
  let queue = Promise.resolve();
  scope.addEventListener("message", (event) => {
    if (attachAudioPort(event.data, audioTransport)) return;
    if (!isPhase0EHostToRuntime(event.data)) return;
    const command = event.data;
    queue = queue.then(async () => {
      const response = (await controller).handle(command);
      postResponse(scope, response);
      if (response.type === "disposed") audioTransport.dispose();
    });
  });
}

/** Production Phase 1E Worker bootstrap with serialized command execution. */
export function installPlayerRuntimeWorker(
  scope: RuntimeWorkerScope,
  controller: Promise<PlayerWorkerController> | PlayerWorkerController,
  audioTransport?: WorkerPcmTransport,
): void {
  let queue = Promise.resolve();
  scope.addEventListener("message", (event) => {
    if (audioTransport !== undefined && attachAudioPort(event.data, audioTransport)) return;
    if (!isPlayerHostToRuntime(event.data)) return;
    const command = event.data;
    queue = queue.then(async () => {
      try {
        const active = await controller;
        const responses = active.handle(command);
        for (const response of responses) postPlayerResponse(scope, response);
        if (
          command.type === "dispose" &&
          responses.some((response) => response.type === "state" && response.state === "disposed")
        ) {
          audioTransport?.dispose();
        }
      } catch (error) {
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
