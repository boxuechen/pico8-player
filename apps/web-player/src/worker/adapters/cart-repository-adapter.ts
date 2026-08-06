import type { ParsedCart } from "@pico8-web/cart-codec";
import {
  PICO_CART_DATA_ROM_SIZE,
  PICO_CART_ROM_SIZE,
  type CartIdentity,
} from "@pico8-web/contracts";
import type { CurrentCartDataRepositoryPort } from "@pico8-web/runtime-core";

interface CartDataRecord {
  readonly original: Uint8Array;
  overlay?: Uint8Array;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const CURRENT_CART_REPOSITORY_MAX_CARTS = 64;

function keyOf(identity: CartIdentity): string {
  if (!SHA256_PATTERN.test(identity.contentSha256)) {
    throw new RangeError("cart repository identity must be a lower-case SHA-256 digest");
  }
  return identity.contentSha256;
}

function assertRange(offset: number, length: number): void {
  if (
    !Number.isInteger(offset) || !Number.isInteger(length) ||
    offset < 0 || length < 0 || offset > PICO_CART_DATA_ROM_SIZE ||
    length > PICO_CART_DATA_ROM_SIZE - offset
  ) {
    throw new RangeError("cart data repository range is out of bounds");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Worker-lifetime, identity-scoped current-cart data ROM with lazy COW. */
export class CartRepositoryAdapter implements CurrentCartDataRepositoryPort {
  readonly #records = new Map<string, CartDataRecord>();
  #disposed = false;

  registerCart(cart: Pick<ParsedCart, "identity" | "rom">): void {
    this.#assertLive();
    if (!(cart.rom instanceof Uint8Array) || cart.rom.byteLength !== PICO_CART_ROM_SIZE) {
      throw new RangeError("registered cart ROM must be exactly 0x8000 bytes");
    }
    const key = keyOf(cart.identity);
    const original = cart.rom.slice(0, PICO_CART_DATA_ROM_SIZE);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (!equalBytes(existing.original, original)) {
        throw new Error("cart identity was registered with different data ROM bytes");
      }
      return;
    }
    if (this.#records.size >= CURRENT_CART_REPOSITORY_MAX_CARTS) {
      throw new RangeError("current-cart repository reached its 64-cart Worker limit");
    }
    this.#records.set(key, { original });
  }

  readData(identity: CartIdentity, source: number, length: number): Uint8Array {
    this.#assertLive();
    assertRange(source, length);
    const record = this.#record(identity);
    return (record.overlay ?? record.original).slice(source, source + length);
  }

  writeDataOverlay(
    identity: CartIdentity,
    destination: number,
    bytes: Uint8Array,
  ): void {
    this.#assertLive();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("cart data overlay bytes must be a Uint8Array");
    }
    assertRange(destination, bytes.byteLength);
    const record = this.#record(identity);
    const overlay = record.overlay ?? record.original.slice();
    overlay.set(bytes.slice(), destination);
    record.overlay = overlay;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#records.clear();
    this.#disposed = true;
  }

  #record(identity: CartIdentity): CartDataRecord {
    const record = this.#records.get(keyOf(identity));
    if (record === undefined) throw new Error("cart is not registered in this Worker");
    return record;
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("cart repository is disposed");
  }
}
