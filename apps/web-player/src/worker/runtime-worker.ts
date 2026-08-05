import {
  isPhase0EHostToRuntime,
  type Phase0ERuntimeToHost,
} from "../transport/public.js";
import type { Phase0EWorkerController } from "./compose-runtime.js";

export interface RuntimeWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  postMessage(message: Phase0ERuntimeToHost, transfer?: readonly ArrayBuffer[]): void;
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

export { createPhase0EWorkerController } from "./compose-runtime.js";
