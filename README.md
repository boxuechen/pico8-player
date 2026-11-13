# PICO-8 Player

An embeddable PICO-8-compatible player with standalone sessions for automated playtesting and agent tools. Built with TypeScript and z8lua WebAssembly; powers [PICO-8 Maker](https://github.com/boxuechen/pico8-maker).

[![Verify](https://github.com/boxuechen/pico8-player/actions/workflows/verify.yml/badge.svg)](https://github.com/boxuechen/pico8-player/actions/workflows/verify.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Demo & static build](https://boxuechen.github.io/pico8-player/) · [简体中文](README.zh-CN.md) · [Contributing](CONTRIBUTING.md)

## Usage

- **Browser:** `createPico8Player()` provides Canvas, audio, controls and saves. Main-thread execution is the default; a Worker is optional.
- **Standalone:** `createPico8Session()` loads source or cartridges, advances exact frame batches and returns copied pixels, diagnostics and logs. Works in Node.js without device output.
- **Agent tools:** `createPico8SessionTool()` adds a JSON interface over the same session runtime.

The repository includes its runtime and WASM sources. Maker consumes the complete static component; no separate runtime repository is needed.

## Quick start

Use **Node.js 24.22.2** (same as Maker), **pnpm 10.8.0**, and **Emscripten 6.0.5**. Set up the pinned compiler using the [WASM guide](wasm/README.md).

```sh
git clone https://github.com/boxuechen/pico8-player.git
cd pico8-player
pnpm install --frozen-lockfile
pnpm run build:wasm
pnpm run build:release
node tools/browser/server.mjs
```

Open the printed URL and select a local `.p8` or `.p8.png` cartridge. To embed the player, copy the entire `apps/player/dist/release/` directory into your site and follow the [browser guide](docs/player.md).

## Development

```sh
pnpm test
pnpm run verify:release
pnpm run test:browser
```

CI uses [`.node-version`](.node-version) and runs these gates from a fresh checkout. See the [development guide](docs/development.md) for focused tests and publishing. Pages retains only the current published build; downstream applications should copy it locally and coordinate lock updates.

## Documentation

| Topic | Guide |
| --- | --- |
| Browser embedding, lifecycle and saves | [Player API](docs/player.md) |
| Frame stepping, JSON tools and inspection | [Standalone sessions](docs/standalone-session.md) |
| Module ownership and execution | [Architecture](docs/architecture.md) |
| Toolchain, tests and static distribution | [Development](docs/development.md) |
| Supported behavior and known differences | [Compatibility](docs/compatibility.md) |

Alpha software targeting the PICO-8 v0.2.7 cartridge runtime. Chrome/Chromium is the tested browser target; universal cartridge compatibility is not promised. This is an independent project, not an official Lexaloffle product.

## License

Original code is [MIT-licensed](LICENSE). Dependencies and user-supplied cartridges retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
