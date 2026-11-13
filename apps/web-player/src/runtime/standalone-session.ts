export { decodeP8, type DecodedP8Cart } from "@pico8-web/cart-codec";
import { prepareInspection, type InspectionRequest, type InspectionResult } from "@pico8-web/runtime-core";
export { INSPECTION_LIMITS, prepareInspection, type InspectionRequest, type InspectionResult, type InspectedValue } from "@pico8-web/runtime-core";
import { PlayerSession } from "./player-session.js";
import { PICO_EMPTY_INPUT } from "@pico8-web/contracts";
import type { PicoInputSnapshot, SerializedRuntimeError } from "@pico8-web/contracts";
import { isPicoInputSnapshot } from "../transport/validators.js";
import type { SessionEvent } from "../transport/session-contract.js";
import type { PlayerRuntimePort, PlayerLocalCartSource } from "../transport/runtime-port.js";
import { createPlayerSession } from "./create-session.js";
import { PlayerLifecycleQueue } from "./lifecycle-queue.js";
import { decodePackedPicoFrame, PICO_RGBA_FRAME_BYTES } from "./pico-frame.js";

export const PICO8_SESSION_API_VERSION = 1 as const;
export interface Pico8SessionOptions {
  readonly inspection?: boolean;
  /** Ephemeral sessions are the default for repeatable tool runs. */
  readonly persistence?: "memory" | "indexeddb";
}
export interface Pico8SessionLoadOptions {
  readonly instructionBudget?: number;
  readonly localCartBundle?: readonly PlayerLocalCartSource[];
}
export interface Pico8SessionFrame {
  readonly frameId: number;
  readonly targetFps: 30 | 60;
  readonly cpuInstructions: number;
  readonly slowFrame: boolean;
  readonly width: 128;
  readonly height: 128;
  readonly rgba: Uint8ClampedArray;
  readonly packedScreen: Uint8Array;
  readonly displayPalette: Uint8Array;
}
export interface Pico8SessionObservation {
  readonly v: 1;
  readonly sessionId: string;
  readonly revision: number;
  readonly generation: number;
  readonly state: string;
  readonly frame: Pico8SessionFrame | null;
  readonly diagnostics: readonly SerializedRuntimeError[];
}
export interface Pico8AdvanceOptions {
  /** 1–600 committed logical frames. No elapsed-time or RAF dependence. */
  readonly frames: number;
  /** Held controller buttons; transient devkit events apply only to the first frame. */
  readonly input?: PicoInputSnapshot;
}
/** Guest sfx()/music() starts during an advance; only for inspection sessions. */
export type Pico8AudioEvent =
  | { readonly frameId: number | null; readonly sfx: number; readonly channel: number; readonly overMusic: boolean }
  | { readonly frameId: number | null; readonly music: number };
export interface Pico8AudioEvents {
  readonly events: readonly Pico8AudioEvent[];
  readonly dropped: number;
}
export const PICO8_AUDIO_EVENT_LIMIT = 32;
export interface Pico8AdvanceResult {
  readonly requestedFrames: number;
  readonly completedFrames: number;
  readonly outcome: "completed" | "stopped" | "faulted" | "session-replaced" | "interrupted";
  readonly observation: Pico8SessionObservation;
  /** Present for inspection sessions: audio calls made during these frames (including pending boot calls). */
  readonly audio?: Pico8AudioEvents;
}

/** A standalone manual session: no DOM, RAF, Worker or audio device is created. */
export class Pico8Session {
  readonly #runtime: PlayerSession;
  readonly #queue = new PlayerLifecycleQueue();
  readonly #id = globalThis.crypto.randomUUID();
  readonly #remove: (() => void)[];
  #revision = 0;
  #state = "empty";
  #frame: Extract<SessionEvent, { type: "frame" }> | undefined;
  #diagnostics: SerializedRuntimeError[] = [];
  #frameCount = 0;
  #disposal: Promise<void> | undefined;
  readonly #inspection: boolean;
  private constructor(runtime: PlayerSession, inspection: boolean) {
    this.#runtime = runtime;
    this.#inspection = inspection;
    this.#remove = [runtime.onSessionGenerationChange(() => { this.#frame = undefined; }),
      runtime.onEvent(event => {
        if (event.type === "state") this.#state = event.state;
        if (event.type === "frame") { this.#frame = event; this.#frameCount++; }
        if (event.type === "fault" || event.type === "diagnostic") {
          if (event.type === "fault") this.#state = "faulted";
          this.#diagnostics.push(event.error);
          if (this.#diagnostics.length > 64) this.#diagnostics.shift();
        }
      })];
  }
  static async create(options: Pico8SessionOptions = {}): Promise<Pico8Session> {
    if (options.inspection && options.persistence === "indexeddb") throw new TypeError("inspection requires memory persistence");
    if (options.persistence !== undefined && !["memory", "indexeddb"].includes(options.persistence)) {
      throw new TypeError("unknown persistence profile");
    }
    return new Pico8Session(await createPlayerSession(options.persistence === "indexeddb", options.inspection === true),
      options.inspection === true);
  }
  loadCart(bytes: Uint8Array, options: Pico8SessionLoadOptions = {}): Promise<Pico8SessionObservation> {
    if (!(bytes instanceof Uint8Array)) return Promise.reject(new TypeError("cart bytes must be Uint8Array"));
    const copy = bytes.slice();
    const bundle = options.localCartBundle?.map(entry => ({ ref: entry.ref, bytes: entry.bytes.slice(), access: { ...entry.access } }));
    return this.#queue.run(async () => {
      this.#revision++;
      this.#frame = undefined; this.#diagnostics = []; this.#state = "loading";
      try { await this.#runtime.loadCart(copy, options.instructionBudget, bundle); }
      catch (error) {
        if (this.#state !== "faulted") throw error;
      }
      return this.observe();
    });
  }
  loadSource(source: string, options: Pico8SessionLoadOptions = {}): Promise<Pico8SessionObservation> {
    if (typeof source !== "string") return Promise.reject(new TypeError("Lua source must be a string"));
    // The codec remains the single P8SCII/parser authority; raw section delimiters are not code.
    if (/^__[a-zA-Z0-9_]+__\s*$/m.test(source)) return Promise.reject(new TypeError("use loadCart for cartridge sections"));
    return this.loadCart(new TextEncoder().encode(
      `pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n${source}\n`), options);
  }
  reset(): Promise<Pico8SessionObservation> {
    return this.#queue.run(async () => {
      this.#diagnostics = []; this.#frame = undefined;
      try { await this.#runtime.reset(); }
      catch (error) { if (this.#state !== "faulted") throw error; }
      return this.observe();
    });
  }
  advance(options: Pico8AdvanceOptions): Promise<Pico8AdvanceResult> {
    if (!Number.isInteger(options.frames) || options.frames < 1 || options.frames > 600) {
      return Promise.reject(new RangeError("frames must be an integer between 1 and 600"));
    }
    const requestedFrames = options.frames;
    const raw = options.input ?? PICO_EMPTY_INPUT;
    if (!isPicoInputSnapshot(raw)) return Promise.reject(new TypeError("invalid input snapshot"));
    // Freeze caller input at admission, before preceding operations can await I/O.
    const input = { controllers: raw.controllers.slice(), devkit: { ...raw.devkit, keypresses: raw.devkit.keypresses.slice() } };
    return this.#queue.run(async () => {
      const generation = this.#runtime.sessionGeneration;
      const before = this.#frameCount;
      let outcome: Pico8AdvanceResult["outcome"] = "completed";
      const audio: Pico8AudioEvent[] = [];
      let audioDropped = 0;
      const collectAudio = () => {
        if (!this.#inspection || this.#runtime.sessionGeneration !== generation) return;
        const log = this.#runtime.takeAudioEvents();
        const frameId = this.#frame?.frameId ?? null;
        audioDropped += log.dropped;
        for (const event of log.events) {
          if (audio.length >= PICO8_AUDIO_EVENT_LIMIT) { audioDropped++; continue; }
          audio.push("sfx" in event
            ? { frameId, sfx: event.sfx, channel: event.channel, overMusic: event.music }
            : { frameId, music: event.music });
        }
      };
      if (!["ready", "paused"].includes(this.#state)) throw new Error("advance requires a ready or paused session");
      try {
        if (this.#state === "ready") await this.#runtime.start();
        else await this.#runtime.resume();
        for (let i = 0; i < requestedFrames; i++) {
          if (this.#queue.closed) { outcome = "interrupted"; break; }
          const framesBefore = this.#frameCount;
          const snapshot = i === 0 ? input : { controllers: input.controllers, devkit: { ...input.devkit,
            wheelRaw: 0, movementXRaw: 0, movementYRaw: 0, keypresses: [],
          } };
          await this.#runtime.step(snapshot);
          collectAudio();
          if (this.#runtime.sessionGeneration !== generation) { outcome = "session-replaced"; break; }
          if (this.#state === "stopped") { outcome = "stopped"; break; }
          if (this.#frameCount === framesBefore) { outcome = "interrupted"; break; }
          // Yield between bounded slices so disposal/UI can be serviced on the same thread.
          if ((i + 1) % 8 === 0) await new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));
        }
      } catch (error) {
        if (this.#state !== "faulted") throw error;
        outcome = "faulted";
      } finally {
        if (this.#state === "running") await this.#runtime.pause();
        this.#runtime.clearInput();
      }
      // Calls made before a fault are still evidence; a torn-down runtime has none.
      if (outcome === "faulted") { try { collectAudio(); } catch { /* no runtime left */ } }
      return { requestedFrames, completedFrames: this.#frameCount - before, outcome, observation: this.observe(),
        ...(this.#inspection ? { audio: { events: audio, dropped: audioDropped } } : {}) };
    });
  }
  inspect(request: InspectionRequest): Promise<InspectionResult> {
    const prepared = prepareInspection(request);
    return this.#queue.run(async () => {
      if (!this.#frame || !["ready","paused"].includes(this.#state)) throw new Error("inspect requires a completed frame");
      return this.#runtime.inspect(prepared);
    });
  }

  /** Non-destructive log snapshot. Cursor is local to this loaded VM generation. */
  readLogs(after = 0) {
    if (!Number.isInteger(after) || after < 0 || after > 0xffffffff) throw new TypeError("invalid log cursor");
    const snapshot = this.#runtime.snapshotLogs();
    const first = snapshot.entries[0]?.sequence ?? snapshot.sequence + 1;
    return { cursor: snapshot.sequence, dropped: Math.max(0, first - after - 1),
      entries: snapshot.entries.filter(entry => entry.sequence > after).map(entry => ({
        sequence: entry.sequence, frameId: entry.frameId,
        text: Array.from(entry.bytes, byte => byte >= 32 && byte <= 126 || byte === 10 || byte === 9
          ? String.fromCharCode(byte) : "\\x" + byte.toString(16).padStart(2, "0")).join(""), truncated: entry.truncated,
      })) };
  }

  /** Pure snapshot: does not run guest code or consume diagnostic/input events. */
  observe(): Pico8SessionObservation {
    const frame = this.#frame;
    let snapshot: Pico8SessionFrame | null = null;
    if (frame !== undefined) {
      const rgba = new Uint8ClampedArray(PICO_RGBA_FRAME_BYTES);
      const packedScreen = new Uint8Array(frame.packedScreen).slice();
      const displayPalette = new Uint8Array(frame.displayPalette).slice();
      decodePackedPicoFrame(packedScreen, rgba, undefined, displayPalette);
      snapshot = { frameId: frame.frameId, targetFps: frame.targetFps, cpuInstructions: frame.cpuInstructions,
        slowFrame: frame.slowFrame, width: 128, height: 128, rgba, packedScreen, displayPalette };
    }
    return { v: 1, sessionId: this.#id, revision: this.#revision, generation: this.#runtime.sessionGeneration,
      state: this.#queue.closed ? "disposed" : this.#state, frame: snapshot,
      diagnostics: this.#diagnostics.map(error => ({ ...error, ...(error.details === undefined ? {} : { details: { ...error.details } }) })) };
  }
  dispose(): Promise<void> {
    return this.#disposal ??= this.#queue.close(async () => {
      try { await this.#runtime.dispose(); }
      finally { this.#remove.forEach(remove => remove()); this.#frame = undefined; this.#state = "disposed"; }
    });
  }
}
export function createPico8Session(options?: Pico8SessionOptions): Promise<Pico8Session> {
  return Pico8Session.create(options);
}
