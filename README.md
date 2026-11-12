# PICO-8 Web Player

A local `0.2.0-alpha.1` PICO-8 v0.2.7 mobile-integration candidate for desktop Chrome/Chromium, built with a z8lua
WASM language core and a browser-neutral TypeScript RuntimeCore. It accepts caller-provided
`.p8`/`.p8.png` bytes or a caller-authorized local multicart bundle; it has no BBS crawler,
arbitrary-URL cart loader, host-filesystem resolver, or non-Chrome support claim.

The current API inventory contains 113 entries: 101 compatible, 5 partial
(`flip`, `printh`, `stat`, `print`, `extcmd`), 7 unsupported platform/console entries, and zero
unknown required release modes. See [the compatibility profile](./docs/06-testing-compatibility.md#1-当前发布口径)
for Known Differences and scope exclusions.

## Build and run the local demo

The pinned toolchain is Node 22.22.x, pnpm 10.8.0 and Emscripten 6.0.5. The exact emsdk source
lock is documented in [`wasm/README.md`](./wasm/README.md).

```sh
pnpm install --frozen-lockfile
pnpm run build:release
python3 -m http.server 8000 --directory apps/web-player/dist/release
```

Open `http://127.0.0.1:8000/demo/` in Chrome/Chromium and choose a local `.p8` or `.p8.png`.
Static HTTP is required: `file://` does not provide the Worker, module, MIME and CSP behavior used
by the release gate. Cart bytes remain in the browser; the demo does not upload them or resolve a
cart URL.

The same build writes `apps/web-player/dist/package/pico8-web-player-0.2.0-alpha.1.tar.gz` and
`SHA256SUMS`. The archive contains one top-level directory. After checking the archive checksum,
extract it and run `node verify.mjs` inside that directory to verify its embedded allowlist, lengths
and hashes without repository-relative inputs.

## Embed the release artifact

Host the complete `apps/web-player/dist/release/` tree without renaming individual artifacts.
Consumers discover private filenames through the six stable manifest keys:

```js
const releaseRoot = new URL("/pico8-player/", location.href);
const manifest = await fetch(new URL("manifest.json", releaseRoot)).then((response) => {
  if (!response.ok) throw new Error(`release manifest: HTTP ${response.status}`);
  return response.json();
});
const { createPico8WebPlayer } = await import(
  new URL(manifest.artifacts.main.path, releaseRoot)
);

const player = await createPico8WebPlayer({ root: document.querySelector("#player") });
const bytes = new Uint8Array(await selectedFile.arrayBuffer());
await player.loadCart(bytes, { displayName: selectedFile.name });
await player.start();

// Later: await player.pause(), resume(), reset(), stop(), or dispose().
```

The manifest fetch above discovers release assets only; cart acquisition remains the caller's
explicit responsibility. Use `pnpm run verify:release` for the bounded Chrome RC gate. No npm package,
website, GitHub Release, or other external publication is performed by the build or test commands.

## Standalone session and agent tools

The web facade executes on the main thread by default. Set `execution: "worker"` to use the optional
isolated adapter. Both hosts use the same session execution and RuntimeCore.

The release also exports `createPico8Session()` and `createPico8SessionTool(session)` for a manual
source → exact-frame input → image/diagnostic observation loop. A standalone session creates no DOM,
RAF, Worker or audio device. It works in Chrome and in a Node process importing the extracted release.
See [the standalone component guide](./docs/11-standalone-session.md) for code, JSON tool arguments,
image encoding, lifecycle boundaries and plugin integration.

## Local cart gallery

The repository includes a loopback-only developer gallery for manually browsing a caller-authorized directory
of `.p8` and `.p8.png` files. It is separate from the release artifact and never copies carts into the build:

```sh
pnpm run build:release
node tools/local-gallery/server.mjs --cart-root /absolute/path/to/your/carts
```

Open the printed `http://127.0.0.1:4178/` URL in Chrome/Chromium. The CLI requires an explicit cart root;
there is no built-in corpus path, remote fetcher, upload, or non-loopback bind option.

## Release and license status

The local candidate is versioned `0.2.0-alpha.1` and remains `UNLICENSED`. The project-owned source
and compiled artifacts are not granted redistribution rights; see [`LICENSE`](./LICENSE).
Third-party components retain their own terms and are included in the generated release notices.
[`CHANGELOG.md`](./CHANGELOG.md) records the user-visible candidate scope. Creating a remote, tag,
website, npm package or public release requires a separate publication decision.

Engineering status, architecture boundaries, verification and immutable exit evidence start at
[`docs/README.md`](./docs/README.md).
