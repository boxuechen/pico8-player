import createZ8LuaModule from "/wasm/dist/z8lua-runtime-v1.mjs";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import {
  installPlayerRuntimeWorker,
} from "../../apps/web-player/dist/worker/runtime-worker.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const hostRequestHandler = {
  async handle(request, cancellation) {
    const payload = decoder.decode(request.bytes);
    await delay(payload === "slow" ? 100 : 5);
    if (cancellation.cancelled) {
      self.postMessage({ type: "phase5c-handler-cancelled", requestId: request.requestId });
      throw new Error("cancelled");
    }
    const response = payload === "boot"
      ? "four"
      : payload === "step"
        ? "tri"
        : "ok";
    return {
      generation: request.generation,
      requestId: request.requestId,
      bytes: encoder.encode(response),
      isError: false,
    };
  },
};

const controller = (async () => {
  const wasmResponse = await fetch("/wasm/dist/z8lua-runtime-v1.wasm");
  if (!wasmResponse.ok) throw new Error(`WASM fetch failed: ${wasmResponse.status}`);
  const module = await createZ8LuaModule({ wasmBinary: await wasmResponse.arrayBuffer() });
  return createPlayerWorkerController(module, { hostRequestHandler });
})();

installPlayerRuntimeWorker(self, controller);
