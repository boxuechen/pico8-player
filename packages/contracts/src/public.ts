/** Physical PICO-8 Base RAM size. Cart ROM is a separate object. */
export const PICO_RAM_SIZE = 0x1_0000 as const;

/** Serialized cartridge ROM size before it is copied into Base RAM. */
export const PICO_CART_ROM_SIZE = 0x8000 as const;

/** Highest cart format version accepted by the PICO-8 0.2.7 target. */
export const PICO8_0_2_7_CART_VERSION = 42 as const;

/**
 * Runtime-neutral lease for a stable 64 KiB region in an adapter-owned buffer.
 * It intentionally exposes neither WebAssembly.Memory nor an Emscripten module.
 */
export interface PicoMemoryLease {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: typeof PICO_RAM_SIZE;
  readonly leaseId: string;
}
