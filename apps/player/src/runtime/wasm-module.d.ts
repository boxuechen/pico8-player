declare module "*z8lua-runtime-v1.mjs" {
  const create: () => Promise<import("@pico8-player/z8lua-bridge").FrameRuntimeModule>;
  export default create;
}
