import type { PicoRam } from "../memory/pico-ram.js";

const MAP_BASE_REGISTER = 0x5f56;
const MAP_WIDTH_REGISTER = 0x5f57;
const LOWER_MAP_START = 0x1000;
const LOWER_MAP_BYTES = 0x2000;
const UPPER_MAP_START = 0x8000;
const RAM_END = 0x1_0000;
const DEFAULT_MAP_BASE_PAGE = 0x20;

export interface PicoMapLayout {
  readonly basePage: number;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly upper: boolean;
}

/** Resolves the RAM-backed map without changing canonical logical RAM mapping. */
export class PicoMapMemory {
  readonly #ram: Uint8Array;

  constructor(memory: PicoRam) {
    this.#ram = memory.physicalBytes;
  }

  layout(): PicoMapLayout {
    const configuredBase = this.#ram[MAP_BASE_REGISTER]!;
    const width = this.#ram[MAP_WIDTH_REGISTER]! || 256;
    if (configuredBase >= 0x80) {
      const byteLength = RAM_END - configuredBase * 0x100;
      return {
        basePage: configuredBase,
        width,
        height: Math.floor(byteLength / width),
        byteLength,
        upper: true,
      };
    }
    const basePage = normalizeLowerBase(configuredBase);
    return {
      basePage,
      width,
      height: Math.floor(LOWER_MAP_BYTES / width),
      byteLength: LOWER_MAP_BYTES,
      upper: false,
    };
  }

  read(x: number, y: number): number | undefined {
    const address = this.address(x, y);
    return address === undefined ? undefined : this.#ram[address]!;
  }

  write(x: number, y: number, value: number): boolean {
    const address = this.address(x, y);
    if (address === undefined) return false;
    this.#ram[address] = value & 0xff;
    return true;
  }

  address(x: number, y: number): number | undefined {
    const layout = this.layout();
    if (
      !Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || x >= layout.width || y < 0 || y >= layout.height
    ) {
      return undefined;
    }
    const index = y * layout.width + x;
    if (layout.upper) return layout.basePage * 0x100 + index;
    const baseOffset = (layout.basePage - 0x10) * 0x100;
    return LOWER_MAP_START + ((baseOffset + index) & (LOWER_MAP_BYTES - 1));
  }
}

function normalizeLowerBase(configuredBase: number): number {
  if (configuredBase >= 0x10 && configuredBase <= 0x2f) return configuredBase;
  if (configuredBase >= 0x30 && configuredBase <= 0x3f) return configuredBase - 0x20;
  return DEFAULT_MAP_BASE_PAGE;
}
