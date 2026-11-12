# Changelog

## Unreleased local changes — 2026-11-12

- Default Web execution now directly calls the shared session on the main thread. `execution: "worker"`
  retains the optional isolated adapter; RuntimeCore and z8lua guest semantics are unchanged.
- Adds standalone `createPico8Session()` and `createPico8SessionTool(session)` exports for agent loops.
  Manual sessions load Lua or cart bytes, advance 1–600 exact frames with input, and observe copy-owned
  pixels/diagnostics with session/revision/generation/frame identity. They create no UI or audio device.
- JSON tools support load_source, advance, observe, reset and dispose. Images are RGBA8 base64;
  platform-specific plugin registration and PNG/image-content encoding remain the caller's responsibility.
- Main-thread execution retains the VM instruction cap but has no preemptive wall-clock watchdog.

Use the complete extracted release in Node or import the same module from a browser:

```js
import { createPico8Session, createPico8SessionTool } from "./main/player.mjs";
const session = await createPico8Session();
try {
  const tool = createPico8SessionTool(session);
  await tool.execute({ action: "load_source", source: "function _draw() cls(8) end" });
  const result = await tool.execute({ action: "advance", frames: 1 });
  // result.observation.frame: 128x128 rgba8-base64 pixels and logical frameId.
} finally {
  await session.dispose();
}
```

## 0.2.0-alpha.1 — 2026-08-11

Local mobile-integration candidate with Embed API v2.

- Adds an opt-in hosted shell that leaves selection and controls to the caller.
- Adds copy-owned external input snapshots and explicit inactive/background/active lifecycle entry points.
- Adds caller-provided `cartdata()` hydration/write/flush with Worker acknowledgement and typed status events.
- Keeps the default full Web shell and Worker IndexedDB profile when no host adapter is supplied.
- Remains Chrome/Chromium-gated and `UNLICENSED`; no remote, package, tag or website publication is performed.

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
