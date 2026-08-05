import {
  CartCodecError,
  decodeP8Png,
  type DecodedP8PngCart,
  type P8PngDecodeOptions,
} from "@pico8-web/cart-codec";
import {
  PICO_RAM_SIZE,
  type PicoInputSnapshot,
  type PicoMemoryLease,
  type SerializedRuntimeError,
} from "@pico8-web/contracts";
import {
  FrameSliceRuntime,
  logicalTimeRaw,
  type FrameVmPort,
} from "@pico8-web/runtime-core";
import {
  Z8LuaFrameVm,
  type FrameRuntimeModule,
  Phase0BMemoryBinding,
  type Phase0BMemoryModule,
} from "@pico8-web/z8lua-bridge";

declare const module: Phase0BMemoryModule;
declare const handle: number;

const binding = new Phase0BMemoryBinding(module, handle);
const lease: PicoMemoryLease = binding.lease;
const exactSize: 65536 = PICO_RAM_SIZE;
declare const pngBytes: Uint8Array;
const decodeOptions: P8PngDecodeOptions = { limits: { maximumCartVersion: 42 } };
const decodedCart: DecodedP8PngCart = decodeP8Png(pngBytes, decodeOptions);
const codecErrorConstructor: typeof CartCodecError = CartCodecError;
declare const frameModule: FrameRuntimeModule;
const frameVm: FrameVmPort = new Z8LuaFrameVm(frameModule);
const frameRuntime = new FrameSliceRuntime(frameVm);
const input: PicoInputSnapshot = { buttons: 0 };
declare const serializedError: SerializedRuntimeError;
const oneSecondRaw = logicalTimeRaw(60n, 60);

void lease;
void exactSize;
void decodedCart;
void codecErrorConstructor;
void frameRuntime;
void input;
void serializedError;
void oneSecondRaw;

export {};
