import {
  PICO_RAM_SIZE,
  type PicoMemoryLease,
} from "@pico8-web/contracts";

const INVALID_MAPPED_ADDRESS = 0xffff_ffff;
const moduleIds = new WeakMap<object, number>();
let nextModuleId = 1;

/** Minimal Emscripten surface consumed by the Phase 0B memory adapter. */
export interface Phase0BMemoryModule {
  readonly HEAPU8: Uint8Array;
  _p8w0b_ram_ptr(handle: number): number;
  _p8w0b_ram_size(handle: number): number;
  _p8w0b_ram_reset(handle: number): number;
  _p8w0b_map_address(handle: number, logicalAddress: number): number;
}

export interface PicoRamLayout {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly gfx: Uint8Array;
  readonly map: Uint8Array;
  readonly flags: Uint8Array;
  readonly songs: Uint8Array;
  readonly sfx: Uint8Array;
  readonly cartData: Uint8Array;
  readonly screen: Uint8Array;
}

function moduleId(module: object): number {
  const existing = moduleIds.get(module);
  if (existing !== undefined) return existing;
  const assigned = nextModuleId++;
  moduleIds.set(module, assigned);
  return assigned;
}

/**
 * Zero-copy physical views plus logical reads/writes routed through the WASM
 * address mapper used by z8lua direct memory operators.
 */
export class Phase0BMemoryBinding implements PicoRamLayout {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly gfx: Uint8Array;
  readonly map: Uint8Array;
  readonly flags: Uint8Array;
  readonly songs: Uint8Array;
  readonly sfx: Uint8Array;
  readonly cartData: Uint8Array;
  readonly screen: Uint8Array;
  readonly lease: PicoMemoryLease;

  readonly #module: Phase0BMemoryModule;
  readonly #handle: number;

  constructor(module: Phase0BMemoryModule, handle: number) {
    const pointer = module._p8w0b_ram_ptr(handle) >>> 0;
    const size = module._p8w0b_ram_size(handle) >>> 0;
    const buffer = module.HEAPU8.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("Phase 0B requires a non-shared ArrayBuffer");
    }
    if (
      pointer === 0 ||
      size !== PICO_RAM_SIZE ||
      pointer + size > module.HEAPU8.byteLength
    ) {
      throw new RangeError("invalid or stale Phase 0B Pico RAM allocation");
    }

    this.#module = module;
    this.#handle = handle;
    this.bytes = module.HEAPU8.subarray(pointer, pointer + size);
    this.view = new DataView(buffer, pointer, size);
    this.gfx = this.bytes.subarray(0x0000, 0x2000);
    this.map = this.bytes.subarray(0x2000, 0x3000);
    this.flags = this.bytes.subarray(0x3000, 0x3100);
    this.songs = this.bytes.subarray(0x3100, 0x3200);
    this.sfx = this.bytes.subarray(0x3200, 0x4300);
    this.cartData = this.bytes.subarray(0x5e00, 0x5f00);
    this.screen = this.bytes.subarray(0x6000, 0x8000);
    this.lease = Object.freeze({
      buffer,
      byteOffset: pointer,
      byteLength: PICO_RAM_SIZE,
      leaseId: `p8w0b:${moduleId(module)}:${handle >>> 0}:${pointer}`,
    });
  }

  assertBoundLease(leaseId = this.lease.leaseId): void {
    if (
      leaseId !== this.lease.leaseId ||
      this.#module.HEAPU8.buffer !== this.lease.buffer ||
      (this.#module._p8w0b_ram_ptr(this.#handle) >>> 0) !==
        this.lease.byteOffset ||
      (this.#module._p8w0b_ram_size(this.#handle) >>> 0) !== PICO_RAM_SIZE
    ) {
      throw new Error("stale or detached Pico memory lease");
    }
  }

  reset(): void {
    this.assertBoundLease();
    if (this.#module._p8w0b_ram_reset(this.#handle) !== 0) {
      throw new Error("unable to reset Pico RAM");
    }
  }

  mapAddress(logicalAddress: number): number {
    this.assertBoundLease();
    const mapped =
      this.#module._p8w0b_map_address(this.#handle, logicalAddress >>> 0) >>> 0;
    if (mapped === INVALID_MAPPED_ADDRESS || mapped >= PICO_RAM_SIZE) {
      throw new RangeError("unable to map Pico RAM address");
    }
    return mapped;
  }

  readU8(logicalAddress: number): number {
    return this.bytes[this.mapAddress(logicalAddress)]!;
  }

  writeU8(logicalAddress: number, value: number): void {
    this.bytes[this.mapAddress(logicalAddress)] = value & 0xff;
  }

  readI16LE(logicalAddress: number): number {
    const unsigned =
      this.readU8(logicalAddress) |
      (this.readU8(logicalAddress + 1) << 8);
    return (unsigned << 16) >> 16;
  }

  readI32LE(logicalAddress: number): number {
    return this.readU8(logicalAddress) |
      (this.readU8(logicalAddress + 1) << 8) |
      (this.readU8(logicalAddress + 2) << 16) |
      (this.readU8(logicalAddress + 3) << 24);
  }

  writeI32LE(logicalAddress: number, raw: number): void {
    this.writeU8(logicalAddress, raw);
    this.writeU8(logicalAddress + 1, raw >>> 8);
    this.writeU8(logicalAddress + 2, raw >>> 16);
    this.writeU8(logicalAddress + 3, raw >>> 24);
  }
}

export type { PicoMemoryLease } from "@pico8-web/contracts";
