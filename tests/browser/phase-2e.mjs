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
function _init()
 poke(0x5600,1,8,1,0,0,0,1,0)
 poke(0x5600+97*8,1,0,0,0,0,0,0,0)
end
function _update() end
function _draw()
 cls(1)
 pal(7,12)
 print("a",2,2,7)
 print(chr(14).."a",10,2,8)
 print(chr(6)..":447cb67c3e7f0106",20,2,11)
 print(chr(255),32,2,10)
end
`);

  document.body.dataset.progress = "production worker P8SCII raster";
  await controller.loadCart(cart, "phase-2e.p8");
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 2, "2E cart did not publish frames");
  check(latestFrame?.packedBytes === 0x2000, "packed screen DTO length drifted");
  check(latestFrame?.displayPaletteBytes === 16, "display palette DTO length drifted");

  const builtin = rgbaAt(elements.canvas, 2, 2);
  const custom = rgbaAt(elements.canvas, 10, 2);
  const oneOff = rgbaAt(elements.canvas, 22, 2);
  const background = rgbaAt(elements.canvas, 127, 127);
  check(builtin.join(",") === "41,173,255,255", `built-in text drifted: ${builtin}`);
  check(custom.join(",") === "255,0,77,255", `custom font drifted: ${custom}`);
  check(oneOff.join(",") === "0,228,54,255", `one-off glyph drifted: ${oneOff}`);
  check(background.join(",") === "29,43,83,255", `text frame background drifted: ${background}`);

  await controller.pause();
  const result = {
    frameId: latestFrame.frameId,
    packedBytes: latestFrame.packedBytes,
    displayPaletteBytes: latestFrame.displayPaletteBytes,
    eventKeys: latestFrame.eventKeys,
    builtin,
    custom,
    oneOff,
    background,
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
