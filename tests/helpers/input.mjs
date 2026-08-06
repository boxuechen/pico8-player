const ZERO_CONTROLLERS = Object.freeze(new Array(8).fill(0));

export function inputSnapshot(
  controllers = ZERO_CONTROLLERS,
  devkit = {},
) {
  return {
    controllers: [...controllers, ...ZERO_CONTROLLERS].slice(0, 8),
    devkit: {
      mouseXRaw: 0,
      mouseYRaw: 0,
      mouseButtons: 0,
      wheelRaw: 0,
      movementXRaw: 0,
      movementYRaw: 0,
      keypresses: [],
      ...devkit,
      ...(devkit.keypresses === undefined
        ? {}
        : { keypresses: Array.from(devkit.keypresses) }),
    },
  };
}
