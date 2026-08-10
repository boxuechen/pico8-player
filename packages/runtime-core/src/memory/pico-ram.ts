import {
  PICO_RAM_SIZE,
  type PicoMemoryLease,
} from "@pico8-web/contracts";
import type { PicoLogicalMemoryPort } from "../frame-runtime.js";

/** RuntimeCore-owned logical view over a stable physical Base RAM lease. */
export class PicoRam {
  readonly physicalBytes: Uint8Array;
  readonly #mapper: PicoLogicalMemoryPort;

  constructor(memory: PicoMemoryLease, mapper: PicoLogicalMemoryPort) {
    if (
      !(memory.buffer instanceof ArrayBuffer) ||
      memory.byteLength !== PICO_RAM_SIZE ||
      memory.byteOffset < 0 ||
      memory.byteOffset + memory.byteLength > memory.buffer.byteLength
    ) {
      throw new RangeError("PicoRam requires a valid 64 KiB memory lease");
    }
    if (mapper.memoryLeaseId !== memory.leaseId) {
      throw new Error("logical memory port is bound to a different memory lease");
    }
    this.physicalBytes = new Uint8Array(
      memory.buffer,
      memory.byteOffset,
      memory.byteLength,
    );
    this.#mapper = mapper;
  }

  mapAddress(logicalAddress: number): number {
    if (!Number.isInteger(logicalAddress) || !Number.isSafeInteger(logicalAddress)) {
      throw new RangeError("logical Pico RAM address must be a safe integer");
    }
    const mapped = this.#mapper.mapAddress(logicalAddress);
    if (!Number.isInteger(mapped) || mapped < 0 || mapped >= PICO_RAM_SIZE) {
      throw new RangeError("logical memory port returned an invalid physical address");
    }
    return mapped;
  }

  readU8(logicalAddress: number): number {
    return this.physicalBytes[this.mapAddress(logicalAddress)]!;
  }

  writeU8(logicalAddress: number, value: number): void {
    this.physicalBytes[this.mapAddress(logicalAddress)] = value & 0xff;
  }

  readU16LE(logicalAddress: number): number {
    return this.readU8(logicalAddress) |
      (this.readU8(logicalAddress + 1) << 8);
  }

  readI32LE(logicalAddress: number): number {
    return this.readU8(logicalAddress) |
      (this.readU8(logicalAddress + 1) << 8) |
      (this.readU8(logicalAddress + 2) << 16) |
      (this.readU8(logicalAddress + 3) << 24);
  }

  writeU16LE(logicalAddress: number, value: number): void {
    this.writeU8(logicalAddress, value);
    this.writeU8(logicalAddress + 1, value >>> 8);
  }

  writeI32LE(logicalAddress: number, value: number): void {
    this.writeU8(logicalAddress, value);
    this.writeU8(logicalAddress + 1, value >>> 8);
    this.writeU8(logicalAddress + 2, value >>> 16);
    this.writeU8(logicalAddress + 3, value >>> 24);
  }

  fill(logicalAddress: number, length: number, value: number): void {
    assertLength(length);
    if (length === 0) return;
    const normalizedStart = logicalAddress & 0xffff;
    const normalizedEnd = normalizedStart + length - 1;
    const changesVideoMapping = normalizedStart <= 0x5f57 && normalizedEnd >= 0x5f54;
    if (normalizedEnd < PICO_RAM_SIZE && !changesVideoMapping) {
      const physicalStart = this.mapAddress(normalizedStart);
      const physicalEnd = this.mapAddress(normalizedEnd);
      if (physicalEnd === physicalStart + length - 1) {
        this.physicalBytes.fill(value & 0xff, physicalStart, physicalEnd + 1);
        return;
      }
    }
    for (let index = 0; index < length; index += 1) {
      this.writeU8(logicalAddress + index, value);
    }
  }

  copy(logicalAddress: number, length: number): Uint8Array {
    assertLength(length);
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = this.readU8(logicalAddress + index);
    }
    return result;
  }
}

function assertLength(length: number): void {
  if (!Number.isInteger(length) || length < 0 || length > PICO_RAM_SIZE) {
    throw new RangeError("logical Pico RAM length must be between 0 and 65536");
  }
}
