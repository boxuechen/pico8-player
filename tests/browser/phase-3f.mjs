import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";

const DATABASE_NAME = "pico8-web-player";
const STORE_NAME = "cartdata";
const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");
const workerErrors = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

async function deleteDatabase() {
  await requestResult(indexedDB.deleteDatabase(DATABASE_NAME));
}

async function openDatabase(version = 1, upgrade) {
  const request = indexedDB.open(DATABASE_NAME, version);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      const store = database.createObjectStore(STORE_NAME, {
        keyPath: ["namespace", "id"],
      });
      store.createIndex("namespace", "namespace", { unique: false });
    }
    upgrade?.(database, request.transaction);
  });
  return requestResult(request);
}

async function putRecords(records) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const record of records) store.put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function readRecords() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const records = await requestResult(transaction.objectStore(STORE_NAME).getAll());
    await transactionDone(transaction);
    return records;
  } finally {
    database.close();
  }
}

async function dropStoreWithFutureDatabaseVersion() {
  const database = await openDatabase(2, (upgraded) => {
    if (upgraded.objectStoreNames.contains(STORE_NAME)) {
      upgraded.deleteObjectStore(STORE_NAME);
    }
  });
  database.close();
}

function workerFactory() {
  const worker = new Worker(
    "/apps/web-player/dist/browser/player-worker.mjs",
    { type: "module" },
  );
  worker.addEventListener("error", (event) => {
    workerErrors.push(`${event.message} @ ${event.filename}:${event.lineno}`);
  });
  return worker;
}

async function mount() {
  return mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory: workerFactory,
    commandTimeoutMs: 5000,
  });
}

function cartSource(id, suffix) {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
loaded=false
function _init()
 loaded=cartdata("${id}")
 if not loaded then
  for i=0,255 do poke(0x5e00+i,(i*37+11)%256) end
 end
end
function _update60()
 if btn(4) then poke(0x5eff,0xa5) end
end
function _draw()
 cls(1)
 pset(loaded and 10 or 5,0,7)
 pset(peek(0x5e00)%128,1,7)
 pset(peek(0x5eff)%128,2,7)
end
--${suffix}
`);
}

function expectedFreshBytes() {
  return Uint8Array.from({ length: 256 }, (_, index) => (index * 37 + 11) & 0xff);
}

function whitePixelX(canvas, y) {
  const pixels = canvas.getContext("2d").getImageData(0, y, 128, 1).data;
  for (let x = 0; x < 128; x += 1) {
    const offset = x * 4;
    if (
      pixels[offset] === 0xff && pixels[offset + 1] === 0xf1 &&
      pixels[offset + 2] === 0xe8 && pixels[offset + 3] === 0xff
    ) return x;
  }
  return -1;
}

async function waitFrames(composition, count) {
  const target = composition.presenter.lastFrameId + count;
  await waitFor(
    () => composition.presenter.lastFrameId >= target,
    `rAF did not advance ${count} frames`,
  );
}

function key(type, code) {
  window.dispatchEvent(new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
  }));
}

async function run() {
  document.body.dataset.progress = "fresh database round-trip";
  await deleteDatabase();
  const first = await mount();
  await first.controller.loadCart(cartSource("shared_slot", "cart-a"), "phase-3f-a.p8");
  await first.controller.start();
  await waitFrames(first.composition, 2);
  const firstHit = whitePixelX(first.elements.canvas, 0);
  await first.controller.pause();
  const fresh = (await readRecords()).find(({ id }) => id === "shared_slot");
  check(fresh !== undefined, "pause did not durably write the fresh record");
  const freshBytes = new Uint8Array(fresh.bytes);
  check(fresh.schemaVersion === 1, "fresh record did not use schema 1");
  check(
    JSON.stringify([...freshBytes]) === JSON.stringify([...expectedFreshBytes()]),
    "fresh record did not preserve all 256 bytes",
  );

  document.body.dataset.progress = "pagehide flush";
  await first.controller.resume();
  key("keydown", "KeyZ");
  await waitFrames(first.composition, 2);
  key("keyup", "KeyZ");
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(async () => {
    const record = (await readRecords()).find(({ id }) => id === "shared_slot");
    return record !== undefined && new Uint8Array(record.bytes)[255] === 0xa5;
  }, "pagehide did not flush the latest committed snapshot");
  await first.controller.dispose();

  document.body.dataset.progress = "different-cart restart and reset";
  const second = await mount();
  await second.controller.loadCart(cartSource("shared_slot", "different-cart-hash"), "phase-3f-b.p8");
  await second.controller.start();
  await waitFrames(second.composition, 2);
  const restartHit = whitePixelX(second.elements.canvas, 0);
  const restartLastByte = whitePixelX(second.elements.canvas, 2);
  await second.controller.reset();
  await second.controller.start();
  await waitFrames(second.composition, 2);
  const resetHit = whitePixelX(second.elements.canvas, 0);
  await second.controller.dispose();

  document.body.dataset.progress = "legacy migration and malformed records";
  await deleteDatabase();
  const legacyBytes = new Uint8Array(256);
  legacyBytes[0] = 23;
  legacyBytes[255] = 41;
  await putRecords([
    { namespace: "default", id: "legacy_slot", bytes: legacyBytes.buffer },
    {
      schemaVersion: 2,
      namespace: "default",
      id: "future_slot",
      bytes: new Uint8Array(256).buffer,
    },
    {
      schemaVersion: 1,
      namespace: "default",
      id: "corrupt_slot",
      bytes: new Uint8Array(12).buffer,
    },
  ]);
  const third = await mount();
  const migrationDiagnostics = [];
  const removeMigrationListener = third.composition.runtime.onEvent((event) => {
    if (event.type === "diagnostic") migrationDiagnostics.push(event.error);
  });
  await third.controller.loadCart(cartSource("legacy_slot", "migration"), "phase-3f-legacy.p8");
  await third.controller.start();
  await waitFrames(third.composition, 2);
  const legacyHit = whitePixelX(third.elements.canvas, 0);
  const legacyFirstByte = whitePixelX(third.elements.canvas, 1);
  await third.controller.reset();
  const migrated = (await readRecords()).find(({ id }) => id === "legacy_slot");
  removeMigrationListener();
  await third.controller.dispose();

  document.body.dataset.progress = "record bound and durable write failure";
  await deleteDatabase();
  const boundedRecords = Array.from({ length: 4097 }, (_, index) => ({
    schemaVersion: 1,
    namespace: "default",
    id: `r_${index}`,
    bytes: new Uint8Array(256).buffer,
  }));
  await putRecords(boundedRecords);
  const fourth = await mount();
  const boundDiagnostics = [];
  const removeBoundListener = fourth.composition.runtime.onEvent((event) => {
    if (event.type === "diagnostic") boundDiagnostics.push(event.error);
  });
  await fourth.controller.loadCart(cartSource("r_0", "bounded"), "phase-3f-bounded.p8");
  await fourth.controller.start();
  await waitFrames(fourth.composition, 2);
  const boundedHit = whitePixelX(fourth.elements.canvas, 0);
  await dropStoreWithFutureDatabaseVersion();
  key("keydown", "KeyZ");
  await waitFrames(fourth.composition, 2);
  key("keyup", "KeyZ");
  await fourth.controller.pause();
  const failureState = fourth.controller.state;
  removeBoundListener();
  await fourth.controller.dispose();

  check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);
  return {
    phase: "3F",
    firstHit,
    freshSchema: fresh.schemaVersion,
    freshBytes: freshBytes.length,
    pagehideLastByte: 0xa5,
    restartHit,
    restartLastByte,
    resetHit,
    legacyHit,
    legacyFirstByte,
    migratedSchema: migrated?.schemaVersion ?? null,
    migrationReadDiagnostics: migrationDiagnostics.filter(
      ({ code }) => code === "E_PERSISTENCE_READ",
    ).length,
    boundedHit,
    boundReadDiagnostic: boundDiagnostics.some(
      ({ code, message }) => code === "E_PERSISTENCE_READ" && message.includes("4096"),
    ),
    writeFailureDiagnostic: boundDiagnostics.some(
      ({ code }) => code === "E_PERSISTENCE_WRITE",
    ),
    failureState,
    workerErrors,
    userAgent: navigator.userAgent,
  };
}

try {
  const result = await run();
  resultNode.textContent = JSON.stringify(result);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
