import { decodeCart, type ParsedCart } from "@pico8-player/cart-codec";
import type { CartAccess } from "@pico8-player/contracts";

import {
  CART_RESOLUTION_ERROR_CODES,
  CartResolutionError,
  assertCartAccessForPurpose,
  assertCartRef,
  assertCartResolvePurpose,
  copyCartAccess,
  copyResolvedCartSource,
  throwIfCartCancelled,
} from "./cart-resolution.js";
import type {
  CartCancellationToken,
  CartResolveContext,
  CartResolverPort,
} from "../ports/cart-resolver-port.js";
import type { CartRepositoryPort } from "../ports/cart-repository-port.js";

export interface LoadedCart {
  readonly ref: string;
  readonly cart: ParsedCart;
  readonly access: Readonly<CartAccess>;
}

/** Resolve, validate, decode and cache one caller-authorized cart transaction. */
export class CartLoader {
  readonly #resolver: CartResolverPort;
  readonly #repository: CartRepositoryPort;

  constructor(resolver: CartResolverPort, repository: CartRepositoryPort) {
    this.#resolver = resolver;
    this.#repository = repository;
  }

  async load(
    ref: string,
    context: CartResolveContext,
    cancellation: CartCancellationToken,
  ): Promise<LoadedCart> {
    const requestedRef = assertCartRef(ref);
    const purpose = assertCartResolvePurpose(context.purpose);
    throwIfCartCancelled(cancellation);

    const resolved = copyResolvedCartSource(
      await this.#resolver.resolve(requestedRef, context, cancellation),
    );
    throwIfCartCancelled(cancellation);
    if (resolved.ref !== requestedRef) {
      throw new CartResolutionError(
        CART_RESOLUTION_ERROR_CODES.invalidRef,
        "resolver returned bytes for a different cart ref",
      );
    }

    const access = copyCartAccess(resolved.access);
    assertCartAccessForPurpose(access, purpose);
    const decoded = decodeCart(resolved.bytes);
    throwIfCartCancelled(cancellation);
    this.#repository.put(decoded);
    const cart = this.#repository.get(decoded.identity);
    if (cart === undefined) {
      throw new Error("cart repository did not retain the decoded cart");
    }
    return Object.freeze({ ref: requestedRef, cart, access });
  }
}
