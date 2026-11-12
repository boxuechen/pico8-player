import { createPico8WebPlayer } from "../../apps/web-player/dist/release/main/player.mjs";

const mount = document.querySelector("#mount");
const contexts = [];
const unhandled = [];
const frames = new Set();
let workers = 0;
let terminated = 0;
const NativeWorker = window.Worker;
const requestFrame = window.requestAnimationFrame.bind(window);
const cancelFrame = window.cancelAnimationFrame.bind(window);
window.Worker = class extends NativeWorker {
  #terminated = false;
  constructor(...args) { super(...args); workers++; }
  terminate() {
    if (!this.#terminated) { this.#terminated = true; terminated++; }
    super.terminate();
  }
};
window.requestAnimationFrame = callback => {
  const id = requestFrame(time => { frames.delete(id); callback(time); });
  frames.add(id);
  return id;
};
window.cancelAnimationFrame = id => { frames.delete(id); cancelFrame(id); };
window.addEventListener("unhandledrejection", event => unhandled.push(String(event.reason)));
const audio = { contextFactory(options) {
  const context = new AudioContext(options);
  contexts.push(context);
  return context;
} };
function check(value, message) { if (!value) throw new Error(message); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function cart(marker, color) {
  return new TextEncoder().encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init() cartdata("phase15") dset(0,${marker}) end
function _update60() dset(1,dget(1)+1) end
function _draw() cls(${color}) end
`);
}
function pixel(player) {
  return [...player.canvas.getContext("2d").getImageData(0, 0, 1, 1).data].join(",");
}

async function run() {
  const hydrateEntered = deferred();
  const hydrateGate = deferred();
  const writeEntered = deferred();
  const writeGate = deferred();
  const writes = [];
  const flushes = [];
  const adapter = {
    async hydrate(contentId) {
      if (contentId === "cart-b") {
        hydrateEntered.resolve();
        await hydrateGate.promise;
      }
      return [];
    },
    async write(contentId, commit) {
      if (contentId === "cart-b") {
        writeEntered.resolve();
        await writeGate.promise;
      }
      writes.push({ contentId, value: new DataView(commit.bytes.buffer).getInt32(0, true) / 65536 });
    },
    async flush(contentId) { flushes.push(contentId); },
  };
  const player = await createPico8WebPlayer({ root: mount, shell: "hosted", audio,
    persistence: adapter });
  const generations = [];
  player.on("frame", event => generations.push(event.sessionGeneration));
  await player.loadCart(cart(10, 2), { contentId: "cart-a" });
  await player.start();
  const firstPixel = pixel(player);
  const firstGeneration = generations.at(-1);
  const switching = player.loadCart(cart(40, 8), { contentId: "cart-b" });
  await hydrateEntered.promise;
  check(player.state === "stopped", "old producer is running during new hydration");
  await sleep(30);
  hydrateGate.resolve();
  await switching;
  await writeEntered.promise;
  await player.start();
  const secondPixel = pixel(player);
  check(firstPixel !== secondPixel, "start did not present the replacement cart");
  check(generations.at(-1) > firstGeneration, "replacement did not advance generation");
  let disposed = false;
  const disposal = player.dispose().then(() => { disposed = true; });
  await sleep(30);
  check(!disposed, "dispose returned before the pending host write");
  writeGate.resolve();
  await disposal;
  check(writes.some(w => w.contentId === "cart-a"), "missing A writes");
  check(writes.some(w => w.contentId === "cart-b"), "missing final B writes");
  check(writes.every(w => w.value === (w.contentId === "cart-a" ? 10 : 40)),
    "commit crossed content identities");
  check(flushes.at(-1) === "cart-b", "dispose did not flush B");
  check(frames.size === 0 && contexts[0].state === "closed" && terminated === 0,
    "host facade leaked resources");

  mount.replaceChildren();
  const fresh = await createPico8WebPlayer({ root: mount, shell: "hosted", audio });
  await fresh.loadCart(cart(70, 3));
  await fresh.start();
  check(pixel(fresh) !== secondPixel, "fresh facade retained old pixels");
  await fresh.pause();
  const flushed = await fresh.flushPersistence("browser-default");
  check(flushed.durable && flushed.status === "flushed", "default IndexedDB flush failed");
  await fresh.dispose();
  await sleep(20);
  check(unhandled.length === 0, `unhandled rejections: ${unhandled}`);
  check(workers === 0 && terminated === 0 && frames.size === 0 &&
    contexts.every(context => context.state === "closed"), "final resource teardown failed");
  return { writes: writes.length, contentIds: [...new Set(writes.map(w => w.contentId))],
    workers, terminated, closedAudioContexts: contexts.length, activeAnimationFrames: frames.size,
    unhandledRejections: unhandled.length, defaultDurable: flushed.durable };
}
try {
  document.querySelector("#result").textContent = JSON.stringify(await run());
  document.body.dataset.status = "complete";
} catch (error) {
  document.querySelector("#result").textContent = error.stack ?? String(error);
  document.body.dataset.status = "error";
}
