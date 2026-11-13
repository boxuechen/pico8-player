# Contributing to PICO-8 Player

Focused bug reports, reproducible compatibility cases, documentation improvements and pull requests are welcome. English and Chinese are both fine.

## Set up

Follow the [development guide](docs/development.md) for Node.js 22.22.2, pnpm 10.8.0 and the pinned Emscripten compiler. A fresh checkout needs `pnpm run build:wasm` before runtime tests or release builds. No Maker checkout, model account or external cartridge collection is needed.

## Choose the right place

| Change | Owner |
| --- | --- |
| Cartridge parsing | `packages/cart-codec` |
| Graphics, audio synthesis, input and game state | `packages/runtime-core` |
| Lua/WASM execution boundary | `packages/z8lua-bridge` and `wasm/bridge` |
| Session composition and host adapters | `apps/player/src/runtime` |
| Browser controls, rendering and device lifecycle | `apps/player/src/main`, `worker`, `worklet` |
| Authoring experience or model integration | [PICO-8 Maker](https://github.com/boxuechen/pico8-maker) |

Read [AGENTS.md](AGENTS.md), the [architecture guide](docs/architecture.md), and the relevant `spec/` contract before changing behavior. Keep RuntimeCore browser-neutral and main-thread/Worker execution on one implementation. Do not add dependencies on ignored `ref/` directories or personal cartridge collections.

## Validate the change

Run the narrow behavioral test while iterating, then the gates relevant to your change:

```sh
pnpm test
pnpm run verify:release
pnpm run test:browser
```

For compiler or WASM bridge changes, also run `pnpm run test:wasm:repro`. Documentation-only edits need link and example verification; they do not require republishing static assets. CI runs its full gates independently.

Use original minimal fixtures. Test observable behavior and keep useful regressions. If compatibility or public behavior changes, update the owning contract, API inventory and user-facing documentation in the same PR. Keep English/Chinese counterparts aligned, or clearly identify a translation follow-up.

Never refresh a source or artifact checksum just to silence a failure. Explain intentional source changes, preserve provenance and license records, and reproduce generated output using the pinned tools.

## A useful pull request

Explain the triggering problem, the resulting behavior, and the commands you ran. Mention unverified environments or checks you could not run. Keep generated builds, screenshots of local test runs, private paths, credentials and external cartridge collections out of commits. Publication is a separate maintainer action: it replaces the current Pages build and requires a coordinated Maker lock update.

## Reports and licensing

For a bug, provide the source commit or static-build directory, browser/OS or Node version, minimal reproduction, expected result and actual result. Attach a small original cartridge or source snippet where possible. Report a suspected security issue through the [security policy](SECURITY.md).

Original contributions are provided under the project's [MIT License](LICENSE). Third-party code and assets need their source and applicable notices; existing exceptions are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

中文贡献同样欢迎。请尽量提供最小复现、环境版本和验证结果；运行行为、来源记录和许可证以实际源码与契约为准。
