import type { VmLogSnapshot } from "@pico8-web/runtime-core";
import { PICO_EMPTY_INPUT, type PicoInputSnapshot } from "@pico8-web/contracts";
import type { SessionEvent } from "../transport/session-contract.js";
import type { PlayerRuntimePort, PlayerLocalCartSource, PlayerHostCartDataSeed, RuntimeAudioPort } from "../transport/runtime-port.js";
import { isCartLoad, isPicoInputSnapshot } from "../transport/validators.js";
import { RuntimeClientError } from "../transport/runtime-error.js";
import { createSessionController, type SessionController, type SessionControllerOptions, type SessionContext, type SessionBatch } from "./compose-session.js";
import { PcmOutput } from "./audio-transport.js";
import type { FrameRuntimeModule } from "@pico8-web/z8lua-bridge";

function copyInput(input: PicoInputSnapshot): PicoInputSnapshot {
  if (!isPicoInputSnapshot(input)) throw new TypeError("invalid input snapshot");
  return { controllers: input.controllers.slice(), devkit: { ...input.devkit, keypresses: input.devkit.keypresses.slice() } };
}

/** Direct calls with per-operation continuations; no wire dispatch or request matching. */
export class PlayerSession implements PlayerRuntimePort {
  #controller: SessionController | undefined;
  readonly #audio = new PcmOutput();
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #generations = new Set<(generation: number) => void>();
  readonly #cancel = new Set<(error: Error) => void>();
  #tail: Promise<void> = Promise.resolve();
  #generation = 0;
  #inputSequence = 0;
  #frameSequence = 0;
  #retained = false;
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(module: FrameRuntimeModule, options: Omit<SessionControllerOptions, "audioTransport"> = {}) {
    this.#controller = createSessionController(module, { ...options, audioTransport: this.#audio });
  }
  snapshotLogs(): VmLogSnapshot { this.#assertActive(); return this.#controller!.snapshotLogs(); }
  get sessionGeneration(): number { return this.#generation; }
  get hasRetainedCart(): boolean { return this.#retained; }
  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.#assertActive(); this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }
  onSessionGenerationChange(listener: (generation: number) => void): () => void {
    this.#assertActive(); this.#generations.add(listener); return () => this.#generations.delete(listener);
  }
  #advanceGeneration(): void {
    if (this.#generation >= 0xffff_ffff) throw new RangeError("session generation exhausted");
    for (const cancel of [...this.#cancel]) cancel(new RuntimeClientError({
      code: "E_INVALID_STATE", message: "session operation was superseded by replacement",
      phase: "none", recoverable: true,
    }));
    this.#generation++;
    this.#inputSequence = this.#frameSequence = 0;
    for (const listener of this.#generations) listener(this.#generation);
  }
  async loadCart(source: Uint8Array, instructionBudget?: number,
    bundle: readonly PlayerLocalCartSource[] = [], host?: readonly PlayerHostCartDataSeed[]): Promise<SessionEvent> {
    this.#assertActive();
    if (!isCartLoad(source, instructionBudget, bundle, host)) throw new TypeError("invalid cart load arguments");
    const load = { source: source.slice(),
      localCartBundle: bundle.map(entry => ({ ref: entry.ref, bytes: entry.bytes.slice(), access: { ...entry.access } })),
      ...(host === undefined ? {} : { hostCartData: host.map(entry => ({ id: entry.id, bytes: entry.bytes.slice() })) }),
      ...(instructionBudget === undefined ? {} : { instructionBudget }),
    };
    this.#advanceGeneration();
    const event = await this.#invoke(context => this.#controller!.loadCart(context, load), "state");
    this.#retained = event.type === "state" && event.state === "ready";
    return event;
  }
  reset(): Promise<SessionEvent> {
    this.#assertActive(); this.#advanceGeneration();
    return this.#invoke(context => this.#controller!.reset(context), "state");
  }
  start() { return this.#invoke(context => this.#controller!.start(context), "state"); }
  pause() { this.clearInput(); return this.#invoke(context => this.#controller!.pause(context), "state"); }
  resume() { return this.#invoke(context => this.#controller!.resume(context), "state"); }
  stop() { this.clearInput(); return this.#invoke(context => this.#controller!.stop(context), "state"); }
  openPauseMenu() { this.clearInput(); return this.#invoke(context => this.#controller!.openPauseMenu(context), "pause-menu"); }
  closePauseMenu() { this.clearInput(); return this.#invoke(context => this.#controller!.closePauseMenu(context), "pause-menu"); }
  invokeMenuItem(slot: 1 | 2 | 3 | 4 | 5, button: 1 | 2 | 4) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 5 || ![1, 2, 4].includes(button)) {
      return Promise.reject(new TypeError("invalid menu item intent"));
    }
    return this.#invoke(context => this.#controller!.invokeMenuItem(context, slot, button), "pause-menu");
  }
  flushPersistence() { return this.#invoke(context => this.#controller!.flushPersistence(context), "persistence-flushed"); }
  pulse(timestampMs: number, input: PicoInputSnapshot) {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) return Promise.reject(new TypeError("invalid frame timestamp"));
    const sequence = ++this.#frameSequence;
    return this.#invoke(context => this.#controller!.pulse(context, sequence, timestampMs), "heartbeat", input);
  }
  step(input: PicoInputSnapshot) {
    const sequence = ++this.#frameSequence;
    return this.#invoke(context => this.#controller!.step(context, sequence), "heartbeat", input);
  }
  clearInput(): void {
    if (this.#disposed || this.#generation === 0) return;
    const generation = this.#generation, sequence = ++this.#inputSequence;
    void this.#enqueue(() => this.#controller!.input(generation, sequence, PICO_EMPTY_INPUT)).catch(() => undefined);
  }
  attachAudioPort(port: RuntimeAudioPort): void {
    this.#assertActive(); this.#audio.attach(port, this.#generation);
  }
  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    for (const cancel of [...this.#cancel]) cancel(new Error("PlayerSession is disposed"));
    this.#disposal = this.#enqueue(async () => {
      try {
        this.#emit(await this.#controller!.dispose({ sessionGeneration: this.#generation, onResume: events => this.#emit(events) }));
      } catch (error) {
        await this.#controller!.destroy();
        throw error;
      } finally {
        this.#controller = undefined;
        this.#audio.dispose(); this.#listeners.clear(); this.#generations.clear(); this.#retained = false;
      }
    });
    return this.#disposal;
  }
  #enqueue(operation: () => void | Promise<void>): Promise<void> {
    const pending = this.#tail.then(operation);
    this.#tail = pending.catch(() => undefined);
    return pending;
  }
  #invoke(execute: (context: SessionContext) => SessionBatch, terminal: SessionEvent["type"], input?: PicoInputSnapshot): Promise<SessionEvent> {
    if (this.#disposed) return Promise.reject(new Error("PlayerSession is disposed"));
    if (this.#generation === 0) return Promise.reject(new TypeError("no cart session is loaded"));
    let snapshot: PicoInputSnapshot | undefined;
    try { snapshot = input === undefined ? undefined : copyInput(input); }
    catch (error) { return Promise.reject(error); }
    const generation = this.#generation, inputSequence = ++this.#inputSequence;
    return new Promise((resolve, reject) => {
      let settled = false, handling = true;
      const background: (readonly SessionEvent[])[] = [];
      const finish = (error?: Error, result?: SessionEvent) => {
        if (settled) return;
        settled = true; this.#cancel.delete(cancel);
        if (error !== undefined) reject(error); else resolve(result!);
      };
      const cancel = (error: Error) => finish(error);
      const accept = (events: readonly SessionEvent[]) => {
        this.#emit(events);
        for (const event of events) {
          if (event.type === "fault") { finish(new RuntimeClientError(event.error)); return; }
          if (event.type === "state" && event.state === "waiting-host") continue;
          if (event.type === terminal || (terminal === "heartbeat" && event.type === "state" &&
            ["stopped", "ready", "running"].includes(event.state))) { finish(undefined, event); return; }
        }
      };
      const context: SessionContext = { sessionGeneration: generation, onResume(events) {
        if (handling) background.push(events); else accept(events);
      } };
      this.#cancel.add(cancel);
      void this.#enqueue(async () => {
        if (settled) return;
        try {
          if (snapshot !== undefined) this.#controller!.input(generation, inputSequence, snapshot);
          accept(await execute(context));
        } finally {
          handling = false;
          for (const events of background.splice(0)) accept(events);
        }
      }).catch(cancel);
    });
  }
  #emit(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.type === "session-replaced" && event.previousSessionGeneration === this.#generation) {
        this.#generation = event.nextSessionGeneration;
        this.#inputSequence = this.#frameSequence = 0;
        for (const listener of this.#generations) listener(this.#generation);
      }
      if (event.sessionGeneration !== this.#generation) continue;
      for (const listener of [...this.#listeners]) listener(event);
    }
  }
  #assertActive(): void { if (this.#disposed) throw new Error("PlayerSession is disposed"); }
}
