import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";

const resultNode = document.querySelector("#result");
const encoder = new TextEncoder();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rgbaAt(canvas, x, y) {
  return [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
}

async function run() {
  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory: () => new Worker(
      "/apps/web-player/dist/browser/player-worker.mjs",
      { type: "module" },
    ),
    commandTimeoutMs: 2000,
  });
  const { controller, composition, elements } = mounted;
  let latestFrame;
  const removeFrameListener = composition.runtime.onEvent((event) => {
    if (event.type !== "frame") return;
    latestFrame = {
      frameId: event.frameId,
      packedBytes: event.packedScreen.byteLength,
      displayPaletteBytes: event.displayPalette.byteLength,
    };
  });
  const cart = encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 for y=0,7 do
  for x=0,7 do sset(x,y,12) end
 end
 sset(8,0,11)
 sset(9,0,9)
end
function _update() end
function _draw()
 cls(2)
 pal(12,3)
 pal(3,0x87,2)
 fillp(0xaaaa.4000)
 spr(0,0,0)
 fillp()
 sspr(8,0,2,1,7,10,-4,2)
end
`);

  document.body.dataset.progress = "production worker sprite raster";
  await controller.loadCart(cart, "phase-2c.p8");
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 2, "2C cart did not publish frames");
  check(latestFrame?.packedBytes === 0x2000, "packed screen DTO length drifted");
  check(latestFrame?.displayPaletteBytes === 16, "display palette DTO length drifted");

  const patternedA = rgbaAt(elements.canvas, 0, 0);
  const patternedB = rgbaAt(elements.canvas, 1, 0);
  const stretchedA = rgbaAt(elements.canvas, 4, 10);
  const stretchedB = rgbaAt(elements.canvas, 6, 10);
  check(patternedA.join(",") === "255,0,77,255", `sprite alternate colour drifted: ${patternedA}`);
  check(patternedB.join(",") === "255,241,232,255", `sprite primary colour drifted: ${patternedB}`);
  check(stretchedA.join(",") === "255,163,0,255", `negative sspr first sample drifted: ${stretchedA}`);
  check(stretchedB.join(",") === "0,228,54,255", `negative sspr second sample drifted: ${stretchedB}`);

  await controller.pause();
  const result = {
    frameId: latestFrame.frameId,
    packedBytes: latestFrame.packedBytes,
    displayPaletteBytes: latestFrame.displayPaletteBytes,
    patternedA,
    patternedB,
    stretchedA,
    stretchedB,
    presenterFrameId: composition.presenter.lastFrameId,
    userAgent: navigator.userAgent,
  };
  removeFrameListener();
  await controller.dispose();
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
