import {
  PICO_CART_REF_MAX_BYTES,
  PICO_HOST_REQUEST_MAX_BYTES,
} from "@pico8-player/contracts";

import { decodeCartRequestRef, invalidCartRequest } from "./cart-request-codec.js";

export const EXTERNAL_CART_DATA_REQUEST_MAGIC = Object.freeze(
  [0x50, 0x38, 0x57, 0x44] as const,
);
export const EXTERNAL_CART_DATA_REQUEST_VERSION = 1 as const;
export const EXTERNAL_CART_DATA_REQUEST_HEADER_BYTES = 24 as const;

const RELOAD_OPERATION = 1;
const CSTORE_OPERATION = 2;
const DESTINATION_PRESENT = 1 << 0;
const SOURCE_PRESENT = 1 << 1;
const LENGTH_PRESENT = 1 << 2;
const REFERENCE_PRESENT = 1 << 3;
const KNOWN_FLAGS = DESTINATION_PRESENT | SOURCE_PRESENT | LENGTH_PRESENT |
  REFERENCE_PRESENT;

export interface ExternalCartDataRequest {
  readonly operation: "reload" | "cstore";
  readonly ref: string;
  readonly destinationRaw?: number;
  readonly sourceRaw?: number;
  readonly lengthRaw?: number;
}

function invalid(message: string): never {
  return invalidCartRequest("external cart-data", message);
}

/** Cheap discriminator; matching payloads must still pass the strict decoder. */
export function isExternalCartDataRequestPayload(bytes: Uint8Array): boolean {
  return bytes.byteLength >= EXTERNAL_CART_DATA_REQUEST_MAGIC.length &&
    EXTERNAL_CART_DATA_REQUEST_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Decode a copy-owned root external reload/cstore transaction request. */
export function decodeExternalCartDataRequest(
  bytes: Uint8Array,
): ExternalCartDataRequest {
  if (!(bytes instanceof Uint8Array)) invalid("payload must be a Uint8Array");
  if (bytes.byteLength > PICO_HOST_REQUEST_MAX_BYTES) invalid("payload exceeds 4096 bytes");
  if (bytes.byteLength < EXTERNAL_CART_DATA_REQUEST_HEADER_BYTES) invalid("payload is truncated");
  if (!isExternalCartDataRequestPayload(bytes)) invalid("magic does not match");
  if (bytes[4] !== EXTERNAL_CART_DATA_REQUEST_VERSION) invalid("version is unsupported");
  const operation = bytes[5] === RELOAD_OPERATION
    ? "reload" as const
    : bytes[5] === CSTORE_OPERATION
      ? "cstore" as const
      : invalid("operation is unsupported");
  const flags = bytes[6]!;
  if ((flags & ~KNOWN_FLAGS) !== 0 || (flags & REFERENCE_PRESENT) === 0 || bytes[7] !== 0) {
    invalid("flags are not canonical");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawSlots = [view.getInt32(8, true), view.getInt32(12, true), view.getInt32(16, true)];
  const scalarFlags = [DESTINATION_PRESENT, SOURCE_PRESENT, LENGTH_PRESENT];
  for (let index = 0; index < rawSlots.length; index += 1) {
    if ((flags & scalarFlags[index]!) === 0 && rawSlots[index] !== 0) {
      invalid("absent scalar slot is not zero");
    }
  }
  const refLength = view.getUint16(20, true);
  if (view.getUint16(22, true) !== 0) invalid("reserved field is not zero");
  if (refLength === 0 || refLength > PICO_CART_REF_MAX_BYTES) invalid("ref length is invalid");
  if (EXTERNAL_CART_DATA_REQUEST_HEADER_BYTES + refLength !== bytes.byteLength) {
    invalid("payload length is not canonical");
  }
  const ref = decodeCartRequestRef(
    "external cart-data",
    bytes.subarray(EXTERNAL_CART_DATA_REQUEST_HEADER_BYTES),
  );
  return Object.freeze({
    operation,
    ref,
    ...((flags & DESTINATION_PRESENT) === 0 ? {} : { destinationRaw: rawSlots[0]! }),
    ...((flags & SOURCE_PRESENT) === 0 ? {} : { sourceRaw: rawSlots[1]! }),
    ...((flags & LENGTH_PRESENT) === 0 ? {} : { lengthRaw: rawSlots[2]! }),
  });
}
