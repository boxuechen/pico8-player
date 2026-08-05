import type {
  PicoInputSnapshot,
  SerializedRuntimeError,
} from "@pico8-web/contracts";

interface CommandEnvelope {
  readonly v: 1;
  readonly requestId: number;
  readonly sessionGeneration: number;
}

export type Phase0EHostToRuntime =
  | (CommandEnvelope & {
      readonly type: "loadCart";
      readonly p8PngBytes: ArrayBuffer;
      readonly instructionBudget?: number;
    })
  | (CommandEnvelope & {
      readonly type: "step";
      readonly input: PicoInputSnapshot;
    })
  | (CommandEnvelope & {
      readonly type: "hostResponse";
      readonly hostRequestId: number;
      readonly bytes: ArrayBuffer;
      readonly isError: boolean;
    })
  | (CommandEnvelope & { readonly type: "dispose" });

interface EventEnvelope {
  readonly v: 1;
  readonly requestId: number;
  readonly sessionGeneration: number;
}

export type Phase0ERuntimeToHost =
  | (EventEnvelope & {
      readonly type: "ready";
      readonly mode: "callback" | "custom";
      readonly targetFps: 30 | 60;
    })
  | (EventEnvelope & {
      readonly type: "frame";
      readonly frameId: number;
      readonly completedSlices: string;
      readonly timeRawBeforeStep: number;
      readonly targetFps: 30 | 60;
      readonly packedScreen: ArrayBuffer;
    })
  | (EventEnvelope & {
      readonly type: "hostRequest";
      readonly hostRequestId: number;
      readonly operation: "boot" | "step";
      readonly bytes: ArrayBuffer;
    })
  | (EventEnvelope & { readonly type: "stopped" })
  | (EventEnvelope & {
      readonly type: "fault";
      readonly error: SerializedRuntimeError;
    })
  | (EventEnvelope & { readonly type: "disposed" });
