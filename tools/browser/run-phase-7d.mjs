import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  delay,
  evaluate,
  launchChrome,
} from "./chrome-cdp.mjs";

const projectRoot = resolve(".");
const releaseRoot = join(projectRoot, "apps/web-player/dist/release");
const contract = JSON.parse(await readFile("spec/release-artifact-contract.json", "utf8"));
const requestLog = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const prefix = "/nested/phase-7d/release/";
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const releasePath = url.pathname.slice(prefix.length);
    const path = resolve(releaseRoot, releasePath);
    if (releasePath === "" || !path.startsWith(`${releaseRoot}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const mime = releasePath === contract.manifest
      ? "application/json; charset=utf-8"
      : contract.files[releasePath];
    if (mime === undefined) {
      response.writeHead(404).end("Not found");
      return;
    }
    requestLog.push(releasePath);
    response.writeHead(200, {
      "content-type": mime,
      "content-security-policy": contract.csp,
      "cache-control": "no-store",
    });
    response.end(await readFile(path));
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500).end(
      error instanceof Error ? error.message : String(error),
    );
  }
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const chrome = await launchChrome({ profilePrefix: "p8w-phase7d-" });

async function waitFor(expression, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(chrome.cdp, expression)) return;
    if (Date.now() > deadline) {
      const detail = await evaluate(
        chrome.cdp,
        `JSON.stringify({
          status: document.body?.dataset.status,
          progress: document.body?.dataset.progress,
          playerState: document.querySelector('.pico8-player')?.dataset.playerState,
          diagnostic: document.querySelector('.pico8-player__diagnostic')?.textContent,
          contexts: window.__phase7d?.contexts.map((context) => context.state),
          clicks: window.__phase7d?.clicks,
          resumes: window.__phase7d?.resumes,
        })`,
      );
      throw new Error(`${message}: ${detail}`);
    }
    await delay(25);
  }
}

async function trustedClick(selector) {
  const bounds = JSON.parse(await evaluate(chrome.cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('missing click target: ${selector}');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const hit = document.elementFromPoint(x, y);
    return JSON.stringify({
      x,
      y,
      disabled: Boolean(element.disabled),
      hitMatches: hit === element || (hit !== null && element.contains(hit)),
    });
  })()`));
  check(bounds.disabled === false, `trusted click target is disabled: ${selector}`);
  check(bounds.hitMatches, `trusted click target is obscured or outside the viewport: ${selector}`);
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: bounds.x,
    y: bounds.y,
    button: "left",
    clickCount: 1,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: bounds.x,
    y: bounds.y,
    button: "left",
    clickCount: 1,
  });
}

function cartSource(color) {
  return `pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
x=10
function _update60()
 if btn(1) then x+=1 end
end
function _draw()
 cls(${color})
 pset(x%128,64,7)
end
`;
}

async function dispatchFiles(entries, target = "input") {
  await evaluate(chrome.cdp, `(() => {
    const transfer = new DataTransfer();
    for (const entry of ${JSON.stringify(entries)}) {
      transfer.items.add(new File(
        [new TextEncoder().encode(entry.source)],
        entry.name,
        { type: entry.type ?? 'application/octet-stream' },
      ));
    }
    if (${JSON.stringify(target)} === 'input') {
      const input = document.querySelector('.pico8-player__file-input');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const zone = document.querySelector('.pico8-player__stage');
      zone.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
    }
    return true;
  })()`);
}

try {
  await chrome.cdp.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const NativeWorker = window.Worker;
      const NativeAudioContext = window.AudioContext;
      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
      const tracker = window.__phase7d = {
        workers: [],
        terminatedWorkers: 0,
        contexts: [],
        clicks: [],
        resumes: [],
        activeAnimationFrames: new Set(),
      };
      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : undefined;
        tracker.clicks.push({
          action: target?.closest('[data-action]')?.getAttribute('data-action') ?? null,
          className: target?.className ?? null,
          tagName: target?.tagName ?? null,
          eventIsTrusted: event.isTrusted,
          userActivationIsActive: navigator.userActivation.isActive,
        });
      }, true);
      window.Worker = class TrackedWorker extends NativeWorker {
        constructor(...args) {
          super(...args);
          tracker.workers.push(this);
        }
        terminate() {
          if (!this.__phase7dTerminated) {
            this.__phase7dTerminated = true;
            tracker.terminatedWorkers += 1;
          }
          return super.terminate();
        }
      };
      window.AudioContext = class TrackedAudioContext extends NativeAudioContext {
        constructor(...args) {
          super(...args);
          tracker.contexts.push(this);
        }
        resume() {
          tracker.resumes.push({
            state: this.state,
            userActivationIsActive: navigator.userActivation.isActive,
          });
          return super.resume();
        }
      };
      window.requestAnimationFrame = (callback) => {
        let handle;
        handle = nativeRequestAnimationFrame((timestamp) => {
          tracker.activeAnimationFrames.delete(handle);
          callback(timestamp);
        });
        tracker.activeAnimationFrames.add(handle);
        return handle;
      };
      window.cancelAnimationFrame = (handle) => {
        tracker.activeAnimationFrames.delete(handle);
        return nativeCancelAnimationFrame(handle);
      };
    })();`,
  });
  await chrome.cdp.command("Page.navigate", {
    url: `${origin}/nested/phase-7d/release/demo/index.html`,
  });
  await waitFor(
    "document.body?.dataset.status === 'ready'",
    "release demo did not create the shell",
  );

  const semantics = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify((() => {
    const shell = document.querySelector('.pico8-player');
    const status = shell.querySelector('.pico8-player__status');
    const diagnostic = shell.querySelector('.pico8-player__diagnostic');
    const canvas = shell.querySelector('canvas');
    const touch = [...shell.querySelectorAll('[data-pico-button]')];
    const namedButtons = [...shell.querySelectorAll('button')].every(
      (button) => Boolean(button.getAttribute('aria-label') || button.textContent.trim()),
    );
    return {
      shellLabel: shell.getAttribute('aria-label'),
      shellState: shell.dataset.playerState,
      statusRole: status.getAttribute('role'),
      statusLive: status.getAttribute('aria-live'),
      diagnosticRole: diagnostic.getAttribute('role'),
      diagnosticHidden: diagnostic.hidden,
      canvasLabel: canvas.getAttribute('aria-label'),
      canvasBacking: [canvas.width, canvas.height],
      toolbarRole: shell.querySelector('.pico8-player__toolbar').getAttribute('role'),
      touchCount: touch.length,
      minimumTouchTarget: Math.min(...touch.map((button) => button.getBoundingClientRect().height)),
      namedButtons,
      inputLabel: shell.querySelector('input[type=file]').getAttribute('aria-label'),
      childCanvasCount: canvas.querySelectorAll('*').length,
    };
  })())`));
  check(semantics.shellLabel === "PICO-8 player" && semantics.shellState === "idle",
    "shell landmark or initial state is missing");
  check(semantics.statusRole === "status" && semantics.statusLive === "polite",
    "status live region is incomplete");
  check(semantics.diagnosticRole === "alert" && semantics.diagnosticHidden === true,
    "diagnostic alert is not initially quiet");
  check(semantics.canvasLabel === "PICO-8 playfield" &&
    semantics.canvasBacking[0] === 128 && semantics.canvasBacking[1] === 128,
  "playfield accessibility or backing size drifted");
  check(semantics.toolbarRole === "toolbar" && semantics.touchCount === 6,
    "control groups are incomplete");
  check(semantics.minimumTouchTarget >= 44 && semantics.namedButtons,
    "touch targets or accessible button names are incomplete");
  check(semantics.inputLabel.includes("local") && semantics.childCanvasCount === 0,
    "local chooser or Canvas-only playfield boundary drifted");

  await dispatchFiles([{ name: "initial.p8", source: cartSource(2) }]);
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'audio-blocked'",
    "programmatic start did not surface audio-blocked",
  );
  await waitFor(
    "document.body?.dataset.status === 'complete'",
    "audio-blocked visual playback did not publish a frame",
  );
  const blocked = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify({
    playLabel: document.querySelector('[data-action=play]').textContent,
    pauseDisabled: document.querySelector('[data-action=pause]').disabled,
    contextState: window.__phase7d.contexts[0]?.state,
    framePixel: [...document.querySelector('canvas').getContext('2d').getImageData(0, 0, 1, 1).data],
  })`));
  check(blocked.playLabel === "Enable audio" && blocked.pauseDisabled === false,
    "audio-blocked state is not actionable");
  check(blocked.contextState === "suspended", "audio was not actually blocked before gesture");

  await trustedClick("[data-action=play]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running' && window.__phase7d.contexts[0]?.state === 'running'",
    "trusted Enable audio did not recover",
  );

  await trustedClick("[data-action=mute]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.audioState === 'muted'",
    "mute did not update the DOM state",
  );
  check(await evaluate(chrome.cdp, "document.querySelector('[data-action=mute]').getAttribute('aria-pressed')") === "true",
    "mute pressed semantics are missing");
  await trustedClick("[data-action=mute]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.audioState === 'enabled'",
    "unmute did not restore audio state",
  );

  await trustedClick("[data-action=pause]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'paused'",
    "pause control did not pause",
  );
  await trustedClick("[data-action=play]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running'",
    "resume control did not resume",
  );

  const baselineX = await evaluate(chrome.cdp, `(() => {
    const pixels = document.querySelector('canvas').getContext('2d').getImageData(0, 64, 128, 1).data;
    for (let x = 0; x < 128; x += 1) {
      if (pixels[x * 4] === 255 && pixels[x * 4 + 1] === 241 && pixels[x * 4 + 2] === 232) return x;
    }
    return -1;
  })()`);
  await evaluate(chrome.cdp, `(() => {
    const canvas = document.querySelector('canvas');
    canvas.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true }));
    return document.activeElement === canvas;
  })()`);
  await delay(150);
  await evaluate(chrome.cdp, "window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight', bubbles: true, cancelable: true }))");
  const movedX = await evaluate(chrome.cdp, `(() => {
    const pixels = document.querySelector('canvas').getContext('2d').getImageData(0, 64, 128, 1).data;
    for (let x = 0; x < 128; x += 1) {
      if (pixels[x * 4] === 255 && pixels[x * 4 + 1] === 241 && pixels[x * 4 + 2] === 232) return x;
    }
    return -1;
  })()`);
  check(movedX > baselineX, `focused keyboard input did not reach the cart: ${baselineX}/${movedX}`);

  const touchState = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify((() => {
    const button = document.querySelector('[data-pico-button="4"]');
    button.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 77,
      bubbles: true,
      cancelable: true,
    }));
    const pressed = button.getAttribute('aria-pressed');
    button.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 77,
      bubbles: true,
      cancelable: true,
    }));
    return { pressed, released: button.getAttribute('aria-pressed') };
  })())`));
  check(touchState.pressed === "true" && touchState.released === "false",
    "touch pressed/cancel semantics are incomplete");

  await dispatchFiles([
    { name: "one.p8", source: cartSource(3) },
    { name: "two.p8", source: cartSource(4) },
  ], "drop");
  await waitFor(
    "document.querySelector('.pico8-player__diagnostic')?.textContent.includes('exactly one')",
    "multiple-file drop did not fail visibly",
  );
  check(await evaluate(chrome.cdp, "document.querySelector('.pico8-player').dataset.playerState") === "running",
    "invalid drop changed the committed runtime state");

  await dispatchFiles([{ name: "replacement.p8", source: cartSource(3) }], "drop");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running' && document.querySelector('.pico8-player__diagnostic')?.hidden",
    "valid drop did not replace and recover",
  );
  const replacementPixel = JSON.parse(await evaluate(
    chrome.cdp,
    "JSON.stringify([...document.querySelector('canvas').getContext('2d').getImageData(0, 0, 1, 1).data])",
  ));
  check(JSON.stringify(replacementPixel) !== JSON.stringify(blocked.framePixel),
    "replacement cart did not change the presented playfield");

  await chrome.cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.scale === '2'",
    "narrow viewport did not select 2x integer scale",
  );
  const narrow = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    canvasWidth: document.querySelector('canvas').getBoundingClientRect().width,
  })`));
  check(narrow.canvasWidth === 256 && narrow.scrollWidth <= narrow.innerWidth,
    `200%/narrow layout overflowed: ${JSON.stringify(narrow)}`);
  await chrome.cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    "Number(document.querySelector('.pico8-player')?.dataset.scale) >= 3",
    "wide viewport did not restore integer scale",
  );

  await chrome.cdp.command("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reducedMotion = await evaluate(
    chrome.cdp,
    "getComputedStyle(document.querySelector('.pico8-player__drop-hint')).transitionDuration",
  );
  check(reducedMotion === "0s", `reduced motion retained transitions: ${reducedMotion}`);

  await trustedClick("[data-action=fullscreen]");
  await waitFor(
    "document.fullscreenElement === document.querySelector('.pico8-player')",
    "fullscreen control did not enter fullscreen",
  );
  check(await evaluate(chrome.cdp, "document.querySelector('[data-action=fullscreen]').getAttribute('aria-pressed')") === "true",
    "fullscreen pressed semantics are missing");
  await evaluate(chrome.cdp, "document.exitFullscreen()");
  await waitFor("document.fullscreenElement === null", "fullscreen did not exit");

  await evaluate(chrome.cdp, `(() => {
    window.__phase7d.transitions = [];
    window.__phase7d.stateObserver = new MutationObserver(() => {
      window.__phase7d.transitions.push(document.querySelector('.pico8-player').dataset.playerState);
    });
    window.__phase7d.stateObserver.observe(document.querySelector('.pico8-player'), {
      attributes: true,
      attributeFilter: ['data-player-state'],
    });
  })()`);
  await trustedClick("[data-action=reset]");
  await waitFor(
    "window.__phase7d.transitions.includes('ready') && window.__phase7d.transitions.includes('running')",
    "running reset did not return through ready to running",
  );
  await trustedClick("[data-action=stop]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'stopped'",
    "stop control did not stop",
  );
  await trustedClick("[data-action=reset]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'ready'",
    "stopped reset did not recover to ready",
  );
  await trustedClick("[data-action=play]");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running'",
    "ready play did not restart",
  );

  await dispatchFiles([{
    name: "broken.p8",
    source: "pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\nfunction (\n",
  }], "drop");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'faulted'",
    "broken cart did not enter visible fault state",
  );
  await dispatchFiles([{ name: "recovery.p8", source: cartSource(4) }], "drop");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'running'",
    "faulted shell did not recover through a new local selection",
  );

  await evaluate(chrome.cdp, "window.dispatchEvent(new PageTransitionEvent('pagehide'))");
  await waitFor(
    "document.querySelector('.pico8-player')?.dataset.playerState === 'disposed' && window.__phase7d.terminatedWorkers === 1 && window.__phase7d.contexts[0]?.state === 'closed' && window.__phase7d.activeAnimationFrames.size === 0",
    "pagehide disposal did not release the shell resources",
  );

  const result = JSON.parse(await evaluate(chrome.cdp, `JSON.stringify({
    semantics: ${JSON.stringify(semantics)},
    audioBlockedRecovered: true,
    keyboard: { baselineX: ${baselineX}, movedX: ${movedX} },
    touchState: ${JSON.stringify(touchState)},
    narrow: ${JSON.stringify(narrow)},
    reducedMotion: ${JSON.stringify(reducedMotion)},
    finalState: document.querySelector('.pico8-player').dataset.playerState,
    workersCreated: window.__phase7d.workers.length,
    workersTerminated: window.__phase7d.terminatedWorkers,
    audioState: window.__phase7d.contexts[0].state,
    activeAnimationFrames: window.__phase7d.activeAnimationFrames.size,
    requestedReleasePaths: performance.getEntriesByType('resource').map(({ name }) => new URL(name).pathname),
  })`));
  check(requestLog.every((path) => path === contract.manifest || path in contract.files),
    "7D requested a path outside the release manifest allowlist");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await chrome.close();
}
