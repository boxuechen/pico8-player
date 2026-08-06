import createZ8LuaModule from "../../../../wasm/dist/z8lua-runtime-v1.mjs";
import {
  createPlayerWorkerController,
} from "./compose-runtime.ts";
import { WorkerPcmTransport } from "./audio-transport.ts";
import { IndexedDbCartDataPersistenceAdapter } from "./adapters/indexeddb-persistence-adapter.ts";
import { installPlayerRuntimeWorker } from "./runtime-worker.ts";

const audioTransport = new WorkerPcmTransport();
const persistence = new IndexedDbCartDataPersistenceAdapter();
const heapLimitText = new URL(import.meta.url).searchParams.get("luaHeapLimit");
const luaHeapLimit = heapLimitText === null ? undefined : Number(heapLimitText);
const controller = (async () => {
  const wasmUrl = new URL(
    "../../../../wasm/dist/z8lua-runtime-v1.wasm",
    import.meta.url,
  );
  const wasmResponse = await fetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(`Unable to load z8lua WASM: HTTP ${wasmResponse.status}`);
  }
  const wasmBinary = await wasmResponse.arrayBuffer();
  const module = await createZ8LuaModule({ wasmBinary });
  return createPlayerWorkerController(module, {
    audioTransport,
    persistence,
    ...(luaHeapLimit === undefined ? {} : { luaHeapLimit }),
  });
})();

installPlayerRuntimeWorker(self, controller, audioTransport);
