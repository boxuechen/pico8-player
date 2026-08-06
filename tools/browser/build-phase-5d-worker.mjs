import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";

const outfile = resolve("apps/web-player/dist/browser/phase-5d-worker.mjs");
await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve("tests/browser/phase-5d-worker.mjs")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  external: ["node:*", "/wasm/dist/z8lua-runtime-v1.mjs"],
  sourcemap: false,
  legalComments: "none",
});
process.stdout.write(`Built ${outfile}\n`);
