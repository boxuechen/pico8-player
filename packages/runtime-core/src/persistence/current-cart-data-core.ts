import {
  PICO_CART_DATA_ROM_SIZE,
  PICO_RAM_SIZE,
  type CartIdentity,
} from "@pico8-web/contracts";

import { PicoRam } from "../memory/pico-ram.js";
import type { CurrentCartDataRepositoryPort } from "../ports/current-cart-data-repository-port.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Recognized by the VM adapter without introducing a RuntimeCore value import. */
export class PicoFeatureUnsupportedError extends Error {
  override readonly name = "PicoFeatureUnsupportedError";
}

function rawInteger(raw: number | undefined, fallback: number): number {
  return raw === undefined ? fallback : raw >> 16;
}

function ramAddress(raw: number | undefined): number {
  return rawInteger(raw, 0) & 0xffff;
}

function cartOffset(raw: number | undefined): number {
  return rawInteger(raw, 0);
}

function byteLength(raw: number | undefined): number {
  return rawInteger(raw, PICO_CART_DATA_ROM_SIZE);
}

function assertRange(
  label: string,
  offset: number,
  length: number,
  limit: number,
): void {
  if (
    !Number.isInteger(offset) || !Number.isInteger(length) ||
    offset < 0 || length < 0 || offset > limit || length > limit - offset
  ) {
    throw new RangeError(`${label} range is out of bounds`);
  }
}

function assertNoReference(reference: Uint8Array | undefined): void {
  if (reference !== undefined) {
    throw new PicoFeatureUnsupportedError(
      "reload/cstore external cart references are not supported",
    );
  }
}

/** Synchronous reload/cstore policy over live logical Base RAM. */
export class CurrentCartDataCore {
  readonly #ram: PicoRam;
  readonly #identity: CartIdentity;
  readonly #repository: CurrentCartDataRepositoryPort;

  constructor(
    ram: PicoRam,
    identity: CartIdentity,
    repository: CurrentCartDataRepositoryPort,
  ) {
    if (!SHA256_PATTERN.test(identity.contentSha256)) {
      throw new RangeError("current-cart identity must be a lower-case SHA-256 digest");
    }
    this.#ram = ram;
    this.#identity = Object.freeze({ contentSha256: identity.contentSha256 });
    this.#repository = repository;
  }

  reload(
    destinationRaw?: number,
    sourceRaw?: number,
    lengthRaw?: number,
    reference?: Uint8Array,
  ): void {
    assertNoReference(reference);
    const destination = ramAddress(destinationRaw);
    const source = cartOffset(sourceRaw);
    const length = byteLength(lengthRaw);
    assertRange("reload Base RAM destination", destination, length, PICO_RAM_SIZE);
    assertRange("reload cart ROM source", source, length, PICO_CART_DATA_ROM_SIZE);
    const bytes = this.#repository.readData(this.#identity, source, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new Error("current-cart repository returned an invalid reload snapshot");
    }
    for (let index = 0; index < length; index += 1) {
      this.#ram.writeU8(destination + index, bytes[index]!);
    }
  }

  cstore(
    destinationRaw?: number,
    sourceRaw?: number,
    lengthRaw?: number,
    reference?: Uint8Array,
  ): void {
    assertNoReference(reference);
    const destination = cartOffset(destinationRaw);
    const source = ramAddress(sourceRaw);
    const length = byteLength(lengthRaw);
    assertRange("cstore cart ROM destination", destination, length, PICO_CART_DATA_ROM_SIZE);
    assertRange("cstore Base RAM source", source, length, PICO_RAM_SIZE);
    const bytes = this.#ram.copy(source, length);
    this.#repository.writeDataOverlay(this.#identity, destination, bytes);
  }
}
