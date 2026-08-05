import {
  Phase0ERuntimeClient,
  RuntimeClientError,
} from "../../apps/web-player/dist/main/runtime-client.js";

const resultNode = document.querySelector("#result");
const encoder = new TextEncoder();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const generations = [];
  const client = new Phase0ERuntimeClient(
    () => {
      const worker = new Worker("./phase-0e-worker.mjs", { type: "module" });
      worker.addEventListener("error", (event) => {
        resultNode.textContent = `Worker error: ${event.message}`;
        document.body.dataset.status = "error";
      });
      return worker;
    },
    { commandTimeoutMs: 1000 },
  );
  generations.push(client.sessionGeneration);
  const source = encoder.encode(`
function _init() poke(0x150,0) end
function _update60() poke(0x150,peek(0x150)+1) end
function _draw() cls(2) pset(peek(0x150)-1,0,7) end`);
  const ready = await client.loadCart(source, 100000);
  check(ready.type === "ready" && ready.targetFps === 60, "callback cart did not boot at 60 Hz");
  document.body.dataset.progress = "60 manual Worker steps";
  let frame;
  for (let index = 0; index < 60; index += 1) {
    frame = await client.step({ buttons: index === 59 ? 1 : 0 });
    check(frame.type === "frame", `step ${index} did not produce a frame`);
  }
  check(frame.completedSlices === "60", "60 steps did not complete 60 slices");
  const screen = new Uint8Array(frame.packedScreen);
  check(screen[29] === 0x72, "packed framebuffer did not contain final pset");

  document.body.dataset.progress = "watchdog terminate/recreate";
  const watchdogReady = await client.loadCart(encoder.encode("__phase0e_watchdog_fixture__"));
  check(watchdogReady.type === "ready", "watchdog fixture did not arm");
  let watchdogCode = "";
  try {
    await client.step({ buttons: 0 });
  } catch (error) {
    if (error instanceof RuntimeClientError) watchdogCode = error.record.code;
  }
  check(watchdogCode === "E_VM_WATCHDOG", "hung Worker did not trip Window watchdog");
  generations.push(client.sessionGeneration);
  check(generations[1] === generations[0] + 1, "watchdog did not advance generation");

  const recovered = await client.loadCart(source, 100000);
  check(recovered.type === "ready", "recreated Worker did not accept a new cart");
  const recoveredFrame = await client.step({ buttons: 0 });
  check(recoveredFrame.type === "frame", "recreated Worker did not step");
  await client.dispose();
  return {
    callbackSteps: 60,
    completedSlices: frame.completedSlices,
    finalPackedByte: screen[29],
    watchdogCode,
    generations,
    recovered: true,
    userAgent: navigator.userAgent,
  };
}

try {
  const result = await run();
  resultNode.textContent = JSON.stringify(result);
  document.body.dataset.status = "complete";
  document.body.dataset.progress = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  document.body.dataset.status = "error";
}
