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
      eventKeys: Object.keys(event).sort(),
    };
  });
  const cart = encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function solid(n,c)
 for y=0,7 do
  for x=0,7 do sset(n*8+x,y,c) end
 end
end
function _init()
 solid(1,8) solid(2,11)
 mset(0,0,1) mset(1,0,2)
 fset(1,1) fset(2,2)
end
function _update() end
function _draw()
 camera() clip() cls()
 map(0,0,0,0,2,1)
 tline(0,10,15,10,0,0)
 map(0,0,0,20,2,1,1)
 tline(0,40,15,40,0,0,0.125,0,2)
 camera(8,0) clip(0,30,8,8)
 map(0,0,8,30,2,1)
 camera() clip()
end
`);

  document.body.dataset.progress = "production worker map and tline raster";
  await controller.loadCart(cart, "phase-2d.p8");
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 2, "2D cart did not publish frames");
  check(latestFrame?.packedBytes === 0x2000, "packed screen DTO length drifted");
  check(latestFrame?.displayPaletteBytes === 16, "display palette DTO length drifted");

  const mapFirst = rgbaAt(elements.canvas, 0, 0);
  const mapSecond = rgbaAt(elements.canvas, 8, 0);
  const tlineFirst = rgbaAt(elements.canvas, 0, 10);
  const tlineSecond = rgbaAt(elements.canvas, 8, 10);
  const mapLayerSkipped = rgbaAt(elements.canvas, 8, 20);
  const tlineLayerSkipped = rgbaAt(elements.canvas, 0, 40);
  const clippedMap = rgbaAt(elements.canvas, 0, 30);
  check(mapFirst.join(",") === "255,0,77,255", `map first tile drifted: ${mapFirst}`);
  check(mapSecond.join(",") === "0,228,54,255", `map second tile drifted: ${mapSecond}`);
  check(tlineFirst.join(",") === "255,0,77,255", `tline first sample drifted: ${tlineFirst}`);
  check(tlineSecond.join(",") === "0,228,54,255", `tline second sample drifted: ${tlineSecond}`);
  check(mapLayerSkipped.join(",") === "0,0,0,255", `map layer filter drifted: ${mapLayerSkipped}`);
  check(tlineLayerSkipped.join(",") === "0,0,0,255", `tline layer filter drifted: ${tlineLayerSkipped}`);
  check(clippedMap.join(",") === "255,0,77,255", `camera/clip map drifted: ${clippedMap}`);

  await controller.pause();
  const result = {
    frameId: latestFrame.frameId,
    packedBytes: latestFrame.packedBytes,
    displayPaletteBytes: latestFrame.displayPaletteBytes,
    eventKeys: latestFrame.eventKeys,
    mapFirst,
    mapSecond,
    tlineFirst,
    tlineSecond,
    mapLayerSkipped,
    tlineLayerSkipped,
    clippedMap,
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
