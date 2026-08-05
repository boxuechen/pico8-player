# ADR-009: Canvas2D is the default frame presenter

状态：Accepted
日期：2026-08-05

## Context

Phase 0F must select one Chrome/Chromium presenter for the 128 × 128 packed
PICO framebuffer. The presenter is a browser adapter: it must not own draw
state, execute PICO graphics primitives, read WASM memory or drive simulation.

The candidate baseline was Canvas2D. WebGL would add context/resource lifecycle
and a second production path, so it was only authorized if Canvas2D failed
pixel, resize or p95 ≤ 4 ms gates.

## Decision

- Production uses `Canvas2DFramePresenter` as its only default presenter.
- Main-thread code decodes the 8,192-byte low/high-nibble packed snapshot into
  one reused 128 × 128 `ImageData` and presents it with `putImageData`.
- The canvas backing store remains 128 × 128. Letterboxing changes CSS size
  only, with `image-rendering: pixelated`; Canvas smoothing remains disabled.
- `sessionGeneration` and monotonic `frameId` reject stale/replayed frames.
- WebGL is not implemented as a production fallback. Reopening that option
  requires a measured Canvas2D failure and a superseding ADR.

## Evidence

- [Chrome raw result](../../benchmarks/phase-0f/results/chromium-macos-arm64-render.json)
- [Chrome screenshot](../evidence/phase-0f-render-chrome.png)
- Project-owned fixture hashes:
  - packed screen: `003f38517f7c1cccab9d309fb68d3871abe2671716bc4467e610a4cb2937c6f3`
  - RGBA: `b60f72f8ba81fd392d3cbc0a18e22aa61f0cca3df30bad9c81d77fa50663c93d`
- Google Chrome 150 / Apple M4 Pro evidence passed DPR 1, 2 and 1.25,
  fractional CSS resize, palette-only nearest-neighbor and source-pixel hash.
- 10,000-frame result: p50 `0.0364 ms`, p95 `0.0388 ms`, p99 `0.0410 ms`;
  post-GC live heap delta `15,156 bytes`.

## Consequences

- Renderer code remains in `apps/web-player/src/main/render`; RuntimeCore and
  Worker protocol keep packed framebuffer ownership unchanged.
- A 128 × 128 backing store avoids resize-driven Canvas state resets and keeps
  the per-frame path to one bounded decode plus one `putImageData`.
- CSS/browser-compositor scaling is covered by Chrome screenshot/DPR gates;
  it is not part of deterministic core hashes.
- Context-loss handling for a WebGL resource graph is unnecessary in v1;
  Canvas replacement or loss is recovered by constructing a new presenter and
  presenting the next immutable frame snapshot.

## Rejected alternatives

- **WebGL default/fallback:** rejected because Canvas2D passed all correctness,
  lifecycle and performance gates with large margin; a dormant second adapter
  would add unexercised complexity.
- **Canvas-drawn PICO primitives:** rejected because it would move observable
  graphics semantics out of RuntimeCore and make browser rasterization an
  authority.
- **DPR-sized backing store:** rejected because it increases upload work and
  makes a browser resize reset the source surface without improving the fixed
  128 × 128 simulation output.
