import type { PicoInputSnapshot } from "@pico8-player/contracts";
import {
  PICO_CART_INPUT_MAX_BYTES,
  PICO_CART_DATA_BYTES,
  PICO_CART_DATA_ID_MAX_BYTES,
  PICO_CART_DATA_MAX_RECORDS,
  PICO_CART_REF_MAX_BYTES,
  PICO_CONTROLLER_BUTTON_MASK,
  PICO_CONTROLLER_COUNT,
  PICO_DEVKIT_KEYPRESS_BATCH_LIMIT,
  PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES,
  type PlayerHostToRuntime,
  type PlayerRuntimeToHost,
} from "./player-protocol.js";
import {
  AUDIO_PROTOCOL_VERSION,
  PICO_CANONICAL_SAMPLE_RATE,
  type AudioDeviceStatsMessage,
  type AudioPortAttachmentEnvelope,
  type AudioTransportMessage,
  type AudioWorkletControlMessage,
} from "./audio-protocol.js";

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

function isInt32(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= -0x8000_0000 &&
    Number(value) <= 0x7fff_ffff;
}

export function isPicoInputSnapshot(value: unknown): value is PicoInputSnapshot {
  return isRecord(value) &&
    Array.isArray(value.controllers) &&
    value.controllers.length === PICO_CONTROLLER_COUNT &&
    value.controllers.every((buttons) =>
      isUint(buttons) && Number(buttons) <= PICO_CONTROLLER_BUTTON_MASK) &&
    isRecord(value.devkit) &&
    isInt32(value.devkit.mouseXRaw) && isInt32(value.devkit.mouseYRaw) &&
    isUint(value.devkit.mouseButtons) && Number(value.devkit.mouseButtons) <= 0x07 &&
    isInt32(value.devkit.wheelRaw) && isInt32(value.devkit.movementXRaw) &&
    isInt32(value.devkit.movementYRaw) && Array.isArray(value.devkit.keypresses) &&
    value.devkit.keypresses.length <= PICO_DEVKIT_KEYPRESS_BATCH_LIMIT &&
    value.devkit.keypresses.every((byte) => isUint(byte) && Number(byte) <= 0xff);
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
    "E_PERSISTENCE_READ",
    "E_PERSISTENCE_WRITE",
    "E_INVALID_STATE",
    "E_INVARIANT",
  ]);
  const phases = new Set([
    "none", "compile", "boot", "init", "update", "update60", "draw",
    "custom-loop", "host-call", "menuitem",
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

function isCartAccess(value: unknown): boolean {
  return isRecord(value) && typeof value.load === "boolean" &&
    typeof value.reloadData === "boolean" && typeof value.cstoreData === "boolean" &&
    typeof value.include === "boolean";
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) length += 1;
    else if (unit <= 0x7ff) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff &&
      index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}

function isLocalCartBundle(value: unknown, wire = false): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES) return false;
  const refs = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    const bytes = wire ? entry.cartBytes : entry.bytes;
    if (typeof entry.ref !== "string" || entry.ref.length === 0 ||
      utf8ByteLength(entry.ref) > PICO_CART_REF_MAX_BYTES ||
      !(wire ? bytes instanceof ArrayBuffer : bytes instanceof Uint8Array) ||
      (bytes as ArrayBuffer | Uint8Array).byteLength === 0 ||
      (bytes as ArrayBuffer | Uint8Array).byteLength > PICO_CART_INPUT_MAX_BYTES || !isCartAccess(entry.access) ||
      refs.has(entry.ref)) return false;
    refs.add(entry.ref);
  }
  return true;
}

function isHostCartData(value: unknown, wire = false): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > PICO_CART_DATA_MAX_RECORDS) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" ||
      entry.id.length < 1 || utf8ByteLength(entry.id) > PICO_CART_DATA_ID_MAX_BYTES ||
      !/^[a-z0-9_-]+$/u.test(entry.id) || ids.has(entry.id) ||
      !(wire ? entry.bytes instanceof ArrayBuffer : entry.bytes instanceof Uint8Array) ||
      (entry.bytes as ArrayBuffer | Uint8Array).byteLength !== PICO_CART_DATA_BYTES) {
      return false;
    }
    ids.add(entry.id);
    return true;
  });
}

/** Shared argument validation without constructing a protocol message. */
export function isCartLoad(source: unknown, budget: unknown, bundle: unknown, host: unknown): boolean {
  return source instanceof Uint8Array && source.byteLength > 0 &&
    source.byteLength <= PICO_CART_INPUT_MAX_BYTES &&
    (budget === undefined || isPositiveUint(budget)) &&
    isLocalCartBundle(bundle) && isHostCartData(host);
}

export function isPlayerHostToRuntime(value: unknown): value is PlayerHostToRuntime {
  return isPlayerEnvelope(value) && isPlayerCommand(value);
}

function isPlayerCommand(value: unknown): boolean {
  if (!isRecord(value) || !isUint(value.sessionGeneration)) return false;
  if (value.type === "input") {
    return (
      value.requestId === 0 &&
      isPositiveUint(value.sessionGeneration) &&
      isUint(value.sequence) &&
      isPicoInputSnapshot(value.input)
    );
  }
  if (!isPositiveUint(value.requestId)) return false;
  if (value.type === "loadCart") {
    return (
      isPositiveUint(value.sessionGeneration) &&
      value.cartBytes instanceof ArrayBuffer &&
      value.cartBytes.byteLength > 0 &&
      value.cartBytes.byteLength <= PICO_CART_INPUT_MAX_BYTES &&
      isLocalCartBundle(value.localCartBundle, true) &&
      isHostCartData(value.hostCartData, true) &&
      (value.instructionBudget === undefined ||
        (isPositiveUint(value.instructionBudget)))
    );
  }
  if (value.type === "step") return isPositiveUint(value.sessionGeneration) && isUint(value.sequence);
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
    value.type === "reset" || value.type === "stop" || value.type === "flushPersistence" ||
    value.type === "openPauseMenu" || value.type === "closePauseMenu"
  ) {
    return isPositiveUint(value.sessionGeneration);
  }
  if (value.type === "invokeMenuItem") {
    return isPositiveUint(value.sessionGeneration) &&
      isUint(value.slot) && Number(value.slot) >= 1 && Number(value.slot) <= 5 &&
      (value.button === 1 || value.button === 2 || value.button === 4);
  }
  return value.type === "dispose";
}

export function isPlayerRuntimeToHost(value: unknown): value is PlayerRuntimeToHost {
  if (!isPlayerEnvelope(value)) return false;
  if (!isPositiveUint(value.requestId) && !(
    value.requestId === 0 && value.type === "diagnostic"
  )) return false;
  if (value.type === "cartdata-commit") {
    return typeof value.id === "string" && value.id.length >= 1 &&
      utf8ByteLength(value.id) <= PICO_CART_DATA_ID_MAX_BYTES &&
      /^[a-z0-9_-]+$/u.test(value.id) && isPositiveUint(value.revision) &&
      value.bytes instanceof ArrayBuffer && value.bytes.byteLength === PICO_CART_DATA_BYTES;
  }
  if (value.type === "persistence-flushed") {
    return typeof value.durable === "boolean" &&
      (value.message === undefined || typeof value.message === "string");
  }
  if (value.type === "session-replaced") {
    return isPositiveUint(value.previousSessionGeneration) &&
      isPositiveUint(value.nextSessionGeneration) &&
      Number(value.nextSessionGeneration) === Number(value.previousSessionGeneration) + 1 &&
      value.sessionGeneration === value.nextSessionGeneration &&
      typeof value.cartRef === "string" && value.cartRef.length > 0 &&
      value.breadcrumb instanceof ArrayBuffer &&
      value.breadcrumb.byteLength <= 4096 && isUint(value.breadcrumbDepth);
  }
  if (value.type === "pause-menu") {
    return typeof value.open === "boolean" &&
      ["opened", "keep-open", "closed", "removed"].includes(String(value.outcome)) &&
      Array.isArray(value.items) && value.items.length <= 5 &&
      value.items.every((item) => isRecord(item) &&
        isUint(item.slot) && Number(item.slot) >= 1 && Number(item.slot) <= 5 &&
        item.label instanceof ArrayBuffer && item.label.byteLength <= 16 &&
        isUint(item.filter) && (Number(item.filter) & 0xffff_00ff) === 0);
  }
  if (value.type === "state") {
    if (!isUint(value.devkitFlags) || Number(value.devkitFlags) > 0x07) return false;
    if (value.state === "disposed") {
      return value.mode === "none" && value.targetFps === 0;
    }
    if (value.state === "stopped" && value.mode === "none") {
      return value.targetFps === 0;
    }
    if (value.state === "waiting-host" && value.mode === "none") {
      return value.targetFps === 0;
    }
    return ["ready", "running", "waiting-host", "paused", "stopped"].includes(
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
      isUint(value.cpuInstructions) &&
      isUint(value.cpuFractionRaw) && Number(value.cpuFractionRaw) <= 0x7fff_ffff &&
      typeof value.slowFrame === "boolean" &&
      isUint(value.devkitFlags) && Number(value.devkitFlags) <= 0x07 &&
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
  if (value.type === "runtime-control") {
    return (value.control === "run" || value.control === "stop") &&
      value.payload instanceof ArrayBuffer && value.payload.byteLength <= 4096;
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
