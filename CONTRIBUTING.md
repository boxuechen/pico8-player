# Contributing

Issues and pull requests in English or Chinese are welcome.

1. Follow the [setup instructions](README.md#quick-start), using the Node version in `.node-version`.
2. Read [AGENTS.md](AGENTS.md), the [architecture guide](docs/architecture.md) and the relevant `spec/` contract before changing behavior.
3. Add a small regression case and run the [checks relevant to your change](docs/development.md#verification).
4. Explain the problem, resulting behavior and validation in your PR. Update the owning contract or guide when needed.

Keep guest behavior in RuntimeCore and browser resources in the app adapters. Use original fixtures; do not depend on personal cartridge collections or ignored `ref/` checkouts. Preserve third-party provenance and explain any intentional checksum changes.

For bug reports, include the commit or static-build URL, environment, reproduction steps and expected/actual results. Remove credentials and private content. Report vulnerabilities through [SECURITY.md](SECURITY.md); authoring UI and model-provider issues belong in [Maker](https://github.com/boxuechen/pico8-maker/issues).

Original contributions use the project's [MIT License](LICENSE). Identify the source and license of any third-party material. Do not commit generated builds or local test reports. Publishing is a separate maintainer action coordinated with Maker.
