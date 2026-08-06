import {
  PICO_CART_DATA_BYTES,
  PICO_CART_DATA_ID_MAX_BYTES,
  PICO_CART_DATA_NUMBER_COUNT,
  type PicoCartDataCommit,
  type PicoCartDataSeed,
} from "@pico8-web/contracts";
import { PicoRam } from "../memory/pico-ram.js";

export const PICO_CART_DATA_ADDRESS = 0x5e00;

const CART_DATA_ID_PATTERN = /^[a-z0-9_]+$/u;

function validId(id: string): boolean {
  return id.length >= 1 && id.length <= PICO_CART_DATA_ID_MAX_BYTES &&
    CART_DATA_ID_PATTERN.test(id);
}

function copySeedRecords(seeds: readonly PicoCartDataSeed[]): ReadonlyMap<string, Uint8Array> {
  const records = new Map<string, Uint8Array>();
  for (const seed of seeds) {
    if (typeof seed !== "object" || seed === null || !validId(seed.id)) {
      throw new RangeError("cartdata seed id must contain 1..64 lower-case ASCII id bytes");
    }
    if (!(seed.bytes instanceof Uint8Array) || seed.bytes.byteLength !== PICO_CART_DATA_BYTES) {
      throw new RangeError("cartdata seed must contain exactly 256 bytes");
    }
    if (records.has(seed.id)) {
      throw new RangeError(`duplicate cartdata seed id: ${seed.id}`);
    }
    records.set(seed.id, seed.bytes.slice());
  }
  return records;
}

function idFromBytes(bytes: Uint8Array): string {
  if (
    bytes.byteLength < 1 || bytes.byteLength > PICO_CART_DATA_ID_MAX_BYTES ||
    bytes.some((byte) =>
      !(
        (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) ||
        byte === 0x5f
      )
    )
  ) {
    throw new RangeError("cartdata id must contain 1..64 lower-case ASCII id bytes");
  }
  return String.fromCharCode(...bytes);
}

function cartDataIndex(indexRaw: number): number {
  const index = indexRaw >> 16;
  if (index < 0 || index >= PICO_CART_DATA_NUMBER_COUNT) {
    throw new RangeError("cartdata index must be between 0 and 63");
  }
  return index;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  for (let index = 0; index < PICO_CART_DATA_BYTES; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Synchronous browser-neutral cartdata state over live Pico RAM.
 * Seed and commit byte arrays are copied; RAM remains authoritative after open.
 */
export class CartDataCore {
  readonly #ram: PicoRam;
  readonly #seeds: ReadonlyMap<string, Uint8Array>;
  #openCalled = false;
  #id: string | undefined;
  #committedBytes: Uint8Array | undefined;
  #revision = 0;

  constructor(ram: PicoRam, seeds: readonly PicoCartDataSeed[] = []) {
    if (!Array.isArray(seeds)) {
      throw new TypeError("cartdata seeds must be an array");
    }
    this.#ram = ram;
    this.#seeds = copySeedRecords(seeds);
  }

  reset(): void {
    this.#openCalled = false;
    this.#id = undefined;
    this.#committedBytes = undefined;
    this.#revision = 0;
    this.#ram.fill(PICO_CART_DATA_ADDRESS, PICO_CART_DATA_BYTES, 0);
  }

  cartdata(idBytes: Uint8Array): number {
    if (this.#openCalled) {
      throw new RangeError("cartdata may only be called once per cart execution");
    }
    const id = idFromBytes(idBytes);
    this.#openCalled = true;
    this.#id = id;
    this.#ram.fill(PICO_CART_DATA_ADDRESS, PICO_CART_DATA_BYTES, 0);
    const seed = this.#seeds.get(id);
    if (seed !== undefined) {
      for (let index = 0; index < PICO_CART_DATA_BYTES; index += 1) {
        this.#ram.writeU8(PICO_CART_DATA_ADDRESS + index, seed[index]!);
      }
    }
    // Opening establishes the persistence baseline. Loading an unchanged seed
    // (or an absent all-zero slot) is not itself a durable write.
    this.#committedBytes = this.#ram.copy(PICO_CART_DATA_ADDRESS, PICO_CART_DATA_BYTES);
    return seed === undefined ? 0 : 1;
  }

  dget(indexRaw: number): number {
    this.#assertOpen();
    return this.#ram.readI32LE(PICO_CART_DATA_ADDRESS + cartDataIndex(indexRaw) * 4);
  }

  dset(indexRaw: number, valueRaw: number): void {
    this.#assertOpen();
    this.#ram.writeI32LE(PICO_CART_DATA_ADDRESS + cartDataIndex(indexRaw) * 4, valueRaw);
  }

  takeCommit(): PicoCartDataCommit | undefined {
    const id = this.#id;
    const committedBytes = this.#committedBytes;
    if (id === undefined || committedBytes === undefined) return undefined;
    const bytes = this.#ram.copy(PICO_CART_DATA_ADDRESS, PICO_CART_DATA_BYTES);
    if (bytesEqual(bytes, committedBytes)) return undefined;
    this.#revision += 1;
    this.#committedBytes = bytes.slice();
    return Object.freeze({ id, bytes: bytes.slice(), revision: this.#revision });
  }

  #assertOpen(): void {
    if (this.#id === undefined) {
      throw new RangeError("cartdata must select a slot before dget or dset");
    }
  }
}
