#!/usr/bin/env node

import { createServer } from "node:http";
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_LIMITS = Object.freeze({
  maximumCartFiles: 1000,
  maximumCartBytes: 2 * 1024 * 1024,
  maximumCatalogResponseBytes: 512 * 1024,
});

const PUBLIC_ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const DEFAULT_RELEASE_ROOT = resolve("apps/web-player/dist/release");
const CART_SUFFIXES = [".p8.png", ".p8"];
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/gallery.css", ["gallery.css", "text/css; charset=utf-8"]],
  ["/gallery.mjs", ["gallery.mjs", "text/javascript; charset=utf-8"]],
]);

function fail(message) {
  throw new Error(`Local gallery: ${message}`);
}

function supportedSuffix(name) {
  const lower = name.toLowerCase();
  return CART_SUFFIXES.find((suffix) => lower.endsWith(suffix));
}

function contained(root, candidate) {
  return candidate.startsWith(`${root}${sep}`);
}

function displayMetadata(relativePath, suffix) {
  const fileName = basename(relativePath);
  const stem = fileName.slice(0, -suffix.length);
  const ranked = /^(\d{1,4})[-_ ](.+)$/u.exec(stem);
  const rank = ranked === null ? null : Number(ranked[1]);
  const titleSource = ranked?.[2] ?? stem;
  const title = titleSource
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const groupPath = dirname(relativePath);
  return {
    displayName: fileName,
    title: title || fileName,
    rank: Number.isSafeInteger(rank) ? rank : null,
    group: groupPath === "." ? null : groupPath.split(sep).join("/"),
  };
}

async function collectFiles(root, current, collected, limits) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, path, collected, limits);
      continue;
    }
    if (!entry.isFile()) continue;
    const suffix = supportedSuffix(entry.name);
    if (suffix === undefined) continue;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size <= 0) continue;
    if (metadata.size > limits.maximumCartBytes) {
      fail(`${relative(root, path)} exceeds ${limits.maximumCartBytes} bytes`);
    }
    collected.push({ path, relativePath: relative(root, path), suffix, bytes: metadata.size });
    if (collected.length > limits.maximumCartFiles) {
      fail(`cart count exceeds ${limits.maximumCartFiles}`);
    }
  }
}

export async function createCartCatalog(cartRoot, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (typeof cartRoot !== "string" || cartRoot.trim() === "") {
    fail("--cart-root is required");
  }
  const requestedRoot = resolve(cartRoot);
  let root;
  try {
    root = await realpath(requestedRoot);
  } catch {
    fail("cart root does not exist");
  }
  if (!(await lstat(root)).isDirectory()) fail("cart root must be a directory");

  const files = [];
  await collectFiles(root, root, files, limits);
  if (files.length === 0) fail("cart root contains no supported .p8 or .p8.png files");
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  const entries = files.map((file, index) => {
    const id = `cart-${String(index + 1).padStart(4, "0")}`;
    const format = file.suffix === ".p8.png" ? "p8.png" : "p8";
    return Object.freeze({
      id,
      path: file.path,
      ...displayMetadata(file.relativePath, file.suffix),
      format,
      bytes: file.bytes,
      cartUrl: `/api/carts/${id}`,
      thumbnailUrl: format === "p8.png" ? `/api/carts/${id}/thumbnail` : null,
    });
  });
  const publicCarts = entries.map(({ path: _path, ...entry }) => entry);
  const body = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    count: publicCarts.length,
    carts: publicCarts,
  }));
  if (body.byteLength > limits.maximumCatalogResponseBytes) {
    fail(`catalog response exceeds ${limits.maximumCatalogResponseBytes} bytes`);
  }
  return Object.freeze({
    root,
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    body,
    publicCarts,
  });
}

async function loadReleaseIndex(releaseRoot) {
  const root = await realpath(resolve(releaseRoot)).catch(() => {
    fail("release artifact is missing; run pnpm run build:release first");
  });
  const manifestPath = join(root, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("release manifest is missing or invalid; run pnpm run build:release first");
  }
  if (!Array.isArray(manifest.files) || typeof manifest.csp !== "string") {
    fail("release manifest does not satisfy the release contract");
  }
  const files = new Map([["manifest.json", {
    path: manifestPath,
    mime: "application/json; charset=utf-8",
  }]]);
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || typeof file?.mime !== "string") {
      fail("release manifest contains an invalid file entry");
    }
    const path = resolve(root, file.path);
    if (!contained(root, path)) fail("release manifest contains an escaping path");
    files.set(file.path, { path, mime: file.mime });
  }
  return { root, manifest, files };
}

function commonHeaders(csp, contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy": csp,
    "content-type": contentType,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function send(response, requestMethod, status, headers, body = undefined) {
  response.writeHead(status, headers);
  response.end(requestMethod === "HEAD" ? undefined : body);
}

async function safeCartBytes(catalog, entry) {
  const resolved = await realpath(entry.path).catch(() => undefined);
  if (resolved === undefined || !contained(catalog.root, resolved)) {
    fail("catalog entry is no longer contained by cart root");
  }
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.size !== entry.bytes) {
    fail("catalog entry changed after startup");
  }
  return readFile(resolved);
}

export async function startLocalGallery({
  cartRoot,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  port = 4178,
  limits = DEFAULT_LIMITS,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("port must be 0..65535");
  const [catalog, release] = await Promise.all([
    createCartCatalog(cartRoot, limits),
    loadReleaseIndex(releaseRoot),
  ]);
  const csp = release.manifest.csp;

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      send(response, method, 405, {
        ...commonHeaders(csp, "text/plain; charset=utf-8"),
        allow: "GET, HEAD",
      }, "Method not allowed");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/favicon.ico") {
        send(response, method, 204, commonHeaders(csp, "image/x-icon"));
        return;
      }
      const staticFile = STATIC_FILES.get(url.pathname);
      if (staticFile !== undefined) {
        const [name, mime] = staticFile;
        send(response, method, 200, commonHeaders(csp, mime), await readFile(join(PUBLIC_ROOT, name)));
        return;
      }
      if (url.pathname === "/api/carts") {
        send(response, method, 200, commonHeaders(csp, "application/json; charset=utf-8"), catalog.body);
        return;
      }
      const cartMatch = /^\/api\/carts\/(cart-\d{4})(\/thumbnail)?$/u.exec(url.pathname);
      if (cartMatch !== null) {
        const entry = catalog.byId.get(cartMatch[1]);
        const thumbnail = cartMatch[2] !== undefined;
        if (entry === undefined || (thumbnail && entry.thumbnailUrl === null)) {
          send(response, method, 404, commonHeaders(csp, "text/plain; charset=utf-8"), "Not found");
          return;
        }
        const body = await safeCartBytes(catalog, entry);
        const mime = thumbnail || entry.format === "p8.png"
          ? "image/png"
          : "text/plain; charset=utf-8";
        send(response, method, 200, {
          ...commonHeaders(csp, mime),
          "content-length": String(body.byteLength),
        }, body);
        return;
      }
      if (url.pathname.startsWith("/release/")) {
        const releasePath = decodeURIComponent(url.pathname.slice("/release/".length));
        const entry = release.files.get(releasePath);
        if (entry === undefined) {
          send(response, method, 404, commonHeaders(csp, "text/plain; charset=utf-8"), "Not found");
          return;
        }
        send(response, method, 200, commonHeaders(csp, entry.mime), await readFile(entry.path));
        return;
      }
      send(response, method, 404, commonHeaders(csp, "text/plain; charset=utf-8"), "Not found");
    } catch (error) {
      const message = error instanceof URIError ? "Invalid request path" : "Local resource unavailable";
      send(response, method, error instanceof URIError ? 400 : 409,
        commonHeaders(csp, "text/plain; charset=utf-8"), message);
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") fail("unable to resolve loopback address");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    catalog,
    async close() {
      await new Promise((resolvePromise, reject) => {
        server.close((error) => error === undefined ? resolvePromise() : reject(error));
      });
    },
  };
}

export function parseCliArgs(argv) {
  const options = { cartRoot: undefined, releaseRoot: DEFAULT_RELEASE_ROOT, port: 4178 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!["--cart-root", "--release-root", "--port"].includes(flag)) {
      fail(`unknown argument ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value`);
    index += 1;
    if (flag === "--cart-root") options.cartRoot = value;
    else if (flag === "--release-root") options.releaseRoot = value;
    else options.port = Number(value);
  }
  return options;
}

function usage() {
  return `Usage: node tools/local-gallery/server.mjs --cart-root <directory> [--port 4178]\n\n` +
    `The server binds only to 127.0.0.1. Cart files remain outside the build and release artifact.`;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const gallery = await startLocalGallery(options);
  process.stdout.write([
    "PICO-8 Local Cart Gallery",
    `Carts: ${gallery.catalog.entries.length}`,
    `Open: ${gallery.origin}/`,
    "Press Ctrl+C to stop.",
    "",
  ].join("\n"));
  const shutdown = async () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await gallery.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
