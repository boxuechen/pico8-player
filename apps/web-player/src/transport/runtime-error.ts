import type { SerializedRuntimeError } from "@pico8-web/contracts";
export class RuntimeClientError extends Error {
  readonly record: SerializedRuntimeError;

  constructor(record: SerializedRuntimeError) {
    super(record.message);
    this.name = "RuntimeClientError";
    this.record = record;
  }
}
