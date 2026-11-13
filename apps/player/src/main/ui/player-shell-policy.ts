import { PICO_CART_INPUT_MAX_BYTES } from "@pico8-player/contracts";

export const MAX_LOCAL_CART_BYTES = PICO_CART_INPUT_MAX_BYTES;
export const PICO_PLAYFIELD_SIZE = 128;
export const MAX_INTEGER_SCALE = 8;

export type PlayerShellState =
  | "idle"
  | "loading"
  | "ready"
  | "running"
  | "audio-blocked"
  | "menu-open"
  | "paused"
  | "stopped"
  | "faulted"
  | "disposed";

export interface PlayerShellPresentationOptions {
  readonly state: PlayerShellState;
  readonly hasRetainedCart: boolean;
  readonly muted: boolean;
}

export interface PlayerShellPresentation {
  readonly audioBlocked: boolean;
  readonly busy: boolean;
  readonly cartSelectionDisabled: boolean;
  readonly fullscreenDisabled: boolean;
  readonly muteDisabled: boolean;
  readonly menuDisabled: boolean;
  readonly pauseDisabled: boolean;
  readonly playDisabled: boolean;
  readonly playLabel: "Play" | "Resume" | "Enable audio";
  readonly resetDisabled: boolean;
  readonly stopDisabled: boolean;
  readonly touchDisabled: boolean;
}

export interface LocalCartFileMetadata {
  readonly name: string;
  readonly size: number;
}

export type LocalCartSelectionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function isActivelyPlaying(state: PlayerShellState): boolean {
  return state === "running" || state === "audio-blocked";
}

export function derivePlayerShellPresentation(
  options: PlayerShellPresentationOptions,
): PlayerShellPresentation {
  const { state } = options;
  const active = isActivelyPlaying(state);
  const disposed = state === "disposed";
  const loading = state === "loading";
  const audioBlocked = state === "audio-blocked";
  return {
    audioBlocked,
    busy: loading,
    cartSelectionDisabled: loading || disposed,
    fullscreenDisabled: disposed,
    muteDisabled: disposed,
    menuDisabled: !active,
    pauseDisabled: !active && state !== "menu-open",
    playDisabled: !["ready", "paused", "audio-blocked"].includes(state),
    playLabel: audioBlocked ? "Enable audio" : state === "paused" ? "Resume" : "Play",
    resetDisabled: !options.hasRetainedCart || loading || disposed,
    stopDisabled: !["ready", "running", "audio-blocked", "menu-open", "paused", "faulted"].includes(
      state,
    ),
    touchDisabled: !active,
  };
}

export function validateLocalCartSelection(
  files: readonly LocalCartFileMetadata[],
): LocalCartSelectionResult {
  if (files.length !== 1) {
    return { ok: false, message: "Choose or drop exactly one cartridge." };
  }
  const file = files[0]!;
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith(".p8") && !lowerName.endsWith(".p8.png")) {
    return { ok: false, message: "Cartridges must use a .p8 or .p8.png filename." };
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return { ok: false, message: "The selected cartridge is empty or unreadable." };
  }
  if (file.size > MAX_LOCAL_CART_BYTES) {
    return {
      ok: false,
      message: `The selected cartridge exceeds ${MAX_LOCAL_CART_BYTES} bytes.`,
    };
  }
  return { ok: true };
}

export function computeIntegerScale(
  availableWidthCssPixels: number,
  availableHeightCssPixels: number,
  maximumScale = MAX_INTEGER_SCALE,
): number {
  if (
    !Number.isFinite(availableWidthCssPixels) || availableWidthCssPixels <= 0 ||
    !Number.isFinite(availableHeightCssPixels) || availableHeightCssPixels <= 0 ||
    !Number.isSafeInteger(maximumScale) || maximumScale < 1
  ) {
    throw new RangeError("integer scale inputs must be positive and finite");
  }
  return Math.max(
    1,
    Math.min(
      maximumScale,
      Math.floor(
        Math.min(availableWidthCssPixels, availableHeightCssPixels) / PICO_PLAYFIELD_SIZE,
      ),
    ),
  );
}
