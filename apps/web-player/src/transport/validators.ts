import type {
  Phase0EHostToRuntime,
  Phase0ERuntimeToHost,
} from "./worker-protocol.js";

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
