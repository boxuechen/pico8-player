# ADR-031 — Standalone session and main-thread default

Status: Accepted · Date: 2026-11-12

## Decision

The user selected a standalone controllable/observable PICO-8 component for agent development loops.
Reuse RuntimeCore and z8lua unchanged. Extract app session orchestration into runtime/, which runs in either
Window or Worker. UI/main and Worker are consumers; neither owns a second simulation implementation.
Default web execution directly calls the session; optional Worker transport adapts the same commands/events.
Wire v/workerGeneration remain exclusively in the Worker boundary. Session identity and asynchronous operation
correlation remain because cart replacement and external persistence are asynchronous even on one thread.
Audio synthesis stays in RuntimeCore; the active execution host feeds the existing dedicated Worklet port.
Standalone sessions expose manual stepping and copy-owned observations; no DOM/RAF or audio device is required.
The public web facade retains API v2; standalone session/tool surface is additive and separately versioned.

## Consequences

Supersedes ADR-004 Worker-only placement and ADR-015 exclusive worker composition ownership; partially supersedes
ADR-010 producer placement and ADR-017/027 watchdog requirement for the default host. The deterministic 32M
instruction cap and all guest semantics remain unchanged. Main-thread JS/WASM cannot be interrupted by a same-thread
timer; no responsiveness or hard timeout guarantee is claimed. Worker adapter retains terminate/restart containment.
Shared runtime may import core/codec/bridge; UI may only import its explicit facade, never concrete core/VM.
Browser storage/audio remain app adapters. No new package or core-to-browser dependency is introduced.

## Verification

Phase 17 owns direct/Worker parity, manual agent loop, Chrome resource teardown and architecture enforcement.
Results will be recorded in Phase 17 exit evidence.
