export const AUDIO_PROTOCOL_VERSION = 1 as const;
export const PICO_CANONICAL_SAMPLE_RATE = 22_050 as const;

interface AudioEnvelope {
  readonly v: typeof AUDIO_PROTOCOL_VERSION;
  readonly sessionGeneration: number;
}

export interface AudioPortAttachmentEnvelope extends AudioEnvelope {
  readonly type: "attachAudioPort";
}

export interface AudioResetMessage extends AudioEnvelope {
  readonly type: "audioReset";
  readonly nextSequence: number;
  readonly firstSample: string;
}

export interface AudioChunkMessage extends AudioEnvelope {
  readonly type: "audioChunk";
  readonly sequence: number;
  readonly firstSample: string;
  readonly sampleRate: typeof PICO_CANONICAL_SAMPLE_RATE;
  readonly frameCount: number;
  readonly pcm16le: ArrayBuffer;
}

export type AudioTransportMessage = AudioResetMessage | AudioChunkMessage;

export interface AudioDeviceStatsMessage extends AudioEnvelope {
  readonly type: "audioStats";
  readonly deviceSampleRate: number;
  readonly queuedSourceFrames: number;
  readonly queueHighWaterFrames: number;
  readonly configuredLowWaterFrames: number;
  readonly configuredHighWaterFrames: number;
  readonly startupUnderruns: number;
  readonly steadyUnderruns: number;
  readonly overruns: number;
  readonly droppedSourceFrames: number;
  readonly discontinuities: number;
  readonly staleChunks: number;
  readonly receivedChunks: number;
  readonly renderedDeviceFrames: number;
  readonly playing: boolean;
}

export type AudioWorkletControlMessage =
  | { readonly v: 1; readonly type: "requestAudioStats" }
  | { readonly v: 1; readonly type: "disposeAudio" };
