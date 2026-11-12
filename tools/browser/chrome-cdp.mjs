import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const CANDIDATES = [
  process.env.P8W_CHROMIUM,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

export const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function firstAvailableChrome() {
  for (const executable of CANDIDATES) {
    try {
      await access(executable);
      return executable;
    } catch {}
  }
  throw new Error("Chrome/Chromium executable not found; set P8W_CHROMIUM");
}

async function waitForPort(path, processHandle) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (processHandle.exitCode !== null) {
      throw new Error("Chrome exited before CDP was ready");
    }
    try {
      const [port] = (await readFile(path, "utf8")).trim().split(/\r?\n/u);
      if (port) return Number(port);
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for Chrome DevToolsActivePort");
}

async function stopProcess(processHandle) {
  const hasExited = () => processHandle.exitCode !== null || processHandle.signalCode !== null;
  if (hasExited()) return;
  const exited = new Promise((resolve) => processHandle.once("exit", resolve));
  processHandle.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (!hasExited()) {
    processHandle.kill("SIGKILL");
    await exited;
  }
}

export class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

export async function evaluate(cdp, expression) {
  const response = await cdp.command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description;
    throw new Error(description ?? "Chrome evaluation failed");
  }
  return response.result.value;
}

export async function waitForDocumentStatus(
  cdp,
  { accepted = ["complete"], timeoutMs = 60_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for browser gate");
    const status = await evaluate(cdp, "document.body?.dataset?.status ?? 'loading'");
    if (accepted.includes(status)) return status;
    if (status === "error") {
      const progress = await evaluate(cdp, "document.body?.dataset?.progress ?? ''");
      const detail = await evaluate(
        cdp,
        "document.querySelector('#result, #release-status')?.textContent ?? ''",
      );
      throw new Error(`${progress}: ${detail}`);
    }
    await delay(100);
  }
}

export async function launchChrome({
  extraFlags = [],
  headless = true,
  profilePrefix = "p8w-chrome-",
} = {}) {
  const executable = await firstAvailableChrome();
  const version = spawnSync(executable, ["--version"], { encoding: "utf8" }).stdout.trim();
  const profile = await mkdtemp(join(tmpdir(), profilePrefix));
  const processHandle = spawn(
    executable,
    [
      ...(headless ? ["--headless=new"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      ...extraFlags,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  let cdp;
  async function close() {
    cdp?.close();
    await stopProcess(processHandle);
    // Chrome child processes can still finish writing the profile after the browser exits.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try {
    const port = await waitForPort(join(profile, "DevToolsActivePort"), processHandle);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find(({ type }) => type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    cdp = new CdpConnection(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.command("Runtime.enable");
    await cdp.command("Page.enable");
    return {
      cdp,
      executable,
      version,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
