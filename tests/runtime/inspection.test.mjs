import assert from "node:assert/strict";
import test from "node:test";
import {
  createPico8Session,
  prepareInspection,
} from "../../apps/web-player/dist/main/public.js";
const fixture = `g={n=0, board={[1]=false,[7]=1.5}, text=chr(128)}
setmetatable(g,{__index=function() error("metamethod ran") end})
g.self=g g.saved=dset
function _update() g.n+=1 g.r=rnd() g.time=time() end
function _draw() cls(g.n) end`;
const read = (s, ...paths) => s.inspect({ mode: "read", paths });
async function setup(t, source = fixture, inspection = true) {
  const s = await createPico8Session({ inspection });
  t.after(() => s.dispose());
  await s.loadSource(source);
  await s.advance({ frames: 1 });
  return s;
}
test("raw inspection is opt-in, bounded and does not run metamethods or advance simulation", async (t) => {
  const s = await setup(t),
    control = await setup(t),
    disabled = await setup(t, fixture, false);
  await assert.rejects(() => read(disabled, ["g"]), /disabled/);
  const before = s.observe();
  const result = await read(
    s,
    ["g", "n"],
    ["g", "missing"],
    ["g", "board", 1],
    ["g", "board", 7],
    ["g", "text"],
    ["_draw"],
    ["g"],
  );
  assert.deepEqual(result.values.slice(0, 6), [
    1,
    { type: "nil" },
    false,
    1.5,
    "\x80",
    { type: "function" },
  ]);
  assert.deepEqual(
    result.values[6].entries.find((e) => e.key === "self").value,
    { type: "cycle" },
  );
  assert.deepEqual(s.observe(), before);
  const a = await s.advance({ frames: 3 }),
    b = await control.advance({ frames: 3 });
  assert.deepEqual(a.observation.frame, b.observation.frame);
  assert.deepEqual(
    (await read(s, ["g", "r"], ["g", "time"])).values,
    (await read(control, ["g", "r"], ["g", "time"])).values,
  );
  for (const request of [
    { mode: "read", paths: [] },
    { mode: "read", paths: [[1]] },
    { mode: "debug", code: "a".repeat(4097) },
    { mode: "read", paths: [["g", 0.5]] },
  ])
    assert.throws(() => prepareInspection(request));
});
test("debug changes live globals but leaves the completed frame unchanged, including custom roots", async (t) => {
  for (const source of [
    fixture,
    "g={n=0} while true do g.n+=1 cls(g.n) flip() end",
  ]) {
    const s = await setup(t, source),
      before = s.observe();
    assert.deepEqual(
      await s.inspect({
        mode: "debug",
        code: 'g.n=9; printh("debug"); return g.n',
      }),
      { ok: true, executed: true, values: [9] },
    );
    assert.equal((await read(s, ["g", "n"])).values[0], 9);
    assert.deepEqual(s.observe().frame, before.frame);
    assert.equal(s.readLogs().entries.at(-1).text, "debug");
    assert.equal((await s.advance({ frames: 1 })).outcome, "completed");
    assert.equal((await read(s, ["g", "n"])).values[0], 10);
  }
});
test("failed debug is bounded; reads remain available but execution requires reset; syntax failure can recover", async (t) => {
  const s = await setup(t);
  let result = await s.inspect({ mode: "debug", code: "if" });
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal((await read(s, ["g", "n"])).values[0], 1);
  for (const code of [
    'g.n=99; error("expected")',
    "while true do end",
    'pcall(function() local x=string.rep("a",32000) for i=1,100 do g[i]=x..i end end)',
    "local c=cocreate(function() while true do end end) coresume(c)",
    "pcall(function() flip() end)",
    "pcall(function() yield() end)",
    "local f=dset; pcall(function() f(0,1) end)",
    'cartdata("x")',
    "g.saved(0,1)",
    "__p8w_probe_host_request()",
    "run()",
    "stop()",
    'load("x")',
    "reload()",
    "cstore()",
    'extcmd("reset")',
    "reset()",
  ]) {
    await s.loadSource(fixture);
    await s.advance({ frames: 1 });
    result = await s.inspect({ mode: "debug", code });
    assert.equal(result.ok, false, code);
    if (code.includes("32000")) assert.match(result.error, /memory/);
    assert.equal(result.executed, true, code);
    // Raw reads run no Lua, so they can inspect partial writes after failure.
    assert.equal((await read(s, ["g", "n"])).ok, true, code);
    await assert.rejects(
      () => s.inspect({ mode: "debug", code: "return 1" }),
      /boundary|reset|state/i,
      code,
    );
    assert.equal((await s.advance({ frames: 1 })).outcome, "faulted", code);
  }
  await s.loadSource(fixture);
  await s.advance({ frames: 1 });
  await s.inspect({ mode: "debug", code: 'g.n=99; error("expected")' });
  assert.equal((await read(s, ["g", "n"])).values[0], 99, "partial write is readable");
  await s.loadSource(fixture);
  await s.advance({ frames: 1 });
  assert.equal((await read(s, ["g", "n"])).values[0], 1);
});
test("raw values truncate cycles, depth, entries and byte size with valid JSON", async (t) => {
  const s = await setup(
    t,
    `g={} for i=1,600 do g[i]=i end
 deep={a={a={a={a={n=1}}}}}
 text="" for i=1,18000 do text..="a" end
 function _draw() cls() end`,
  );
  const entries = (await read(s, ["g"])).values[0];
  assert.equal(entries.entries.length, 512);
  assert.equal(entries.truncated, "entries");
  let deep = (await read(s, ["deep"])).values[0];
  for (let i = 0; i < 4; i++) deep = deep.entries[0].value;
  assert.deepEqual(deep, { type: "truncated", reason: "depth" });
  assert.equal((await read(s, ["text"])).truncated, "bytes");
});
test("inspection sessions report guest sfx/music starts with the voice used", async (t) => {
  const source = `function _init()
 for id=0,1 do local b=0x3200+id*68 poke(b,24,10) poke(b+65,32) end
 poke(0x3100,0,0x41,0x42,0x43) music(0)
end
n=0
function _update() n+=1
 if n==2 then sfx(1,3) end
 if n==4 then sfx(1,0) end
 if n==6 then music(-1) end
end
function _draw() cls() end`;
  const s = await setup(t, source),
    plain = await setup(t, source, false);
  assert.equal((await plain.advance({ frames: 2 })).audio, undefined);
  // The one-frame setup advance already drained the boot music() call.
  const r = await s.advance({ frames: 6 });
  assert.equal(r.audio.dropped, 0);
  assert.deepEqual(
    r.audio.events.map(({ frameId, ...e }) => e),
    [
      { sfx: 1, channel: 3, overMusic: false },
      { sfx: 1, channel: 0, overMusic: true },
      { music: -1 },
    ],
  );
  const ids = r.audio.events.map((e) => e.frameId);
  assert.ok(ids[0] < ids[1] && ids[1] < ids[2], "events carry their frame");
  const boot = await createPico8Session({ inspection: true });
  t.after(() => boot.dispose());
  await boot.loadSource(source);
  const first = await boot.advance({ frames: 1 });
  assert.deepEqual(first.audio.events.map(({ frameId, ...e }) => e), [{ music: 0 }]);
  // Bounded: a flood reports dropped events instead of growing results.
  const flood = await setup(t, "function _update() for i=1,40 do sfx(0) end end function _draw() end");
  const f = await flood.advance({ frames: 2 });
  assert.equal(f.audio.events.length, 32);
  assert.ok(f.audio.dropped > 0);
});
