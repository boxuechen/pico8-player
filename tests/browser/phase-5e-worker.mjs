import createZ8LuaModule from "/wasm/dist/z8lua-runtime-v1.mjs";
import { createPlayerWorkerController } from
  "../../apps/web-player/dist/worker/compose-runtime.js";
import { installPlayerRuntimeWorker } from
  "../../apps/web-player/dist/worker/runtime-worker.js";

const controller = (async () => {
  const wasmResponse = await fetch("/wasm/dist/z8lua-runtime-v1.wasm");
  if (!wasmResponse.ok) throw new Error(`WASM fetch failed: ${wasmResponse.status}`);
  const module = await createZ8LuaModule({ wasmBinary: await wasmResponse.arrayBuffer() });
  return createPlayerWorkerController(module);
})();

installPlayerRuntimeWorker(self, controller);
