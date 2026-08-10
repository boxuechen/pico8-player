import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 8F is the only active unit after aggregate-only pair qualification", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  assert.deepEqual(contract.completedWorkUnits, ["8A", "8B", "8C", "8D", "8E"]);
  assert.equal(contract.activeWorkUnit, "8F");
  assert.equal(contract.nextWorkUnit, "8F");
  assert.equal(contract.workUnits["8E"].status, "complete");
  assert.equal(contract.workUnits["8F"].status, "active");
  assert.equal(
    Object.values(contract.workUnits).filter(({ status }) => status === "active").length,
    1,
  );
});

test("Phase 8F locks C2, risk, review and external-data boundaries", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  const unit = contract.workUnits["8F"];
  assert.ok(unit.exit.some((entry) => entry.includes("at least 10")));
  assert.ok(unit.exit.some((entry) => entry.includes("graphics, audio, input, persistence")));
  assert.ok(unit.exit.some((entry) => entry.includes("main verbs")));
  assert.ok(unit.exit.some((entry) => entry.includes("Canvas screenshots")));
  assert.ok(unit.exit.some((entry) => entry.includes("open P0/P1 are zero")));
  assert.ok(unit.allowedPaths.includes("tools/compat/"));
  assert.ok(unit.allowedPaths.includes("tests/compat/"));
  assert.ok(unit.allowedPaths.includes("docs/phases/8-expanded-real-cart-qualification.md"));
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("ref/")), false);
  assert.equal(contract.corpusPolicy.networkAccess, false);
  assert.equal(contract.classification.thirdPartyPerCartResultsTracked, false);
});

test("Phase 8F routing is documented and continuously verified", async () => {
  const [packageJson, docsReadme, phase] = await Promise.all([
    readJson("package.json"),
    readFile(new URL("docs/README.md", root), "utf8"),
    readFile(new URL("docs/phases/8-expanded-real-cart-qualification.md", root), "utf8"),
  ]);
  assert.match(docsReadme, /Active work unit \| 8F/u);
  assert.match(phase, /Active work unit：8F/u);
  assert.match(phase, /至少 10 个分层 case/u);
  assert.match(phase, /smoke\/CU 不能自动\s*升级为 C2/u);
  assert.equal(packageJson.scripts["test:phase-8f"],
    "node --test tests/contract/phase-8f-activation.test.mjs");
  assert.match(packageJson.scripts["test:phase-8e"], /phase-8f-activation\.test\.mjs/u);
  assert.match(packageJson.scripts.test, /test:phase-8e/u);
  assert.match(packageJson.scripts.verify, /test:phase-8e/u);
});
