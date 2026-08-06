import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  delay,
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(cdp, expression, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evaluate(cdp, expression))) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(50);
  }
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ headless: false, profilePrefix: "p8w-phase3d-" });

try {
  await chrome.cdp.command("Browser.grantPermissions", {
    permissions: ["pointerLock"],
    origin: server.origin,
  });
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-3d.html`,
  });
  await chrome.cdp.command("Page.bringToFront");
  await waitFor(
    chrome.cdp,
    "document.body?.dataset?.progress === 'await-trusted-pointer-lock'",
    "Phase 3D page did not reach the trusted-input checkpoint",
    90_000,
  );
  const box = await evaluate(chrome.cdp, `(() => {
    const rect = document.querySelector('canvas').getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`);
  const x = box.x + box.width * 0.4;
  const y = box.y + box.height * 0.6;
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", buttons: 0,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, button: "none", buttons: 0, deltaX: 0, deltaY: -100,
  });
  await chrome.cdp.command("Input.dispatchKeyEvent", {
    type: "keyDown", key: "q", code: "KeyQ", text: "q", windowsVirtualKeyCode: 81,
  });
  await chrome.cdp.command("Input.dispatchKeyEvent", {
    type: "keyUp", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1,
  });
  await delay(150);
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "middle", buttons: 4, clickCount: 1,
  });
  await delay(150);
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "middle", buttons: 0, clickCount: 1,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
  try {
    await waitFor(
      chrome.cdp,
      "document.pointerLockElement === document.querySelector('canvas')",
      "trusted canvas gesture did not enter pointer lock",
    );
  } catch (error) {
    const diagnostics = await evaluate(chrome.cdp, `({
      active: document.activeElement?.tagName,
      flags: document.body.dataset.progress,
      pointerLockErrors: window.__phase3dPointerLockErrors,
      pointerLockElement: document.pointerLockElement?.tagName ?? null,
      gesture: window.__phase3dGesture,
    })`);
    throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`);
  }
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: x + 24, y: y - 16, button: "none", buttons: 1,
  });
  await delay(250);
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
  await evaluate(chrome.cdp, "window.__phase3dCdpDone = true");

  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 90_000 });
  } catch (error) {
    const diagnostics = await evaluate(chrome.cdp, `({
      result: document.querySelector('#result').textContent,
      progress: document.body.dataset.progress,
      pointerLock: document.pointerLockElement?.tagName ?? null,
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostics, null, 2)}`);
  }
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.phase === "3D", "Chrome reported the wrong phase");
  check(result.pointerLockEntered, "Chrome never observed pointer lock");
  check(result.pointerLockExitedOnPause, "pause did not exit pointer lock");
  check(result.observed[2] === 9 && result.observed[3] === 9,
    "Chrome duplicated event-style input");
  check(result.observed[4] > 8, "Chrome missed relative pointer movement");
  check(result.observed.slice(5).every((value) => value > 8),
    "Chrome missed a mouse button overlay");
  check(result.reset.slice(2).every((value) => value === 8),
    "Chrome reset retained devkit events");
  check(result.generationAfterReset > result.generationBeforeReset,
    "Chrome reset did not advance generation");
  check(result.workerErrors.length === 0, "production Worker reported an error");
  check(result.finalState === "stopped", "production shell did not stop cleanly");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
