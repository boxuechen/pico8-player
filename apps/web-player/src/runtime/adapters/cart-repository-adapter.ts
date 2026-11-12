import type { CartWarning, ParsedCart } from "@pico8-web/cart-codec";
import {
  PICO_CART_DATA_ROM_SIZE,
  PICO_CART_ROM_SIZE,
  type CartIdentity,
} from "@pico8-web/contracts";
import type { CartRepositoryPort } from "@pico8-web/runtime-core";

interface CartDataRecord {
  readonly original: Uint8Array;
  readonly rom: Uint8Array;
  cart?: ParsedCart;
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

function copyWarnings(warnings: readonly CartWarning[]): readonly CartWarning[] {
  return Object.freeze(warnings.map((warning) => Object.freeze({
    code: warning.code,
    message: warning.message,
    offset: warning.offset,
    ...(warning.section === undefined ? {} : { section: warning.section }),
  })));
}

function copyParsedCart(cart: ParsedCart): ParsedCart {
  if (
    !(cart.rom instanceof Uint8Array) || cart.rom.byteLength !== PICO_CART_ROM_SIZE ||
    !(cart.code instanceof Uint8Array) || !Array.isArray(cart.warnings) ||
    (cart.format !== "p8" && cart.format !== "p8.png") ||
    !Number.isSafeInteger(cart.version) || cart.version < 0 || cart.version > 255 ||
    !Number.isSafeInteger(cart.sourceBytes) || cart.sourceBytes < 0
  ) {
    throw new TypeError("cart repository requires a valid ParsedCart snapshot");
  }
  const code = cart.code.slice();
  return Object.freeze({
    identity: Object.freeze({ contentSha256: keyOf(cart.identity) }),
    format: cart.format,
    version: cart.version,
    rom: cart.rom.slice(),
    code,
    warnings: copyWarnings(cart.warnings),
    sourceBytes: cart.sourceBytes,
    cartVersion: cart.version,
    luaSource: code,
  });
}

function equalCart(left: ParsedCart, right: ParsedCart): boolean {
  return left.format === right.format &&
    left.version === right.version &&
    left.sourceBytes === right.sourceBytes &&
    equalBytes(left.rom, right.rom) &&
    equalBytes(left.code, right.code) &&
    JSON.stringify(left.warnings) === JSON.stringify(right.warnings);
}

/** Worker-lifetime, identity-scoped current-cart data ROM with lazy COW. */
export class CartRepositoryAdapter implements CartRepositoryPort {
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
      if (!equalBytes(existing.rom, cart.rom)) {
        throw new Error("cart identity was registered with different ROM bytes");
      }
      return;
    }
    if (this.#records.size >= CURRENT_CART_REPOSITORY_MAX_CARTS) {
      throw new RangeError("current-cart repository reached its 64-cart Worker limit");
    }
    this.#records.set(key, { original, rom: cart.rom.slice() });
  }

  put(cart: ParsedCart): void {
    this.#assertLive();
    const owned = copyParsedCart(cart);
    const key = keyOf(owned.identity);
    const original = owned.rom.slice(0, PICO_CART_DATA_ROM_SIZE);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (!equalBytes(existing.rom, owned.rom)) {
        throw new Error("cart identity was registered with different ROM bytes");
      }
      if (existing.cart !== undefined && !equalCart(existing.cart, owned)) {
        throw new Error("cart identity was registered with different parsed cart content");
      }
      existing.cart = owned;
      return;
    }
    if (this.#records.size >= CURRENT_CART_REPOSITORY_MAX_CARTS) {
      throw new RangeError("current-cart repository reached its 64-cart Worker limit");
    }
    this.#records.set(key, { original, rom: owned.rom, cart: owned });
  }

  get(identity: CartIdentity): ParsedCart | undefined {
    this.#assertLive();
    const cart = this.#records.get(keyOf(identity))?.cart;
    return cart === undefined ? undefined : copyParsedCart(cart);
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
