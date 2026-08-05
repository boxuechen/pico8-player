import type {
  Phase0EHostToRuntime,
  Phase0ERuntimeToHost,
} from "./worker-protocol.js";
import type {
  PlayerHostToRuntime,
  PlayerRuntimeToHost,
} from "./player-protocol.js";
import {
  AUDIO_PROTOCOL_VERSION,
  PICO_CANONICAL_SAMPLE_RATE,
  type AudioDeviceStatsMessage,
  type AudioPortAttachmentEnvelope,
  type AudioTransportMessage,
  type AudioWorkletControlMessage,
} from "./audio-protocol.js";

function isEnvelope(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    Number.isSafeInteger(candidate.requestId) &&
    Number(candidate.requestId) >= 0 &&
    Number.isSafeInteger(candidate.sessionGeneration) &&
    Number(candidate.sessionGeneration) >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUint(value: unknown): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= 0xffff_ffff
  );
}

function isPositiveUint(value: unknown): boolean {
  return isUint(value) && Number(value) > 0;
}

function isPlayerEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.v === 1 &&
    isUint(value.requestId) &&
    isPositiveUint(value.workerGeneration) &&
    isUint(value.sessionGeneration)
  );
}

function isPlayerError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const codes = new Set([
    "E_VM_SYNTAX",
    "E_VM_RUNTIME",
    "E_VM_INSTRUCTION_BUDGET",
    "E_VM_OOM",
    "E_VM_WATCHDOG",
    "E_CART_PARSE",
    "E_TIME_DISCONTINUITY",
    "E_FEATURE_UNSUPPORTED",
    "E_HOST_REQUEST",
    "E_HOST_API",
    "E_INVALID_STATE",
    "E_INVARIANT",
  ]);
  const phases = new Set([
    "none", "compile", "boot", "init", "update", "update60", "draw",
    "custom-loop", "host-call",
  ]);
  const detailsValid = value.details === undefined || (
    isRecord(value.details) &&
    Object.values(value.details).every((detail) =>
      typeof detail === "string" || typeof detail === "boolean" ||
      (typeof detail === "number" && Number.isFinite(detail))
    )
  );
  return (
    typeof value.code === "string" &&
    codes.has(value.code) &&
    typeof value.message === "string" &&
    typeof value.phase === "string" && phases.has(value.phase) &&
    typeof value.recoverable === "boolean" &&
    (value.line === undefined || Number.isSafeInteger(value.line)) &&
    (value.trace === undefined || typeof value.trace === "string") &&
    detailsValid
  );
}

export function isPlayerHostToRuntime(value: unknown): value is PlayerHostToRuntime {
  if (!isPlayerEnvelope(value)) return false;
  if (value.type === "input") {
    return (
      value.requestId === 0 &&
      isPositiveUint(value.sessionGeneration) &&
      isUint(value.sequence) &&
      isRecord(value.input) &&
      isUint(value.input.buttons) &&
      Number(value.input.buttons) <= 0x3f
    );
  }
  if (!isPositiveUint(value.requestId)) return false;
  if (value.type === "loadCart") {
    return (
      isPositiveUint(value.sessionGeneration) &&
      value.cartBytes instanceof ArrayBuffer &&
      (value.instructionBudget === undefined ||
        (isPositiveUint(value.instructionBudget)))
    );
  }
  if (value.type === "vsync") {
    return (
      isPositiveUint(value.sessionGeneration) &&
      isUint(value.sequence) &&
      typeof value.timestampMs === "number" &&
      Number.isFinite(value.timestampMs) &&
      value.timestampMs >= 0
    );
  }
  if (
    value.type === "start" || value.type === "pause" || value.type === "resume" ||
    value.type === "reset" || value.type === "stop"
  ) {
    return isPositiveUint(value.sessionGeneration);
  }
  return value.type === "dispose";
}

export function isPlayerRuntimeToHost(value: unknown): value is PlayerRuntimeToHost {
  if (!isPlayerEnvelope(value)) return false;
  if (!isPositiveUint(value.requestId)) return false;
  if (value.type === "state") {
    if (value.state === "disposed") {
      return value.mode === "none" && value.targetFps === 0;
    }
    return ["ready", "running", "paused", "stopped"].includes(
      String(value.state),
    ) &&
      (value.mode === "callback" || value.mode === "custom") &&
      (value.targetFps === 30 || value.targetFps === 60);
  }
  if (value.type === "frame") {
    return (
      isUint(value.frameId) &&
      isDecimalUint(value.completedSlices) &&
      Number.isInteger(value.timeRawBeforeStep) &&
      Number(value.timeRawBeforeStep) >= -0x8000_0000 &&
      Number(value.timeRawBeforeStep) <= 0x7fff_ffff &&
      (value.targetFps === 30 || value.targetFps === 60) &&
      value.packedScreen instanceof ArrayBuffer &&
      value.packedScreen.byteLength === 0x2000 &&
      value.displayPalette instanceof ArrayBuffer &&
      value.displayPalette.byteLength === 16
    );
  }
  if (value.type === "heartbeat") {
    return (
      isUint(value.vsyncSequence) && isUint(value.tickCount) &&
      Number(value.tickCount) <= 5 && isUint(value.droppedTicks)
    );
  }
  if (value.type === "diagnostic" || value.type === "fault") {
    return isPlayerError(value.error);
  }
  return false;
}

function isDecimalUint(value: unknown): boolean {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function isAudioEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.v === AUDIO_PROTOCOL_VERSION &&
    isUint(value.sessionGeneration)
  );
}

export function isAudioPortAttachmentEnvelope(
  value: unknown,
): value is AudioPortAttachmentEnvelope {
  return isAudioEnvelope(value) && value.type === "attachAudioPort";
}

export function isAudioTransportMessage(value: unknown): value is AudioTransportMessage {
  if (!isAudioEnvelope(value)) return false;
  if (value.type === "audioReset") {
    return isUint(value.nextSequence) && isDecimalUint(value.firstSample);
  }
  if (value.type !== "audioChunk") return false;
  return (
    isUint(value.sequence) &&
    isDecimalUint(value.firstSample) &&
    value.sampleRate === PICO_CANONICAL_SAMPLE_RATE &&
    isUint(value.frameCount) &&
    Number(value.frameCount) > 0 &&
    Number(value.frameCount) <= 0x10000 &&
    value.pcm16le instanceof ArrayBuffer &&
    value.pcm16le.byteLength === Number(value.frameCount) * 2
  );
}

export function isAudioDeviceStatsMessage(
  value: unknown,
): value is AudioDeviceStatsMessage {
  if (!isAudioEnvelope(value) || value.type !== "audioStats") return false;
  const uintFields = [
    "queuedSourceFrames",
    "queueHighWaterFrames",
    "configuredLowWaterFrames",
    "configuredHighWaterFrames",
    "startupUnderruns",
    "steadyUnderruns",
    "overruns",
    "droppedSourceFrames",
    "discontinuities",
    "staleChunks",
    "receivedChunks",
    "renderedDeviceFrames",
  ];
  return (
    typeof value.deviceSampleRate === "number" &&
    Number.isFinite(value.deviceSampleRate) &&
    value.deviceSampleRate > 0 &&
    uintFields.every((field) => isUint(value[field])) &&
    typeof value.playing === "boolean"
  );
}

export function isAudioWorkletControlMessage(
  value: unknown,
): value is AudioWorkletControlMessage {
  return (
    isRecord(value) &&
    value.v === AUDIO_PROTOCOL_VERSION &&
    (value.type === "requestAudioStats" || value.type === "disposeAudio")
  );
}

export function isPhase0EHostToRuntime(value: unknown): value is Phase0EHostToRuntime {
  if (!isEnvelope(value)) return false;
  if (value.type === "dispose") return true;
  if (value.type === "loadCart") {
    return (
      value.p8PngBytes instanceof ArrayBuffer &&
      (value.instructionBudget === undefined ||
        (isUint(value.instructionBudget) && Number(value.instructionBudget) > 0))
    );
  }
  if (value.type === "step") {
    return (
      isRecord(value.input) &&
      isUint(value.input.buttons) &&
      Number(value.input.buttons) <= 0x3f
    );
  }
  if (value.type === "hostResponse") {
    return (
      isUint(value.hostRequestId) &&
      value.bytes instanceof ArrayBuffer &&
      typeof value.isError === "boolean"
    );
  }
  return false;
}

export function isPhase0ERuntimeToHost(value: unknown): value is Phase0ERuntimeToHost {
  if (!isEnvelope(value)) return false;
  if (value.type === "stopped" || value.type === "disposed") return true;
  if (value.type === "ready") {
    return (
      (value.mode === "callback" || value.mode === "custom") &&
      (value.targetFps === 30 || value.targetFps === 60)
    );
  }
  if (value.type === "frame") {
    return (
      isUint(value.frameId) &&
      typeof value.completedSlices === "string" &&
      /^(?:0|[1-9][0-9]*)$/u.test(value.completedSlices) &&
      Number.isInteger(value.timeRawBeforeStep) &&
      Number(value.timeRawBeforeStep) >= -0x8000_0000 &&
      Number(value.timeRawBeforeStep) <= 0x7fff_ffff &&
      (value.targetFps === 30 || value.targetFps === 60) &&
      value.packedScreen instanceof ArrayBuffer &&
      value.packedScreen.byteLength === 0x2000
    );
  }
  if (value.type === "hostRequest") {
    return (
      isUint(value.hostRequestId) &&
      (value.operation === "boot" || value.operation === "step") &&
      value.bytes instanceof ArrayBuffer
    );
  }
  if (value.type === "fault") {
    return (
      isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string" &&
      typeof value.error.phase === "string" &&
      typeof value.error.recoverable === "boolean"
    );
  }
  return false;
}
