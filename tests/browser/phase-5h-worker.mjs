import createZ8LuaModule from "/wasm/dist/z8lua-runtime-v1.mjs";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import {
  installPlayerRuntimeWorker,
} from "../../apps/web-player/dist/worker/runtime-worker.js";
import { WorkerPcmTransport } from
  "../../apps/web-player/dist/worker/audio-transport.js";
import { IndexedDbCartDataPersistenceAdapter } from
  "../../apps/web-player/dist/worker/adapters/indexeddb-persistence-adapter.js";

const audioTransport = new WorkerPcmTransport();
const persistence = new IndexedDbCartDataPersistenceAdapter();
const modulePromise = (async () => {
  const wasmResponse = await fetch("/wasm/dist/z8lua-runtime-v1.wasm");
  if (!wasmResponse.ok) throw new Error(`WASM fetch failed: ${wasmResponse.status}`);
  return createZ8LuaModule({ wasmBinary: await wasmResponse.arrayBuffer() });
})();
const controller = modulePromise.then((module) => createPlayerWorkerController(module, {
  audioTransport,
  persistence,
  hostRequestHandler: {
    handle() {
      return new Promise((resolve) => {
        setTimeout(() => resolve(new Uint8Array()), 100);
      });
    },
  },
}));

self.addEventListener("message", (event) => {
  if (event.data?.type !== "phase5h-resource-probe") return;
  void modulePromise.then((module) => self.postMessage({
    type: "phase5h-resource-probe",
    probeId: event.data.probeId,
    liveContexts: module._p8w_live_contexts(),
    wasmBytes: module.HEAPU8.buffer.byteLength,
  }));
});

installPlayerRuntimeWorker(self, controller, audioTransport);
