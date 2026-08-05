import {
  PlayerComposition,
  type PlayerCompositionOptions,
} from "./compose-player.js";
import {
  PlayerController,
  type PlayerShellElements,
} from "./player-controller.js";

export interface MountPlayerOptions {
  readonly root: HTMLElement;
  readonly runtimeWorkerFactory: PlayerCompositionOptions["runtimeWorkerFactory"];
  readonly commandTimeoutMs?: number;
  readonly workletModuleUrl?: string | URL;
  readonly audio?: PlayerCompositionOptions["audio"];
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

  const status = document.createElement("output");
  status.className = "pico8-player__status";
  const diagnostic = document.createElement("pre");
  diagnostic.className = "pico8-player__diagnostic";
  diagnostic.style.whiteSpace = "pre-wrap";

  shell.append(fileInput, canvas, controls, status, diagnostic);
  options.root.replaceChildren(shell);

  const composition = await PlayerComposition.create({
    canvas,
    runtimeWorkerFactory: options.runtimeWorkerFactory,
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
  };
  const controller = new PlayerController(composition, elements, {
    window: document.defaultView ?? window,
    document,
  });
  return { composition, controller, elements };
}

export { PlayerComposition } from "./compose-player.js";
export { KeyboardInputFrontend } from "./input-frontend.js";
export { PlayerController } from "./player-controller.js";
export { PlayerRuntimeClient } from "./player-runtime-client.js";
