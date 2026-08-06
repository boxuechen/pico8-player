import {
  CartCodecError,
  decodeCart,
  decodeP8,
  decodeP8Png,
  type DecodedP8Cart,
  type DecodedP8PngCart,
  type ParsedCart,
  type P8DecodeOptions,
  type P8PngDecodeOptions,
} from "@pico8-web/cart-codec";
import {
  PICO_CONTROLLER_BUTTON_COUNT,
  PICO_CONTROLLER_BUTTON_MASK,
  PICO_CONTROLLER_COUNT,
  PICO_RAM_SIZE,
  type CartIdentity,
  type PicoInputSnapshot,
  type PicoMemoryLease,
  type SerializedRuntimeError,
} from "@pico8-web/contracts";
import {
  CartSession,
  createPicoApiHost,
  FrameSliceRuntime,
  logicalTimeRaw,
  type CartSessionRuntimeContext,
  type CartSessionRuntimePort,
  type FrameVmPort,
  type PicoApiHost,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
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
const exactControllerCount: 8 = PICO_CONTROLLER_COUNT;
const exactButtonCount: 6 = PICO_CONTROLLER_BUTTON_COUNT;
const exactButtonMask: 63 = PICO_CONTROLLER_BUTTON_MASK;
declare const pngBytes: Uint8Array;
declare const textBytes: Uint8Array;
const decodeOptions: P8PngDecodeOptions = { limits: { maximumCartVersion: 42 } };
const decodedCart: DecodedP8PngCart = decodeP8Png(pngBytes, decodeOptions);
const textDecodeOptions: P8DecodeOptions = { limits: { maximumCartVersion: 42 } };
const decodedTextCart: DecodedP8Cart = decodeP8(textBytes, textDecodeOptions);
const parsedCart: ParsedCart = decodeCart(textBytes);
const cartIdentity: CartIdentity = parsedCart.identity;
const codecErrorConstructor: typeof CartCodecError = CartCodecError;
declare const frameModule: FrameRuntimeModule;
const frameVm: FrameVmPort = new Z8LuaFrameVm(
  frameModule,
  createPicoApiHostRouter(frameModule),
);
const frameRuntime = new FrameSliceRuntime(frameVm);
const picoApiHost: PicoApiHost = createPicoApiHost(
  frameVm.memory,
  frameVm.logicalMemory,
);
declare const runtimeFactory: (
  context: CartSessionRuntimeContext,
) => CartSessionRuntimePort;
const cartSession = new CartSession({ createRuntime: runtimeFactory });
const input: PicoInputSnapshot = {
  controllers: [0, 0, 0, 0, 0, 0, 0, 0],
  devkit: {
    mouseXRaw: 0,
    mouseYRaw: 0,
    mouseButtons: 0,
    wheelRaw: 0,
    movementXRaw: 0,
    movementYRaw: 0,
    keypresses: [],
  },
};
declare const serializedError: SerializedRuntimeError;
const oneSecondRaw = logicalTimeRaw(60n, 60);

void lease;
void exactSize;
void exactControllerCount;
void exactButtonCount;
void exactButtonMask;
void decodedCart;
void decodedTextCart;
void parsedCart;
void cartIdentity;
void codecErrorConstructor;
void frameRuntime;
void picoApiHost;
void cartSession;
void input;
void serializedError;
void oneSecondRaw;

export {};
