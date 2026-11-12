import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditGeneratedBindings,
  auditPackageGraph,
  auditRepository,
  auditSourceText,
  auditWorkspace,
  formatViolation,
} from "../../tools/architecture/architecture.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIRECTORY, "../..");

test("production repository satisfies the canonical architecture", () => {
  const violations = auditRepository(REPO_ROOT);
  assert.deepEqual(violations, [], violations.map(formatViolation).join("\n"));
});

test("declared package cycles and illegal edges are rejected", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "pico8-architecture-"));
  try {
    for (const packageDirectory of ["contracts", "cart-codec", "runtime-core", "z8lua-bridge"]) {
      const targetDirectory = path.join(temporaryRoot, "packages", packageDirectory);
      mkdirSync(targetDirectory, { recursive: true });
      cpSync(
        path.join(REPO_ROOT, "packages", packageDirectory, "package.json"),
        path.join(targetDirectory, "package.json"),
      );
    }
    const contractsManifestPath = path.join(temporaryRoot, "packages/contracts/package.json");
    const contractsManifest = JSON.parse(readFileSync(contractsManifestPath, "utf8"));
    contractsManifest.dependencies = { "@pico8-web/z8lua-bridge": "workspace:*" };
    writeFileSync(contractsManifestPath, `${JSON.stringify(contractsManifest, null, 2)}\n`);

    const rules = new Set(auditPackageGraph(temporaryRoot).map(({ rule }) => rule));
    assert.equal(rules.has("illegal-package-edge"), true);
    assert.equal(rules.has("package-cycle"), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("unmanifested generated source is rejected", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "pico8-generated-"));
  try {
    const specificationDirectory = path.join(temporaryRoot, "spec/abi");
    const generatedDirectory = path.join(
      temporaryRoot,
      "packages/z8lua-bridge/src/generated",
    );
    mkdirSync(specificationDirectory, { recursive: true });
    mkdirSync(generatedDirectory, { recursive: true });
    writeFileSync(
      path.join(specificationDirectory, "generated-bindings.manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, files: [] }, null, 2)}\n`,
    );
    writeFileSync(path.join(generatedDirectory, "manual.ts"), "export {};\n");

    const rules = auditGeneratedBindings(temporaryRoot).map(({ rule }) => rule);
    assert.deepEqual(rules, ["untracked-generated-source"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("ref cannot be added to workspace globs", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "pico8-workspace-"));
  try {
    writeFileSync(
      path.join(temporaryRoot, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n  - "apps/*"\n  - "ref/*"\n',
    );
    const rules = auditWorkspace(temporaryRoot).map(({ rule }) => rule);
    assert.deepEqual(rules, ["workspace-includes-ref"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

const negativeCases = [
  {
    name: "bridge-runtime-import",
    logicalPath: "packages/z8lua-bridge/src/illegal.ts",
    expectedRule: "bridge-runtime-core-runtime-import",
    sourceText: "import \"@pico8-web/runtime-core\";",
  },
  {
    name: "deep-import",
    logicalPath: "packages/runtime-core/src/illegal.ts",
    expectedRule: "deep-package-import",
    sourceText: "import \"@pico8-web/cart-codec/src/public.js\";",
  },
  {
    name: "main-to-runtime",
    logicalPath: "apps/web-player/src/main/illegal.ts",
    expectedRule: "main-imports-runtime",
    sourceText: "import \"@pico8-web/runtime-core\";",
  },
  {
    name: "packages-to-apps",
    logicalPath: "packages/runtime-core/src/illegal.ts",
    expectedRule: "package-imports-app",
    sourceText: "import \"../../../apps/web-player/src/main/main.js\";",
  },
  {
    name: "platform-leak",
    logicalPath: "packages/runtime-core/src/illegal.ts",
    expectedRule: "platform-global-leak",
    sourceText: "document.title = \"illegal core platform access\";\ncreateImageBitmap(new Blob());\nglobalThis[\"DecompressionStream\"];",
  },
  {
    name: "ref-import",
    logicalPath: "packages/runtime-core/src/illegal.ts",
    expectedRule: "ref-import",
    sourceText: "import \"../../../ref/fake-08/source/cart.cpp\";",
  },
  {
    name: "worklet-to-z8lua",
    logicalPath: "apps/web-player/src/worklet/illegal.ts",
    expectedRule: "worklet-imports-runtime",
    sourceText: "import \"@pico8-web/z8lua-bridge\";",
  },
];

for (const { name, logicalPath, sourceText, expectedRule } of negativeCases) {
  test(`negative fixture is rejected: ${name}`, () => {
    const violations = auditSourceText({
      repoRoot: REPO_ROOT,
      logicalPath,
      sourceText,
    });
    const rules = [...new Set(violations.map(({ rule }) => rule))];
    assert.deepEqual(rules, [expectedRule], violations.map(formatViolation).join("\n"));
  });
}

test("public package exports resolve for an external consumer", async () => {
  for (const packageName of [
    "@pico8-web/contracts",
    "@pico8-web/cart-codec",
    "@pico8-web/runtime-core",
    "@pico8-web/z8lua-bridge",
  ]) {
    await assert.doesNotReject(import(packageName), packageName);
  }
});

test("internal package paths are not exported", async () => {
  await assert.rejects(
    import("@pico8-web/cart-codec/src/public.js"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});

test("consumer-view TypeScript project compiles through package exports", () => {
  const tscPath = path.join(REPO_ROOT, "node_modules/typescript/bin/tsc");
  assert.equal(existsSync(tscPath), true, "run pnpm install before architecture tests");
  const result = spawnSync(
    process.execPath,
    [tscPath, "-p", "tests/architecture/consumer/tsconfig.json", "--pretty", "false"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("all package and execution-domain build outputs exist", () => {
  for (const relativePath of [
    "packages/contracts/dist/public.js",
    "packages/cart-codec/dist/public.js",
    "packages/runtime-core/dist/public.js",
    "packages/z8lua-bridge/dist/public.js",
    "apps/web-player/dist/main/main.js",
    "apps/web-player/dist/worker/runtime-worker.js",
    "apps/web-player/dist/worklet/pico8-audio-processor.js",
  ]) {
    assert.equal(existsSync(path.join(REPO_ROOT, relativePath)), true, relativePath);
  }
});

test("bridge type-only dependency does not become a runtime load", () => {
  const output = readFileSync(
    path.join(REPO_ROOT, "packages/z8lua-bridge/dist/public.js"),
    "utf8",
  );
  assert.equal(output.includes("@pico8-web/runtime-core"), false, output);
});

test("shared session layer rejects host-specific imports and Worker/UI globals", () => {
  for (const sourceText of [
    'import { PlayerController } from "../main/player-controller.js";',
    'import { installPlayerRuntimeWorker } from "../worker/runtime-worker.js";',
    'new Worker("runtime.mjs");',
    'globalThis.document.createElement("canvas");',
  ]) {
    const violations = auditSourceText({ repoRoot: REPO_ROOT,
      logicalPath: "apps/web-player/src/runtime/negative.ts", sourceText });
    assert.ok(violations.length > 0, sourceText);
  }
  const valid = auditSourceText({repoRoot: REPO_ROOT,
    logicalPath: "apps/web-player/src/runtime/positive.ts",
    sourceText: 'import { CartSession } from "@pico8-web/runtime-core";'});
  assert.deepEqual(valid, []);
});
