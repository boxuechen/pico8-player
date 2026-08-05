import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifySourceInventory } from "./source-inventory.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const inventory = await verifySourceInventory(projectRoot);
process.stdout.write(`Verified vendored z8lua inventory ${inventory}\n`);
