import type { CartCancellationToken } from "./cart-resolver-port.js";

export interface RootHostRequest {
  readonly generation: number;
  readonly requestId: number;
  readonly operation: "boot" | "step";
  readonly bytes: Uint8Array;
}

export interface RootHostRequestCompletion {
  readonly generation: number;
  readonly requestId: number;
  readonly bytes: Uint8Array;
  readonly isError: boolean;
}

/** Consumer-owned asynchronous handler for a single root VM suspension. */
export interface RootHostRequestHandlerPort {
  handle(
    request: RootHostRequest,
    cancellation: CartCancellationToken,
  ): Promise<RootHostRequestCompletion>;
}
