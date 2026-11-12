import { PICO_EMPTY_INPUT } from "@pico8-web/contracts";
import type { PicoInputSnapshot } from "@pico8-web/contracts";
import type { SessionCommand, SessionControlCommand, SessionEvent } from "../transport/session-contract.js";
import type { PlayerRuntimePort, PlayerLocalCartSource, PlayerHostCartDataSeed, RuntimeAudioPort } from "../transport/runtime-port.js";
import { isSessionCommand } from "../transport/validators.js";
import { RuntimeClientError } from "../transport/runtime-error.js";
import { createSessionController, type SessionController, type SessionControllerOptions } from "./compose-session.js";
import { PcmOutput } from "./audio-transport.js";
import type { FrameRuntimeModule } from "@pico8-web/z8lua-bridge";

type Body<T = SessionControlCommand> = T extends unknown ? Omit<T, "requestId" | "sessionGeneration"> : never;

/** Direct execution, with no Worker, wire envelopes, response map or watchdog. */
export class PlayerSession implements PlayerRuntimePort {
  #controller: SessionController | undefined;
  readonly #audio = new PcmOutput();
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #generations = new Set<(generation: number) => void>();
  readonly #cancel = new Set<(error: Error) => void>();
  #tail: Promise<void> = Promise.resolve();
  #handling = false;
  readonly #background: SessionEvent[][] = [];
  #generation = 0;
  #nextId = 0;
  #inputSequence = 0;
  #frameSequence = 0;
  #retained = false;
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(module: FrameRuntimeModule, options: Omit<SessionControllerOptions, "audioTransport"> = {}) {
    this.#controller = createSessionController(module, { ...options, audioTransport: this.#audio });
    this.#controller.setEventSink(events => {
      if (this.#handling) this.#background.push([...events]);
      else this.#emit(events);
    });
  }
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
    if (!(source instanceof Uint8Array)) throw new TypeError("cart source must be Uint8Array");
    const body = { type: "loadCart" as const, cartBytes: source.slice().buffer,
      localCartBundle: bundle.map(entry => ({ ref: entry.ref, cartBytes: entry.bytes.slice().buffer, access: { ...entry.access } })),
      ...(host === undefined ? {} : { hostCartData: host.map(entry => ({ id: entry.id, bytes: entry.bytes.slice().buffer })) }),
      ...(instructionBudget === undefined ? {} : { instructionBudget }),
    };
    if (!isSessionCommand({ ...body, requestId: 1, sessionGeneration: 1 })) throw new TypeError("invalid cart load arguments");
    this.#advanceGeneration();
    const event = await this.#call(body, "state");
    this.#retained = event.type === "state" && event.state === "ready";
    return event;
  }
  reset(): Promise<SessionEvent> {
    this.#assertActive(); this.#advanceGeneration(); return this.#call({ type: "reset" }, "state");
  }
  start() { return this.#call({ type: "start" }, "state"); }
  pause() { this.clearInput(); return this.#call({ type: "pause" }, "state"); }
  resume() { return this.#call({ type: "resume" }, "state"); }
  stop() { this.clearInput(); return this.#call({ type: "stop" }, "state"); }
  openPauseMenu() { this.clearInput(); return this.#call({ type: "openPauseMenu" }, "pause-menu"); }
  closePauseMenu() { this.clearInput(); return this.#call({ type: "closePauseMenu" }, "pause-menu"); }
  invokeMenuItem(slot: 1 | 2 | 3 | 4 | 5, button: 1 | 2 | 4) {
    return this.#call({ type: "invokeMenuItem", slot, button }, "pause-menu");
  }
  flushPersistence() { return this.#call({ type: "flushPersistence" }, "persistence-flushed"); }
  pulse(timestampMs: number, input: PicoInputSnapshot) {
    return this.#call({ type: "vsync", timestampMs, sequence: ++this.#frameSequence }, "heartbeat", input);
  }
  step(input: PicoInputSnapshot) {
    return this.#call({ type: "step", sequence: ++this.#frameSequence }, "heartbeat", input);
  }
  clearInput(): void {
    if (this.#disposed || this.#generation === 0) return;
    // Ordered with asynchronous persistence, without waiting for guest continuations.
    void this.#execute(this.#input(PICO_EMPTY_INPUT)).catch(() => undefined);
  }
  attachAudioPort(port: RuntimeAudioPort): void {
    this.#assertActive(); this.#audio.attach(port, this.#generation);
  }
  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    for (const cancel of this.#cancel) cancel(new Error("PlayerSession is disposed"));
    this.#disposal = this.#tail.then(async () => {
      try {
        this.#emit(await this.#controller!.handle({ type: "dispose", requestId: ++this.#nextId,
          sessionGeneration: this.#generation }));
      } catch (error) {
        await this.#controller!.dispose();
        throw error;
      }
      finally {
        this.#controller = undefined; // Release the closure holding the WASM instance even if the caller retains this session.
        this.#audio.dispose(); this.#listeners.clear(); this.#generations.clear(); this.#retained = false;
      }
    });
    return this.#disposal;
  }
  #input(input: PicoInputSnapshot): SessionCommand {
    const command = { type: "input" as const, requestId: 0 as const, sessionGeneration: this.#generation,
      sequence: ++this.#inputSequence, input };
    if (!isSessionCommand(command)) throw new TypeError("invalid input snapshot");
    return { ...command, input: { controllers: input.controllers.slice(), devkit: {
      ...input.devkit, keypresses: input.devkit.keypresses.slice(),
    } } };
  }
  #execute(command: SessionCommand, input?: SessionCommand): Promise<void> {
    const operation = this.#tail.then(async () => {
      this.#handling = true;
      try {
        if (input !== undefined) this.#emit(await this.#controller!.handle(input));
        this.#emit(await this.#controller!.handle(command));
      } finally {
        this.#handling = false;
        for (const events of this.#background.splice(0)) this.#emit(events);
      }
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
  #call(body: Body, terminal: SessionEvent["type"], input?: PicoInputSnapshot): Promise<SessionEvent> {
    if (this.#disposed) return Promise.reject(new Error("PlayerSession is disposed"));
    const command = { ...body, requestId: ++this.#nextId, sessionGeneration: this.#generation } as SessionControlCommand;
    if (!isSessionCommand(command)) return Promise.reject(new TypeError("invalid session operation"));
    let inputCommand: SessionCommand | undefined;
    try { inputCommand = input === undefined ? undefined : this.#input(input); }
    catch (error) { return Promise.reject(error); }
    // A temporary continuation is needed only until the direct result or an async host completion.
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.#listeners.delete(receive); this.#cancel.delete(cancel); };
      const cancel = (error: Error) => { cleanup(); reject(error); };
      const receive = (event: SessionEvent) => {
        if (event.requestId !== command.requestId) return;
        if (event.type === "fault") { cancel(new RuntimeClientError(event.error)); return; }
        if (event.type === "state" && event.state === "waiting-host") return;
        if (event.type === terminal || (terminal === "heartbeat" && event.type === "state" &&
          ["stopped", "ready", "running"].includes(event.state))) {
          cleanup(); resolve(event);
        }
      };
      this.#listeners.add(receive); this.#cancel.add(cancel);
      void this.#execute(command, inputCommand).catch(cancel);
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
