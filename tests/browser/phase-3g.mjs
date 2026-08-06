import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";

const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");
const workerErrors = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function deleteCartdataDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("pico8-web-player");
    request.addEventListener("success", resolve, { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("database deletion blocked")), {
      once: true,
    });
  });
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

function cartSource(base, suffix) {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
value=0
saved=0
function _init()
 cartdata("phase3g_slot")
 dset(0,dget(0)+1)
 saved=flr(dget(0))
 reload(0x100,0x100,1)
 value=peek(0x100)
 if value==0 then value=${base} end
 value+=1
 poke(0x100,value)
 cstore(0x100,0x100,1)
 poke(0x100,0)
 reload(0x100,0x100,1)
 value=peek(0x100)
end
function _update60() end
function _draw()
 cls(1)
 pset(value,0,7)
 pset(saved,1,7)
end
--${suffix}
`);
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

async function sample(mounted) {
  await mounted.controller.start();
  const target = mounted.composition.presenter.lastFrameId + 2;
  await waitFor(
    () => mounted.composition.presenter.lastFrameId >= target,
    "production player did not render current-cart output",
  );
  return [
    whitePixelX(mounted.elements.canvas, 0),
    whitePixelX(mounted.elements.canvas, 1),
  ];
}

async function run() {
  await deleteCartdataDatabase();
  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory: workerFactory,
    commandTimeoutMs: 5000,
  });
  const firstCart = cartSource(20, "identity-a");
  const secondCart = cartSource(40, "identity-b");

  document.body.dataset.progress = "first identity";
  await mounted.controller.loadCart(firstCart, "phase-3g-a.p8");
  const first = await sample(mounted);

  document.body.dataset.progress = "reset same identity";
  await mounted.controller.reset();
  const reset = await sample(mounted);

  document.body.dataset.progress = "reload same bytes";
  await mounted.controller.loadCart(firstCart, "phase-3g-a-again.p8");
  const repeated = await sample(mounted);

  document.body.dataset.progress = "different identity";
  await mounted.controller.loadCart(secondCart, "phase-3g-b.p8");
  const isolated = await sample(mounted);

  check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);
  await mounted.controller.stop();
  const finalState = mounted.controller.state;
  await mounted.controller.dispose();
  return {
    phase: "3G",
    first,
    reset,
    repeated,
    isolated,
    finalState,
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
