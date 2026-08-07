import {
  PlayerComposition,
  type PlayerCompositionOptions,
} from "./compose-player.js";
import {
  PlayerController,
  type PlayerShellElements,
} from "./player-controller.js";
import type { GamepadSource } from "./gamepad-input.js";

export interface MountPlayerOptions {
  readonly root: HTMLElement;
  readonly runtimeWorkerFactory?: PlayerCompositionOptions["runtimeWorkerFactory"];
  /** Internal release composition switch; public consumers use createPico8WebPlayer. */
  readonly useDefaultAssets?: boolean;
  readonly commandTimeoutMs?: number;
  readonly workletModuleUrl?: string | URL;
  readonly audio?: PlayerCompositionOptions["audio"];
  readonly gamepadSource?: GamepadSource;
}

export interface MountedPlayer {
  readonly composition: PlayerComposition;
  readonly controller: PlayerController;
  readonly elements: PlayerShellElements;
}

function button(document: Document, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  return element;
}

/** Creates the deliberately small Phase 1E DOM shell inside a caller-owned root. */
export async function mountPico8Player(
  options: MountPlayerOptions,
): Promise<MountedPlayer> {
  const document = options.root.ownerDocument;
  const shell = document.createElement("section");
  shell.className = "pico8-player";
  shell.style.display = "inline-grid";
  shell.style.gap = "0.5rem";
  shell.setAttribute("aria-label", "PICO-8 player");

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "PICO-8 playfield");
  canvas.tabIndex = 0;

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".p8,.p8.png,image/png";
  fileInput.setAttribute("aria-label", "Choose a PICO-8 cartridge");

  const controls = document.createElement("div");
  const playButton = button(document, "Play");
  const pauseButton = button(document, "Pause");
  const resetButton = button(document, "Reset");
  const stopButton = button(document, "Stop");
  controls.append(playButton, pauseButton, resetButton, stopButton);

  const touchControls = document.createElement("div");
  touchControls.className = "pico8-player__touch-controls";
  touchControls.setAttribute("aria-label", "Player 1 touch controls");
  touchControls.style.display = "grid";
  touchControls.style.gridTemplateColumns = "repeat(6, minmax(2.75rem, 1fr))";
  touchControls.style.gap = "0.25rem";
  touchControls.style.touchAction = "none";
  for (const [label, picoButton] of [
    ["←", 0], ["→", 1], ["↑", 2], ["↓", 3], ["O", 4], ["X", 5],
  ] as const) {
    const control = button(document, label);
    control.dataset.picoButton = String(picoButton);
    control.dataset.picoPlayer = "0";
    control.style.touchAction = "none";
    touchControls.append(control);
  }

  const status = document.createElement("output");
  status.className = "pico8-player__status";
  const diagnostic = document.createElement("pre");
  diagnostic.className = "pico8-player__diagnostic";
  diagnostic.style.whiteSpace = "pre-wrap";

  shell.append(fileInput, canvas, controls, touchControls, status, diagnostic);
  options.root.replaceChildren(shell);

  const composition = await PlayerComposition.create({
    canvas,
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
  const elements: PlayerShellElements = {
    root: shell,
    canvas,
    status,
    diagnostic,
    fileInput,
    playButton,
    pauseButton,
    resetButton,
    stopButton,
    touchControls,
  };
  const controller = new PlayerController(composition, elements, {
    window: document.defaultView ?? window,
    document,
    ...(options.gamepadSource === undefined
      ? {}
      : { gamepadSource: options.gamepadSource }),
  });
  return { composition, controller, elements };
}

export { PlayerComposition } from "./compose-player.js";
export { KeyboardInputFrontend } from "./input-frontend.js";
export { GamepadInputFrontend } from "./gamepad-input.js";
export { DevkitInputFrontend } from "./devkit-input.js";
export { PlayerInputFrontend } from "./player-input.js";
export { TouchInputFrontend } from "./touch-input.js";
export { PlayerController } from "./player-controller.js";
export { PlayerRuntimeClient } from "./player-runtime-client.js";
