import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { delay, evaluate, launchChrome } from "./chrome-cdp.mjs";

const releaseRoot = resolve("apps/web-player/dist/release");
const contract = JSON.parse(await readFile("spec/release-artifact-contract.json", "utf8"));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") return response.writeHead(204).end();
    const prefix = "/phase-7e/release/";
    if (!url.pathname.startsWith(prefix)) return response.writeHead(404).end("Not found");
    const relative = url.pathname.slice(prefix.length);
    const path = resolve(releaseRoot, relative);
    if (relative === "" || !path.startsWith(`${releaseRoot}${sep}`)) {
      return response.writeHead(403).end("Forbidden");
    }
    const mime = relative === contract.manifest
      ? "application/json; charset=utf-8"
      : contract.files[relative];
    if (mime === undefined) return response.writeHead(404).end("Not found");
    response.writeHead(200, {
      "content-type": mime,
      "content-security-policy": contract.csp,
      "cache-control": "no-store",
    });
    response.end(await readFile(path));
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500).end(String(error));
  }
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const chrome = await launchChrome({ profilePrefix: "p8w-phase7e-" });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(expression, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(chrome.cdp, expression)) return;
    if (Date.now() > deadline) {
      const detail = await evaluate(chrome.cdp, `JSON.stringify({
        state: document.querySelector('.pico8-player')?.dataset.playerState,
        menuOpen: document.querySelector('.pico8-player')?.dataset.menuOpen,
        status: document.querySelector('.pico8-player__status')?.textContent,
        diagnostic: document.querySelector('.pico8-player__diagnostic')?.textContent,
        audio: window.__phase7e?.contexts.map((context) => context.state),
      })`);
      throw new Error(`${message}: ${detail}`);
    }
    await delay(25);
  }
}

async function bounds(selector) {
  return JSON.parse(await evaluate(chrome.cdp, `JSON.stringify((() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('missing target');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { x: box.left + box.width / 2, y: box.top + box.height / 2,
      width: box.width, height: box.height, disabled: Boolean(element.disabled),
      hit: hit === element || (hit !== null && element.contains(hit)) };
  })())`));
}

async function click(selector) {
  const target = await bounds(selector);
  check(!target.disabled, `disabled click target ${selector}`);
  check(target.hit, `obscured click target ${selector}`);
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
}

async function touch(selector) {
  const target = await bounds(selector);
  await chrome.cdp.command("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: target.x, y: target.y, radiusX: 2, radiusY: 2 }],
  });
  await chrome.cdp.command("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

async function key(key, code = key) {
  await chrome.cdp.command("Input.dispatchKeyEvent", { type: "keyDown", key, code });
  await chrome.cdp.command("Input.dispatchKeyEvent", { type: "keyUp", key, code });
}

async function choose(name, source) {
  await evaluate(chrome.cdp, `(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      [new TextEncoder().encode(${JSON.stringify(source)})],
      ${JSON.stringify(name)},
      { type: 'application/octet-stream' },
    ));
    const input = document.querySelector('.pico8-player__file-input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

function menuCart({ fault = true } = {}) {
  return `pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
ticks=0
count=0
function keep(b)
 count+=1
 menuitem(0x101,"count:"..count,keep)
 return true
end
function _init()
 menuitem(0x101,"count:0",keep)
 menuitem(2,"close",function() return false end)
 ${fault ? 'menuitem(3,"fault",function() error("menu fault") end)' : ''}
 menuitem(0x404,"🐱 x-filter",function() menuitem(4,"bad",keep) return true end)
end
function _update60() ticks+=1 end
function _draw() cls(1) pset(ticks%128,64,7) end
`;
}

async function whitePixelX() {
  return evaluate(chrome.cdp, `(() => {
    const data = document.querySelector('canvas').getContext('2d').getImageData(0,64,128,1).data;
    for (let x=0;x<128;x+=1) if (data[x*4]===255 && data[x*4+1]===241) return x;
    return -1;
  })()`);
}

try {
  await chrome.cdp.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const NativeAudioContext = window.AudioContext;
      const tracker = window.__phase7e = { contexts: [] };
      window.AudioContext = class extends NativeAudioContext {
        constructor(...args) { super(...args); tracker.contexts.push(this); }
      };
    })();`,
  });
  await chrome.cdp.command("Page.navigate", {
    url: `${origin}/phase-7e/release/demo/index.html`,
  });
  await waitFor("document.body?.dataset.status === 'ready'", "release demo did not boot");
  await choose("menu.p8", menuCart());
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'audio-blocked'",
    "cart did not reach audio-blocked playback",
  );
  await click("[data-action=play]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running' && window.__phase7e.contexts[0]?.state === 'running'",
    "trusted audio recovery failed",
  );

  await click("[data-action=menu]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'menu-open' && window.__phase7e.contexts[0]?.state === 'suspended'",
    "Menu did not atomically pause simulation/audio",
  );
  const opened = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify({
    role: document.querySelector('.pico8-player__pause-menu').getAttribute('role'),
    modal: document.querySelector('.pico8-player__pause-menu').getAttribute('aria-modal'),
    focus: document.activeElement?.dataset.action,
    labels: [...document.querySelectorAll('.pico8-player__pause-menu [role=menuitem]')].map((x) => x.textContent),
    targets: [...document.querySelectorAll('.pico8-player__pause-menu [role=menuitem]')].map((x) => x.getBoundingClientRect().height),
  })`));
  check(opened.role === "dialog" && opened.modal === "true" && opened.focus === "menu-continue",
    "dialog/focus semantics are incomplete");
  check(opened.labels.join("|") === "Continue|count:0|close|fault|🐱 x-filter",
    `slot order drifted: ${opened.labels.join("|")}`);
  check(Math.min(...opened.targets) >= 44, "pause-menu touch target is below 44 CSS px");

  const pausedPixel = await whitePixelX();
  await delay(180);
  check(await whitePixelX() === pausedPixel, "simulation advanced while menu was open");
  await key("ArrowDown");
  check(await evaluate(chrome.cdp, "document.activeElement?.dataset.menuSlot") === "1",
    "ArrowDown did not enter roving slot focus");
  await key("ArrowLeft");
  await delay(50);
  check(await evaluate(chrome.cdp, "document.querySelector('[data-menu-slot=\"1\"]')?.textContent") === "count:0",
    "filtered Left intent invoked the callback");
  await key("ArrowRight");
  await waitFor(
    "document.querySelector('[data-menu-slot=\"1\"]')?.textContent === 'count:1'",
    "Right keep-open did not refresh the snapshot",
  );
  check(await evaluate(chrome.cdp, "document.activeElement?.dataset.menuSlot") === "1",
    "keep-open refresh lost focused slot");
  await click("[data-menu-slot=\"4\"]");
  await delay(50);
  check(await evaluate(chrome.cdp, "document.querySelector('[data-menu-slot=\"4\"]')?.textContent") === "🐱 x-filter",
    "filtered X/pointer intent invoked the callback");
  await touch("[data-menu-slot=\"1\"]");
  await waitFor(
    "document.querySelector('[data-menu-slot=\"1\"]')?.textContent === 'count:2'",
    "touch activation did not invoke X and keep the menu open",
  );
  await click("[data-action=menu-continue]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running' && document.activeElement === document.querySelector('canvas') && window.__phase7e.contexts[0]?.state === 'running'",
    "Continue did not resume the same playfield generation",
  );
  await delay(100);
  check(await whitePixelX() !== pausedPixel, "simulation did not resume after Continue");

  await click("[data-action=menu]");
  await waitFor("document.querySelector('.pico8-player')?.dataset.menuOpen === 'true'", "second open failed");
  await evaluate(chrome.cdp, "window.dispatchEvent(new Event('blur'))");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'paused' && document.querySelector('.pico8-player')?.dataset.menuOpen === 'false'",
    "blur did not close guest menu into host pause",
  );
  await click("[data-action=play]");
  await waitFor("document.querySelector('.pico8-player')?.dataset.playerState === 'running'", "host resume failed");

  await click("[data-action=menu]");
  await waitFor("document.querySelector('.pico8-player')?.dataset.menuOpen === 'true'", "third open failed");
  await choose("replacement.p8", menuCart({ fault: false }));
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running' && document.querySelector('.pico8-player')?.dataset.menuOpen === 'false'",
    "cart replacement did not clear the prior menu generation",
  );

  await click("[data-action=menu]");
  await waitFor("document.querySelector('[data-menu-slot=\"1\"]')", "replacement menu did not open");
  await key("Escape");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running' && document.activeElement === document.querySelector('canvas')",
    "Escape did not continue and restore playfield focus",
  );

  await choose("fault.p8", menuCart());
  await waitFor("document.querySelector('.pico8-player')?.dataset.playerState === 'running'", "fault cart did not start");
  await click("[data-action=menu]");
  await waitFor("document.querySelector('[data-menu-slot=\"3\"]')", "fault item was not rendered");
  await click("[data-menu-slot=\"3\"]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'faulted' && document.querySelector('.pico8-player')?.dataset.menuOpen === 'false'",
    "callback fault did not fail closed visibly",
  );
  await choose("recovery.p8", menuCart({ fault: false }));
  await waitFor("document.querySelector('.pico8-player')?.dataset.playerState === 'running'", "fault recovery failed");

  process.stdout.write(`${JSON.stringify({
    browser: chrome.version,
    dialog: opened.role,
    slotOrder: opened.labels,
    minimumTarget: Math.min(...opened.targets),
    filter: true,
    keyboard: true,
    pointer: true,
    touch: true,
    simulationPause: true,
    audioPause: true,
    generationCleanup: true,
    callbackFaultRecovery: true,
  }, null, 2)}\n`);
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await chrome.close();
}
