import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = "apps/web-player/dist/release";

test("Phase 13D artifact declares API v2 host ports without publication authority", async () => {
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));
  assert.deepEqual({
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    channel: manifest.channel,
  }, {
    schemaVersion: 3,
    version: "0.2.0-alpha.1",
    apiVersion: 2,
    channel: "mobile-integration",
  });
  assert.deepEqual({
    hostedShell: manifest.capabilities.hostedShell,
    externalInput: manifest.capabilities.externalInput,
    hostPersistence: manifest.capabilities.hostPersistence,
    awaitablePersistenceFlush: manifest.capabilities.awaitablePersistenceFlush,
    publicationPerformed: manifest.capabilities.publicationPerformed,
  }, {
    hostedShell: true,
    externalInput: true,
    hostPersistence: true,
    awaitablePersistenceFlush: true,
    publicationPerformed: false,
  });
});

test("Phase 13D public module contains no native dependency or cart acquisition authority", async () => {
  const source = await readFile(`${root}/main/player.mjs`, "utf8");
  assert.doesNotMatch(source, /@capacitor|Filesystem|\bfetch\s*\(/u);
  assert.match(source, /PICO8_WEB_PLAYER_API_VERSION = 2/u);
  assert.match(source, /contentId is required with a host persistence adapter/u);
  assert.match(source, /flushPersistence/u);
});
