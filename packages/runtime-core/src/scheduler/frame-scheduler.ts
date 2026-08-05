export interface FrameSchedulerOptions {
  readonly maximumCatchUpTicks?: number;
}

export interface FrameScheduleDecision {
  readonly tickCount: number;
  readonly discontinuity: boolean;
  readonly droppedTicks: number;
}

const EMPTY_DECISION: FrameScheduleDecision = Object.freeze({
  tickCount: 0,
  discontinuity: false,
  droppedTicks: 0,
});

function assertTimestamp(timestampMs: number): void {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new RangeError("scheduler timestamp must be a non-negative finite number");
  }
}

/**
 * Browser-neutral wall-clock accumulator. It owns pacing policy, but neither a
 * clock source nor simulation state. The caller executes the returned ticks.
 */
export class FrameScheduler {
  readonly #maximumCatchUpTicks: number;
  #targetFps: 30 | 60 = 30;
  #running = false;
  #anchorMs: number | undefined;
  #accumulatorMs = 0;

  constructor(options: FrameSchedulerOptions = {}) {
    const maximumCatchUpTicks = options.maximumCatchUpTicks ?? 5;
    if (!Number.isSafeInteger(maximumCatchUpTicks) || maximumCatchUpTicks <= 0) {
      throw new RangeError("maximumCatchUpTicks must be a positive safe integer");
    }
    this.#maximumCatchUpTicks = maximumCatchUpTicks;
  }

  get targetFps(): 30 | 60 {
    return this.#targetFps;
  }

  get running(): boolean {
    return this.#running;
  }

  configure(targetFps: 30 | 60): void {
    if (targetFps !== 30 && targetFps !== 60) {
      throw new RangeError("targetFps must be 30 or 60");
    }
    this.#targetFps = targetFps;
    this.reset();
  }

  start(): void {
    this.#running = true;
    this.#anchorMs = undefined;
    this.#accumulatorMs = 0;
  }

  pause(): void {
    this.#running = false;
    this.#anchorMs = undefined;
    this.#accumulatorMs = 0;
  }

  resume(): void {
    this.start();
  }

  reset(): void {
    this.pause();
  }

  pulse(timestampMs: number): FrameScheduleDecision {
    assertTimestamp(timestampMs);
    if (!this.#running) return EMPTY_DECISION;

    const previous = this.#anchorMs;
    this.#anchorMs = timestampMs;
    if (previous === undefined) return EMPTY_DECISION;
    if (timestampMs < previous) {
      this.#accumulatorMs = 0;
      return Object.freeze({ tickCount: 0, discontinuity: true, droppedTicks: 0 });
    }

    this.#accumulatorMs += timestampMs - previous;
    const tickDurationMs = 1000 / this.#targetFps;
    const availableTicks = Math.floor(
      (this.#accumulatorMs + Number.EPSILON * timestampMs) / tickDurationMs,
    );
    if (availableTicks <= 0) return EMPTY_DECISION;

    const tickCount = Math.min(availableTicks, this.#maximumCatchUpTicks);
    const droppedTicks = Math.min(
      Math.max(0, availableTicks - tickCount),
      0xffff_ffff,
    );
    if (droppedTicks > 0) {
      this.#accumulatorMs = 0;
    } else {
      this.#accumulatorMs -= tickCount * tickDurationMs;
      if (Math.abs(this.#accumulatorMs) < 1e-9) this.#accumulatorMs = 0;
    }
    return Object.freeze({
      tickCount,
      discontinuity: droppedTicks > 0,
      droppedTicks,
    });
  }
}
