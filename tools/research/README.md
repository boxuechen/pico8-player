# Official Web Player research probes

`capture-official-phase-0e.mjs` reproduces the Phase 0E startup-clock
differential against the real PICO-8 0.2.7 BBS Web Player in an isolated
Chrome/Chromium profile.

The runner builds a project-owned `.p8.png` from the sources under
`tests/fixtures/official-web/`. It opens the official BBS widget and replaces
only that isolated page's `get_cart.php` response through Chrome DevTools
Protocol. It does not upload a cart or modify BBS state. Cached official
player/widget files, generated carts, full-page captures, and temporary debug
artifacts stay under the gitignored `ref/phase0e-official-web/` directory.

Requirements:

- network access to `www.lexaloffle.com`;
- Google Chrome or Chromium; set `P8W_CHROMIUM` when it is not in a standard
  location;
- the repository's pinned Node.js version. The probe PNG encoder is pure Node
  and does not depend on Canvas or an image utility.

Run all three probes explicitly; they are intentionally not part of hermetic
CI:

```text
node tools/research/capture-official-phase-0e.mjs
node tools/research/capture-official-phase-0e.mjs --callback-startup
node tools/research/capture-official-phase-0e.mjs --callback60-startup
```

Each command validates the color markers and exact clock samples before it
prints hashes and capture paths. The reviewed, committed evidence is
`docs/evidence/phase-0e-official-clock.json` plus its three framebuffer PNGs.
