# Architecture

English · [简体中文](architecture.zh-CN.md)

## One execution implementation

```text
Browser facade ── controller / lifecycle queue ── runtime port
                                                       │
Standalone session / JSON tool ── lifecycle queue ──────┤
                                                       ▼
                                          compose-session.ts
                                                       │
                              RuntimeCore ← ports ← z8lua bridge → WASM
```

`compose-player.ts` connects the runtime, Canvas, input, audio and host lifecycle. The browser's default main-thread player calls the shared session directly. With `execution: "worker"`, a Worker client reaches the same session implementation through bounded messages; command dispatch, request IDs and Worker generations belong to that adapter.

Manual sessions do not create a DOM tree, animation loop or audio device. AudioWorklet handles device PCM queues and resampling; it does not advance the simulation.

## Ownership

| Location | Owns |
| --- | --- |
| `packages/contracts` | Stable value types, input snapshots and errors; no state or platform dependencies |
| `packages/cart-codec` | Cartridge bytes, P8SCII and code decoding; depends on contracts |
| `packages/runtime-core` | RAM, graphics, audio, input, cartridge/session state, frame scheduling and host capability ports |
| `packages/z8lua-bridge` | VM port, WASM handles, memory leases and host bindings; Core imports are type-only |
| `apps/player/src/runtime` | Shared session composition, standalone API, JSON tool, frame decoding, PCM output and host adapters |
| `apps/player/src/main` | Browser API, Canvas, audio devices, input, UI and Worker client |
| `apps/player/src/transport` | Validated runtime commands/events; optional Worker protocol |
| `apps/player/src/worker` | Worker entry point and message adapter |
| `apps/player/src/worklet` | PCM consumption, resampling and device statistics |
| `wasm` | Pinned z8lua source, project bridge, patches, license records and build locks |

Core does not use DOM, Worker, fetch, IndexedDB or a concrete WASM module. WASM handles and pointers are not exposed to UI consumers. The physical RAM lease lasts from VM creation to destruction; logical addressing goes through the memory adapter. PNG cartridge decoding does not use Canvas.

TypeScript project references define build order. Architecture tests check import boundaries, platform APIs, package exports and generated bindings. Production source and build configuration must not depend on ignored `ref/` checkouts.

## Frames and state

Core owns the authoritative game state. z8lua supplies the Lua parser/VM, Q16.16 arithmetic, coroutines and garbage collection. The frame runtime commits screen, input, audio and persistence at complete logical boundaries; asynchronous host requests resume within their original transaction.

Real-time playback uses animation callbacks to schedule logical ticks. Manual `advance` executes a requested frame count without relying on wall-clock time. Default execution has a deterministic instruction cap, but a same-thread timer cannot preempt an in-progress synchronous WASM call.

Input is an eight-player snapshot plus a devkit batch. In a manual batch, held buttons apply throughout, while keypress, wheel and movement transients apply only to the first frame. Pause, menu, focus loss and stop release controls.

## Lifecycle

Each browser player or standalone session has a serial lifecycle queue. API calls, controls and environment events use that queue. A browser `start()` resolves after the current generation's first frame is actually presented to Canvas, rather than merely after a state change to running.

Changing cartridges stops the previous producer and flushes its persistence identity before hydrating the next one. Host requests carry generation and request identity, so stale completions cannot write into a replacement session. Failures do not permanently poison the lifecycle queue.

`dispose()` rejects queued work that has not started, finishes required persistence work, and releases VM references, listeners, animation callbacks, audio resources and the optional Worker. Disposal is idempotent. It cannot interrupt a single synchronous WASM call already executing on the main thread.

## Explicit host capabilities

Cartridge bytes and local bundles are supplied by the caller. A resolver does not infer filesystem, BBS or network authority from a cartridge name. Guest `load/reload/cstore` operations resume only from an authorized root; nested coroutine suspension is rejected without external side effects.

Manual sessions retain memory cartdata within their instance. Browser players use IndexedDB by default, with an optional host persistence adapter. A flush result distinguishes durable storage from a queued or failed write.

## Observation and inspection

Observers receive copied snapshots; reading them does not execute guest code. Structured diagnostics, bounded logs and opt-in inspection serve automated tests and agent loops.

Read inspection uses raw access and does not invoke metamethods. Debug inspection has its own bounded execution rules and can mutate state; it is distinct from normal gameplay. Inspection is opt-in on standalone memory sessions and is not exposed through the real-time browser facade. Details and failure semantics are in the [session guide](standalone-session.md#inspection-and-debugging).
