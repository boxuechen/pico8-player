# Development

## Toolchain

| Tool | Version | Source of truth |
| --- | --- | --- |
| Node.js | 24.22.2 | [`.node-version`](../.node-version) |
| pnpm | 10.8.0 | [`package.json`](../package.json) |
| Emscripten | 6.0.5, pinned revision | [`wasm/toolchain.lock.json`](../wasm/toolchain.lock.json) |

Follow the [WASM setup guide](../wasm/README.md) to install and select the exact compiler. Use Chrome/Chromium for browser verification.

```sh
pnpm install --frozen-lockfile
pnpm run build:wasm
pnpm test
pnpm run build:release
```

`build` compiles TypeScript. `build:wasm` generates the production VM and its notices. Ordinary TypeScript changes do not require recompiling WASM. `build:release` verifies the existing WASM against its lock, then creates the static component and deterministic archive.

## Verification

| Command | Coverage |
| --- | --- |
| `pnpm test` | Generated bindings, architecture, codec, runtime/device regressions, tooling and source integrity |
| `pnpm run test:architecture` | Module boundaries and public exports |
| `pnpm run test:runtime` | Execution, graphics, audio, input, persistence, lifecycle and sessions |
| `pnpm run verify:release` | Manifest, file allowlist, hashes, notices, archive and extracted-package use |
| `pnpm run test:browser` | Chrome session loops, default UI, optional Worker, persistence and resource cleanup |
| `pnpm run test:wasm:repro` | Two clean WASM builds compared byte for byte; use for compiler or bridge changes |

Browser tests launch a separate temporary Chrome profile. Set `P8W_CHROMIUM` to choose a Chrome/Chromium executable. CI builds WASM with the pinned toolchain, then runs the default, release and browser gates. Firefox, WebKit, external cartridge downloads and long-running soak tests are outside those gates.

Tests are organized by observable behavior. Use original minimal fixtures, retain behavioral regressions, and update the [API inventory](../spec/pico-api-inventory.yaml) when compatibility changes.

## Local preview

```sh
pnpm run build:release
node tools/browser/server.mjs
```

Open the printed URL and choose a local cartridge. The server binds to an available loopback port and prints the complete `/apps/player/dist/release/demo/` URL.

To explore a local cartridge directory:

```sh
pnpm run gallery --cart-root /absolute/path/to/carts
```

The gallery binds to loopback; cartridge collections stay outside the repository and distribution. Keep generated output in ignored `dist/` directories and temporary evidence in `.cache/`.

## Use the static component

The complete component is `apps/player/dist/release/`; the archive and checksum file are in `apps/player/dist/package/`. Preserve every manifest-listed file and its relative path, including WASM, Worker, Worklet, styles and licenses.

Serve files over HTTP(S). Use JavaScript MIME types for `.js`/`.mjs` and `application/wasm` for `.wasm`. The [artifact contract](../spec/release-artifact-contract.json) records the exact paths, MIME values and CSP profile. An embedding site's policy must allow WebAssembly compilation and the required same-origin scripts, workers and requests.

The demo uses a strict CSP. Put integration code in a separate module file or authorize it with your site's CSP mechanism.

## Publish static assets

After committing and validating the source:

```sh
pnpm run publish:pages
```

The command verifies and publishes the complete component to the `gh-pages` branch under `<source-commit>/`, updates the index and removes previous build directories. Configure GitHub Pages to use the root of `gh-pages`. Publishing does not create a GitHub Release or publish an npm package.

**Only the current published build is retained.** Coordinate Player publication with downstream lock updates:

1. Wait for [Pages](https://boxuechen.github.io/pico8-player/) deployment to finish.
2. Obtain the new directory's `manifest.json` and its SHA-256.
3. Update Maker's `app/player.lock.json` with the directory URL, source commit and manifest hash.
4. Run Maker's tests/build/deployment checks and deploy it.

Maker downloads the full component into its build and serves those assets from its own site; gameplay does not require a live cross-origin Pages import. Integration details are in [Maker's development guide](https://github.com/boxuechen/pico8-maker/blob/main/docs/development.md#player-updates).

Documentation-only changes do not require republishing static assets or changing Maker's pinned runtime.
