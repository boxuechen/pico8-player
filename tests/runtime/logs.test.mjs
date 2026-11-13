import assert from "node:assert/strict";
import test from "node:test";
import { createPico8Session } from "../../apps/web-player/dist/main/public.js";

test("printh logs are bounded, non-destructive, frame tagged and session-local", async t => {
  const a = await createPico8Session(), b = await createPico8Session();
  t.after(() => Promise.all([a.dispose(), b.dispose()]));
  await a.loadSource('printh("boot", "ignored.txt")\nfunction _update() printh("tick") end');
  await b.loadSource('printh("other")');
  assert.deepEqual(a.readLogs().entries.map(e => [e.text, e.frameId]), [["boot", null]]);
  await a.advance({frames: 3});
  const logs = a.readLogs(1);
  assert.deepEqual(logs.entries.map(e => e.frameId), [0, 1, 2]);
  assert.deepEqual(a.readLogs(1), logs);
  assert.equal(a.readLogs(logs.cursor).entries.length, 0);
  assert.equal(b.readLogs().entries[0].text, "other");
  await a.loadSource('for i=1,80 do printh(i) end');
  const overflow = a.readLogs();
  assert.equal(overflow.entries.length, 64);
  assert.equal(overflow.dropped, 16);
  assert.equal(overflow.entries[0].text, "17");
  assert.equal(a.readLogs(overflow.cursor).dropped, 0);
  await a.loadSource('local s="" for i=1,1500 do s..="a" end for i=1,20 do printh(s) end');
  const long = a.readLogs();
  assert.equal(long.entries.length, 8);
  assert.equal(long.dropped, 12);
  assert.ok(long.entries.every(e => e.text.length === 1024 && e.truncated));
  await a.loadSource('printh(chr(128))');
  assert.equal(a.readLogs().entries[0].text, "\\x80");
  await a.loadSource('function _draw() cls(0) end');
  assert.deepEqual(a.readLogs(), {cursor: 0, dropped: 0, entries: []});
});

test("logs survive frame and startup faults without masking diagnostics", async t => {
  const s = await createPico8Session(); t.after(() => s.dispose());
  await s.loadSource('function _update() printh("before fault") error("expected") end');
  const run = await s.advance({frames: 2});
  assert.equal(run.outcome, "faulted");
  assert.equal(s.readLogs().entries[0].text, "before fault");
  assert.match(run.observation.diagnostics.at(-1).message, /expected/);
  await s.loadSource('printh("boot fault") error("init expected")');
  assert.equal(s.readLogs().entries[0].text, "boot fault");
  await s.loadSource('function broken(');
  assert.equal(s.readLogs().entries.length, 0);
  assert.throws(() => s.readLogs(-1), /cursor/);
});
