import {
  PICO_CART_DATA_ROM_SIZE,
  PICO_RAM_SIZE,
} from "@pico8-web/contracts";

export interface NormalizedReloadRange {
  readonly destination: number;
  readonly source: number;
  readonly length: number;
}

export interface NormalizedCstoreRange {
  readonly destination: number;
  readonly source: number;
  readonly length: number;
}

function rawInteger(raw: number | undefined, fallback: number): number {
  return raw === undefined ? fallback : raw >> 16;
}

function ramAddress(raw: number | undefined): number {
  return rawInteger(raw, 0) & 0xffff;
}

function cartOffset(raw: number | undefined): number {
  return rawInteger(raw, 0);
}

function byteLength(raw: number | undefined): number {
  return rawInteger(raw, PICO_CART_DATA_ROM_SIZE);
}

function assertRange(label: string, offset: number, length: number, limit: number): void {
  if (
    !Number.isInteger(offset) || !Number.isInteger(length) ||
    offset < 0 || length < 0 || offset > limit || length > limit - offset
  ) {
    throw new RangeError(`${label} range is out of bounds`);
  }
}

/** Normalize public Q16.16 reload arguments before any transaction writes. */
export function normalizeReloadRange(
  destinationRaw?: number,
  sourceRaw?: number,
  lengthRaw?: number,
): NormalizedReloadRange {
  const destination = ramAddress(destinationRaw);
  const source = cartOffset(sourceRaw);
  const length = byteLength(lengthRaw);
  assertRange("reload Base RAM destination", destination, length, PICO_RAM_SIZE);
  assertRange("reload cart ROM source", source, length, PICO_CART_DATA_ROM_SIZE);
  return Object.freeze({ destination, source, length });
}

/** Normalize public Q16.16 cstore arguments before taking its RAM snapshot. */
export function normalizeCstoreRange(
  destinationRaw?: number,
  sourceRaw?: number,
  lengthRaw?: number,
): NormalizedCstoreRange {
  const destination = cartOffset(destinationRaw);
  const source = ramAddress(sourceRaw);
  const length = byteLength(lengthRaw);
  assertRange("cstore cart ROM destination", destination, length, PICO_CART_DATA_ROM_SIZE);
  assertRange("cstore Base RAM source", source, length, PICO_RAM_SIZE);
  return Object.freeze({ destination, source, length });
}
