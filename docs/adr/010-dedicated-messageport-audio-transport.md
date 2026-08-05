# ADR-010: Dedicated MessagePort is the default audio transport

状态：Accepted
日期：2026-08-05

## Context

Phase 0F must select one bounded path from the Runtime Worker to an
AudioWorklet. The baseline transfers one end of a Window-created
`MessageChannel` to each execution domain. Window relay and SharedArrayBuffer
were authorized only if the direct path failed a real Chrome steady-state gate.

This decision covers transport and device queue behavior, not complete PICO-8
SFX/music synthesis. The producer uses project-owned deterministic synthetic
22,050 Hz mono PCM16LE.

## Decision

- The default path is Worker → dedicated `MessagePort` → AudioWorklet.
- PCM never enters the Window ↔ Runtime Worker command/response protocol.
- Transport DTOs are versioned and include generation, sequence, first sample,
  canonical sample rate, frame count and transferable PCM bytes.
- The Worklet owns a fixed three-second source ring, 0.5-second prebuffer,
  0.25-second low-water and two-second high-water threshold.
- Queue overflow drops the oldest source frames and increments observable
  counters; it never blocks simulation or grows memory.
- The Worklet performs device-only linear resampling to the actual
  `AudioContext.sampleRate`; canonical PCM and simulation time stay unchanged.
- `DedicatedAudioFrontend` explicitly starts suspended and resumes only through
  its caller's trusted gesture path.
- Window relay and SAB/COOP/COEP paths are not implemented. Reconsidering one
  requires a reproducible direct-port failure and a superseding ADR.

## Evidence

- [Chrome 10-minute raw result](../../benchmarks/phase-0f/results/chromium-macos-arm64-audio.json)
- Google Chrome 150 / Apple M4 Pro, two AudioContexts running concurrently:
  requested and actual device rates were 44,100 and 48,000 Hz.
- CDP generated a trusted click with active user activation; both contexts were
  suspended before it and running afterward.
- Measured duration: `600,000.6 ms`; rAF callbacks `72,002`, missed frames `0`.
- Both rates reported `0` startup/steady underruns, overruns, dropped source
  frames and sample-sequence discontinuities.
- Queue peaks were `22,406` and `22,530` source frames, below the configured
  `44,100` high-water threshold; more than 30,000 chunks passed each path.

## Consequences

- Default playback works without cross-origin isolation, SharedArrayBuffer,
  COOP or COEP deployment headers.
- Worklet/device backpressure cannot pause, accelerate or roll back guest
  simulation. Failure is observable through stats and bounded dropping.
- Generation/reset/dispose must replace or close transferred ports and reject
  stale chunks; these lifecycle rules remain integration gates.
- Linear resampling is sufficient for this transport spike. Future audio
  conformance may replace the resampler behind the same queue/ownership
  boundary if quality evidence requires it.

## Rejected alternatives

- **Window relay:** rejected because the direct port passed steady-state and
  lifecycle gates; relaying would mix PCM pressure into UI/control traffic.
- **SharedArrayBuffer ring:** rejected because the bounded transferable path
  passed with zero underrun and no unbounded growth; SAB would add cross-origin
  isolation and deployment complexity without measured benefit.
- **AudioWorklet-owned synthesis clock:** rejected because a device callback is
  not authoritative simulation time and may not drive guest state.
