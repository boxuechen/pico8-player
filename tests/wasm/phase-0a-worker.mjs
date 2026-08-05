import { parentPort } from "node:worker_threads";

import createZ8LuaPhase0CModule from "../../wasm/dist/z8lua-phase-0c.mjs";

const module = await createZ8LuaPhase0CModule();
parentPort.postMessage({
  abiVersion: module._p8w0a_abi_version(),
  memoryBytes: module.HEAPU8.byteLength,
});
parentPort.close();
