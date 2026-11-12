import { createPico8WebPlayer, createPico8Session, createPico8SessionTool } from "../../apps/web-player/dist/release/main/player.mjs";

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
function _init() cartdata("phase17") dset(0,${marker}) end
function _update60() dset(1,dget(1)+1) end
function _draw() cls(${color}) end
`);
}
function pixel(player) {
  return [...player.canvas.getContext("2d").getImageData(0, 0, 1, 1).data].join(",");
}

async function run() {
  const session = await createPico8Session();
  const tool = createPico8SessionTool(session);
  await tool.execute({action: "load_source", source: `x=0
function _update60() if btn(1) then x+=1 end end
function _draw() cls(0) pset(x,0,8) end`});
  const manual = await tool.execute({action: "advance", frames: 30, buttons: 2});
  check(manual.completedFrames === 30 && manual.observation.frame.frameId === 29, "manual frame count");
  const observed = session.observe();
  check([...observed.frame.rgba.slice(120,124)].join(",") === "255,0,77,255", "manual input/pixel mismatch");
  check(workers === 0 && contexts.length === 0 && frames.size === 0, "standalone session created browser devices");
  await tool.execute({action: "load_source", source: "function broken("});
  check(session.observe().state === "faulted", "source fault missing");
  await tool.execute({action: "load_source", source: "function _draw() cls(3) end"});
  await tool.execute({action: "advance", frames: 1});
  check(session.observe().revision === 3, "revision not advanced");
  await session.dispose();
  const gates = new Map(["cart-b", "cart-c"].map(id => [id, { entered: deferred(), release: deferred() }]));
  const player = await createPico8WebPlayer({ root: mount, shell: "full", audio,
    persistence: {
      async hydrate(id) {
        const gate = gates.get(id);
        if (gate) { gate.entered.resolve(); await gate.release.promise; }
        return [];
      },
      async write() {},
      async flush() {},
    },
  });
  const states = [];
  const faults = [];
  player.on("state", event => states.push({ state: event.state, message: event.message }));
  player.on("fault", event => faults.push(event.error));
  await player.loadCart(cart(10, 2), { contentId: "cart-a", displayName: "A" });
  await player.start();
  const firstPixel = pixel(player);
  const switching = player.loadCart(cart(40, 8), { contentId: "cart-b", displayName: "B" });
  await gates.get("cart-b").entered.promise;
  const heldCount = states.length;
  const reset = mount.querySelector('[data-action="reset"]');
  check(!reset.disabled, "reset control is not available for the retained cart");
  reset.click();
  const started = player.start();
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  const drained = player.flushPersistence("queue-barrier");
  await sleep(30);
  check(player.state === "stopped" && states.length === heldCount,
    "UI or environment action overtook hydration");
  gates.get("cart-b").release.resolve();
  await Promise.all([switching, started, drained]);
  const transitions = states.slice(heldCount);
  const messages = transitions.map(event => event.message);
  check(messages.indexOf("B ready") < messages.indexOf("Reset complete") &&
    messages.includes("Reset complete"), "UI reset did not follow replacement");
  check(transitions.map(event => event.state).join(",") === "loading,ready,ready,running,paused,running",
    `unexpected lifecycle order: ${JSON.stringify(transitions)}`);
  check(pixel(player) !== firstPixel && player.state === "running", "B failed to present/resume");

  mount.querySelector('[data-action="menu"]').click();
  await player.flushPersistence("menu-barrier");
  check(player.state === "menu-open", "queued menu failed to open");
  mount.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await player.flushPersistence("close-menu-barrier");
  check(player.state === "running", "queued menu failed to close");

  const loading = player.loadCart(cart(70, 3), { contentId: "cart-c" })
    .then(() => "resolved", error => error.message);
  await gates.get("cart-c").entered.promise;
  reset.click();
  const pending = player.start().then(() => "resolved", error => error.message);
  const disposal = player.dispose();
  check(states.at(-1).state === "disposed", "missing terminal public state");
  const finalEventCount = states.length;
  const late = player.reset().then(() => "resolved", error => error.message);
  gates.get("cart-c").release.resolve();
  const rejected = await Promise.all([loading, pending, late]);
  await disposal;
  check(rejected.every(message => /disposed/i.test(message)), `dispose admitted work: ${rejected}`);
  check(states.length === finalEventCount, "dispose emitted late public events");
  await sleep(20);
  check(faults.length === 0 && unhandled.length === 0, `unexpected errors: ${JSON.stringify({faults, unhandled})}`);
  check(workers === 0 && terminated === 0 && frames.size === 0 &&
    contexts.every(context => context.state === "closed"), "resource teardown failed");
  mount.replaceChildren();
  const isolated = await createPico8WebPlayer({root: mount, shell: "hosted", execution: "worker", audio});
  await isolated.loadCart(cart(70,3)); await isolated.start();
  check(pixel(isolated) === "0,135,81,255", "optional Worker did not present matching pixels");
  await isolated.dispose();
  check(workers === 1 && terminated === 1 && frames.size === 0 && contexts.every(c=>c.state === "closed"), "optional Worker leaked resources");
  return { manualFrames: manual.completedFrames, manualFrameId: manual.observation.frame.frameId,
    standaloneCreatedDevices: 0, defaultWorkers: 0, optionalWorkerSmoke: true, transitions, rejectedOperations: rejected.length, menuRoundTrip: true,
    workers, terminated, closedAudioContexts: contexts.length, activeAnimationFrames: frames.size,
    unhandledRejections: unhandled.length };
}
try {
  document.querySelector("#result").textContent = JSON.stringify(await run());
  document.body.dataset.status = "complete";
} catch (error) {
  document.querySelector("#result").textContent = error.stack ?? String(error);
  document.body.dataset.status = "error";
}
