import {
  PlayerRuntimeClient,
} from "../../apps/web-player/dist/main/player-runtime-client.js";

const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function cart(lua) {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
${lua}
`);
}

function waitFor(predicate, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (predicate()) {
        resolve();
      } else if (performance.now() - started > timeoutMs) {
        reject(new Error(message));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

async function run() {
  const rawMessages = [];
  let workerErrors = [];
  globalThis.__phase5cDebug = { rawMessages, workerErrors };
  const workers = [];
  const runtime = new PlayerRuntimeClient(() => {
    const worker = new Worker(
      "/apps/web-player/dist/browser/phase-5c-worker.mjs",
      { type: "module" },
    );
    workers.push(worker);
    worker.addEventListener("message", (event) => rawMessages.push(event.data));
    worker.addEventListener("error", (event) => workerErrors.push({
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: String(event.error),
    }));
    return worker;
  }, { commandTimeoutMs: 2000 });
  const events = [];
  runtime.onEvent((event) => {
    events.push({
      type: event.type,
      sessionGeneration: event.sessionGeneration,
      ...(event.type === "state" ? { state: event.state } : {}),
      ...(event.type === "frame"
        ? { frameId: event.frameId, packed0: new Uint8Array(event.packedScreen)[0] }
        : {}),
    });
  });

  const recoverable = cart(`
function _init()
 local response=__p8w_probe_host_request("boot")
 poke(0x5000,#response)
end
n=0
function _update()
 n+=1
 if n==1 then
  local response=__p8w_probe_host_request("step")
  poke(0x5001,#response)
 end
end
function _draw()
 cls(0)
 pset(0,0,peek(0x5000))
 pset(1,0,peek(0x5001))
end`);

  document.body.dataset.progress = "root boot request";
  const loaded = await runtime.loadCart(recoverable);
  check(loaded.type === "state" && loaded.state === "ready", "boot request did not recover");
  await runtime.start();
  await runtime.pulse(0, {
    controllers: [0, 0, 0, 0, 0, 0, 0, 0],
    devkit: {
      mouseXRaw: 0, mouseYRaw: 0, mouseButtons: 0, wheelRaw: 0,
      movementXRaw: 0, movementYRaw: 0, keypresses: [],
    },
  });
  document.body.dataset.progress = "root step request";
  await runtime.pulse(34, {
    controllers: [0, 0, 0, 0, 0, 0, 0, 0],
    devkit: {
      mouseXRaw: 0, mouseYRaw: 0, mouseButtons: 0, wheelRaw: 0,
      movementXRaw: 0, movementYRaw: 0, keypresses: [],
    },
  });
  const recoveredFrame = events.find((event) => event.type === "frame");
  check(recoveredFrame?.packed0 === 0x34, `unexpected recovered pixel byte: ${recoveredFrame?.packed0}`);
  const waitingStates = events.filter((event) => event.state === "waiting-host").length;
  check(waitingStates >= 2, "boot/step waiting-host states were not observable");

  document.body.dataset.progress = "stale cancellation";
  const slowCart = cart(`
function _init() __p8w_probe_host_request("slow") end
function _update() end
function _draw() end`);
  const slowLoad = runtime.loadCart(slowCart).then(
    () => "resolved",
    (error) => error?.record?.code ?? "rejected",
  );
  await waitFor(
    () => events.some((event) => event.sessionGeneration === 2 && event.state === "waiting-host"),
    "slow request did not enter waiting-host",
  );
  const oldMessageCount = rawMessages.filter((message) => message.sessionGeneration === 2).length;
  const replacement = cart(`
function _update() end
function _draw() cls(2) end`);
  const replacementResult = await runtime.loadCart(replacement);
  check(replacementResult.type === "state" && replacementResult.state === "ready", "replacement did not load");
  check(await slowLoad === "E_INVALID_STATE", "superseded load did not reject at the client boundary");
  await waitFor(
    () => rawMessages.some((message) => message.type === "phase5c-handler-cancelled"),
    "Worker handler did not observe cancellation",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finalOldMessageCount = rawMessages.filter((message) => message.sessionGeneration === 2).length;
  check(finalOldMessageCount === oldMessageCount, "late completion emitted a stale runtime event");

  const result = {
    waitingStates,
    recoveredPackedByte: recoveredFrame.packed0,
    cancelled: true,
    staleRuntimeEvents: finalOldMessageCount - oldMessageCount,
    workerCount: workers.length,
    workerErrors,
    finalSessionGeneration: runtime.sessionGeneration,
    userAgent: navigator.userAgent,
  };
  await runtime.dispose();
  return result;
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
