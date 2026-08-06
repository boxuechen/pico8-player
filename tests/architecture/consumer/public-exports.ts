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
  PICO_CART_DATA_BYTES,
  PICO_CART_DATA_ID_MAX_BYTES,
  PICO_CART_DATA_NUMBER_COUNT,
  PICO_CART_DATA_ROM_SIZE,
  PICO_CART_INPUT_MAX_BYTES,
  PICO_CART_REF_MAX_BYTES,
  PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES,
  PICO_HOST_REQUEST_MAX_BYTES,
  PICO_RAM_SIZE,
  type CartAccess,
  type CartIdentity,
  type PicoCartDataCommit,
  type PicoCartDataSeed,
  type PicoInputSnapshot,
  type PicoMemoryLease,
  type SerializedRuntimeError,
} from "@pico8-web/contracts";
import {
  CartCancellationSource,
  CartLoader,
  CartSession,
  createPicoApiHost,
  decodeGuestCartLoadRequest,
  FrameSliceRuntime,
  GUEST_CART_REQUEST_VERSION,
  isGuestCartRequestPayload,
  logicalTimeRaw,
  type CartDataPersistencePort,
  type CartRepositoryPort,
  type CartResolverPort,
  type RootHostRequestHandlerPort,
  type CurrentCartDataRepositoryPort,
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
const exactCartDataBytes: 256 = PICO_CART_DATA_BYTES;
const exactCartDataNumbers: 64 = PICO_CART_DATA_NUMBER_COUNT;
const exactCartDataIdBytes: 64 = PICO_CART_DATA_ID_MAX_BYTES;
const exactCartDataRomBytes: 17152 = PICO_CART_DATA_ROM_SIZE;
const exactCartInputBytes: 1048576 = PICO_CART_INPUT_MAX_BYTES;
const exactCartRefBytes: 256 = PICO_CART_REF_MAX_BYTES;
const exactLocalBundleEntries: 64 = PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES;
const exactHostRequestBytes: 4096 = PICO_HOST_REQUEST_MAX_BYTES;
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
const cartDataSeed: PicoCartDataSeed = {
  id: "public_export",
  bytes: new Uint8Array(PICO_CART_DATA_BYTES),
};
const frameRuntime = new FrameSliceRuntime(frameVm, { cartDataSeeds: [cartDataSeed] });
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
declare const cartDataCommit: PicoCartDataCommit;
declare const cartDataPersistence: CartDataPersistencePort;
declare const currentCartRepository: CurrentCartDataRepositoryPort;
declare const cartRepository: CartRepositoryPort;
declare const cartResolver: CartResolverPort;
declare const rootHostRequestHandler: RootHostRequestHandlerPort;
const cancellation = new CartCancellationSource();
const cartLoader = new CartLoader(cartResolver, cartRepository);
const cartAccess: CartAccess = {
  load: true,
  reloadData: true,
  cstoreData: true,
  include: false,
};
const oneSecondRaw = logicalTimeRaw(60n, 60);
declare const guestCartRequestBytes: Uint8Array;
const guestCartRequest = decodeGuestCartLoadRequest(guestCartRequestBytes);
const guestCartRequestVersion: 1 = GUEST_CART_REQUEST_VERSION;
const isGuestCartRequest: boolean = isGuestCartRequestPayload(guestCartRequestBytes);

void lease;
void exactSize;
void exactControllerCount;
void exactButtonCount;
void exactButtonMask;
void exactCartDataBytes;
void exactCartDataNumbers;
void exactCartDataIdBytes;
void exactCartDataRomBytes;
void exactCartInputBytes;
void exactCartRefBytes;
void exactLocalBundleEntries;
void exactHostRequestBytes;
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
void cartDataCommit;
void cartDataPersistence;
void currentCartRepository;
void cartRepository;
void cartResolver;
void rootHostRequestHandler;
void cancellation;
void cartLoader;
void cartAccess;
void oneSecondRaw;
void guestCartRequest;
void guestCartRequestVersion;
void isGuestCartRequest;

export {};
