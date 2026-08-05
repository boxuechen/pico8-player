import "@pico8-web/cart-codec";
import {
  PICO_RAM_SIZE,
  type PicoMemoryLease,
} from "@pico8-web/contracts";
import "@pico8-web/runtime-core";
import {
  Phase0BMemoryBinding,
  type Phase0BMemoryModule,
} from "@pico8-web/z8lua-bridge";

declare const module: Phase0BMemoryModule;
declare const handle: number;

const binding = new Phase0BMemoryBinding(module, handle);
const lease: PicoMemoryLease = binding.lease;
const exactSize: 65536 = PICO_RAM_SIZE;

void lease;
void exactSize;

export {};
