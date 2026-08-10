import {
  PlayerComposition,
  type PlayerCompositionOptions,
} from "./compose-player.js";
import {
  PlayerController,
} from "./player-controller.js";
import type { GamepadSource } from "./gamepad-input.js";
import {
  PlayerShellView,
  type PlayerShellElements,
  type PlayerShellMode,
} from "./ui/player-shell-view.js";

export interface MountPlayerOptions {
  readonly root: HTMLElement;
  readonly runtimeWorkerFactory?: PlayerCompositionOptions["runtimeWorkerFactory"];
  /** Internal release composition switch; public consumers use createPico8WebPlayer. */
  readonly useDefaultAssets?: boolean;
  readonly commandTimeoutMs?: number;
  readonly workletModuleUrl?: string | URL;
  readonly audio?: PlayerCompositionOptions["audio"];
  readonly gamepadSource?: GamepadSource;
  readonly shell?: PlayerShellMode;
}

export interface MountedPlayer {
  readonly composition: PlayerComposition;
  readonly controller: PlayerController;
  readonly elements: PlayerShellElements;
  readonly view: PlayerShellView;
}

/** Creates the production DOM shell inside a caller-owned root. */
export async function mountPico8Player(
  options: MountPlayerOptions,
): Promise<MountedPlayer> {
  const document = options.root.ownerDocument;
  const view = PlayerShellView.create(options.root, {
    window: document.defaultView ?? window,
    document,
    ...(options.shell === undefined ? {} : { shell: options.shell }),
  });
  const { elements } = view;

  try {
    const composition = await PlayerComposition.create({
      canvas: elements.canvas,
      ...(options.runtimeWorkerFactory === undefined
        ? {}
        : { runtimeWorkerFactory: options.runtimeWorkerFactory }),
      ...(options.useDefaultAssets === undefined
        ? {}
        : { useDefaultAssets: options.useDefaultAssets }),
      ...(options.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: options.commandTimeoutMs }),
      ...(options.workletModuleUrl === undefined
        ? {}
        : { workletModuleUrl: options.workletModuleUrl }),
      ...(options.audio === undefined ? {} : { audio: options.audio }),
    });
    const controller = new PlayerController(composition, view, {
      window: document.defaultView ?? window,
      document,
      ...(options.gamepadSource === undefined
        ? {}
        : { gamepadSource: options.gamepadSource }),
    });
    return { composition, controller, elements, view };
  } catch (error) {
    view.showDiagnostic(error instanceof Error ? error.message : String(error));
    view.dispose();
    throw error;
  }
}

export { PlayerComposition } from "./compose-player.js";
export { KeyboardInputFrontend } from "./input-frontend.js";
export { GamepadInputFrontend } from "./gamepad-input.js";
export { DevkitInputFrontend } from "./devkit-input.js";
export { PlayerInputFrontend } from "./player-input.js";
export { TouchInputFrontend } from "./touch-input.js";
export { PlayerController } from "./player-controller.js";
export { PlayerRuntimeClient } from "./player-runtime-client.js";
export { PlayerShellView } from "./ui/player-shell-view.js";
