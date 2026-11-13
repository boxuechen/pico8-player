import assert from "node:assert/strict";
import test from "node:test";
import { createPico8Session, createPico8SessionTool } from "../../apps/player/dist/main/public.js";
import { PlayerSession } from "../../apps/player/dist/runtime/player-session.js";
import createModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
const lua = `x=0
function _update60() if btn(1) then x+=1 end end
function _draw() cls(0) pset(x,0,8) end`;
const input = buttons => ({ controllers: [buttons,0,0,0,0,0,0,0], devkit: {
  mouseXRaw:0,mouseYRaw:0,mouseButtons:0,wheelRaw:0,movementXRaw:0,movementYRaw:0,keypresses:[],
} });
const cart = source => new TextEncoder().encode(`pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n${source}\n`);
const pixel = (o,x) => [...o.frame.rgba.slice(x*4,x*4+4)];

test("standalone source/input/frame loop runs without DOM or Worker and resets deterministically", async t => {
  const s=await createPico8Session(); t.after(()=>s.dispose());
  const loaded=await s.loadSource(lua);
  assert.equal(loaded.state,"ready"); assert.equal(loaded.frame,null);
  const run=await s.advance({frames:30,input:input(2)});
  assert.equal(run.completedFrames,30); assert.equal(run.outcome,"completed");
  assert.equal(run.observation.frame.frameId,29); assert.equal(run.observation.state,"paused");
  assert.deepEqual(pixel(run.observation,30),[255,0,77,255]);
  await s.reset();
  const again=await s.advance({frames:30,input:input(2)});
  assert.deepEqual(again.observation.frame.rgba,run.observation.frame.rgba);
  assert.ok(again.observation.generation>run.observation.generation);
  const released=await s.advance({frames:1});
  assert.deepEqual(pixel(released.observation,30),[255,0,77,255]);
});

test("observe is pure, copy-owned, revision tagged and sessions are independent",async t=>{
  const a=await createPico8Session(),b=await createPico8Session();t.after(()=>Promise.all([a.dispose(),b.dispose()]));
  await a.loadSource(lua);await b.loadSource(lua);
  await a.advance({frames:2,input:input(2)});await b.advance({frames:1});
  const observed=a.observe(),stable=a.observe();
  assert.deepEqual(observed,stable); observed.frame.rgba.fill(0); observed.frame.packedScreen.fill(0);
  assert.deepEqual(a.observe(),stable);assert.notEqual(a.observe().sessionId,b.observe().sessionId);
  assert.deepEqual(pixel(b.observe(),0),[255,0,77,255]);
  const revision=a.observe().revision;await a.loadSource('function _draw() cls(3) end');
  assert.equal(a.observe().revision,revision+1);assert.equal(a.observe().frame,null);
  const next=await a.advance({frames:1});assert.deepEqual(pixel(next.observation,0),[0,135,81,255]);
});

test("syntax and runtime faults are observable and a new revision recovers",async t=>{
  const s=await createPico8Session();t.after(()=>s.dispose());
  const bad=await s.loadSource('function broken(');
  assert.equal(bad.state,'faulted');assert.ok(bad.diagnostics.length);assert.equal(bad.frame,null);
  await s.loadSource('n=0\nfunction _update() n+=1 if n==3 then error("owned fault") end end\nfunction _draw() cls(8) end');
  const failed=await s.advance({frames:10});assert.equal(failed.outcome,'faulted');assert.equal(failed.completedFrames,2);
  assert.match(failed.observation.diagnostics.at(-1).message,/owned fault/);
  await s.loadSource(lua);assert.equal((await s.advance({frames:1})).outcome,'completed');
});

test("manual batches validate bounds and report guest stop rather than claiming requested frames",async t=>{
  const s=await createPico8Session();t.after(()=>s.dispose());await s.loadSource('n=0\nfunction _update() n+=1 if n==3 then stop("done") end end\nfunction _draw() cls(8) end');
  for(const frames of [0,-1,601,1.5,NaN])await assert.rejects(s.advance({frames}));
  await assert.rejects(s.advance({frames:1,input:input(64)}));
  assert.equal(s.observe().state,'ready');
  const result=await s.advance({frames:20});assert.equal(result.outcome,'stopped');assert.equal(result.completedFrames,2);
});

test("manual guest load replaces the generation and pauses before executing the target",async t=>{
  const s=await createPico8Session();t.after(()=>s.dispose());
  await s.loadSource('function _update() load("next.p8") end\nfunction _draw() cls(2) end', {localCartBundle:[{
    ref:'next.p8', bytes:cart('function _draw() cls(3) end'),access:{load:true,reloadData:false,cstoreData:false,include:false},
  }]});
  const old=s.observe().generation;
  const result=await s.advance({frames:10});assert.equal(result.outcome,'session-replaced');assert.equal(result.completedFrames,0);
  assert.ok(result.observation.generation>old);assert.equal(result.observation.state,'paused');assert.equal(result.observation.frame,null);
  const next=await s.advance({frames:1});assert.deepEqual(pixel(next.observation,0),[0,135,81,255]);
});

test("ephemeral cartdata survives reset within a session without becoming shared storage",async t=>{
  const a=await createPico8Session(),b=await createPico8Session();t.after(()=>Promise.all([a.dispose(),b.dispose()]));
  const source='function _init() cartdata("phase17") dset(0,dget(0)+1) end\nfunction _draw() cls(dget(0)) end';
  await a.loadSource(source);await a.advance({frames:1});const first=a.observe();
  await a.reset();await a.advance({frames:1});assert.notDeepEqual(a.observe().frame.rgba,first.frame.rgba);
  await b.loadSource(source);await b.advance({frames:1});assert.deepEqual(b.observe().frame.rgba,first.frame.rgba);
});

test("dispose interrupts a bounded batch between slices, rejects queued work and is terminal",async()=>{
  const s=await createPico8Session();await s.loadSource(lua);
  const run=s.advance({frames:600});
  const queued=assert.rejects(s.reset(),/disposed/);
  await new Promise(resolve=>setTimeout(resolve,0));
  const end=s.dispose();assert.equal(s.dispose(),end);
  const result=await run;await Promise.all([queued,end]);
  assert.equal(result.outcome,'interrupted');assert.ok(result.completedFrames>0&&result.completedFrames<600);
  assert.equal(s.observe().state,'disposed');assert.equal(s.observe().frame,null);
  await assert.rejects(s.loadSource(lua),/disposed/);
});

test("direct session retains asynchronous root host completion without wire envelopes",async()=>{
  const module=await createModule();let finish;
  const session=new PlayerSession(module,{hostRequestHandler:{handle:async request=>{
    await new Promise(resolve=>{finish=resolve;});return {generation:request.generation,requestId:request.requestId,bytes:new Uint8Array(),isError:false};
  }}});
  const events=[];session.onEvent(e=>events.push(e));
  const loading=session.loadCart(cart('function _init() __p8w_probe_host_request("boot") end\nfunction _draw() cls(8) end'));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(events.at(-1).state,'waiting-host');finish();
  const loaded=await loading;assert.equal(loaded.state,'ready');
  assert.ok(events.every(e=>!('requestId' in e)&&!('workerGeneration' in e)&&!('v' in e)));
  await session.dispose();
});

test("JSON tool surface performs a source/action/observation loop with serializable image data",async t=>{
  const s=await createPico8Session();t.after(()=>s.dispose());const tool=createPico8SessionTool(s);
  assert.equal(tool.name,'pico8_session');
  await tool.execute({action:'load_source',source:lua});
  const result=await tool.execute({action:'advance',frames:2,buttons:2});
  const parsed=JSON.parse(JSON.stringify(result));assert.equal(parsed.completedFrames,2);
  assert.equal(parsed.observation.frame.encoding,'rgba8-base64');assert.equal(atob(parsed.observation.frame.data).length,128*128*4);
  assert.equal((await tool.execute({action:'observe',image:false})).observation.frame.data,undefined);
  await assert.rejects(tool.execute({action:'advance',frames:1,buttons:64}));
  await assert.rejects(tool.execute({action:'observe',unknown:1}));
});

test("manual custom flip loop and 30 Hz callback use logical frames rather than wall-clock",async t=>{
  const s=await createPico8Session();t.after(()=>s.dispose());
  await s.loadSource('n=0\nwhile true do cls(n%16) n+=1 flip() end');
  const custom=await s.advance({frames:3});assert.equal(custom.completedFrames,3);assert.equal(custom.outcome,'completed');
  await s.loadSource('function _update() end\nfunction _draw() cls(flr(t())) end');
  const callback=await s.advance({frames:31});assert.equal(callback.completedFrames,31);assert.equal(callback.observation.frame.targetFps,30);
  assert.deepEqual(pixel(callback.observation,0),[29,43,83,255]);
});

test("replacement cancels a suspended direct operation and discards its late completion",async()=>{
  let finish;
  const s=new PlayerSession(await createModule(),{hostRequestHandler:{handle:request=>new Promise(resolve=>{
    finish=()=>resolve({generation:request.generation,requestId:request.requestId,bytes:new Uint8Array(),isError:false});
  })}});
  try {
    const old=s.loadCart(cart('function _init() __p8w_probe_host_request("old") end\nfunction _draw() cls(2) end'));
    const cancelled=assert.rejects(old,/superseded/);
    await new Promise(resolve=>setTimeout(resolve,0));
    const loaded=await s.loadCart(cart('function _draw() cls(3) end'));
    assert.equal(loaded.state,'ready');await cancelled;finish();
    await s.start();const frames=[];s.onEvent(event=>{if(event.type==='frame')frames.push(event);});
    await s.step(input(0));assert.equal(frames.length,1);assert.equal(new Uint8Array(frames[0].packedScreen)[0],0x33);
  } finally {await s.dispose();}
});

test("main-thread composition preserves command deadline admission validation before allocating resources",async()=>{
  const {PlayerComposition}=await import('../../apps/player/dist/main/compose-player.js');
  for(const commandTimeoutMs of [0,-1,NaN,Infinity]) {
    await assert.rejects(PlayerComposition.create({canvas:{},useDefaultAssets:true,commandTimeoutMs}),/commandTimeoutMs must be positive/);
  }
});


test("a suspended direct call cannot consume a concurrent flush result", { timeout: 2000 }, async () => {
  let finish;
  const session = new PlayerSession(await createModule(), { hostRequestHandler: {
    handle: request => new Promise(resolve => {
      finish = () => resolve({ generation: request.generation, requestId: request.requestId,
        bytes: new Uint8Array(), isError: false });
    }),
  } });
  try {
    let loaded = false;
    const loading = session.loadCart(cart('function _init() __p8w_probe_host_request("pending") end'))
      .then(result => { loaded = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 0));
    const flushed = await session.flushPersistence();
    assert.equal(flushed.type, "persistence-flushed");
    assert.equal(loaded, false);
    assert.equal("requestId" in flushed, false);
    finish();
    assert.equal((await loading).state, "ready");
  } finally { await session.dispose(); }
});

test("dispose cancels a suspended direct call and ignores its late host result", { timeout: 2000 }, async () => {
  let finish;
  const module = await createModule();
  const session = new PlayerSession(module, { hostRequestHandler: {
    handle: request => new Promise(resolve => {
      finish = () => resolve({ generation: request.generation, requestId: request.requestId,
        bytes: new Uint8Array(), isError: false });
    }),
  } });
  const events = [];
  session.onEvent(event => events.push(event));
  const loading = session.loadCart(cart('function _init() __p8w_probe_host_request("pending") end'));
  const rejected = assert.rejects(loading, /disposed/);
  await new Promise(resolve => setTimeout(resolve, 0));
  await session.dispose(); await rejected;
  const count = events.length;
  finish(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(events.length, count);
  assert.equal(module._p8w_live_contexts(), 0);
});
