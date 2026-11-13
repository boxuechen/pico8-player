import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const productionContractPath = "spec/abi/pico-host-api-v1.json";
const tsOutputPath = "packages/z8lua-bridge/src/generated/pico-host-bindings.ts";
const cppOutputPath = "wasm/bridge/generated/p8w_host_bindings.generated.h";
const manifestPath = "spec/abi/generated-bindings.manifest.json";
const resultKinds = new Map([
  ["void", "P8W_HOST_RESULT_VOID"],
  ["integer", "P8W_HOST_RESULT_INTEGER"],
  ["boolean", "P8W_HOST_RESULT_BOOLEAN"],
  ["q16.16-raw-i32", "P8W_HOST_RESULT_Q16"],
  ["integer-if-first-omitted-otherwise-boolean", "P8W_HOST_RESULT_INTEGER_OR_BOOLEAN"],
  ["integer-unless-second-present-then-boolean", "P8W_HOST_RESULT_INTEGER_OR_BOOLEAN_SECOND"],
  ["stat-input-selector", "P8W_HOST_RESULT_STAT_INPUT"],
]);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`${label} must be an identifier`);
  }
}

export function validateBindingContract(contract, { runtimeExposed } = {}) {
  if (contract?.schemaVersion !== 2 || !Array.isArray(contract.bindings)) {
    throw new Error("host binding contract must use schemaVersion 2 and contain bindings");
  }
  if (
    contract.dispatchAbi?.maximumArguments !== 12 ||
    contract.dispatchAbi?.callFrame?.byteSize !== 80 ||
    contract.dispatchAbi?.callFrame?.scalarSlots !== 12 ||
    contract.dispatchAbi?.callFrame?.byteStringArguments !== 1
  ) {
    throw new Error("host binding contract must use the 80-byte call frame");
  }
  if (runtimeExposed !== undefined && contract.runtimeExposed !== runtimeExposed) {
    throw new Error(`runtimeExposed must be ${runtimeExposed}`);
  }
  const ids = new Set();
  const guestNames = new Set();
  for (const binding of contract.bindings) {
    if (!Number.isInteger(binding.id) || binding.id <= 0 || binding.id > 0xffff_ffff) {
      throw new Error("binding id must be a positive uint32");
    }
    assertIdentifier(binding.guestName, "guestName");
    assertIdentifier(binding.hostMethod, "hostMethod");
    if (ids.has(binding.id) || guestNames.has(binding.guestName)) {
      throw new Error("binding ids and guest names must be unique");
    }
    ids.add(binding.id);
    guestNames.add(binding.guestName);
    if (!Array.isArray(binding.parameters) || binding.parameters.length > 12) {
      throw new Error("binding parameters must contain at most twelve entries");
    }
    let optionalSeen = false;
    let byteStrings = 0;
    for (const parameter of binding.parameters) {
      assertIdentifier(parameter.name, "parameter name");
      if (
        parameter.type !== "q16.16-raw-i32" &&
        parameter.type !== "boolean-i32" &&
        parameter.type !== "byte-string"
      ) {
        throw new Error(`unsupported parameter type: ${parameter.type}`);
      }
      if (parameter.type === "byte-string") byteStrings += 1;
      optionalSeen ||= parameter.optional === true;
      if (optionalSeen && parameter.optional !== true) {
        throw new Error("required parameters cannot follow optional parameters");
      }
    }
    if (byteStrings > 1) {
      throw new Error("the call frame accepts one byte-string argument");
    }
    if (!resultKinds.has(binding.result)) {
      throw new Error(`unsupported result kind: ${binding.result}`);
    }
  }
  return contract;
}

function operationConstant(name) {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
}

function argumentExpression(parameter, index) {
  if (parameter.type === "byte-string") {
    return parameter.optional === true
      ? `(argumentMask & ${1 << index}) !== 0 ? byteString : undefined`
      : `byteString!`;
  }
  if (parameter.type === "boolean-i32") {
    return parameter.optional === true
      ? `(argumentMask & ${1 << index}) !== 0 ? args[${index}]! !== 0 : undefined`
      : `args[${index}]! !== 0`;
  }
  return parameter.optional === true
    ? `(argumentMask & ${1 << index}) !== 0 ? args[${index}]! : undefined`
    : `args[${index}]!`;
}

export function renderTypeScript(contract, sourceHash = sha256(JSON.stringify(contract))) {
  const constants = contract.bindings
    .map((binding) => `  ${operationConstant(binding.hostMethod)}: ${binding.id},`)
    .join("\n");
  const cases = contract.bindings.map((binding) => {
    const argumentsText = binding.parameters
      .map((parameter, index) => argumentExpression(parameter, index))
      .join(", ");
    const call = `host.${binding.hostMethod}(${argumentsText})`;
    return binding.result === "void"
      ? `    case ${binding.id}:\n      ${call};\n      return 0;`
      : `    case ${binding.id}:\n      return ${call} | 0;`;
  }).join("\n");
  return `// Generated by tools/wasm/generate-host-bindings.mjs from ${productionContractPath} (sha256:${sourceHash}). Do not edit.\n` +
    `import type { PicoApiHost } from "@pico8-player/runtime-core";\n\n` +
    `export const PICO_HOST_CALL_FRAME = Object.freeze({\n` +
    `  BYTE_SIZE: 80,\n  OPERATION_ID: 4,\n  PRESENCE_BITS: 8,\n` +
    `  FLAGS: 12,\n  SCALAR_COUNT: 16,\n  SCALAR_SLOTS: 20,\n` +
    `  SCALAR_CAPACITY: 12,\n  BYTE_BUFFER_POINTER: 68,\n` +
    `  BYTE_BUFFER_LENGTH: 72,\n  RESULT: 76,\n});\n\n` +
    `export const PICO_HOST_OPERATION = Object.freeze({\n${constants}\n});\n\n` +
    `export type PicoHostOperationId = typeof PICO_HOST_OPERATION[keyof typeof PICO_HOST_OPERATION];\n\n` +
    `export function dispatchPicoHostCall(\n` +
    `  host: PicoApiHost,\n` +
    `  operationId: number,\n` +
    `  argumentMask: number,\n` +
    `  args: Int32Array,\n` +
    `  byteString?: Uint8Array,\n` +
    `): number {\n` +
    `  switch (operationId >>> 0) {\n${cases}\n` +
    `    default:\n      throw new RangeError(\`unknown PicoApiHost operation \${operationId >>> 0}\`);\n` +
    `  }\n}\n`;
}

export function renderCpp(contract, sourceHash = sha256(JSON.stringify(contract))) {
  const descriptors = contract.bindings.map((binding) => {
    const minimumArguments = binding.parameters.filter((parameter) => parameter.optional !== true).length;
    const byteStringMask = binding.parameters.reduce(
      (mask, parameter, index) => parameter.type === "byte-string" ? mask | (1 << index) : mask,
      0,
    );
    const booleanMask = binding.parameters.reduce(
      (mask, parameter, index) => parameter.type === "boolean-i32" ? mask | (1 << index) : mask,
      0,
    );
    return `    {${binding.id}u, "${binding.guestName}", ${minimumArguments}u, ${binding.parameters.length}u, ${byteStringMask}u, ${booleanMask}u, ${resultKinds.get(binding.result)}},`;
  }).join("\n");
  return `// Generated by tools/wasm/generate-host-bindings.mjs from ${productionContractPath} (sha256:${sourceHash}). Do not edit.\n` +
    `#ifndef P8W_HOST_BINDINGS_GENERATED_H\n#define P8W_HOST_BINDINGS_GENERATED_H\n\n` +
    `struct P8wHostCallFrame {\n` +
    `  uint32_t byte_size;\n  uint32_t operation_id;\n  uint32_t presence_bits;\n` +
    `  uint32_t flags;\n  uint32_t scalar_count;\n  int32_t scalar_slots[12];\n` +
    `  uint32_t byte_buffer_ptr;\n  uint32_t byte_buffer_len;\n  int32_t result;\n};\n\n` +
    `static_assert(sizeof(P8wHostCallFrame) == 80, "host call frame ABI drift");\n\n` +
    `enum P8wHostResultKind : uint8_t {\n` +
    `  P8W_HOST_RESULT_VOID = 0,\n  P8W_HOST_RESULT_INTEGER = 1,\n` +
    `  P8W_HOST_RESULT_BOOLEAN = 2,\n  P8W_HOST_RESULT_INTEGER_OR_BOOLEAN = 3,\n` +
    `  P8W_HOST_RESULT_Q16 = 4,\n  P8W_HOST_RESULT_INTEGER_OR_BOOLEAN_SECOND = 5,\n` +
    `  P8W_HOST_RESULT_STAT_INPUT = 6,\n};\n\n` +
    `struct P8wHostBindingDescriptor {\n  uint32_t operation_id;\n  const char *guest_name;\n` +
    `  uint8_t minimum_arguments;\n  uint8_t maximum_arguments;\n  uint16_t byte_string_mask;\n` +
    `  uint16_t boolean_mask;\n  P8wHostResultKind result_kind;\n};\n\n` +
    `constexpr P8wHostBindingDescriptor kP8wHostBindings[] = {\n${descriptors}\n};\n\n` +
    `#endif\n`;
}

export async function generateHostBindings(root = projectRoot) {
  const read = async (relativePath) => readFile(resolve(root, relativePath), "utf8");
  const productionText = await read(productionContractPath);
  const production = validateBindingContract(JSON.parse(productionText));
  const productionHash = sha256(productionText);
  const outputs = [
    { path: tsOutputPath, text: renderTypeScript(production, productionHash) },
    { path: cppOutputPath, text: renderCpp(production, productionHash) },
  ];
  for (const output of outputs) {
    await mkdir(dirname(resolve(root, output.path)), { recursive: true });
    await writeFile(resolve(root, output.path), output.text);
  }
  const manifest = {
    schemaVersion: 1,
    generator: "tools/wasm/generate-host-bindings.mjs",
    source: productionContractPath,
    sourceHash: productionHash,
    files: outputs.map((output) => ({ path: output.path, sha256: sha256(output.text) })),
  };
  await writeFile(resolve(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const manifest = await generateHostBindings();
  process.stdout.write(`Generated ${manifest.files.length} host binding files\n`);
}
