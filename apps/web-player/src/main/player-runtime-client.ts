import type {
  CartAccess,
  PicoInputSnapshot,
  SerializedRuntimeError,
} from "@pico8-web/contracts";

import {
  isPlayerRuntimeToHost,
  PLAYER_CART_INPUT_MAX_BYTES,
  PLAYER_CART_DATA_BYTES,
  PLAYER_CART_DATA_ID_MAX_BYTES,
  PLAYER_CART_DATA_MAX_RECORDS,
  PLAYER_CART_REF_MAX_BYTES,
  PLAYER_CONTROLLER_BUTTON_MASK,
  PLAYER_CONTROLLER_COUNT,
  PLAYER_DEVKIT_KEYPRESS_BATCH_LIMIT,
  PLAYER_LOCAL_CART_BUNDLE_MAX_ENTRIES,
  type AudioPortAttachmentEnvelope,
  type PlayerHostToRuntime,
  type PlayerRuntimeControlCommand,
  type PlayerRuntimeToHost,
} from "../transport/public.js";
import { RuntimeClientError } from "./runtime-client.js";

export interface PlayerRuntimeWorkerPort {
  postMessage(
    message:
      | PlayerHostToRuntime
      | (AudioPortAttachmentEnvelope & { readonly port: MessagePort }),
    transfer?: readonly Transferable[],
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  terminate(): void;
}

export type PlayerRuntimeWorkerFactory = () => PlayerRuntimeWorkerPort;
export type PlayerRuntimeEventListener = (event: PlayerRuntimeToHost) => void;
export type PlayerSessionGenerationListener = (sessionGeneration: number) => void;

export interface PlayerRuntimeClientOptions {
  readonly commandTimeoutMs?: number;
}

export interface PlayerLocalCartSource {
  readonly ref: string;
  readonly bytes: Uint8Array;
  readonly access: CartAccess;
}

export interface PlayerHostCartDataSeed {
  readonly id: string;
  readonly bytes: Uint8Array;
}

interface PendingPlayerCommand {
  readonly workerGeneration: number;
  sessionGeneration: number;
  readonly terminalType: "state" | "heartbeat" | "pause-menu" | "persistence-flushed";
  readonly timer: number;
  readonly resolve: (event: PlayerRuntimeToHost) => void;
  readonly reject: (error: RuntimeClientError) => void;
}

type PlayerControlBody<T = PlayerRuntimeControlCommand> =
  T extends PlayerRuntimeControlCommand
    ? Omit<T, "v" | "requestId" | "workerGeneration" | "sessionGeneration">
    : never;

function clientError(
  code: SerializedRuntimeError["code"],
  message: string,
  recoverable: boolean,
  details?: SerializedRuntimeError["details"],
): RuntimeClientError {
  return new RuntimeClientError({
    code,
    message,
    phase: "none",
    recoverable,
    ...(details === undefined ? {} : { details }),
  });
}

export class PlayerRuntimeClient {
  readonly #factory: PlayerRuntimeWorkerFactory;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, PendingPlayerCommand>();
  readonly #eventListeners = new Set<PlayerRuntimeEventListener>();
  readonly #sessionListeners = new Set<PlayerSessionGenerationListener>();
  #worker!: PlayerRuntimeWorkerPort;
  #workerGeneration = 0;
  #sessionGeneration = 0;
  #nextRequestId = 1;
  #inputSequence = 0;
  #vsyncSequence = 0;
  #lastCartBytes: Uint8Array | undefined;
  #lastLocalCartBundle: readonly PlayerLocalCartSource[] = [];
  #lastHostCartData: readonly PlayerHostCartDataSeed[] | undefined;
  #hasWorkerSession = false;
  #disposed = false;

  constructor(
    factory: PlayerRuntimeWorkerFactory,
    options: PlayerRuntimeClientOptions = {},
  ) {
    const timeoutMs = options.commandTimeoutMs ?? 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("commandTimeoutMs must be positive");
    }
    this.#factory = factory;
    this.#timeoutMs = timeoutMs;
    this.#spawn();
  }

  get workerGeneration(): number {
    return this.#workerGeneration;
  }

  get sessionGeneration(): number {
    return this.#sessionGeneration;
  }

  get hasRetainedCart(): boolean {
    return this.#lastCartBytes !== undefined;
  }

  onEvent(listener: PlayerRuntimeEventListener): () => void {
    this.#assertActive();
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onSessionGenerationChange(listener: PlayerSessionGenerationListener): () => void {
    this.#assertActive();
    this.#sessionListeners.add(listener);
    return () => this.#sessionListeners.delete(listener);
  }

  async loadCart(
    source: Uint8Array,
    instructionBudget?: number,
    localCartBundle: readonly PlayerLocalCartSource[] = [],
    hostCartData?: readonly PlayerHostCartDataSeed[],
  ): Promise<PlayerRuntimeToHost> {
    this.#assertActive();
    if (!(source instanceof Uint8Array)) {
      throw new TypeError("cart source must be a Uint8Array");
    }
    if (source.byteLength === 0 || source.byteLength > PLAYER_CART_INPUT_MAX_BYTES) {
      throw new RangeError("cart source must contain at most 1 MiB");
    }
    this.#lastCartBytes = source.slice();
    this.#lastLocalCartBundle = this.#copyLocalCartBundle(localCartBundle);
    this.#lastHostCartData = hostCartData === undefined
      ? undefined
      : this.#copyHostCartData(hostCartData);
    this.#advanceSession();
    const cartBytes = this.#lastCartBytes.slice().buffer;
    const bundle = this.#bundleForTransfer();
    const host = this.#hostCartDataForTransfer();
    const event = await this.#send(
      {
        type: "loadCart",
        cartBytes,
        localCartBundle: bundle.entries,
        ...(host === undefined ? {} : { hostCartData: host.entries }),
        ...(instructionBudget === undefined ? {} : { instructionBudget }),
      },
      "state",
      [cartBytes, ...bundle.transfers, ...(host?.transfers ?? [])],
    );
    this.#hasWorkerSession = event.type === "state" && event.state === "ready";
    return event;
  }

  async reset(): Promise<PlayerRuntimeToHost> {
    this.#assertActive();
    const retained = this.#lastCartBytes;
    if (retained === undefined) {
      throw clientError("E_INVALID_STATE", "no cart is available to reset", false);
    }
    this.#advanceSession();
    if (!this.#hasWorkerSession) {
      const cartBytes = retained.slice().buffer;
      const bundle = this.#bundleForTransfer();
      const host = this.#hostCartDataForTransfer();
      const event = await this.#send(
        {
          type: "loadCart",
          cartBytes,
          localCartBundle: bundle.entries,
          ...(host === undefined ? {} : { hostCartData: host.entries }),
        },
        "state",
        [cartBytes, ...bundle.transfers, ...(host?.transfers ?? [])],
      );
      this.#hasWorkerSession = event.type === "state" && event.state === "ready";
      return event;
    }
    const event = await this.#send({ type: "reset" }, "state");
    this.#hasWorkerSession = event.type === "state" && event.state === "ready";
    return event;
  }

  start(): Promise<PlayerRuntimeToHost> {
    return this.#send({ type: "start" }, "state");
  }

  pause(): Promise<PlayerRuntimeToHost> {
    this.clearInput();
    return this.#send({ type: "pause" }, "state");
  }

  openPauseMenu(): Promise<PlayerRuntimeToHost> {
    this.clearInput();
    return this.#send({ type: "openPauseMenu" }, "pause-menu");
  }

  closePauseMenu(): Promise<PlayerRuntimeToHost> {
    this.clearInput();
    return this.#send({ type: "closePauseMenu" }, "pause-menu");
  }

  invokeMenuItem(
    slot: 1 | 2 | 3 | 4 | 5,
    button: 1 | 2 | 4,
  ): Promise<PlayerRuntimeToHost> {
    return this.#send({ type: "invokeMenuItem", slot, button }, "pause-menu");
  }

  resume(): Promise<PlayerRuntimeToHost> {
    return this.#send({ type: "resume" }, "state");
  }

  stop(): Promise<PlayerRuntimeToHost> {
    this.clearInput();
    return this.#send({ type: "stop" }, "state");
  }

  pulse(
    timestampMs: number,
    input: PicoInputSnapshot,
  ): Promise<PlayerRuntimeToHost> {
    this.#assertActive();
    this.#postInput(input);
    const sequence = ++this.#vsyncSequence;
    return this.#send({ type: "vsync", sequence, timestampMs }, "heartbeat");
  }

  clearInput(): void {
    if (this.#disposed || this.#sessionGeneration === 0) return;
    this.#postInput({
      controllers: new Array<number>(PLAYER_CONTROLLER_COUNT).fill(0),
      devkit: {
        mouseXRaw: 0,
        mouseYRaw: 0,
        mouseButtons: 0,
        wheelRaw: 0,
        movementXRaw: 0,
        movementYRaw: 0,
        keypresses: [],
      },
    });
  }

  flushPersistence(): Promise<PlayerRuntimeToHost> {
    return this.#send({ type: "flushPersistence" }, "persistence-flushed");
  }

  attachAudioPort(port: MessagePort): void {
    this.#assertActive();
    this.#worker.postMessage(
      {
        v: 1,
        type: "attachAudioPort",
        sessionGeneration: this.#sessionGeneration,
        port,
      },
      [port],
    );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.clearInput();
    try {
      await this.#send({ type: "dispose" }, "state");
    } finally {
      this.#disposed = true;
      this.#worker.terminate();
      for (const pending of this.#pending.values()) {
        globalThis.clearTimeout(pending.timer);
      }
      this.#pending.clear();
      this.#eventListeners.clear();
      this.#sessionListeners.clear();
      this.#lastCartBytes = undefined;
      this.#lastLocalCartBundle = [];
      this.#lastHostCartData = undefined;
    }
  }

  #advanceSession(): void {
    if (this.#sessionGeneration >= 0xffff_ffff) {
      throw clientError("E_INVARIANT", "session generation space is exhausted", false);
    }
    const previousSessionGeneration = this.#sessionGeneration;
    this.#sessionGeneration += 1;
    this.#inputSequence = 0;
    this.#vsyncSequence = 0;
    const superseded = clientError(
      "E_INVALID_STATE",
      "runtime command was superseded by a new session generation",
      true,
      {
        previousSessionGeneration,
        nextSessionGeneration: this.#sessionGeneration,
      },
    );
    for (const [requestId, pending] of this.#pending) {
      if (pending.sessionGeneration !== previousSessionGeneration) continue;
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(superseded);
    }
    for (const listener of this.#sessionListeners) listener(this.#sessionGeneration);
  }

  #postInput(input: PicoInputSnapshot): void {
    const devkit = input.devkit;
    const isInt32 = (value: unknown): boolean => Number.isInteger(value) &&
      Number(value) >= -0x8000_0000 && Number(value) <= 0x7fff_ffff;
    if (
      !Array.isArray(input.controllers) || input.controllers.length !== PLAYER_CONTROLLER_COUNT ||
      input.controllers.some((buttons) =>
        !Number.isSafeInteger(buttons) || buttons < 0 ||
        buttons > PLAYER_CONTROLLER_BUTTON_MASK) ||
      typeof devkit !== "object" || devkit === null ||
      !isInt32(devkit.mouseXRaw) || !isInt32(devkit.mouseYRaw) ||
      !Number.isInteger(devkit.mouseButtons) || devkit.mouseButtons < 0 ||
      devkit.mouseButtons > 0x07 || !isInt32(devkit.wheelRaw) ||
      !isInt32(devkit.movementXRaw) || !isInt32(devkit.movementYRaw) ||
      !Array.isArray(devkit.keypresses) ||
      devkit.keypresses.length > PLAYER_DEVKIT_KEYPRESS_BATCH_LIMIT ||
      devkit.keypresses.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)
    ) {
      throw new RangeError("input must contain a fixed controller snapshot and devkit batch");
    }
    this.#worker.postMessage({
      v: 1,
      type: "input",
      requestId: 0,
      workerGeneration: this.#workerGeneration,
      sessionGeneration: this.#sessionGeneration,
      sequence: ++this.#inputSequence,
      input: {
        controllers: input.controllers.slice(),
        devkit: {
          mouseXRaw: devkit.mouseXRaw,
          mouseYRaw: devkit.mouseYRaw,
          mouseButtons: devkit.mouseButtons,
          wheelRaw: devkit.wheelRaw,
          movementXRaw: devkit.movementXRaw,
          movementYRaw: devkit.movementYRaw,
          keypresses: devkit.keypresses.slice(),
        },
      },
    });
  }

  #spawn(): void {
    if (this.#workerGeneration >= 0xffff_ffff) {
      throw clientError("E_INVARIANT", "Worker generation space is exhausted", false);
    }
    this.#workerGeneration += 1;
    const generation = this.#workerGeneration;
    const worker = this.#factory();
    worker.addEventListener("message", (event) => this.#receive(event.data, generation));
    this.#worker = worker;
  }

  #receive(value: unknown, sourceWorkerGeneration: number): void {
    if (!isPlayerRuntimeToHost(value)) return;
    if (
      sourceWorkerGeneration === this.#workerGeneration &&
      value.workerGeneration === this.#workerGeneration &&
      value.type === "session-replaced"
    ) {
      this.#acceptSessionReplacement(value);
      return;
    }
    if (
      sourceWorkerGeneration !== this.#workerGeneration ||
      value.workerGeneration !== this.#workerGeneration ||
      value.sessionGeneration !== this.#sessionGeneration
    ) return;
    if (value.type === "cartdata-commit" && this.#lastHostCartData !== undefined) {
      const records = new Map(this.#lastHostCartData.map((record) => [record.id, record.bytes]));
      records.set(value.id, new Uint8Array(value.bytes).slice());
      this.#lastHostCartData = Array.from(records, ([id, bytes]) => ({
        id,
        bytes: bytes.slice(),
      }));
    }
    for (const listener of this.#eventListeners) listener(value);
    const pending = this.#pending.get(value.requestId);
    if (
      pending === undefined ||
      pending.workerGeneration !== value.workerGeneration ||
      pending.sessionGeneration !== value.sessionGeneration
    ) return;
    if (value.type === "fault") {
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(value.requestId);
      this.#hasWorkerSession = false;
      pending.reject(new RuntimeClientError(value.error));
      return;
    }
    if (value.type === "state" && value.state === "waiting-host") return;
    if (value.type !== pending.terminalType) return;
    globalThis.clearTimeout(pending.timer);
    this.#pending.delete(value.requestId);
    pending.resolve(value);
  }

  #acceptSessionReplacement(
    event: Extract<PlayerRuntimeToHost, { readonly type: "session-replaced" }>,
  ): void {
    const previous = this.#sessionGeneration;
    if (
      event.previousSessionGeneration !== previous ||
      event.nextSessionGeneration !== previous + 1 ||
      event.sessionGeneration !== event.nextSessionGeneration
    ) return;
    const target = this.#lastLocalCartBundle.find((entry) => entry.ref === event.cartRef);
    if (target === undefined) return;

    const preserved = this.#pending.get(event.requestId);
    this.#sessionGeneration = event.nextSessionGeneration;
    this.#inputSequence = 0;
    this.#vsyncSequence = 0;
    this.#lastCartBytes = target.bytes.slice();
    this.#hasWorkerSession = true;
    const superseded = clientError(
      "E_INVALID_STATE",
      "runtime command was superseded by guest load()",
      true,
      { previousSessionGeneration: previous, nextSessionGeneration: this.#sessionGeneration },
    );
    for (const [requestId, pending] of this.#pending) {
      if (pending.sessionGeneration !== previous) continue;
      if (pending === preserved && pending.terminalType === "state") {
        pending.sessionGeneration = this.#sessionGeneration;
        continue;
      }
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(superseded);
    }
    for (const listener of this.#sessionListeners) listener(this.#sessionGeneration);
    for (const listener of this.#eventListeners) listener(event);
  }

  #copyLocalCartBundle(entries: readonly PlayerLocalCartSource[]): readonly PlayerLocalCartSource[] {
    if (!Array.isArray(entries)) throw new TypeError("local cart bundle must be an array");
    if (entries.length > PLAYER_LOCAL_CART_BUNDLE_MAX_ENTRIES) {
      throw new RangeError("local cart bundle exceeds 64 entries");
    }
    const refs = new Set<string>();
    return entries.map((entry) => {
      if (typeof entry?.ref !== "string" || !(entry.bytes instanceof Uint8Array)) {
        throw new TypeError("local cart bundle entries require ref and Uint8Array bytes");
      }
      let refBytes = 0;
      for (let index = 0; index < entry.ref.length; index += 1) {
        const unit = entry.ref.charCodeAt(index);
        if (unit <= 0x7f) refBytes += 1;
        else if (unit <= 0x7ff) refBytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < entry.ref.length &&
          entry.ref.charCodeAt(index + 1) >= 0xdc00 &&
          entry.ref.charCodeAt(index + 1) <= 0xdfff) {
          refBytes += 4;
          index += 1;
        } else refBytes += 3;
      }
      if (entry.ref.length === 0 || entry.ref.includes("\0") ||
        refBytes > PLAYER_CART_REF_MAX_BYTES || entry.ref.startsWith("/") ||
        entry.ref.startsWith("#") || entry.ref.includes("://") ||
        entry.ref.includes("\\") || entry.ref.split("/").some((part: string) =>
          part === "" || part === "." || part === "..") || refs.has(entry.ref)) {
        throw new RangeError("local cart bundle ref is not canonical or is duplicated");
      }
      if (entry.bytes.byteLength === 0 ||
        entry.bytes.byteLength > PLAYER_CART_INPUT_MAX_BYTES) {
        throw new RangeError("local cart bundle bytes must contain at most 1 MiB");
      }
      refs.add(entry.ref);
      const access = entry.access;
      if (access === null || typeof access !== "object" ||
        typeof access.load !== "boolean" || typeof access.reloadData !== "boolean" ||
        typeof access.cstoreData !== "boolean" || typeof access.include !== "boolean") {
        throw new TypeError("local cart bundle entries require explicit access capabilities");
      }
      return Object.freeze({
        ref: entry.ref,
        bytes: entry.bytes.slice(),
        access: Object.freeze({ ...access }),
      });
    });
  }

  #bundleForTransfer(): {
    readonly entries: readonly import("../transport/public.js").PlayerLocalCartBundleEntry[];
    readonly transfers: readonly ArrayBuffer[];
  } {
    const transfers: ArrayBuffer[] = [];
    const entries = this.#lastLocalCartBundle.map((entry) => {
      const cartBytes = entry.bytes.slice().buffer;
      transfers.push(cartBytes);
      return { ref: entry.ref, cartBytes, access: { ...entry.access } };
    });
    return { entries, transfers };
  }

  #copyHostCartData(entries: readonly PlayerHostCartDataSeed[]): readonly PlayerHostCartDataSeed[] {
    if (!Array.isArray(entries) || entries.length > PLAYER_CART_DATA_MAX_RECORDS) {
      throw new RangeError("host cartdata exceeds 4096 records");
    }
    const ids = new Set<string>();
    return entries.map((entry) => {
      if (typeof entry?.id !== "string" || !/^[a-z0-9_-]+$/u.test(entry.id) ||
        entry.id.length > PLAYER_CART_DATA_ID_MAX_BYTES || ids.has(entry.id) ||
        !(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength !== PLAYER_CART_DATA_BYTES) {
        throw new RangeError("host cartdata contains an invalid record");
      }
      ids.add(entry.id);
      return { id: entry.id, bytes: entry.bytes.slice() };
    });
  }

  #hostCartDataForTransfer(): {
    readonly entries: readonly import("../transport/public.js").PlayerCartDataSeedEntry[];
    readonly transfers: readonly ArrayBuffer[];
  } | undefined {
    if (this.#lastHostCartData === undefined) return undefined;
    const transfers: ArrayBuffer[] = [];
    const entries = this.#lastHostCartData.map((entry) => {
      const bytes = entry.bytes.slice().buffer;
      transfers.push(bytes);
      return { id: entry.id, bytes };
    });
    return { entries, transfers };
  }

  #send(
    command: PlayerControlBody,
    terminalType: PendingPlayerCommand["terminalType"],
    transfer: readonly ArrayBuffer[] = [],
  ): Promise<PlayerRuntimeToHost> {
    if (this.#disposed) {
      return Promise.reject(
        clientError("E_INVALID_STATE", "runtime client is disposed", false),
      );
    }
    const requestId = this.#nextRequestId++;
    const workerGeneration = this.#workerGeneration;
    const sessionGeneration = this.#sessionGeneration;
    const envelope = {
      ...command,
      v: 1 as const,
      requestId,
      workerGeneration,
      sessionGeneration,
    } as PlayerRuntimeControlCommand;
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(
        () => this.#watchdog(requestId, workerGeneration),
        this.#timeoutMs,
      );
      this.#pending.set(requestId, {
        workerGeneration,
        sessionGeneration,
        terminalType,
        timer,
        resolve,
        reject,
      });
      this.#worker.postMessage(envelope, transfer);
    });
  }

  #watchdog(requestId: number, workerGeneration: number): void {
    const timedOut = this.#pending.get(requestId);
    if (timedOut === undefined || timedOut.workerGeneration !== workerGeneration) return;
    const error = clientError(
      "E_VM_WATCHDOG",
      "Runtime Worker did not respond before the command deadline",
      true,
      { workerGeneration, sessionGeneration: timedOut.sessionGeneration },
    );
    this.#worker.terminate();
    for (const [id, pending] of this.#pending) {
      if (pending.workerGeneration !== workerGeneration) continue;
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
    this.#hasWorkerSession = false;
    if (!this.#disposed) this.#spawn();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("PlayerRuntimeClient is disposed");
  }
}
