import {
  decodePackedPicoFrame,
  PICO_FRAME_HEIGHT,
  PICO_FRAME_WIDTH,
  type PackedPicoFrame,
} from "./pico-frame.js";

export interface PresenterSize {
  readonly widthCssPixels: number;
  readonly heightCssPixels: number;
}

function isGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

export class Canvas2DFramePresenter {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #imageData: ImageData;
  #generation = -1;
  #lastFrameId = -1;
  #disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = PICO_FRAME_WIDTH;
    canvas.height = PICO_FRAME_HEIGHT;
    const classList = (canvas as HTMLCanvasElement & { readonly classList?: DOMTokenList })
      .classList;
    if (classList?.contains("pico8-player__canvas") !== true) {
      // Standalone presenter consumers do not load the production shell stylesheet.
      canvas.style.display = "block";
      canvas.style.imageRendering = "pixelated";
    }
    const context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    if (context === null) throw new Error("Canvas2D is unavailable");
    context.imageSmoothingEnabled = false;
    this.#canvas = canvas;
    this.#context = context;
    this.#imageData = context.createImageData(PICO_FRAME_WIDTH, PICO_FRAME_HEIGHT);
  }

  get sessionGeneration(): number {
    return this.#generation;
  }

  get lastFrameId(): number {
    return this.#lastFrameId;
  }

  reset(sessionGeneration: number): void {
    this.#assertActive();
    if (!isGeneration(sessionGeneration)) {
      throw new RangeError("sessionGeneration must be a uint32");
    }
    this.#generation = sessionGeneration;
    this.#lastFrameId = -1;
    this.#context.imageSmoothingEnabled = false;
    this.#context.clearRect(0, 0, PICO_FRAME_WIDTH, PICO_FRAME_HEIGHT);
  }

  resize(availableWidthCssPixels: number, availableHeightCssPixels: number): PresenterSize {
    this.#assertActive();
    if (
      !Number.isFinite(availableWidthCssPixels) ||
      availableWidthCssPixels <= 0 ||
      !Number.isFinite(availableHeightCssPixels) ||
      availableHeightCssPixels <= 0
    ) {
      throw new RangeError("presenter dimensions must be positive finite numbers");
    }
    const side = Math.min(availableWidthCssPixels, availableHeightCssPixels);
    this.#canvas.style.width = `${side}px`;
    this.#canvas.style.height = `${side}px`;
    return { widthCssPixels: side, heightCssPixels: side };
  }

  present(frame: PackedPicoFrame): boolean {
    this.#assertActive();
    if (frame.sessionGeneration !== this.#generation) return false;
    if (!Number.isSafeInteger(frame.frameId) || frame.frameId < 0) {
      throw new RangeError("frameId must be a non-negative safe integer");
    }
    if (frame.frameId <= this.#lastFrameId) return false;
    decodePackedPicoFrame(
      frame.packedScreen,
      this.#imageData.data,
      undefined,
      frame.displayPalette,
    );
    this.#context.imageSmoothingEnabled = false;
    this.#context.putImageData(this.#imageData, 0, 0);
    this.#lastFrameId = frame.frameId;
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#context.clearRect(0, 0, PICO_FRAME_WIDTH, PICO_FRAME_HEIGHT);
    this.#generation = -1;
    this.#lastFrameId = -1;
    this.#disposed = true;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Canvas2DFramePresenter is disposed");
  }
}
