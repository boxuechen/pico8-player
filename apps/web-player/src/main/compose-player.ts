import { createPlayerSession } from "../runtime/create-session.js";
import type { PlayerRuntimePort, PlayerLocalCartSource, PlayerHostCartDataSeed } from "../transport/runtime-port.js";
import type {
  PicoInputSnapshot,
} from "@pico8-web/contracts";
import {
  DedicatedAudioFrontend,
  type AudioFrontendOptions,
  type RuntimeAudioPortTarget,
} from "./audio-frontend.js";
import {
  Canvas2DFramePresenter,
} from "./render/canvas2d-frame-presenter.js";
import {
  PlayerRuntimeClient,
  type PlayerRuntimeClientOptions,
  type PlayerRuntimeWorkerFactory,
} from "./player-runtime-client.js";

export interface PlayerCompositionOptions {
  readonly execution?: "main" | "worker";
  readonly canvas: HTMLCanvasElement;
  readonly runtimeWorkerFactory?: PlayerRuntimeWorkerFactory;
  /** Use package-owned, relative Worker and AudioWorklet assets. */
  readonly useDefaultAssets?: boolean;
  readonly commandTimeoutMs?: PlayerRuntimeClientOptions["commandTimeoutMs"];
  readonly workletModuleUrl?: string | URL;
  readonly audio?: AudioFrontendOptions;
}

const AUDIO_RESUME_PROBE_TIMEOUT_MS = 250;

/** Stable player composition; DOM policy remains in PlayerController. */
export class PlayerComposition {
  readonly runtime: PlayerRuntimePort & RuntimeAudioPortTarget;
  readonly presenter: Canvas2DFramePresenter;
  readonly audio: DedicatedAudioFrontend | undefined;
  readonly #removeRuntimeListener: () => void;
  readonly #removeGenerationListener: () => void;
  #disposed = false;

  private constructor(
    runtime: PlayerRuntimePort & RuntimeAudioPortTarget,
    presenter: Canvas2DFramePresenter,
    audio: DedicatedAudioFrontend | undefined,
  ) {
    this.runtime = runtime;
    this.presenter = presenter;
    this.audio = audio;
    this.#removeRuntimeListener = runtime.onEvent((event) => {
      if (event.type !== "frame") return;
      presenter.present({
        sessionGeneration: event.sessionGeneration,
        frameId: event.frameId,
        packedScreen: new Uint8Array(event.packedScreen),
        displayPalette: new Uint8Array(event.displayPalette),
      });
    });
    this.#removeGenerationListener = runtime.onSessionGenerationChange(
      (sessionGeneration) => {
        presenter.reset(sessionGeneration);
        audio?.attach(runtime);
      },
    );
  }

  static async create(options: PlayerCompositionOptions): Promise<PlayerComposition> {
    if (options.commandTimeoutMs !== undefined &&
      (!Number.isFinite(options.commandTimeoutMs) || options.commandTimeoutMs <= 0)) {
      throw new RangeError("commandTimeoutMs must be positive");
    }
    if (options.useDefaultAssets === true && options.runtimeWorkerFactory !== undefined) {
      throw new TypeError("default assets and a custom Worker factory are mutually exclusive");
    }
    const runtimeWorkerFactory = options.useDefaultAssets === true
      ? () => new Worker(
        new URL("../browser/player-worker.mjs", import.meta.url),
        { type: "module" },
      )
      : options.runtimeWorkerFactory;
    const workletModuleUrl = options.useDefaultAssets === true
      ? new URL("../worklet/pico8-audio-processor.js", import.meta.url)
      : options.workletModuleUrl;
    const useWorker = options.execution === "worker" || options.runtimeWorkerFactory !== undefined;
    if (useWorker && runtimeWorkerFactory === undefined) throw new TypeError("a runtime Worker factory is required");
    const runtime: PlayerRuntimePort & RuntimeAudioPortTarget = useWorker
      ? new PlayerRuntimeClient(runtimeWorkerFactory!, {
        ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
      })
      : await createPlayerSession();
    const presenter = new Canvas2DFramePresenter(options.canvas);
    presenter.reset(runtime.sessionGeneration);
    let audio: DedicatedAudioFrontend | undefined;
    try {
      if (workletModuleUrl !== undefined) {
        audio = await DedicatedAudioFrontend.create(
          runtime,
          workletModuleUrl,
          options.audio,
        );
      }
      return new PlayerComposition(runtime, presenter, audio);
    } catch (error) {
      await audio?.dispose().catch(() => undefined);
      presenter.dispose();
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  resize(widthCssPixels: number, heightCssPixels: number): void {
    this.#assertActive();
    this.presenter.resize(widthCssPixels, heightCssPixels);
  }

  loadCart(
    source: Uint8Array,
    instructionBudget?: number,
    localCartBundle: readonly PlayerLocalCartSource[] = [],
    hostCartData?: readonly PlayerHostCartDataSeed[],
  ) {
    this.#assertActive();
    return this.runtime.loadCart(source, instructionBudget, localCartBundle, hostCartData);
  }

  start() {
    this.#assertActive();
    return this.runtime.start();
  }

  pulse(timestampMs: number, input: PicoInputSnapshot) {
    this.#assertActive();
    return this.runtime.pulse(timestampMs, input);
  }

  pause() {
    this.#assertActive();
    return this.runtime.pause();
  }

  openPauseMenu() {
    this.#assertActive();
    return this.runtime.openPauseMenu();
  }

  closePauseMenu() {
    this.#assertActive();
    return this.runtime.closePauseMenu();
  }

  invokeMenuItem(
    slot: 1 | 2 | 3 | 4 | 5,
    button: 1 | 2 | 4,
  ) {
    this.#assertActive();
    return this.runtime.invokeMenuItem(slot, button);
  }

  resume() {
    this.#assertActive();
    return this.runtime.resume();
  }

  reset() {
    this.#assertActive();
    return this.runtime.reset();
  }

  stop() {
    this.#assertActive();
    return this.runtime.stop();
  }

  flushPersistence() {
    this.#assertActive();
    return this.runtime.flushPersistence();
  }

  async resumeAudio(): Promise<boolean> {
    this.#assertActive();
    if (this.audio === undefined) return true;
    let timeout: number | undefined;
    try {
      await Promise.race([
        this.audio.resume(),
        new Promise<void>((resolve) => {
          timeout = globalThis.setTimeout(resolve, AUDIO_RESUME_PROBE_TIMEOUT_MS);
        }),
      ]);
      return this.audio.contextState === "running";
    } catch {
      return false;
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
  }

  suspendAudio(): Promise<void> {
    this.#assertActive();
    return this.audio?.suspend() ?? Promise.resolve();
  }

  setMuted(muted: boolean): void {
    this.#assertActive();
    this.audio?.setMuted(muted);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeRuntimeListener();
    this.#removeGenerationListener();
    this.presenter.dispose();
    await this.audio?.dispose();
    await this.runtime.dispose();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("PlayerComposition is disposed");
  }
}
