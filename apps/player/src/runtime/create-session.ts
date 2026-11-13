import { PlayerSession } from "./player-session.js";
import { IndexedDbCartDataPersistenceAdapter } from "./adapters/indexeddb-persistence-adapter.js";
/** Each session owns a fresh WASM instance. Loader stays adjacent to its locked .wasm. */
export async function createPlayerSession(persistent = true, inspection = false): Promise<PlayerSession> {
  const { default: createModule } = await import("../../../../wasm/dist/z8lua-runtime-v1.mjs");
  const module = await createModule();
  return new PlayerSession(module, { inspection, ...(persistent ? { persistence: new IndexedDbCartDataPersistenceAdapter() } : {}) });
}
