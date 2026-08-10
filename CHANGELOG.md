# Changelog

## 0.1.0-rc.1 — 2026-08-10

First local release candidate of the Chrome/Chromium desktop PICO-8 v0.2.7 Web Player.

- Loads caller-provided `.p8` and `.p8.png` bytes and caller-authorized local multicart bundles.
- Provides the versioned embed API, production Worker isolation, Canvas presentation, Web Audio,
  keyboard/touch/gamepad input, persistence and structured lifecycle recovery.
- Ships as a self-contained static directory plus a deterministic archive and SHA-256 checksums.
- Records 113 API inventory entries as 101 compatible, 5 partial and 7 unsupported, with no
  unknown required entries.
- Keeps BBS crawling, arbitrary URL loading, host-filesystem access, non-Chrome support and
  third-party cart redistribution outside the release profile.

Known Differences and the evidence boundary are maintained in
[`docs/06-testing-compatibility.md`](./docs/06-testing-compatibility.md). This local candidate is
`UNLICENSED`; no npm, remote, tag, website or public release is produced by the build.
