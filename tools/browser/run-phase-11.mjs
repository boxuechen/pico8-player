import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startLocalGallery } from "../local-gallery/server.mjs";
import { delay, evaluate, launchChrome } from "./chrome-cdp.mjs";

const releaseRoot = resolve("apps/web-player/dist/release");
const temporaryRoot = await mkdtemp(join(tmpdir(), "p8w-phase11-"));
const cartRoot = join(temporaryRoot, "project-owned-carts");
const screenshotPath = join(tmpdir(), "p8w-phase11-gallery.png");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function cartSource(color, label) {
  return `pico-8 cartridge // project-owned phase 11 fixture
version 42
__lua__
t=0
function _update60()
 t+=1
end
function _draw()
 cls(${color})
 rectfill(12,12,115,115,${color + 1})
 print("${label}",48,61,7)
end
`;
}

async function waitFor(cdp, expression, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(cdp, expression)) return;
    if (Date.now() > deadline) {
      const detail = await evaluate(cdp, `JSON.stringify({
        status: document.body?.dataset.status,
        progress: document.body?.dataset.progress,
        runtime: document.querySelector('#runtime-status')?.textContent,
        diagnostic: document.querySelector('.pico8-player__diagnostic')?.textContent,
      })`);
      throw new Error(`${message}: ${detail}`);
    }
    await delay(25);
  }
}

async function trustedClick(cdp, selector) {
  const bounds = JSON.parse(await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('missing click target');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const bounds = element.getBoundingClientRect();
    return JSON.stringify({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
      disabled: Boolean(element.disabled),
    });
  })()`));
  check(!bounds.disabled, `click target is disabled: ${selector}`);
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed", x: bounds.x, y: bounds.y, button: "left", clickCount: 1,
  });
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: bounds.x, y: bounds.y, button: "left", clickCount: 1,
  });
}

await mkdir(cartRoot);
const cartFixtures = [
  ["001-blue-orbit.p8", 1, "blue"],
  ["002-pink-star.p8", 2, "pink"],
  ...Array.from({ length: 16 }, (_, index) => [
    `${String(index + 3).padStart(3, "0")}-scroll-game-${index + 3}.p8`,
    (index + 3) % 8,
    `game ${index + 3}`,
  ]),
];
await Promise.all(cartFixtures.map(([name, color, label]) =>
  writeFile(join(cartRoot, name), cartSource(color, label))));

const gallery = await startLocalGallery({ cartRoot, releaseRoot, port: 0 });
const chrome = await launchChrome({ profilePrefix: "p8w-phase11-chrome-" });

try {
  await chrome.cdp.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const NativeWorker = window.Worker;
      const tracker = window.__phase11Tracker = { workers: 0, terminated: 0 };
      window.Worker = class TrackedWorker extends NativeWorker {
        constructor(...args) { super(...args); tracker.workers += 1; }
        terminate() { tracker.terminated += 1; return super.terminate(); }
      };
    })();`,
  });
  await chrome.cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 1365,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await chrome.cdp.command("Page.navigate", { url: `${gallery.origin}/` });
  await waitFor(chrome.cdp, "document.body?.dataset.status === 'ready'", "gallery did not boot");

  const initial = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify((() => {
    const grid = document.querySelector('#cart-grid');
    const playroom = document.querySelector('.playroom');
    const player = document.querySelector('.pico8-player');
    return {
      count: document.querySelector('#cart-count')?.textContent,
      cards: grid?.querySelectorAll('.cart-card').length,
      title: document.querySelector('#now-playing-title')?.textContent,
      playerLabel: player?.getAttribute('aria-label'),
      canvasLabel: player?.querySelector('canvas')?.getAttribute('aria-label'),
      playroomWidth: playroom?.getBoundingClientRect().width,
      absolutePathLeaked: document.documentElement.innerHTML.includes(${JSON.stringify(temporaryRoot)}),
    };
  })())`));
  check(initial.count === "18" && initial.cards === 18, "catalog count or cards are incomplete");
  check(initial.title === "Select a cartridge", "initial call to action is missing");
  check(initial.playerLabel === "PICO-8 player" && initial.canvasLabel === "PICO-8 playfield",
    "embedded player semantics are missing");
  check(initial.playroomWidth > 600 && !initial.absolutePathLeaked,
    "playfield is cramped or an absolute path leaked");

  const scrollBeforeSelection = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify((() => {
    const grid = document.querySelector('#cart-grid');
    grid.scrollTop = grid.scrollHeight;
    const card = grid.querySelector('.cart-card:last-child');
    card.dataset.scrollRegressionTarget = 'true';
    return {
      scrollTop: grid.scrollTop,
      maximum: grid.scrollHeight - grid.clientHeight,
      id: card.dataset.cartId,
    };
  })())`));
  check(scrollBeforeSelection.maximum > 100 && scrollBeforeSelection.scrollTop > 100,
    `project fixture did not produce an overflowing cart shelf: ${JSON.stringify(scrollBeforeSelection)}`);
  await trustedClick(chrome.cdp, "[data-scroll-regression-target='true']");
  await waitFor(chrome.cdp, "document.body?.dataset.status === 'complete'",
    "scroll regression cart did not render");
  const scrollAfterSelection = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify((() => {
    const grid = document.querySelector('#cart-grid');
    const card = grid.querySelector('[data-scroll-regression-target="true"]');
    return {
      scrollTop: grid.scrollTop,
      sameNode: card !== null,
      selected: card?.dataset.selected,
    };
  })())`));
  check(scrollAfterSelection.sameNode && scrollAfterSelection.selected === "true" &&
    Math.abs(scrollAfterSelection.scrollTop - scrollBeforeSelection.scrollTop) <= 1,
  "selecting a cart rebuilt the shelf or lost its scroll position");

  await evaluate(chrome.cdp, `(() => {
    const search = document.querySelector('#cart-search');
    search.value = 'blue';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.body.dataset.status = 'ready';
    return true;
  })()`);
  check(await evaluate(chrome.cdp, "document.querySelectorAll('.cart-card').length === 1"),
    "search did not filter the shelf");
  await trustedClick(chrome.cdp, ".cart-card");
  await waitFor(chrome.cdp, "document.body?.dataset.status === 'complete'", "selected cart did not render");
  check(await evaluate(chrome.cdp,
    "document.querySelector('#now-playing-title')?.textContent === 'blue orbit'"),
  "selected title did not reach now-playing state");

  const capture = await chrome.cdp.command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(screenshotPath, Buffer.from(capture.data, "base64"));

  await evaluate(chrome.cdp, `(() => {
    const search = document.querySelector('#cart-search');
    search.value = 'pink';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.body.dataset.status = 'ready';
    return true;
  })()`);
  await trustedClick(chrome.cdp, ".cart-card");
  await waitFor(chrome.cdp, "document.body?.dataset.status === 'complete'", "cart swap did not render");
  check(await evaluate(chrome.cdp,
    "document.querySelector('#now-playing-title')?.textContent === 'pink star'"),
  "cart swap did not update now-playing state");

  await chrome.cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 820,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(120);
  const resized = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify((() => ({
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    canvasWidth: document.querySelector('.pico8-player__canvas')?.getBoundingClientRect().width,
    cards: document.querySelectorAll('.cart-card').length,
  }))())`));
  check(!resized.horizontalOverflow && resized.canvasWidth >= 128 && resized.cards === 1,
    "desktop narrow viewport broke the stage or shelf");

  await chrome.cdp.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  check(await evaluate(chrome.cdp,
    "getComputedStyle(document.querySelector('.cart-card')).transitionDuration === '0s'"),
  "reduced motion does not disable gallery transitions");

  await evaluate(chrome.cdp,
    "window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); true");
  await waitFor(chrome.cdp,
    "window.__phase11Tracker.workers > 0 && window.__phase11Tracker.terminated >= window.__phase11Tracker.workers",
    "pagehide did not dispose the embedded player");

  process.stdout.write(`${JSON.stringify({
    chrome: chrome.version,
    projectOwnedCarts: 18,
    catalog: true,
    selectionScrollPreserved: true,
    search: true,
    firstFrame: true,
    cartSwap: true,
    desktopViewportResize: true,
    reducedMotion: true,
    teardown: true,
    screenshot: screenshotPath,
  }, null, 2)}\n`);
} finally {
  await chrome.close();
  await gallery.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
