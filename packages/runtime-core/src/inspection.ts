/** Public inspection contract. Lua byte strings use code points 0..255. */
export const INSPECTION_LIMITS = Object.freeze({
  paths: 16,
  segments: 16,
  keyBytes: 128,
  inputBytes: 4096,
  outputBytes: 16384,
  depth: 4,
  entries: 512,
  instructions: 50000,
});
export type InspectionRequest =
  | {
      readonly mode: "read";
      readonly paths: readonly (readonly (string | number)[])[];
    }
  | { readonly mode: "debug"; readonly code: string };
export interface PreparedInspection {
  readonly mode: "read" | "debug";
  readonly payload: Uint8Array;
}
export type InspectedValue =
  | boolean
  | number
  | string
  | {
      readonly type:
        "nil" | "cycle" | "function" | "userdata" | "thread" | "lightuserdata";
    }
  | { readonly type: "truncated"; readonly reason: "depth" | "returns" }
  | {
      readonly type: "table";
      readonly entries: readonly {
        readonly key: InspectedValue;
        readonly value: InspectedValue;
      }[];
      readonly truncated?: "entries";
    };
export interface InspectionResult {
  readonly ok: boolean;
  readonly executed: boolean;
  readonly values: readonly InspectedValue[];
  readonly error?: string;
  readonly truncated?: "bytes";
}

export function prepareInspection(
  request: InspectionRequest,
): PreparedInspection {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new TypeError("inspection requires an object");
  const bytes: number[] = [];
  const word = (n: number) => {
    for (let i = 0; i < 4; i++) bytes.push((n >>> (i * 8)) & 255);
  };
  if (request.mode === "debug") {
    if (
      Object.keys(request).some((k) => !["mode", "code"].includes(k)) ||
      typeof request.code !== "string"
    )
      throw new TypeError("debug requires only mode and code");
    if (request.code.length > INSPECTION_LIMITS.inputBytes)
      throw new RangeError("debug code exceeds 4096 bytes");
    for (let i = 0; i < request.code.length; i++) {
      const byte = request.code.charCodeAt(i);
      if (byte > 255)
        throw new TypeError(
          "debug code uses Lua byte strings (code points 0..255)",
        );
      bytes.push(byte);
    }
  } else if (request.mode === "read") {
    if (
      Object.keys(request).some((k) => !["mode", "paths"].includes(k)) ||
      !Array.isArray(request.paths) ||
      request.paths.length < 1 ||
      request.paths.length > INSPECTION_LIMITS.paths
    )
      throw new TypeError("read requires 1-16 paths");
    word(request.paths.length);
    for (const path of request.paths) {
      if (
        !Array.isArray(path) ||
        path.length < 1 ||
        path.length > INSPECTION_LIMITS.segments ||
        typeof path[0] !== "string"
      )
        throw new TypeError(
          "path requires a global name and at most 16 segments",
        );
      word(path.length);
      for (const key of path) {
        if (
          typeof key === "string" &&
          key.length <= INSPECTION_LIMITS.keyBytes &&
          [...key].every((c) => c.charCodeAt(0) <= 255)
        ) {
          word(0);
          word(key.length);
          for (let i = 0; i < key.length; i++) bytes.push(key.charCodeAt(i));
        } else if (
          typeof key === "number" &&
          Number.isInteger(key) &&
          key >= -32768 &&
          key <= 32767
        ) {
          word(1);
          word(key);
        } else
          throw new TypeError(
            "path keys must be byte strings of at most 128 bytes or signed 16-bit integers",
          );
      }
    }
  } else throw new TypeError("inspection mode must be read or debug");
  if (bytes.length < 1 || bytes.length > INSPECTION_LIMITS.inputBytes)
    throw new RangeError("inspection input must be 1-4096 bytes");
  return { mode: request.mode, payload: Uint8Array.from(bytes) };
}
