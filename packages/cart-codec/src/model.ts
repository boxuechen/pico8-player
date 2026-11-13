import type { CartIdentity } from "@pico8-player/contracts";

import { sha256Hex } from "./sha256.js";

export type CartFormat = "p8" | "p8.png";

export type { CartIdentity };

export type CartWarningCode = "W_CART_UNKNOWN_SECTION";

export interface CartWarning {
  readonly code: CartWarningCode;
  readonly message: string;
  /** Byte offset in the original encoded input. */
  readonly offset: number;
  readonly section?: string;
}

export interface ParsedCart {
  readonly identity: CartIdentity;
  readonly format: CartFormat;
  readonly version: number;
  readonly rom: Uint8Array;
  readonly code: Uint8Array;
  readonly warnings: readonly CartWarning[];
  readonly sourceBytes: number;
}

interface ParsedCartFields<Format extends CartFormat> {
  readonly format: Format;
  readonly version: number;
  readonly rom: Uint8Array;
  readonly code: Uint8Array;
  readonly warnings?: readonly CartWarning[];
}

export function createParsedCart<Format extends CartFormat, Metadata extends object>(
  input: Uint8Array,
  fields: ParsedCartFields<Format>,
  metadata: Metadata,
): ParsedCart & Readonly<{ format: Format }> & Metadata {
  const rom = fields.rom.slice();
  const code = fields.code.slice();
  const warnings = Object.freeze(
    (fields.warnings ?? []).map((warning) => Object.freeze({ ...warning })),
  );
  const identity = Object.freeze({ contentSha256: sha256Hex(input) });
  return Object.freeze({
    ...metadata,
    identity,
    format: fields.format,
    version: fields.version,
    rom,
    code,
    warnings,
    sourceBytes: input.length,
  }) as ParsedCart & Readonly<{ format: Format }> & Metadata;
}
