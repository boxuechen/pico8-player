import type { ParsedCart } from "@pico8-player/cart-codec";
import type { CartIdentity } from "@pico8-player/contracts";

import type { CurrentCartDataRepositoryPort } from "./current-cart-data-repository-port.js";

/**
 * Worker-lifetime parsed-cart cache plus protected data-ROM/COW access.
 * Implementations copy on put/get/read/write and never expose a live view.
 */
export interface CartRepositoryPort extends CurrentCartDataRepositoryPort {
  get(identity: CartIdentity): ParsedCart | undefined;
  put(cart: ParsedCart): void;
}
