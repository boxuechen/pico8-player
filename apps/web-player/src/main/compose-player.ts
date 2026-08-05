import type {
  PicoInputSnapshot,
} from "@pico8-web/contracts";
import type {
  Phase0ERuntimeToHost,
} from "../transport/public.js";
import {
  DedicatedAudioFrontend,
  type AudioFrontendOptions,
} from "./audio-frontend.js";
import {
  Canvas2DFramePresenter,
} from "./render/canvas2d-frame-presenter.js";
import {
  Phase0ERuntimeClient,
  type RuntimeWorkerFactory,
} from "./runtime-client.js";
import {
  PlayerRuntimeClient,
  type PlayerRuntimeClientOptions,
  type PlayerRuntimeWorkerFactory,
} from "./player-runtime-client.js";

export interface Phase0FPlayerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly runtimeWorkerFactory: RuntimeWorkerFactory;
  readonly workletModuleUrl: string | URL;
  readonly commandTimeoutMs?: number;
  readonly audio?: AudioFrontendOptions;
}

export class Phase0FPlayerComposition {
  readonly runtime: Phase0ERuntimeClient;
  readonly presenter: Canvas2DFramePresenter;
  readonly audio: DedicatedAudioFrontend;
  readonly #removeGenerationListener: () => void;
  #disposed = false;

  private constructor(
    runtime: Phase0ERuntimeClient,
    presenter: Canvas2DFramePresenter,
    audio: DedicatedAudioFrontend,
  ) {
    this.runtime = runtime;
    this.presenter = presenter;
    this.audio = audio;
    this.#removeGenerationListener = runtime.onSessionGenerationChange(
      (sessionGeneration) => {
        presenter.reset(sessionGeneration);
        audio.attach(runtime);
      },
    );
  }

  static async create(options: Phase0FPlayerOptions): Promise<Phase0FPlayerComposition> {
    const runtime = new Phase0ERuntimeClient(options.runtimeWorkerFactory, {
      ...(options.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: options.commandTimeoutMs }),
    });
    const presenter = new Canvas2DFramePresenter(options.canvas);
    presenter.reset(runtime.sessionGeneration);
    try {
      const audio = await DedicatedAudioFrontend.create(
        runtime,
        options.workletModuleUrl,
        options.audio,
      );
      return new Phase0FPlayerComposition(runtime, presenter, audio);
    } catch (error) {
      presenter.dispose();
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  resize(widthCssPixels: number, heightCssPixels: number): void {
    this.#assertActive();
    this.presenter.resize(widthCssPixels, heightCssPixels);
  }

  async loadCart(
    p8PngBytes: Uint8Array,
    instructionBudget?: number,
  ): Promise<Phase0ERuntimeToHost> {
    this.#assertActive();
    return this.runtime.loadCart(p8PngBytes, instructionBudget);
  }

  async step(input: PicoInputSnapshot): Promise<Phase0ERuntimeToHost> {
    this.#assertActive();
    const event = await this.runtime.step(input);
    this.#present(event);
    return event;
  }

  async hostResponse(
    hostRequestId: number,
    response: Uint8Array,
    isError = false,
  ): Promise<Phase0ERuntimeToHost> {
    this.#assertActive();
    const event = await this.runtime.hostResponse(
      hostRequestId,
      response,
      isError,
    );
    this.#present(event);
    return event;
  }

  resumeAudio(): Promise<void> {
    this.#assertActive();
    return this.audio.resume();
  }

  suspendAudio(): Promise<void> {
    this.#assertActive();
    return this.audio.suspend();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeGenerationListener();
    await this.audio.dispose();
    this.presenter.dispose();
    await this.runtime.dispose();
  }

  #present(event: Phase0ERuntimeToHost): void {
    if (event.type !== "frame") return;
    this.presenter.present({
      sessionGeneration: event.sessionGeneration,
      frameId: event.frameId,
      packedScreen: new Uint8Array(event.packedScreen),
    });
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Phase0FPlayerComposition is disposed");
  }
}

export interface PlayerCompositionOptions {
  readonly canvas: HTMLCanvasElement;
  readonly runtimeWorkerFactory: PlayerRuntimeWorkerFactory;
  readonly commandTimeoutMs?: PlayerRuntimeClientOptions["commandTimeoutMs"];
  readonly workletModuleUrl?: string | URL;
  readonly audio?: AudioFrontendOptions;
}

/** Stable player composition; DOM policy remains in PlayerController. */
export class PlayerComposition {
  readonly runtime: PlayerRuntimeClient;
  readonly presenter: Canvas2DFramePresenter;
  readonly audio: DedicatedAudioFrontend | undefined;
  readonly #removeRuntimeListener: () => void;
  readonly #removeGenerationListener: () => void;
  #disposed = false;

  private constructor(
    runtime: PlayerRuntimeClient,
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
    const runtime = new PlayerRuntimeClient(options.runtimeWorkerFactory, {
      ...(options.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: options.commandTimeoutMs }),
    });
    const presenter = new Canvas2DFramePresenter(options.canvas);
    presenter.reset(runtime.sessionGeneration);
    let audio: DedicatedAudioFrontend | undefined;
    try {
      if (options.workletModuleUrl !== undefined) {
        audio = await DedicatedAudioFrontend.create(
          runtime,
          options.workletModuleUrl,
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

  loadCart(source: Uint8Array, instructionBudget?: number) {
    this.#assertActive();
    return this.runtime.loadCart(source, instructionBudget);
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

  resumeAudio(): Promise<void> {
    this.#assertActive();
    return this.audio?.resume() ?? Promise.resolve();
  }

  suspendAudio(): Promise<void> {
    this.#assertActive();
    return this.audio?.suspend() ?? Promise.resolve();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeRuntimeListener();
    this.#removeGenerationListener();
    await this.audio?.dispose();
    this.presenter.dispose();
    await this.runtime.dispose();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("PlayerComposition is disposed");
  }
}
