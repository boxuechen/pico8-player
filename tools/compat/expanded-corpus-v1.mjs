import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export const EXPANDED_CORPUS_RUNNER = "phase-8-expanded-corpus-v1";
export const MAXIMUM_BATCH_CASES = 64;
export const MINIMUM_BATCH_CASES = 12;
export const MAXIMUM_CART_BYTES = 1024 * 1024;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CART_PATTERN = /\.p8(?:\.png)?$/iu;
const PNG_PATTERN = /\.p8\.png$/iu;
const INCLUDE_PATTERN = /^\s*#include[\t ]+(.+?)[\t ]*$/u;

export class ExpandedCorpusError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ExpandedCorpusError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExpandedCorpusError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function portable(path) {
  return path.split(sep).join("/");
}

function cartFormat(path) {
  return PNG_PATTERN.test(path) ? "p8.png" : "p8";
}

function cartStem(path) {
  return basename(path).replace(CART_PATTERN, "").toLowerCase();
}

function safeIdPart(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.length > 0 ? normalized : "cart";
}

function stableId(prefix, project, stem, suffix = "") {
  const raw = `${prefix}/${safeIdPart(project)}/${safeIdPart(stem)}${suffix}`;
  if (raw.length <= 128) return raw;
  const hash = sha256(Buffer.from(raw)).slice(0, 12);
  return `${raw.slice(0, 115)}-${hash}`;
}

function candidateRank(candidate) {
  const segments = portable(candidate.relativePath).split("/");
  if (candidate.format === "p8.png" && segments.includes("export")) return 0;
  if (candidate.format === "p8.png") return 1;
  return 2;
}

function chooseCandidate(candidates, format) {
  return candidates
    .filter((candidate) => candidate.format === format)
    .sort((left, right) => candidateRank(left) - candidateRank(right)
      || left.relativePath.localeCompare(right.relativePath))[0];
}

async function discoverTextIncludes(cartPath, bytes, externalRoot) {
  const includes = [];
  const seen = new Set();
  let section;
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    const marker = /^__([a-z0-9_.:-]+)__$/iu.exec(line);
    if (marker !== null) {
      section = marker[1].toLowerCase();
      continue;
    }
    if (section !== "lua") continue;
    const match = INCLUDE_PATTERN.exec(line);
    if (match === null) continue;
    const ref = match[1];
    if (ref.includes("://") || ref.includes("\\") || ref.startsWith("/")
      || ref.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
      fail("E_INCLUDE_REF", "include ref must be a canonical relative opaque name");
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    const unresolved = resolve(dirname(cartPath), ref);
    const metadata = await lstat(unresolved).catch((error) =>
      fail("E_INCLUDE_READ", `include could not be inspected: ${error.code ?? error.message}`));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("E_INCLUDE_PATH", "include must be a regular non-symlink file");
    }
    const path = await realpath(unresolved);
    if (!isInside(externalRoot, path)) fail("E_INCLUDE_PATH", "include must remain inside source");
    const includeBytes = await readFile(path);
    if (includeBytes.length < 1 || includeBytes.length > MAXIMUM_CART_BYTES) {
      fail("E_INCLUDE_SIZE", `include must contain 1..${MAXIMUM_CART_BYTES} bytes`);
    }
    includes.push({ ref, path, bytes: includeBytes.length, sha256: sha256(includeBytes) });
  }
  return includes;
}

async function assertExternalExistingDirectory(path, label, projectRoot = repositoryRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", `${label} must be a local path`);
  const unresolved = resolve(path);
  const metadata = await lstat(unresolved).catch((error) =>
    fail("E_INPUT_READ", `${label} could not be inspected: ${error.code ?? error.message}`));
  if (metadata.isSymbolicLink()) fail("E_PATH_SYMLINK", `${label} must not be a symbolic link`);
  if (!metadata.isDirectory()) fail("E_PATH_TYPE", `${label} must be a directory`);
  const actual = await realpath(unresolved);
  if (isInside(resolve(projectRoot), actual)) {
    fail("E_PATH_REPOSITORY", `${label} must be outside the project repository`);
  }
  return actual;
}

async function prepareExternalOutput(path, sourceRoot, projectRoot = repositoryRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", "output must be a local path");
  const unresolved = resolve(path);
  const parent = await realpath(dirname(unresolved)).catch((error) =>
    fail("E_OUTPUT_PARENT", `output parent could not be resolved: ${error.code ?? error.message}`));
  if (isInside(resolve(projectRoot), parent)) {
    fail("E_PATH_REPOSITORY", "output must be outside the project repository");
  }
  await mkdir(unresolved, { recursive: false }).catch((error) =>
    fail("E_OUTPUT_CREATE", `output must be a new directory: ${error.code ?? error.message}`));
  const actual = await realpath(unresolved);
  if (isInside(sourceRoot, actual) || isInside(actual, sourceRoot)) {
    fail("E_PATH_OVERLAP", "source and output directories must not overlap");
  }
  return actual;
}

async function walkCartFiles(directory, root, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail("E_PATH_SYMLINK", `corpus contains symlink ${portable(relative(root, path))}`);
    if (entry.isDirectory()) {
      await walkCartFiles(path, root, files);
      continue;
    }
    if (entry.isFile() && CART_PATTERN.test(entry.name)) files.push(path);
  }
}

function balancedBatches(items, maximumCases, itemCaseCount = 1) {
  const maximumItems = Math.floor(maximumCases / itemCaseCount);
  const batchCount = Math.ceil(items.length / maximumItems);
  const base = Math.floor(items.length / batchCount);
  const remainder = items.length % batchCount;
  const batches = [];
  let offset = 0;
  for (let index = 0; index < batchCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    const batch = items.slice(offset, offset + size);
    offset += size;
    if (batch.length * itemCaseCount < MINIMUM_BATCH_CASES) {
      fail("E_BATCH_SIZE", "balanced batch would fall below the v1 runner minimum");
    }
    batches.push(batch);
  }
  return batches;
}

function manifestEntry(candidate, id, label, source) {
  return {
    id,
    label,
    file: candidate.path,
    sha256: candidate.sha256,
    pico8Version: "0.2.7",
    source: {
      label: source.label,
      revision: source.revision,
      permissionStatus: "caller-authorized-local-research",
      permissionBasis: "User explicitly authorized local research; redistribution and publication are not authorized.",
      url: source.repository,
    },
    trace: {
      mode: "fixed-ticks",
      ticks: 120,
      stepMilliseconds: 1000 / 30,
      inputs: [],
    },
    ...(candidate.includes.length === 0 ? {} : {
      bundle: candidate.includes.map((include) => ({
        ref: include.ref,
        file: include.path,
        sha256: include.sha256,
        access: {
          load: false,
          reloadData: false,
          cstoreData: false,
          include: true,
        },
      })),
    }),
  };
}

async function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path, bytes, { flag: "wx" });
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

async function writeManifestBatches({ outputRoot, prefix, corpusId, batches, entriesFor }) {
  const outputs = [];
  for (const [index, batch] of batches.entries()) {
    const manifest = {
      $schema: "https://pico8-web-player.invalid/spec/compat/local-corpus-v1.schema.json",
      schemaVersion: 1,
      corpusId: `${corpusId}-batch-${String(index + 1).padStart(2, "0")}`,
      policy: "developer-supplied-local-only",
      entries: batch.flatMap(entriesFor),
    };
    const name = `${prefix}-batch-${String(index + 1).padStart(2, "0")}.json`;
    const written = await writeJson(join(outputRoot, name), manifest);
    outputs.push({ file: name, cases: manifest.entries.length, sha256: written.sha256 });
  }
  return outputs;
}

export async function discoverExpandedCorpus({ sourceRoot, projectRoot = repositoryRoot }) {
  const externalRoot = await assertExternalExistingDirectory(sourceRoot, "source", projectRoot);
  const cartsRoot = join(externalRoot, "carts");
  const cartsMetadata = await stat(cartsRoot).catch((error) =>
    fail("E_CARTS_ROOT", `source/carts could not be read: ${error.code ?? error.message}`));
  if (!cartsMetadata.isDirectory()) fail("E_CARTS_ROOT", "source/carts must be a directory");
  const paths = [];
  await walkCartFiles(cartsRoot, externalRoot, paths);
  const candidates = [];
  for (const path of paths) {
    const relativePath = portable(relative(cartsRoot, path));
    const [project] = relativePath.split("/");
    if (!project || project === basename(relativePath)) {
      fail("E_PROJECT", `${relativePath} must be inside a top-level project directory`);
    }
    const bytes = await readFile(path);
    if (bytes.length < 1 || bytes.length > MAXIMUM_CART_BYTES) {
      fail("E_CART_SIZE", `${relativePath} must contain 1..${MAXIMUM_CART_BYTES} bytes`);
    }
    const format = cartFormat(path);
    candidates.push({
      path,
      relativePath,
      project,
      stem: cartStem(path),
      format,
      bytes: bytes.length,
      sha256: sha256(bytes),
      includes: format === "p8" ? await discoverTextIncludes(path, bytes, externalRoot) : [],
    });
  }
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.project}/${candidate.stem}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const identities = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, members]) => {
      const text = chooseCandidate(members, "p8");
      const png = chooseCandidate(members, "p8.png");
      const canonical = png ?? text;
      return {
        key,
        project: canonical.project,
        stem: canonical.stem,
        canonical,
        text,
        png,
      };
    });
  const canonical = [];
  const duplicateCanonical = [];
  const seenHashes = new Map();
  for (const identity of identities) {
    const kept = seenHashes.get(identity.canonical.sha256);
    if (kept !== undefined) {
      duplicateCanonical.push({ kept: kept.key, dropped: identity.key, sha256: identity.canonical.sha256 });
      continue;
    }
    seenHashes.set(identity.canonical.sha256, identity);
    canonical.push(identity);
  }
  const pairs = identities.filter(({ text, png }) => text !== undefined && png !== undefined);
  const corpusFingerprint = sha256(Buffer.from(JSON.stringify({
    candidates: candidates.map(({ relativePath, bytes, sha256: hash }) => ({
      relativePath,
      bytes,
      sha256: hash,
    })),
    canonical: canonical.map(({ key, canonical: selected }) => ({
      key,
      relativePath: selected.relativePath,
      sha256: selected.sha256,
    })),
    pairs: pairs.map(({ key, text, png }) => ({
      key,
      p8Sha256: text.sha256,
      p8PngSha256: png.sha256,
    })),
  })));
  return {
    sourceRoot: externalRoot,
    candidates,
    identities,
    canonical,
    pairs,
    duplicateCanonical,
    corpusFingerprint,
    inventory: {
      topLevelProjects: new Set(candidates.map(({ project }) => project)).size,
      cartFiles: candidates.length,
      p8Files: candidates.filter(({ format }) => format === "p8").length,
      p8PngFiles: candidates.filter(({ format }) => format === "p8.png").length,
      byteUniqueFiles: new Set(candidates.map(({ sha256: hash }) => hash)).size,
      logicalIdentities: identities.length,
      canonicalLogicalCarts: canonical.length,
      formatPairs: pairs.length,
    },
  };
}

function assertExpectedInventory(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) fail("E_INVENTORY", `${key} expected ${value}, received ${actual[key]}`);
  }
}

export async function prepareExpandedCorpus({
  sourceRoot,
  outputRoot,
  source,
  expectedInventory,
  projectRoot = repositoryRoot,
}) {
  if (!source || typeof source.repository !== "string" || typeof source.revision !== "string"
    || typeof source.label !== "string") {
    fail("E_SOURCE", "source repository, revision and label are required");
  }
  const discovery = await discoverExpandedCorpus({ sourceRoot, projectRoot });
  assertExpectedInventory(discovery.inventory, expectedInventory);
  const externalOutput = await prepareExternalOutput(outputRoot, discovery.sourceRoot, projectRoot);
  const canonicalBatches = balancedBatches(discovery.canonical, MAXIMUM_BATCH_CASES);
  const pairBatches = balancedBatches(discovery.pairs, MAXIMUM_BATCH_CASES, 2);
  const canonicalOutputs = await writeManifestBatches({
    outputRoot: externalOutput,
    prefix: "canonical",
    corpusId: "phase-8-expanded-canonical-v1",
    batches: canonicalBatches,
    entriesFor: (identity) => [manifestEntry(
      identity.canonical,
      stableId("phase8", identity.project, identity.stem),
      identity.key,
      source,
    )],
  });
  const pairOutputs = await writeManifestBatches({
    outputRoot: externalOutput,
    prefix: "format-pairs",
    corpusId: "phase-8-expanded-format-pairs-v1",
    batches: pairBatches,
    entriesFor: (identity) => [
      manifestEntry(identity.text, stableId("phase8-pair", identity.project, identity.stem, "/p8"),
        `${identity.key} [p8]`, source),
      manifestEntry(identity.png, stableId("phase8-pair", identity.project, identity.stem, "/p8.png"),
        `${identity.key} [p8.png]`, source),
    ],
  });
  const index = {
    $schema: "https://pico8-web-player.invalid/spec/compat/expanded-local-corpus-v1.schema.json",
    schemaVersion: 1,
    runner: EXPANDED_CORPUS_RUNNER,
    targetRuntime: "PICO-8 v0.2.7",
    corpusFingerprint: discovery.corpusFingerprint,
    source: {
      repository: source.repository,
      revision: source.revision,
      label: source.label,
      root: discovery.sourceRoot,
      permissionStatus: "caller-authorized-local-research",
      redistributionAuthorized: false,
    },
    inventory: discovery.inventory,
    canonical: {
      cases: discovery.canonical.map((identity) => ({
        id: stableId("phase8", identity.project, identity.stem),
        identity: identity.key,
        format: identity.canonical.format,
        file: identity.canonical.path,
        sha256: identity.canonical.sha256,
      })),
      duplicateCanonical: discovery.duplicateCanonical,
      batches: canonicalOutputs,
    },
    formatPairs: {
      pairs: discovery.pairs.map((identity) => ({
        identity: identity.key,
        p8Id: stableId("phase8-pair", identity.project, identity.stem, "/p8"),
        p8PngId: stableId("phase8-pair", identity.project, identity.stem, "/p8.png"),
        p8Sha256: identity.text.sha256,
        p8PngSha256: identity.png.sha256,
      })),
      batches: pairOutputs,
    },
  };
  const indexOutput = await writeJson(join(externalOutput, "expanded-corpus-index.json"), index);
  return { outputRoot: externalOutput, index, indexSha256: indexOutput.sha256 };
}

export function checkoutRevision(sourceRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail("E_SOURCE_REVISION", `source revision could not be read: ${error.stderr?.toString().trim() || error.message}`);
  }
}
