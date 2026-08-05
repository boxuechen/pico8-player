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
      displayPalette: [...new Uint8Array(event.displayPalette)],
    };
  });
  const cart = encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _update() end
function _draw()
 cls(1)
 camera(10,20)
 clip(2,3,4,4)
 pal(6,8)
 fillp(0x5a5a)
 rectfill(12,23,15,26,0x76)
 poke(0x5f11,0x8e)
end
`);

  document.body.dataset.progress = "production worker and canvas";
  await controller.loadCart(cart, "phase-2b.p8");
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 2, "2B cart did not publish frames");
  check(latestFrame?.packedBytes === 0x2000, "packed screen DTO length drifted");
  check(latestFrame?.displayPalette.length === 16, "display palette DTO length drifted");
  check(latestFrame?.displayPalette[1] === 0x8e, "direct display-palette write was not snapshotted");
  const background = rgbaAt(elements.canvas, 0, 0);
  check(background.join(",") === "255,110,89,255", `extended display colour drifted: ${background}`);
  const patternedA = rgbaAt(elements.canvas, 2, 3);
  const patternedB = rgbaAt(elements.canvas, 3, 3);
  const patternSet = new Set([patternedA.join(","), patternedB.join(",")]);
  check(patternSet.has("255,0,77,255"), "draw-palette primary colour is missing");
  check(patternSet.has("255,241,232,255"), "fill-pattern alternate colour is missing");

  await controller.pause();
  const result = {
    frameId: latestFrame.frameId,
    packedBytes: latestFrame.packedBytes,
    displayPaletteBytes: latestFrame.displayPalette.length,
    displayPaletteEntry1: latestFrame.displayPalette[1],
    background,
    patternedA,
    patternedB,
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
