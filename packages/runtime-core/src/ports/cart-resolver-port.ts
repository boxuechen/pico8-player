import type { CartAccess, CartIdentity } from "@pico8-player/contracts";

export type CartResolvePurpose = "load" | "reload" | "cstore" | "include";

/** Runtime-neutral cancellation contract. It intentionally is not AbortSignal. */
export interface CartCancellationToken {
  readonly cancelled: boolean;
  onCancel(listener: () => void): () => void;
}

export interface CartResolveContext {
  readonly current?: CartIdentity;
  readonly purpose: CartResolvePurpose;
}

/** Every byte array crossing this port must be owned by the receiver. */
export interface ResolvedCartSource {
  readonly ref: string;
  readonly bytes: Uint8Array;
  readonly access: CartAccess;
}

/** Consumer-owned port for resolving a caller-authorized opaque cart ref. */
export interface CartResolverPort {
  resolve(
    ref: string,
    context: CartResolveContext,
    cancellation: CartCancellationToken,
  ): Promise<ResolvedCartSource>;
}
