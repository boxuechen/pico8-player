import createZ8LuaModule from "../../../../wasm/dist/z8lua-runtime-v1.mjs";
import {
  createPlayerWorkerController,
} from "./compose-runtime.ts";
import { PcmOutput } from "../runtime/audio-transport.ts";
import { IndexedDbCartDataPersistenceAdapter } from "../runtime/adapters/indexeddb-persistence-adapter.ts";
import { installPlayerRuntimeWorker } from "./runtime-worker.ts";

const audioTransport = new PcmOutput();
const persistence = new IndexedDbCartDataPersistenceAdapter();
const heapLimitText = new URL(import.meta.url).searchParams.get("luaHeapLimit");
const luaHeapLimit = heapLimitText === null ? undefined : Number(heapLimitText);
const controller = (async () => {
  // Emscripten owns streaming instantiation and its ArrayBuffer fallback. The
  // runtime loader and .wasm remain adjacent in both workspace and release layouts.
  const module = await createZ8LuaModule();
  return createPlayerWorkerController(module, {
    audioTransport,
    persistence,
    ...(luaHeapLimit === undefined ? {} : { luaHeapLimit }),
  });
})();

installPlayerRuntimeWorker(self, controller, audioTransport);
