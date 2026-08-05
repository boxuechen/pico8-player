import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

const PACKAGE_BY_DIRECTORY = new Map([
  ["contracts", "@pico8-web/contracts"],
  ["cart-codec", "@pico8-web/cart-codec"],
  ["runtime-core", "@pico8-web/runtime-core"],
  ["z8lua-bridge", "@pico8-web/z8lua-bridge"],
]);

const ALLOWED_PACKAGE_DEPENDENCIES = new Map([
  ["@pico8-web/contracts", new Set()],
  ["@pico8-web/cart-codec", new Set(["@pico8-web/contracts"])],
  [
    "@pico8-web/runtime-core",
    new Set(["@pico8-web/contracts", "@pico8-web/cart-codec"]),
  ],
  [
    "@pico8-web/z8lua-bridge",
    new Set(["@pico8-web/contracts", "@pico8-web/runtime-core"]),
  ],
]);

const NEUTRAL_GLOBALS = new Set([
  "window",
  "document",
  "self",
  "navigator",
  "fetch",
  "Worker",
  "MessagePort",
  "AudioContext",
  "OfflineAudioContext",
  "HTMLCanvasElement",
  "CanvasRenderingContext2D",
  "OffscreenCanvas",
  "ImageBitmap",
  "createImageBitmap",
  "DecompressionStream",
  "indexedDB",
  "IDBDatabase",
  "File",
  "FileReader",
]);

const BRIDGE_FORBIDDEN_GLOBALS = new Set([
  "window",
  "document",
  "navigator",
  "fetch",
  "AudioContext",
  "OfflineAudioContext",
  "HTMLCanvasElement",
  "CanvasRenderingContext2D",
  "OffscreenCanvas",
  "ImageBitmap",
  "createImageBitmap",
  "DecompressionStream",
  "indexedDB",
  "IDBDatabase",
  "File",
  "FileReader",
]);

const WORKER_FORBIDDEN_GLOBALS = new Set([
  "window",
  "document",
  "HTMLElement",
  "HTMLCanvasElement",
  "CanvasRenderingContext2D",
  "AudioContext",
]);

const WORKLET_FORBIDDEN_GLOBALS = new Set([
  "window",
  "document",
  "navigator",
  "fetch",
  "Worker",
  "DedicatedWorkerGlobalScope",
  "indexedDB",
  "IDBDatabase",
  "File",
  "FileReader",
  "HTMLElement",
  "HTMLCanvasElement",
  "CanvasRenderingContext2D",
  "AudioContext",
]);

const REQUIRED_FILES = [
  ".gitignore",
  ".github/workflows/verify.yml",
  ".node-version",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "apps/web-player/src/main/main.ts",
  "apps/web-player/src/main/compose-player.ts",
  "apps/web-player/src/worker/runtime-worker.ts",
  "apps/web-player/src/worker/compose-runtime.ts",
  "apps/web-player/src/worklet/pico8-audio-processor.ts",
  "spec/pico-api-inventory.yaml",
  "spec/cart-codec-contract.json",
  "spec/abi/generated-bindings.manifest.json",
  "packages/cart-codec/manifest.lock.json",
  "wasm/manifest.lock.json",
];

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function violation(rule, file, message, line) {
  return { rule, file: toPosix(file), message, ...(line ? { line } : {}) };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function walk(directory, predicate) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", "ref"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath, predicate));
    else if (predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

function layerFor(relativePath) {
  const normalized = toPosix(relativePath).replace(/^\.\//, "");
  const packageMatch = normalized.match(/^packages\/([^/]+)\/src(?:\/|$)/);
  if (packageMatch) {
    return {
      kind: "package",
      name: PACKAGE_BY_DIRECTORY.get(packageMatch[1]) ?? `unknown:${packageMatch[1]}`,
    };
  }
  const domainMatch = normalized.match(
    /^apps\/web-player\/src\/(transport|main|worker|worklet)(?:\/|$)/,
  );
  if (domainMatch) return { kind: "app", name: domainMatch[1] };
  if (normalized === "ref" || normalized.startsWith("ref/")) {
    return { kind: "ref", name: "ref" };
  }
  if (normalized === "tests" || normalized.startsWith("tests/")) {
    return { kind: "test", name: "tests" };
  }
  return { kind: "other", name: "other" };
}

function packageSpecifier(specifier) {
  const match = specifier.match(/^(@pico8-web\/[^/]+)(?:\/(.+))?$/);
  if (!match) return null;
  return { packageName: match[1], subpath: match[2] ?? null };
}

function exportedSubpaths(repoRoot, packageName) {
  const directory = [...PACKAGE_BY_DIRECTORY.entries()].find(([, name]) => name === packageName)?.[0];
  if (!directory) return new Set();
  const manifest = readJson(path.join(repoRoot, "packages", directory, "package.json"));
  if (typeof manifest.exports === "string") return new Set(["."]);
  return new Set(Object.keys(manifest.exports ?? {}));
}

function moduleReferences(sourceFile) {
  const references = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) &&
      node.source?.type === "StringLiteral"
    ) {
      const specifiers = node.specifiers ?? [];
      references.push({
        specifier: node.source.value,
        typeOnly:
          node.importKind === "type" ||
          node.exportKind === "type" ||
          (specifiers.length > 0 && specifiers.every((specifier) => specifier.importKind === "type")),
        node: node.source,
      });
    } else if (
      node.type === "ImportExpression" &&
      node.source?.type === "StringLiteral"
    ) {
      references.push({ specifier: node.source.value, typeOnly: false, node: node.source });
    } else if (
      node.type === "CallExpression" &&
      node.callee?.type === "Import" &&
      node.arguments?.length === 1 &&
      node.arguments[0]?.type === "StringLiteral"
    ) {
      references.push({
        specifier: node.arguments[0].value,
        typeOnly: false,
        node: node.arguments[0],
      });
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "errors", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  }
  visit(sourceFile);
  return references;
}

function identifierIsName(identifier, parent) {
  if (!parent) return false;
  if (["MemberExpression", "OptionalMemberExpression"].includes(parent.type) &&
      parent.property === identifier && !parent.computed) return true;
  if (["ObjectProperty", "ObjectMethod", "ClassMethod", "ClassProperty", "TSPropertySignature"].includes(parent.type) &&
      parent.key === identifier && !parent.computed && !parent.shorthand) return true;
  if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ExportSpecifier"].includes(parent.type)) return true;
  if (["VariableDeclarator", "FunctionDeclaration", "FunctionExpression", "ClassDeclaration", "ClassExpression", "TSTypeAliasDeclaration", "TSInterfaceDeclaration"].includes(parent.type) &&
      parent.id === identifier) return true;
  if (["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type) && parent.label === identifier) return true;
  if (parent.type === "TSQualifiedName" && parent.right === identifier) return true;
  return false;
}

function forbiddenGlobalsFor(layer) {
  if (layer.kind === "package") {
    return layer.name === "@pico8-web/z8lua-bridge"
      ? BRIDGE_FORBIDDEN_GLOBALS
      : NEUTRAL_GLOBALS;
  }
  if (layer.kind !== "app") return new Set();
  if (layer.name === "transport") return NEUTRAL_GLOBALS;
  if (layer.name === "worker") return WORKER_FORBIDDEN_GLOBALS;
  if (layer.name === "worklet") return WORKLET_FORBIDDEN_GLOBALS;
  return new Set();
}

function lineOf(sourceFile, node) {
  return node.loc?.start.line ?? 1;
}

export function auditSourceText({ repoRoot, logicalPath, sourceText }) {
  const relativePath = toPosix(logicalPath);
  const sourceLayer = layerFor(relativePath);
  const violations = [];
  let sourceFile;
  try {
    sourceFile = parse(sourceText, {
      sourceType: "module",
      sourceFilename: relativePath,
      plugins: ["typescript", "importAttributes"],
    });
  } catch (error) {
    return [
      violation(
        "source-parse-error",
        relativePath,
        error instanceof Error ? error.message : String(error),
      ),
    ];
  }

  for (const reference of moduleReferences(sourceFile)) {
    const { specifier } = reference;
    const scoped = packageSpecifier(specifier);
    let targetLayer = { kind: "other", name: "external" };

    if (scoped) {
      targetLayer = scoped.packageName === "@pico8-web/web-player"
        ? { kind: "app", name: "web-player" }
        : { kind: "package", name: scoped.packageName };
      if (scoped.subpath) {
        const exportKey = `./${scoped.subpath}`;
        if (!exportedSubpaths(repoRoot, scoped.packageName).has(exportKey)) {
          violations.push(
            violation(
              "deep-package-import",
              relativePath,
              `${specifier} is not a declared package export`,
              lineOf(sourceFile, reference.node),
            ),
          );
        }
      }
    } else if (specifier.startsWith(".")) {
      const resolved = toPosix(path.normalize(path.join(path.dirname(relativePath), specifier)));
      targetLayer = layerFor(resolved);
      if (targetLayer.kind === "ref") {
        violations.push(
          violation(
            "ref-import",
            relativePath,
            `reference source is not an import/build input: ${specifier}`,
            lineOf(sourceFile, reference.node),
          ),
        );
      }
    } else if (specifier === "ref" || specifier.startsWith("ref/")) {
      targetLayer = { kind: "ref", name: "ref" };
      violations.push(
        violation(
          "ref-import",
          relativePath,
          `reference source is not an import/build input: ${specifier}`,
          lineOf(sourceFile, reference.node),
        ),
      );
    }

    if (sourceLayer.kind === "package" && targetLayer.kind === "app") {
      violations.push(
        violation(
          "package-imports-app",
          relativePath,
          `package source cannot import apps: ${specifier}`,
          lineOf(sourceFile, reference.node),
        ),
      );
    } else if (
      sourceLayer.kind === "package" &&
      targetLayer.kind === "package" &&
      targetLayer.name !== sourceLayer.name
    ) {
      if (specifier.startsWith(".")) {
        violations.push(
          violation(
            "relative-cross-package-import",
            relativePath,
            `cross-package imports must use package exports: ${specifier}`,
            lineOf(sourceFile, reference.node),
          ),
        );
      } else {
        const allowed = ALLOWED_PACKAGE_DEPENDENCIES.get(sourceLayer.name) ?? new Set();
        if (!allowed.has(targetLayer.name)) {
          violations.push(
            violation(
              "illegal-package-edge",
              relativePath,
              `${sourceLayer.name} cannot depend on ${targetLayer.name}`,
              lineOf(sourceFile, reference.node),
            ),
          );
        }
      }
    }

    if (
      sourceLayer.kind === "package" &&
      sourceLayer.name === "@pico8-web/z8lua-bridge" &&
      targetLayer.kind === "package" &&
      targetLayer.name === "@pico8-web/runtime-core" &&
      !reference.typeOnly
    ) {
      violations.push(
        violation(
          "bridge-runtime-core-runtime-import",
          relativePath,
          "z8lua bridge may import RuntimeCore public port types only",
          lineOf(sourceFile, reference.node),
        ),
      );
    }

    if (sourceLayer.kind === "app") {
      const forbiddenForMainOrWorklet = new Set([
        "@pico8-web/cart-codec",
        "@pico8-web/runtime-core",
        "@pico8-web/z8lua-bridge",
      ]);
      if (
        sourceLayer.name === "main" &&
        targetLayer.kind === "package" &&
        forbiddenForMainOrWorklet.has(targetLayer.name)
      ) {
        violations.push(
          violation(
            "main-imports-runtime",
            relativePath,
            `main may communicate through transport only: ${specifier}`,
            lineOf(sourceFile, reference.node),
          ),
        );
      }
      if (
        sourceLayer.name === "worklet" &&
        targetLayer.kind === "package" &&
        forbiddenForMainOrWorklet.has(targetLayer.name)
      ) {
        violations.push(
          violation(
            "worklet-imports-runtime",
            relativePath,
            `worklet may communicate through audio transport only: ${specifier}`,
            lineOf(sourceFile, reference.node),
          ),
        );
      }

      if (targetLayer.kind === "app" && targetLayer.name !== sourceLayer.name) {
        const allowedTarget =
          ["main", "worker", "worklet"].includes(sourceLayer.name) &&
          targetLayer.name === "transport";
        if (!allowedTarget) {
          violations.push(
            violation(
              "illegal-execution-domain-import",
              relativePath,
              `${sourceLayer.name} cannot import ${targetLayer.name}: ${specifier}`,
              lineOf(sourceFile, reference.node),
            ),
          );
        }
      }
    }
  }

  const forbiddenGlobals = forbiddenGlobalsFor(sourceLayer);
  function visitIdentifiers(node, parent = null) {
    if (!node || typeof node !== "object") return;
    if (
      ["MemberExpression", "OptionalMemberExpression"].includes(node.type) &&
      node.object?.type === "Identifier" &&
      node.object.name === "globalThis"
    ) {
      const propertyName = !node.computed && node.property?.type === "Identifier"
        ? node.property.name
        : node.computed && node.property?.type === "StringLiteral"
          ? node.property.value
          : null;
      if (propertyName !== null && forbiddenGlobals.has(propertyName)) {
        violations.push(
          violation(
            "platform-global-leak",
            relativePath,
            `globalThis.${propertyName} is not available in ${sourceLayer.name}`,
            lineOf(sourceFile, node),
          ),
        );
      }
    }
    if (
      node.type === "Identifier" &&
      forbiddenGlobals.has(node.name) &&
      !identifierIsName(node, parent)
    ) {
      violations.push(
        violation(
          "platform-global-leak",
          relativePath,
          `${node.name} is not available in ${sourceLayer.name}`,
          lineOf(sourceFile, node),
        ),
      );
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "errors", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) visitIdentifiers(child, node);
      } else if (value && typeof value === "object") {
        visitIdentifiers(value, node);
      }
    }
  }
  visitIdentifiers(sourceFile);

  return violations;
}

function checkPackageGraph(repoRoot) {
  const violations = [];
  const graph = new Map();
  for (const [directory, expectedName] of PACKAGE_BY_DIRECTORY) {
    const manifestPath = path.join(repoRoot, "packages", directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (manifest.name !== expectedName) {
      violations.push(
        violation("package-name", path.relative(repoRoot, manifestPath), `expected ${expectedName}`),
      );
    }
    const productionDependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    };
    const internal = Object.keys(productionDependencies).filter((name) => name.startsWith("@pico8-web/"));
    graph.set(expectedName, internal);
    const allowed = ALLOWED_PACKAGE_DEPENDENCIES.get(expectedName) ?? new Set();
    for (const dependency of internal) {
      if (!allowed.has(dependency)) {
        violations.push(
          violation(
            "illegal-package-edge",
            path.relative(repoRoot, manifestPath),
            `${expectedName} cannot declare a production dependency on ${dependency}`,
          ),
        );
      }
    }
    for (const dependency of allowed) {
      if (!internal.includes(dependency)) {
        violations.push(
          violation(
            "missing-canonical-package-edge",
            path.relative(repoRoot, manifestPath),
            `${expectedName} must declare ${dependency}`,
          ),
        );
      }
    }
    const exports = manifest.exports ?? {};
    if (!exports["."]?.types || !exports["."]?.import) {
      violations.push(
        violation(
          "missing-public-export",
          path.relative(repoRoot, manifestPath),
          "package must expose typed ESM root export",
        ),
      );
    }
    if (!manifest.scripts?.build || !manifest.scripts?.typecheck) {
      violations.push(
        violation(
          "missing-package-verification-script",
          path.relative(repoRoot, manifestPath),
          "package must expose independent build and typecheck scripts",
        ),
      );
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(name, stack) {
    if (visiting.has(name)) {
      violations.push(
        violation("package-cycle", "packages", `production dependency cycle: ${[...stack, name].join(" -> ")}`),
      );
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...stack, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name, []);

  const appManifestPath = path.join(repoRoot, "apps/web-player/package.json");
  if (existsSync(appManifestPath)) {
    const appManifest = readJson(appManifestPath);
    const appDependencies = new Set(Object.keys(appManifest.dependencies ?? {}));
    for (const packageName of PACKAGE_BY_DIRECTORY.values()) {
      if (!appDependencies.has(packageName)) {
        violations.push(
          violation(
            "missing-app-composition-dependency",
            "apps/web-player/package.json",
            `worker composition requires ${packageName}`,
          ),
        );
      }
    }
    if (!appManifest.scripts?.build || !appManifest.scripts?.typecheck) {
      violations.push(
        violation(
          "missing-package-verification-script",
          "apps/web-player/package.json",
          "web-player must expose independent build and typecheck scripts",
        ),
      );
    }
  }
  return violations;
}

function checkProjectReferences(repoRoot) {
  const expectedReferences = new Map([
    ["tsconfig.json", [
      "packages/contracts",
      "packages/cart-codec",
      "packages/runtime-core",
      "packages/z8lua-bridge",
      "apps/web-player",
    ]],
    ["packages/contracts/tsconfig.json", []],
    ["packages/cart-codec/tsconfig.json", ["packages/contracts"]],
    ["packages/runtime-core/tsconfig.json", ["packages/contracts", "packages/cart-codec"]],
    ["packages/z8lua-bridge/tsconfig.json", ["packages/contracts", "packages/runtime-core"]],
    ["apps/web-player/tsconfig.json", [
      "apps/web-player/src/transport",
      "apps/web-player/src/main",
      "apps/web-player/src/worker",
      "apps/web-player/src/worklet",
    ]],
    ["apps/web-player/src/transport/tsconfig.json", ["packages/contracts"]],
    ["apps/web-player/src/main/tsconfig.json", ["apps/web-player/src/transport"]],
    ["apps/web-player/src/worker/tsconfig.json", [
      "apps/web-player/src/transport",
      "packages/cart-codec",
      "packages/runtime-core",
      "packages/z8lua-bridge",
    ]],
    ["apps/web-player/src/worklet/tsconfig.json", ["apps/web-player/src/transport"]],
  ]);
  const violations = [];
  for (const [relativePath, expected] of expectedReferences) {
    const configPath = path.join(repoRoot, relativePath);
    if (!existsSync(configPath)) continue;
    const config = readJson(configPath);
    const actual = (config.references ?? []).map((reference) =>
      toPosix(path.relative(repoRoot, path.resolve(path.dirname(configPath), reference.path))),
    ).sort();
    const sortedExpected = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
      violations.push(
        violation(
          "project-reference-drift",
          relativePath,
          `expected [${sortedExpected.join(", ")}]; received [${actual.join(", ")}]`,
        ),
      );
    }
  }
  return violations;
}

function checkTypeScriptLibs(repoRoot) {
  const expectations = new Map([
    ["packages/contracts/tsconfig.json", ["ES2022"]],
    ["packages/cart-codec/tsconfig.json", ["ES2022"]],
    ["packages/runtime-core/tsconfig.json", ["ES2022"]],
    ["packages/z8lua-bridge/tsconfig.json", ["ES2022"]],
    ["apps/web-player/src/transport/tsconfig.json", ["ES2022"]],
    ["apps/web-player/src/main/tsconfig.json", ["DOM", "DOM.Iterable", "ES2022"]],
    ["apps/web-player/src/worker/tsconfig.json", ["ES2022", "WebWorker"]],
    ["apps/web-player/src/worklet/tsconfig.json", ["ES2022"]],
  ]);
  const violations = [];
  for (const [relativePath, expected] of expectations) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!existsSync(fullPath)) continue;
    const actual = [...(readJson(fullPath).compilerOptions?.lib ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      violations.push(
        violation(
          "typescript-lib-leak",
          relativePath,
          `expected lib ${expected.join(", ")}; received ${actual.join(", ")}`,
        ),
      );
    }
  }
  return violations;
}

function checkGeneratedBindings(repoRoot) {
  const manifestPath = path.join(repoRoot, "spec/abi/generated-bindings.manifest.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = readJson(manifestPath);
  const listed = new Map((manifest.files ?? []).map((entry) => [toPosix(entry.path), entry.sha256]));
  const generatedSources = [
    ...walk(
      path.join(repoRoot, "packages/z8lua-bridge/src/generated"),
      (file) => /\.(?:[cm]?[jt]sx?|d\.ts)$/.test(file),
    ),
    ...walk(
      path.join(repoRoot, "wasm/bridge/generated"),
      (file) => /\.(?:h|hpp|inc)$/.test(file),
    ),
  ];
  const violations = [];
  for (const file of generatedSources) {
    const relativePath = toPosix(path.relative(repoRoot, file));
    if (!listed.has(relativePath)) {
      violations.push(
        violation("untracked-generated-source", relativePath, "generated source is absent from ABI manifest"),
      );
    }
  }
  for (const [relativePath, expectedHash] of listed) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!existsSync(fullPath)) {
      violations.push(violation("missing-generated-source", relativePath, "manifest entry does not exist"));
      continue;
    }
    const actualHash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
    if (actualHash !== expectedHash) {
      violations.push(
        violation("generated-source-drift", relativePath, `expected ${expectedHash}; received ${actualHash}`),
      );
    }
  }
  return violations;
}

function checkWorkspace(repoRoot) {
  const violations = [];
  const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) return violations;
  const workspace = readFileSync(workspacePath, "utf8");
  if (!workspace.includes('"packages/*"') || !workspace.includes('"apps/*"')) {
    violations.push(
      violation("workspace-layout", "pnpm-workspace.yaml", "workspace must include packages/* and apps/*"),
    );
  }
  if (/(?:^|[\s"'])ref(?:\/|\*|["'])/m.test(workspace)) {
    violations.push(
      violation("workspace-includes-ref", "pnpm-workspace.yaml", "ref/ must not be a workspace input"),
    );
  }
  return violations;
}

function checkToolchainAndCi(repoRoot) {
  const violations = [];
  const rootManifest = readJson(path.join(repoRoot, "package.json"));
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(rootManifest.packageManager ?? "")) {
    violations.push(
      violation("unpinned-package-manager", "package.json", "packageManager must pin an exact pnpm version"),
    );
  }
  for (const script of ["build", "typecheck", "test:architecture", "test:public-exports", "verify"]) {
    if (!rootManifest.scripts?.[script]) {
      violations.push(
        violation("missing-root-verification-script", "package.json", `missing script: ${script}`),
      );
    }
  }
  if (!existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
    violations.push(violation("missing-lockfile", "pnpm-lock.yaml", "frozen installs require a lockfile"));
  }
  const ignorePath = path.join(repoRoot, ".gitignore");
  if (
    existsSync(ignorePath) &&
    !readFileSync(ignorePath, "utf8").split(/\r?\n/).includes("/ref/")
  ) {
    violations.push(
      violation("ref-not-gitignored", ".gitignore", "the complete ref/ directory must be ignored"),
    );
  }
  const workflowPath = path.join(repoRoot, ".github/workflows/verify.yml");
  if (existsSync(workflowPath)) {
    const workflow = readFileSync(workflowPath, "utf8");
    if (!workflow.includes("pnpm install --frozen-lockfile")) {
      violations.push(
        violation("ci-not-frozen", ".github/workflows/verify.yml", "CI must use the frozen lockfile"),
      );
    }
    if (!workflow.includes("pnpm run verify")) {
      violations.push(
        violation("ci-missing-verify", ".github/workflows/verify.yml", "CI must run the canonical verify gate"),
      );
    }
  }

  const buildConfigurationFiles = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "tsconfig.json"),
    path.join(repoRoot, "tsconfig.base.json"),
    path.join(repoRoot, "pnpm-workspace.yaml"),
    workflowPath,
    ...walk(path.join(repoRoot, "packages"), (file) =>
      ["package.json", "tsconfig.json"].includes(path.basename(file))),
    ...walk(path.join(repoRoot, "apps"), (file) =>
      ["package.json", "tsconfig.json"].includes(path.basename(file))),
    ...walk(path.join(repoRoot, "tests"), (file) =>
      ["package.json", "tsconfig.json"].includes(path.basename(file))),
  ];
  for (const file of buildConfigurationFiles) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    if (/(?:^|[\s"'])(?:\.\.\/)*ref\//m.test(content)) {
      violations.push(
        violation(
          "build-includes-ref",
          path.relative(repoRoot, file),
          "ref/ must not appear in workspace, build, or CI inputs",
        ),
      );
    }
  }
  return violations;
}

export function auditRepository(repoRoot) {
  const violations = [];
  for (const relativePath of REQUIRED_FILES) {
    if (!existsSync(path.join(repoRoot, relativePath))) {
      violations.push(violation("missing-scaffold", relativePath, "required Phase 0S artifact is missing"));
    }
  }
  violations.push(...checkToolchainAndCi(repoRoot));
  violations.push(...checkWorkspace(repoRoot));
  violations.push(...checkPackageGraph(repoRoot));
  violations.push(...checkProjectReferences(repoRoot));
  violations.push(...checkTypeScriptLibs(repoRoot));
  violations.push(...checkGeneratedBindings(repoRoot));

  const productionRoots = [path.join(repoRoot, "packages"), path.join(repoRoot, "apps")];
  for (const root of productionRoots) {
    for (const file of walk(root, (candidate) => /\.(?:[cm]?ts|tsx)$/.test(candidate))) {
      const logicalPath = path.relative(repoRoot, file);
      violations.push(
        ...auditSourceText({
          repoRoot,
          logicalPath,
          sourceText: readFileSync(file, "utf8"),
        }),
      );
    }
  }

  for (const file of walk(path.join(repoRoot, "tests"), (candidate) => {
    const relativePath = toPosix(path.relative(repoRoot, candidate));
    if (relativePath.startsWith("tests/architecture/fixtures/")) return false;
    if (relativePath === "tests/architecture/architecture.test.mjs") return false;
    return /\.(?:[cm]?[jt]s|tsx)$/.test(candidate);
  })) {
    const logicalPath = path.relative(repoRoot, file);
    violations.push(
      ...auditSourceText({
        repoRoot,
        logicalPath,
        sourceText: readFileSync(file, "utf8"),
      }),
    );
  }

  const unique = new Map();
  for (const item of violations) {
    const key = `${item.rule}:${item.file}:${item.line ?? 0}:${item.message}`;
    unique.set(key, item);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.file}:${a.line ?? 0}:${a.rule}`.localeCompare(`${b.file}:${b.line ?? 0}:${b.rule}`),
  );
}

export function formatViolation(item) {
  const location = item.line ? `${item.file}:${item.line}` : item.file;
  return `[${item.rule}] ${location} ${item.message}`;
}

export const auditPackageGraph = checkPackageGraph;
export const auditGeneratedBindings = checkGeneratedBindings;
export const auditWorkspace = checkWorkspace;
