import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const projectRoot = resolve(".");
const releaseRoot = join(projectRoot, "apps/web-player/dist/release");
const contract = JSON.parse(await readFile("spec/release-artifact-contract.json", "utf8"));
const requestLog = [];
const wasmRequests = { correct: 0, fallback: 0 };

function modeAndPath(pathname) {
  for (const mode of ["correct", "fallback"]) {
    const prefix = `/nested/phase-7c/${mode}/`;
    if (pathname.startsWith(prefix)) return { mode, path: pathname.slice(prefix.length) };
  }
  return undefined;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const resolved = modeAndPath(url.pathname);
    if (resolved === undefined || resolved.path === "") {
      response.writeHead(404).end("Not found");
      return;
    }
    const path = resolve(releaseRoot, resolved.path);
    if (!path.startsWith(`${releaseRoot}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const mime = resolved.path === contract.artifacts.wasm && resolved.mode === "fallback"
      ? "application/octet-stream"
      : contract.files[resolved.path] ??
        (resolved.path === contract.manifest ? "application/json; charset=utf-8" : undefined);
    if (mime === undefined) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (resolved.path === contract.artifacts.wasm) wasmRequests[resolved.mode] += 1;
    requestLog.push({ mode: resolved.mode, path: resolved.path, mime });
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
const chrome = await launchChrome({
  profilePrefix: "p8w-phase7c-",
  extraFlags: ["--autoplay-policy=no-user-gesture-required"],
});

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function runMode(mode, color) {
  await chrome.cdp.command("Page.navigate", {
    url: `${origin}/nested/phase-7c/${mode}/demo/index.html`,
  });
  await waitForDocumentStatus(chrome.cdp, { accepted: ["ready"], timeoutMs: 60_000 });
  await evaluate(chrome.cdp, `(async () => {
    const input = document.querySelector('input[type=file]');
    if (!input) throw new Error('release demo did not create its local file input');
    const source = 'pico-8 cartridge // http://www.pico-8.com\\nversion 42\\n__lua__\\nfunction _draw() cls(${color}) pset(64,64,7) end\\n';
    const transfer = new DataTransfer();
    transfer.items.add(new File([new TextEncoder().encode(source)], '${mode}.p8'));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  return JSON.parse(await evaluate(chrome.cdp, `JSON.stringify({
    mode: ${JSON.stringify(mode)},
    playerState: document.querySelector('.pico8-player')?.dataset.playerState,
    canvasWidth: document.querySelector('canvas')?.width,
    canvasHeight: document.querySelector('canvas')?.height,
    crossOriginIsolated,
    resources: performance.getEntriesByType('resource').map(({ name }) => new URL(name).pathname),
  })`));
}

try {
  const correct = await runMode("correct", 2);
  const fallback = await runMode("fallback", 3);
  check(correct.playerState === "running" && fallback.playerState === "running",
    "release demo did not enter running state");
  check(correct.canvasWidth === 128 && correct.canvasHeight === 128,
    "release canvas is not the 128x128 playfield");
  check(correct.crossOriginIsolated === false && fallback.crossOriginIsolated === false,
    "release unexpectedly requires cross-origin isolation");
  check(wasmRequests.correct === 1,
    `correct MIME should stream once, observed ${wasmRequests.correct} requests`);
  check(wasmRequests.fallback === 2,
    `wrong MIME should refetch for ArrayBuffer fallback, observed ${wasmRequests.fallback}`);
  check(requestLog.every(({ path }) => path === contract.manifest || path in contract.files),
    "release requested a path outside its manifest allowlist");
  process.stdout.write(`${JSON.stringify({
    browser: chrome.version,
    csp: contract.csp,
    correct,
    fallback,
    wasmRequests,
    requestCount: requestLog.length,
  }, null, 2)}\n`);
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await chrome.close();
}
