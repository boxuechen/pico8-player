import { parentPort } from "node:worker_threads";

import createZ8LuaPhase0AModule from "../../wasm/dist/z8lua-phase-0a.mjs";

const module = await createZ8LuaPhase0AModule();
parentPort.postMessage({
  abiVersion: module._p8w0a_abi_version(),
  memoryBytes: module.HEAPU8.byteLength,
});
parentPort.close();
