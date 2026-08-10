export interface Pico8CartDataSeed {
  readonly id: string;
  readonly bytes: Uint8Array;
}

export interface Pico8CartDataCommit extends Pico8CartDataSeed {
  readonly revision: number;
}

export interface Pico8HostPersistenceAdapter {
  hydrate(contentId: string): Promise<readonly Pico8CartDataSeed[]>;
  /** Failed writes must remain retryable by the next flush call. */
  write(contentId: string, commit: Pico8CartDataCommit): Promise<void>;
  flush(contentId: string): Promise<void>;
}

export type Pico8PersistenceStatus = "saving" | "saved" | "failed";

export interface Pico8PersistenceStatusEventData {
  readonly status: Pico8PersistenceStatus;
  readonly contentId: string;
  readonly cartDataId?: string;
  readonly revision?: number;
  readonly reason?: string;
  readonly message?: string;
}

export interface Pico8PersistenceFlushResult {
  readonly status: "written" | "unchanged" | "failed" | "flushed";
  readonly reason: string;
  readonly durable: boolean;
  readonly message?: string;
}

const CONTENT_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,127}$/u;
const CART_DATA_ID_PATTERN = /^[a-z0-9_-]{1,64}$/u;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copySeed(value: Pico8CartDataSeed): Pico8CartDataSeed {
  if (typeof value?.id !== "string" || !CART_DATA_ID_PATTERN.test(value.id) ||
    !(value.bytes instanceof Uint8Array) || value.bytes.byteLength !== 256) {
    throw new RangeError("host persistence returned an invalid cartdata record");
  }
  return { id: value.id, bytes: value.bytes.slice() };
}

export class HostPersistenceFrontend {
  readonly #adapter: Pico8HostPersistenceAdapter;
  readonly #emit: (event: Pico8PersistenceStatusEventData) => void;
  #contentId: string | undefined;
  #writeQueue: Promise<void> = Promise.resolve();
  #lastFailure: Error | undefined;
  #writesSinceFlush = 0;

  constructor(
    adapter: Pico8HostPersistenceAdapter,
    emit: (event: Pico8PersistenceStatusEventData) => void,
  ) {
    if (typeof adapter?.hydrate !== "function" || typeof adapter.write !== "function" ||
      typeof adapter.flush !== "function") {
      throw new TypeError("persistence adapter requires hydrate, write and flush");
    }
    this.#adapter = adapter;
    this.#emit = emit;
  }

  get active(): boolean {
    return this.#contentId !== undefined;
  }

  async activate(contentId: string): Promise<readonly Pico8CartDataSeed[]> {
    if (!CONTENT_ID_PATTERN.test(contentId)) {
      throw new RangeError("contentId must be a stable 1..128 character identifier");
    }
    this.#contentId = contentId;
    this.#lastFailure = undefined;
    this.#writesSinceFlush = 0;
    const hydrated = await this.#adapter.hydrate(contentId);
    if (!Array.isArray(hydrated) || hydrated.length > 4096) {
      throw new RangeError("host persistence hydration exceeds 4096 records");
    }
    const ids = new Set<string>();
    return hydrated.map((entry) => {
      const copied = copySeed(entry);
      if (ids.has(copied.id)) throw new RangeError("host persistence returned duplicate ids");
      ids.add(copied.id);
      return copied;
    });
  }

  enqueue(commit: Pico8CartDataCommit): void {
    const contentId = this.#contentId;
    if (contentId === undefined) return;
    const copied = { ...copySeed(commit), revision: commit.revision };
    if (!Number.isSafeInteger(copied.revision) || copied.revision < 1) {
      throw new RangeError("cartdata commit revision must be positive");
    }
    this.#writesSinceFlush += 1;
    this.#emit({
      status: "saving",
      contentId,
      cartDataId: copied.id,
      revision: copied.revision,
    });
    const write = this.#writeQueue.then(() => this.#adapter.write(contentId, copied));
    this.#writeQueue = write.then(() => {
      this.#emit({
        status: "saved",
        contentId,
        cartDataId: copied.id,
        revision: copied.revision,
      });
    }, (error: unknown) => {
      this.#lastFailure = error instanceof Error ? error : new Error(message(error));
      this.#emit({
        status: "failed",
        contentId,
        cartDataId: copied.id,
        revision: copied.revision,
        message: message(error),
      });
    });
  }

  async flush(reason: string): Promise<Pico8PersistenceFlushResult> {
    const contentId = this.#contentId;
    if (contentId === undefined) {
      return { status: "unchanged", reason, durable: true };
    }
    await this.#writeQueue;
    try {
      await this.#adapter.flush(contentId);
      const status = this.#writesSinceFlush > 0 ? "written" : "unchanged";
      this.#writesSinceFlush = 0;
      this.#lastFailure = undefined;
      this.#emit({ status: "saved", contentId, reason });
      return { status, reason, durable: true };
    } catch (error) {
      this.#lastFailure = error instanceof Error ? error : new Error(message(error));
      this.#emit({ status: "failed", contentId, reason, message: message(error) });
      return { status: "failed", reason, durable: false, message: message(error) };
    }
  }
}
