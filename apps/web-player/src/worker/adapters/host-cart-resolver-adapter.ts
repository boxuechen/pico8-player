import {
  PICO_CART_INPUT_MAX_BYTES,
  PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES,
  type CartAccess,
} from "@pico8-web/contracts";
import {
  CART_RESOLUTION_ERROR_CODES,
  CartResolutionError,
  assertCartAccessForPurpose,
  assertCartRef,
  assertCartResolvePurpose,
  copyCartAccess,
  type CartCancellationToken,
  type CartResolveContext,
  type CartResolverPort,
  type ResolvedCartSource,
} from "@pico8-web/runtime-core";

export interface LocalCartBundleEntry {
  readonly ref: string;
  readonly bytes: Uint8Array;
  readonly access: CartAccess;
}

interface OwnedLocalCartBundleEntry {
  readonly ref: string;
  readonly bytes: Uint8Array;
  readonly access: Readonly<CartAccess>;
}

function assertLocalRef(ref: string): string {
  const checked = assertCartRef(ref);
  if (
    checked.startsWith("/") || checked.startsWith("#") ||
    checked.includes("://") || checked.includes("\\") ||
    checked.split("/").some((part) => part === "." || part === ".." || part.length === 0)
  ) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.invalidRef,
      "local bundle ref must be a canonical relative opaque name",
    );
  }
  return checked;
}

function copyEntry(entry: LocalCartBundleEntry): OwnedLocalCartBundleEntry {
  const ref = assertLocalRef(entry.ref);
  if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength === 0) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.invalidSource,
      "local bundle entry must contain cart bytes",
    );
  }
  if (entry.bytes.byteLength > PICO_CART_INPUT_MAX_BYTES) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.sourceTooLarge,
      `local bundle entry exceeds ${PICO_CART_INPUT_MAX_BYTES} bytes`,
    );
  }
  return Object.freeze({
    ref,
    bytes: entry.bytes.slice(),
    access: copyCartAccess(entry.access),
  });
}

/**
 * Worker-local resolver over caller-provided bytes. It performs no discovery,
 * URL fetch, filesystem lookup or capability inference.
 */
export class LocalCartBundleResolver implements CartResolverPort {
  readonly #entries = new Map<string, OwnedLocalCartBundleEntry>();
  #disposed = false;

  constructor(entries: readonly LocalCartBundleEntry[]) {
    if (!Array.isArray(entries)) {
      throw new TypeError("local cart bundle must be an array");
    }
    if (entries.length > PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES) {
      throw new CartResolutionError(
        CART_RESOLUTION_ERROR_CODES.bundleLimit,
        `local cart bundle exceeds ${PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES} entries`,
      );
    }
    for (const candidate of entries) {
      const entry = copyEntry(candidate);
      if (this.#entries.has(entry.ref)) {
        throw new CartResolutionError(
          CART_RESOLUTION_ERROR_CODES.duplicateRef,
          `local cart bundle contains duplicate ref: ${entry.ref}`,
        );
      }
      this.#entries.set(entry.ref, entry);
    }
  }

  resolve(
    ref: string,
    context: CartResolveContext,
    cancellation: CartCancellationToken,
  ): Promise<ResolvedCartSource> {
    this.#assertLive();
    const checkedRef = assertLocalRef(ref);
    const entry = this.#entries.get(checkedRef);
    if (entry === undefined) {
      throw new CartResolutionError(
        CART_RESOLUTION_ERROR_CODES.notFound,
        `local cart bundle does not contain ref: ${checkedRef}`,
      );
    }
    assertCartAccessForPurpose(entry.access, assertCartResolvePurpose(context.purpose));

    return new Promise<ResolvedCartSource>((resolve, reject) => {
      let settled = false;
      let unsubscribe = (): void => undefined;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        action();
      };
      const cancel = (): void => {
        finish(() => reject(new CartResolutionError(
          CART_RESOLUTION_ERROR_CODES.cancelled,
          "cart resolution was cancelled",
        )));
      };

      try {
        unsubscribe = cancellation.onCancel(cancel);
        if (cancellation.cancelled) cancel();
      } catch (error) {
        finish(() => reject(error));
      }

      void Promise.resolve().then(() => {
        if (settled) return;
        if (this.#disposed) {
          finish(() => reject(new CartResolutionError(
            CART_RESOLUTION_ERROR_CODES.disposed,
            "local cart bundle resolver is disposed",
          )));
          return;
        }
        if (cancellation.cancelled) {
          cancel();
          return;
        }
        finish(() => resolve(Object.freeze({
          ref: entry.ref,
          bytes: entry.bytes.slice(),
          access: copyCartAccess(entry.access),
        })));
      });
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#entries.clear();
    this.#disposed = true;
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new CartResolutionError(
        CART_RESOLUTION_ERROR_CODES.disposed,
        "local cart bundle resolver is disposed",
      );
    }
  }
}
