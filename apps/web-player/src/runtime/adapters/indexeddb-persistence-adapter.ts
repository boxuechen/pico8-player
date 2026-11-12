import {
  PICO_CART_DATA_BYTES,
  PICO_CART_DATA_ID_MAX_BYTES,
  type PicoCartDataCommit,
  type PicoCartDataSeed,
  type SerializedRuntimeError,
} from "@pico8-web/contracts";
import type { CartDataPersistencePort } from "@pico8-web/runtime-core";

export const CART_DATA_DATABASE_NAME = "pico8-web-player";
export const CART_DATA_DATABASE_VERSION = 1;
export const CART_DATA_OBJECT_STORE = "cartdata";
export const CART_DATA_NAMESPACE_INDEX = "namespace";
export const CART_DATA_RECORD_SCHEMA_VERSION = 1;
export const CART_DATA_MAX_HYDRATED_RECORDS = 4096;
export const CART_DATA_MAX_HYDRATED_BYTES = 1024 * 1024;
export const CART_DATA_DEFAULT_DEBOUNCE_MS = 100;

const MAX_DIAGNOSTICS = 32;
const CART_DATA_ID_PATTERN = /^[a-z0-9_-]+$/u;

interface StoredCartDataRecord {
  readonly schemaVersion: typeof CART_DATA_RECORD_SCHEMA_VERSION;
  readonly namespace: string;
  readonly id: string;
  readonly bytes: ArrayBuffer;
}

export interface IndexedDbCartDataPersistenceOptions {
  readonly factory?: IDBFactory;
  readonly databaseName?: string;
  readonly namespace?: string;
  readonly debounceMs?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function validId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 1 &&
    id.length <= PICO_CART_DATA_ID_MAX_BYTES && CART_DATA_ID_PATTERN.test(id);
}

function copyStoredBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) {
    return value.byteLength === PICO_CART_DATA_BYTES
      ? new Uint8Array(value.slice(0))
      : undefined;
  }
  if (value instanceof Uint8Array && value.byteLength === PICO_CART_DATA_BYTES) {
    return value.slice();
  }
  return undefined;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(
      request.error ?? new Error("IndexedDB request failed"),
    ), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(
      transaction.error ?? new Error("IndexedDB transaction aborted"),
    ), { once: true });
    transaction.addEventListener("error", () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed"),
    ), { once: true });
  });
}

function storedRecord(namespace: string, id: string, bytes: Uint8Array): StoredCartDataRecord {
  return {
    schemaVersion: CART_DATA_RECORD_SCHEMA_VERSION,
    namespace,
    id,
    bytes: bytes.slice().buffer,
  };
}

/** Chrome/Chromium Worker-owned IndexedDB adapter for cartdata records. */
export class IndexedDbCartDataPersistenceAdapter implements CartDataPersistencePort {
  readonly #factory: IDBFactory;
  readonly #databaseName: string;
  readonly #namespace: string;
  readonly #debounceMs: number;
  readonly #pending = new Map<string, Uint8Array>();
  readonly #diagnostics: SerializedRuntimeError[] = [];
  #databasePromise: Promise<IDBDatabase> | undefined;
  #flushInFlight: ReturnType<CartDataPersistencePort["flush"]> | undefined;
  #flushTimer: number | undefined;
  #disposed = false;

  constructor(options: IndexedDbCartDataPersistenceOptions = {}) {
    const factory = options.factory ?? globalThis.indexedDB;
    if (factory === undefined) throw new Error("IndexedDB is unavailable in this Worker");
    const databaseName = options.databaseName ?? CART_DATA_DATABASE_NAME;
    const namespace = options.namespace ?? "default";
    const debounceMs = options.debounceMs ?? CART_DATA_DEFAULT_DEBOUNCE_MS;
    if (databaseName.length < 1 || databaseName.length > 128) {
      throw new RangeError("persistence database name must contain 1..128 characters");
    }
    if (namespace.length < 1 || namespace.length > 128 || namespace.includes("\0")) {
      throw new RangeError("persistence namespace must contain 1..128 non-NUL characters");
    }
    if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 60_000) {
      throw new RangeError("persistence debounce must be between 0 and 60000ms");
    }
    this.#factory = factory;
    this.#databaseName = databaseName;
    this.#namespace = namespace;
    this.#debounceMs = debounceMs;
  }

  async hydrate(): Promise<readonly PicoCartDataSeed[]> {
    if (this.#disposed) return [];
    let records: unknown[];
    try {
      const database = await this.#database();
      const transaction = database.transaction(CART_DATA_OBJECT_STORE, "readonly");
      const request = transaction.objectStore(CART_DATA_OBJECT_STORE)
        .index(CART_DATA_NAMESPACE_INDEX)
        .getAll(this.#namespace, CART_DATA_MAX_HYDRATED_RECORDS + 1);
      records = await requestResult(request);
      await transactionDone(transaction);
    } catch (error) {
      this.#readDiagnostic("Unable to hydrate cartdata; using an empty durable mirror", error);
      return this.#overlayPending([]);
    }
    if (records.length > CART_DATA_MAX_HYDRATED_RECORDS) {
      this.#readDiagnostic("Cartdata hydration exceeded the 4096-record limit");
      return this.#overlayPending([]);
    }

    const seeds: PicoCartDataSeed[] = [];
    let hydratedBytes = 0;
    for (const value of records) {
      if (typeof value !== "object" || value === null) {
        this.#readDiagnostic("Skipped a malformed cartdata record");
        continue;
      }
      const record = value as {
        readonly schemaVersion?: unknown;
        readonly namespace?: unknown;
        readonly id?: unknown;
        readonly bytes?: unknown;
      };
      if (record.namespace !== this.#namespace || !validId(record.id)) {
        this.#readDiagnostic("Skipped a cartdata record with an invalid namespace or id");
        continue;
      }
      const schemaVersion = record.schemaVersion ?? 0;
      if (schemaVersion !== 0 && schemaVersion !== CART_DATA_RECORD_SCHEMA_VERSION) {
        this.#readDiagnostic("Skipped a cartdata record from an unsupported future schema", {
          id: record.id,
          schemaVersion: typeof schemaVersion === "number" ? schemaVersion : -1,
        });
        continue;
      }
      const bytes = copyStoredBytes(record.bytes);
      if (bytes === undefined) {
        this.#readDiagnostic("Skipped a cartdata record without exactly 256 bytes", {
          id: record.id,
        });
        continue;
      }
      hydratedBytes += bytes.byteLength;
      if (hydratedBytes > CART_DATA_MAX_HYDRATED_BYTES) {
        this.#readDiagnostic("Cartdata hydration exceeded the 1 MiB byte limit");
        return this.#overlayPending([]);
      }
      seeds.push(Object.freeze({ id: record.id, bytes: bytes.slice() }));
      if (schemaVersion === 0) this.#queueBytes(record.id, bytes);
    }
    return this.#overlayPending(seeds);
  }

  enqueue(commit: PicoCartDataCommit): void {
    if (this.#disposed) return;
    if (!validId(commit.id) || !(commit.bytes instanceof Uint8Array) ||
      commit.bytes.byteLength !== PICO_CART_DATA_BYTES) {
      this.#writeDiagnostic("Rejected a malformed committed cartdata snapshot");
      return;
    }
    this.#queueBytes(commit.id, commit.bytes);
  }

  flush(): ReturnType<CartDataPersistencePort["flush"]> {
    this.#clearTimer();
    if (this.#disposed || this.#pending.size === 0) {
      return this.#flushInFlight ?? Promise.resolve({ durable: this.#pending.size === 0 });
    }
    if (this.#flushInFlight !== undefined) return this.#flushInFlight;
    const flush = this.#drainPending();
    this.#flushInFlight = flush.finally(() => {
      this.#flushInFlight = undefined;
    });
    return this.#flushInFlight;
  }

  takeDiagnostics(): readonly SerializedRuntimeError[] {
    return this.#diagnostics.splice(0);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#clearTimer();
    await this.flush();
    this.#disposed = true;
    try {
      (await this.#databasePromise)?.close();
    } catch {
      // Open/read diagnostics were already recorded by the operation that failed.
    }
    this.#databasePromise = undefined;
  }

  async #database(): Promise<IDBDatabase> {
    if (this.#databasePromise !== undefined) return this.#databasePromise;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory.open(this.#databaseName, CART_DATA_DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(CART_DATA_OBJECT_STORE)
          ? request.transaction!.objectStore(CART_DATA_OBJECT_STORE)
          : database.createObjectStore(CART_DATA_OBJECT_STORE, {
            keyPath: ["namespace", "id"],
          });
        if (!store.indexNames.contains(CART_DATA_NAMESPACE_INDEX)) {
          store.createIndex(CART_DATA_NAMESPACE_INDEX, "namespace", { unique: false });
        }
      });
      request.addEventListener("success", () => {
        const database = request.result;
        database.addEventListener("versionchange", () => database.close());
        resolve(database);
      }, { once: true });
      request.addEventListener("error", () => reject(
        request.error ?? new Error("Unable to open cartdata IndexedDB"),
      ), { once: true });
      request.addEventListener("blocked", () => reject(
        new Error("Cartdata IndexedDB upgrade was blocked"),
      ), { once: true });
    }).catch((error) => {
      this.#databasePromise = undefined;
      throw error;
    });
    this.#databasePromise = opening;
    return opening;
  }

  #overlayPending(seeds: readonly PicoCartDataSeed[]): readonly PicoCartDataSeed[] {
    const merged = new Map<string, Uint8Array>();
    for (const seed of seeds) merged.set(seed.id, seed.bytes.slice());
    for (const [id, bytes] of this.#pending) merged.set(id, bytes.slice());
    return Object.freeze(Array.from(merged, ([id, bytes]) =>
      Object.freeze({ id, bytes: bytes.slice() })));
  }

  #queueBytes(id: string, bytes: Uint8Array): void {
    this.#pending.set(id, bytes.slice());
    if (this.#flushTimer !== undefined || this.#debounceMs === 0) {
      if (this.#debounceMs === 0) void this.flush();
      return;
    }
    this.#flushTimer = globalThis.setTimeout(() => {
      this.#flushTimer = undefined;
      void this.flush();
    }, this.#debounceMs);
  }

  async #drainPending(): ReturnType<CartDataPersistencePort["flush"]> {
    while (this.#pending.size > 0) {
      const batch = new Map(this.#pending);
      this.#pending.clear();
      try {
        const database = await this.#database();
        const transaction = database.transaction(CART_DATA_OBJECT_STORE, "readwrite");
        const store = transaction.objectStore(CART_DATA_OBJECT_STORE);
        for (const [id, bytes] of batch) {
          store.put(storedRecord(this.#namespace, id, bytes));
        }
        await transactionDone(transaction);
      } catch (error) {
        for (const [id, bytes] of batch) {
          if (!this.#pending.has(id)) this.#pending.set(id, bytes);
        }
        this.#writeDiagnostic("Unable to durably write cartdata; the latest snapshot remains pending", error);
        return { durable: false, message: errorMessage(error) };
      }
    }
    return { durable: true };
  }

  #clearTimer(): void {
    if (this.#flushTimer === undefined) return;
    globalThis.clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
  }

  #readDiagnostic(
    message: string,
    errorOrDetails?: unknown,
  ): void {
    this.#diagnostic("E_PERSISTENCE_READ", message, errorOrDetails);
  }

  #writeDiagnostic(
    message: string,
    errorOrDetails?: unknown,
  ): void {
    this.#diagnostic("E_PERSISTENCE_WRITE", message, errorOrDetails);
  }

  #diagnostic(
    code: "E_PERSISTENCE_READ" | "E_PERSISTENCE_WRITE",
    message: string,
    errorOrDetails?: unknown,
  ): void {
    const details = typeof errorOrDetails === "object" && errorOrDetails !== null &&
        !(errorOrDetails instanceof Error) && !(errorOrDetails instanceof DOMException)
      ? errorOrDetails as Readonly<Record<string, string | number | boolean>>
      : errorOrDetails === undefined
        ? undefined
        : { cause: errorMessage(errorOrDetails) };
    if (this.#diagnostics.length >= MAX_DIAGNOSTICS) this.#diagnostics.shift();
    this.#diagnostics.push(Object.freeze({
      code,
      message,
      phase: "none",
      recoverable: true,
      ...(details === undefined ? {} : { details }),
    }));
  }
}
