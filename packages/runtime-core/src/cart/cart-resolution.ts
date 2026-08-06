import {
  PICO_CART_INPUT_MAX_BYTES,
  PICO_CART_REF_MAX_BYTES,
  type CartAccess,
} from "@pico8-web/contracts";

import type {
  CartCancellationToken,
  CartResolvePurpose,
  ResolvedCartSource,
} from "../ports/cart-resolver-port.js";

export const CART_RESOLUTION_ERROR_CODES = Object.freeze({
  invalidRef: "E_CART_REF_INVALID",
  invalidSource: "E_CART_SOURCE_INVALID",
  sourceTooLarge: "E_CART_SOURCE_TOO_LARGE",
  bundleLimit: "E_CART_BUNDLE_LIMIT",
  duplicateRef: "E_CART_DUPLICATE_REF",
  notFound: "E_CART_NOT_FOUND",
  accessDenied: "E_CART_ACCESS_DENIED",
  cancelled: "E_CART_CANCELLED",
  disposed: "E_CART_RESOLVER_DISPOSED",
} as const);

export type CartResolutionErrorCode =
  (typeof CART_RESOLUTION_ERROR_CODES)[keyof typeof CART_RESOLUTION_ERROR_CODES];

export class CartResolutionError extends Error {
  readonly code: CartResolutionErrorCode;

  constructor(code: CartResolutionErrorCode, message: string) {
    super(message);
    this.name = "CartResolutionError";
    this.code = code;
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (
      unit >= 0xd800 && unit <= 0xdbff &&
      index + 1 < value.length
    ) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > PICO_CART_REF_MAX_BYTES) return bytes;
  }
  return bytes;
}

export function assertCartRef(ref: string): string {
  if (typeof ref !== "string" || ref.length === 0 || ref.includes("\0")) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.invalidRef,
      "cart ref must be a non-empty string without NUL bytes",
    );
  }
  if (utf8ByteLength(ref) > PICO_CART_REF_MAX_BYTES) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.invalidRef,
      `cart ref exceeds ${PICO_CART_REF_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return ref;
}

export function assertCartResolvePurpose(purpose: CartResolvePurpose): CartResolvePurpose {
  if (!["load", "reload", "cstore", "include"].includes(purpose)) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.accessDenied,
      "cart resolve purpose is not recognized",
    );
  }
  return purpose;
}

export function copyCartAccess(access: CartAccess): Readonly<CartAccess> {
  if (
    access === null || typeof access !== "object" ||
    typeof access.load !== "boolean" ||
    typeof access.reloadData !== "boolean" ||
    typeof access.cstoreData !== "boolean" ||
    typeof access.include !== "boolean"
  ) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.accessDenied,
      "cart access must contain four explicit boolean capabilities",
    );
  }
  return Object.freeze({
    load: access.load,
    reloadData: access.reloadData,
    cstoreData: access.cstoreData,
    include: access.include,
  });
}

export function assertCartAccessForPurpose(
  access: CartAccess,
  purpose: CartResolvePurpose,
): void {
  const checkedPurpose = assertCartResolvePurpose(purpose);
  const allowed = checkedPurpose === "load"
    ? access.load
    : checkedPurpose === "reload"
      ? access.reloadData
      : checkedPurpose === "cstore"
        ? access.cstoreData
        : access.include;
  if (!allowed) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.accessDenied,
      `cart access denies ${checkedPurpose}`,
    );
  }
}

export function copyResolvedCartSource(source: ResolvedCartSource): ResolvedCartSource {
  if (source === null || typeof source !== "object") {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.invalidSource,
      "resolver must return a cart source object",
    );
  }
  const ref = assertCartRef(source.ref);
  if (!(source.bytes instanceof Uint8Array) || source.bytes.byteLength === 0) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.invalidSource,
      "resolved cart source must contain bytes",
    );
  }
  if (source.bytes.byteLength > PICO_CART_INPUT_MAX_BYTES) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.sourceTooLarge,
      `resolved cart source exceeds ${PICO_CART_INPUT_MAX_BYTES} bytes`,
    );
  }
  return Object.freeze({
    ref,
    bytes: source.bytes.slice(),
    access: copyCartAccess(source.access),
  });
}

export function throwIfCartCancelled(cancellation: CartCancellationToken): void {
  if (cancellation.cancelled) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.cancelled,
      "cart resolution was cancelled",
    );
  }
}

/** Small runtime-neutral cancellation source for session/request ownership. */
export class CartCancellationSource {
  readonly token: CartCancellationToken;
  readonly #listeners = new Set<() => void>();
  #cancelled = false;

  constructor() {
    const owner = this;
    this.token = Object.freeze({
      get cancelled(): boolean {
        return owner.#cancelled;
      },
      onCancel(listener: () => void): () => void {
        return owner.#subscribe(listener);
      },
    });
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Cancellation is best-effort fan-out; one consumer cannot block peers.
      }
    }
  }

  #subscribe(listener: () => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("cart cancellation listener must be a function");
    }
    if (this.#cancelled) {
      listener();
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
