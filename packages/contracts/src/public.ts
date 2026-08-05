/** Physical PICO-8 Base RAM size. Cart ROM is a separate object. */
export const PICO_RAM_SIZE = 0x1_0000 as const;

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
