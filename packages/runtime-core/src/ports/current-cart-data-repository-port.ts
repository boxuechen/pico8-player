import type { CartIdentity } from "@pico8-player/contracts";

/**
 * Browser-neutral synchronous access to one Worker's effective current-cart
 * data ROM. Implementations must return and retain copy-owned byte ranges.
 */
export interface CurrentCartDataRepositoryPort {
  readData(
    identity: CartIdentity,
    source: number,
    length: number,
  ): Uint8Array;
  writeDataOverlay(
    identity: CartIdentity,
    destination: number,
    bytes: Uint8Array,
  ): void;
}
