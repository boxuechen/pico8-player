import {
  AUDIO_PROTOCOL_VERSION,
  isAudioDeviceStatsMessage,
  type AudioDeviceStatsMessage,
  type AudioPortAttachmentEnvelope,
} from "../transport/public.js";

export interface RuntimeAudioPortTarget {
  readonly sessionGeneration: number;
  attachAudioPort(port: MessagePort): void;
}

export interface AudioFrontendOptions {
  readonly requestedSampleRate?: 44_100 | 48_000;
  readonly outputGain?: number;
  readonly startSuspended?: boolean;
  readonly contextFactory?: (options: AudioContextOptions) => AudioContext;
  readonly nodeFactory?: (
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
  readonly channelFactory?: () => MessageChannel;
}

type StatsPredicate = (stats: AudioDeviceStatsMessage) => boolean;

interface StatsWaiter {
  readonly predicate: StatsPredicate;
  readonly resolve: (stats: AudioDeviceStatsMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: number;
}

export class DedicatedAudioFrontend {
  readonly #context: AudioContext;
  readonly #node: AudioWorkletNode;
  readonly #gain: GainNode;
  readonly #channelFactory: () => MessageChannel;
  readonly #waiters = new Set<StatsWaiter>();
  #lastStats: AudioDeviceStatsMessage | undefined;
  #disposed = false;

  private constructor(
    context: AudioContext,
    node: AudioWorkletNode,
    gain: GainNode,
    channelFactory: () => MessageChannel,
  ) {
    this.#context = context;
    this.#node = node;
    this.#gain = gain;
    this.#channelFactory = channelFactory;
    node.port.onmessage = (event) => this.#receive(event.data);
  }

  static async create(
    target: RuntimeAudioPortTarget,
    workletModuleUrl: string | URL,
    options: AudioFrontendOptions = {},
  ): Promise<DedicatedAudioFrontend> {
    const contextFactory =
      options.contextFactory ?? ((contextOptions) => new AudioContext(contextOptions));
    const nodeFactory =
      options.nodeFactory ??
      ((context, name, nodeOptions) =>
        new AudioWorkletNode(context, name, nodeOptions));
    const channelFactory = options.channelFactory ?? (() => new MessageChannel());
    const context = contextFactory({
      latencyHint: "interactive",
      ...(options.requestedSampleRate === undefined
        ? {}
        : { sampleRate: options.requestedSampleRate }),
    });
    try {
      if (options.startSuspended !== false && context.state === "running") {
        await context.suspend();
      }
      await context.audioWorklet.addModule(workletModuleUrl.toString());
      const node = nodeFactory(context, "pico8-audio-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const gain = context.createGain();
      gain.gain.value = options.outputGain ?? 1;
      node.connect(gain).connect(context.destination);
      const frontend = new DedicatedAudioFrontend(
        context,
        node,
        gain,
        channelFactory,
      );
      frontend.attach(target);
      return frontend;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  get contextState(): AudioContextState {
    return this.#context.state;
  }

  get deviceSampleRate(): number {
    return this.#context.sampleRate;
  }

  get lastStats(): AudioDeviceStatsMessage | undefined {
    return this.#lastStats;
  }

  attach(target: RuntimeAudioPortTarget): void {
    this.#assertActive();
    const channel = this.#channelFactory();
    target.attachAudioPort(channel.port1);
    const envelope: AudioPortAttachmentEnvelope & { readonly port: MessagePort } = {
      v: AUDIO_PROTOCOL_VERSION,
      type: "attachAudioPort",
      sessionGeneration: target.sessionGeneration,
      port: channel.port2,
    };
    this.#node.port.postMessage(envelope, [channel.port2]);
  }

  resume(): Promise<void> {
    this.#assertActive();
    return this.#context.resume();
  }

  suspend(): Promise<void> {
    this.#assertActive();
    return this.#context.suspend();
  }

  requestStats(timeoutMs = 1000): Promise<AudioDeviceStatsMessage> {
    this.#assertActive();
    const previous = this.#lastStats;
    const wait = this.waitForStats((stats) => stats !== previous, timeoutMs);
    this.#node.port.postMessage({ v: AUDIO_PROTOCOL_VERSION, type: "requestAudioStats" });
    return wait;
  }

  waitForStats(
    predicate: StatsPredicate,
    timeoutMs = 5000,
  ): Promise<AudioDeviceStatsMessage> {
    this.#assertActive();
    if (this.#lastStats !== undefined && predicate(this.#lastStats)) {
      return Promise.resolve(this.#lastStats);
    }
    return new Promise((resolve, reject) => {
      const waiter: StatsWaiter = {
        predicate,
        resolve,
        reject,
        timer: globalThis.setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("timed out waiting for AudioWorklet stats"));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#node.port.postMessage({ v: AUDIO_PROTOCOL_VERSION, type: "disposeAudio" });
    this.#node.port.onmessage = null;
    this.#node.disconnect();
    this.#gain.disconnect();
    for (const waiter of this.#waiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.reject(new Error("audio frontend disposed"));
    }
    this.#waiters.clear();
    await this.#context.close();
  }

  #receive(value: unknown): void {
    if (!isAudioDeviceStatsMessage(value)) return;
    this.#lastStats = value;
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(value)) continue;
      globalThis.clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(value);
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("DedicatedAudioFrontend is disposed");
  }
}
