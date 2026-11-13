import { type CartIdentity } from "@pico8-player/contracts";

import { normalizeCstoreRange, normalizeReloadRange } from "../cart/cart-data-range.js";
import { PicoRam } from "../memory/pico-ram.js";
import type { CurrentCartDataRepositoryPort } from "../ports/current-cart-data-repository-port.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Recognized by the VM adapter without introducing a RuntimeCore value import. */
export class PicoFeatureUnsupportedError extends Error {
  override readonly name = "PicoFeatureUnsupportedError";
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
    const { destination, source, length } = normalizeReloadRange(
      destinationRaw,
      sourceRaw,
      lengthRaw,
    );
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
    const { destination, source, length } = normalizeCstoreRange(
      destinationRaw,
      sourceRaw,
      lengthRaw,
    );
    const bytes = this.#ram.copy(source, length);
    this.#repository.writeDataOverlay(this.#identity, destination, bytes);
  }
}
