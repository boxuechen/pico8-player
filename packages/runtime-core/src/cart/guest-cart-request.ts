import {
  PICO_CART_REF_MAX_BYTES,
  PICO_HOST_REQUEST_MAX_BYTES,
} from "@pico8-player/contracts";

import { decodeCartRequestRef, invalidCartRequest } from "./cart-request-codec.js";

export const GUEST_CART_REQUEST_MAGIC = Object.freeze([0x50, 0x38, 0x57, 0x4c] as const);
export const GUEST_CART_REQUEST_VERSION = 1 as const;
export const GUEST_CART_REQUEST_HEADER_BYTES = 16 as const;

const LOAD_OPERATION = 1;
const BREADCRUMB_PRESENT = 1 << 0;
const PARAMETER_PRESENT = 1 << 1;
const KNOWN_FLAGS = BREADCRUMB_PRESENT | PARAMETER_PRESENT;

export interface GuestCartLoadRequest {
  readonly operation: "load";
  readonly ref: string;
  readonly breadcrumb?: Uint8Array;
  readonly parameter?: Uint8Array;
}

function invalid(message: string): never {
  return invalidCartRequest("guest cart", message);
}

/** Cheap discriminator; matching payloads must still pass the strict decoder. */
export function isGuestCartRequestPayload(bytes: Uint8Array): boolean {
  return bytes.byteLength >= GUEST_CART_REQUEST_MAGIC.length &&
    GUEST_CART_REQUEST_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Decode the copy-owned, versioned root load() request emitted by z8lua. */
export function decodeGuestCartLoadRequest(bytes: Uint8Array): GuestCartLoadRequest {
  if (!(bytes instanceof Uint8Array)) invalid("payload must be a Uint8Array");
  if (bytes.byteLength > PICO_HOST_REQUEST_MAX_BYTES) invalid("payload exceeds 4096 bytes");
  if (bytes.byteLength < GUEST_CART_REQUEST_HEADER_BYTES) invalid("payload is truncated");
  if (!isGuestCartRequestPayload(bytes)) invalid("magic does not match");
  if (bytes[4] !== GUEST_CART_REQUEST_VERSION) invalid("version is unsupported");
  if (bytes[5] !== LOAD_OPERATION) invalid("operation is unsupported");
  const flags = bytes[6]!;
  if ((flags & ~KNOWN_FLAGS) !== 0 || bytes[7] !== 0) invalid("flags are not canonical");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const refLength = view.getUint16(8, true);
  const breadcrumbLength = view.getUint16(10, true);
  const parameterLength = view.getUint16(12, true);
  if (view.getUint16(14, true) !== 0) invalid("reserved field is not zero");
  if (refLength === 0 || refLength > PICO_CART_REF_MAX_BYTES) invalid("ref length is invalid");
  if ((flags & BREADCRUMB_PRESENT) === 0 && breadcrumbLength !== 0) {
    invalid("breadcrumb presence is inconsistent");
  }
  if ((flags & PARAMETER_PRESENT) === 0 && parameterLength !== 0) {
    invalid("parameter presence is inconsistent");
  }
  const expectedLength = GUEST_CART_REQUEST_HEADER_BYTES + refLength +
    breadcrumbLength + parameterLength;
  if (expectedLength !== bytes.byteLength) invalid("payload length is not canonical");

  const refStart = GUEST_CART_REQUEST_HEADER_BYTES;
  const ref = decodeCartRequestRef(
    "guest cart",
    bytes.subarray(refStart, refStart + refLength),
  );
  const breadcrumbStart = refStart + refLength;
  const parameterStart = breadcrumbStart + breadcrumbLength;
  return Object.freeze({
    operation: "load" as const,
    ref,
    ...((flags & BREADCRUMB_PRESENT) === 0 ? {} : {
      breadcrumb: bytes.slice(breadcrumbStart, parameterStart),
    }),
    ...((flags & PARAMETER_PRESENT) === 0 ? {} : {
      parameter: bytes.slice(parameterStart),
    }),
  });
}
