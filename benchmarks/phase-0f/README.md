# Phase 0F browser boundary measurements

This suite measures browser adapters rather than PICO-8 simulation behavior.

- Renderer: project-owned packed framebuffer fixture, Canvas2D pixel hash,
  nearest-neighbor/DPR checks, 10,000-frame latency and live-heap trend.
- Audio: synthetic canonical PCM, dedicated Worker-to-AudioWorklet port,
  bounded queue, device-rate resampling and steady-state soak counters.

Smoke artifacts are ignored. Reviewed Chrome evidence is generated explicitly
with the `--evidence` runner option and linked from the Phase 0F evidence file.
