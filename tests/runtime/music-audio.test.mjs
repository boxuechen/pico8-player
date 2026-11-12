import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import {
  createPicoApiHost,
  FrameSliceRuntime,
  PicoSfxSynth,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { createPlayerWorkerController } from "../../apps/web-player/dist/worker/compose-runtime.js";
import { PcmOutput } from "../../apps/web-player/dist/runtime/audio-transport.js";

const encoder = new TextEncoder();
const SFX_BASE = 0x3200;
const SFX_BYTES = 68;
const MUSIC_BASE = 0x3100;
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function q16(value) {
  return Math.trunc(value * 65_536) | 0;
}

function sourceCart(source, rom = new Uint8Array(0x8000)) {
  return { rom, code: encoder.encode(source) };
}

function textCart(lua) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${lua}\n`,
  );
}

function createVm() {
  return new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
}

function writeNote(
  ram,
  sfx,
  note,
  { key = 24, waveform = 0, volume = 7, effect = 0, custom = false } = {},
) {
  const address = SFX_BASE + sfx * SFX_BYTES + note * 2;
  ram[address] = (key & 0x3f) | ((waveform & 3) << 6);
  ram[address + 1] = ((waveform >>> 2) & 1) |
    ((volume & 7) << 1) |
    ((effect & 7) << 4) |
    (custom ? 0x80 : 0);
}

function writeSfx(
  ram,
  sfx,
  { speed = 1, filters = 0, loopStart = 0, loopEnd = 0, notes = 4 } = {},
) {
  for (let note = 0; note < notes; note += 1) {
    writeNote(ram, sfx, note, {
      key: 20 + sfx + note,
      waveform: (sfx + note) & 7,
      volume: 7 - (note & 1),
      effect: note & 7,
    });
  }
  const metadata = SFX_BASE + sfx * SFX_BYTES + 64;
  ram[metadata] = filters;
  ram[metadata + 1] = speed;
  ram[metadata + 2] = loopStart;
  ram[metadata + 3] = loopEnd;
}

function writeSong(
  ram,
  pattern,
  channels,
  { start = false, loop = false, stop = false, mode = false } = {},
) {
  const address = MUSIC_BASE + pattern * 4;
  ram[address] = channels[0] | (start ? 0x80 : 0);
  ram[address + 1] = channels[1] | (loop ? 0x80 : 0);
  ram[address + 2] = channels[2] | (stop ? 0x80 : 0);
  ram[address + 3] = channels[3] | (mode ? 0x80 : 0);
}

function proxyHost(base, calls) {
  return new Proxy(base, {
    get(target, property) {
      if (property === "music") {
        return (patternRaw, fadeLengthRaw, channelMaskRaw) => {
          calls.push([patternRaw, fadeLengthRaw, channelMaskRaw]);
          target.music(patternRaw, fadeLengthRaw, channelMaskRaw);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildGoldenTrace() {
  const ram = new Uint8Array(0x10000);
  for (let sfx = 0; sfx < 6; sfx += 1) {
    writeSfx(ram, sfx, {
      speed: 2 + sfx,
      filters: [0, 8, 24, 72, 16, 48][sfx],
      loopStart: sfx === 3 ? 1 : 4,
      loopEnd: sfx === 3 ? 3 : 0,
      notes: 8,
    });
  }
  writeSong(ram, 0, [0, 1, 0x40, 0x40], { start: true });
  writeSong(ram, 1, [2, 3, 4, 5], { loop: true });
  const synth = new PicoSfxSynth(ram);
  synth.music(q16(0), q16(250), q16(3));
  const chunks = [synth.renderSlices(4, 30)];
  synth.sfx(q16(5));
  chunks.push(synth.renderSlices(3, 30));
  synth.playP8sciiAudio(encoder.encode("s4x5c1egc2"));
  chunks.push(synth.renderSlices(2, 30));
  synth.music(q16(-1), q16(200));
  chunks.push(synth.renderSlices(7, 30));
  return {
    slices: chunks.map(({ firstSample, frameCount }) => ({ firstSample, frameCount })),
    pcmSha256: hashBytes(Buffer.concat(chunks.map(({ pcm16le }) => Buffer.from(pcm16le)))),
    finalMusic: synth.snapshotMusic(),
    finalChannels: synth.snapshotChannels(),
  };
}

function command(type, overrides = {}) {
  return {
    v: 1,
    type,
    requestId: 1,
    workerGeneration: 1,
    sessionGeneration: 1,
    ...overrides,
  };
}

function recordingPort(name, records) {
  return {
    name,
    closed: 0,
    started: 0,
    postMessage(message, transfer = []) {
      records.push({ name, message, transfer });
    },
    start() { this.started += 1; },
    close() { this.closed += 1; },
  };
}

test("appends music binding 32 and preserves raw optional Q16 arguments through real WASM", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.bindings.find(({ id }) => id === 32), {
    id: 32,
    guestName: "music",
    hostMethod: "music",
    parameters: [
      { name: "patternRaw", type: "q16.16-raw-i32" },
      { name: "fadeLengthRaw", type: "q16.16-raw-i32", optional: true },
      { name: "channelMaskRaw", type: "q16.16-raw-i32", optional: true },
    ],
    result: "void",
  });

  const rom = new Uint8Array(0x8000);
  writeSfx(rom, 0, { speed: 8, loopStart: 0, loopEnd: 2 });
  writeSong(rom, 0, [0, 0x40, 0x40, 0x40], { start: true, loop: true });
  const vm = createVm();
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  const calls = [];
  const runtime = new FrameSliceRuntime(vm, { picoApiHost: proxyHost(base, calls) });
  const boot = runtime.boot(sourceCart(`
function _init()
 music(0.5)
 music(0,1000,7)
 music(-1,500)
 print(chr(7).."s4x5c1egc2")
end
function _update() end
function _draw() end`, rom));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.deepEqual(calls, [
    [q16(0.5), undefined, undefined],
    [q16(0), q16(1000), q16(7)],
    [q16(-1), q16(500), undefined],
  ]);
  assert.equal(boot.value.audio.pcm16le.some((byte) => byte !== 0), true);
  const ephemeral = runtime.copyRam(SFX_BASE + 60 * SFX_BYTES, SFX_BYTES);
  assert.equal(ephemeral[65], 4);
  assert.deepEqual(
    [ephemeral[0] & 0x3f, ephemeral[2] & 0x3f, ephemeral[4] & 0x3f, ephemeral[6] & 0x3f],
    [12, 16, 19, 24],
  );
  runtime.dispose();
});

test("music patterns honor duration, start/loop/stop flags and all 64 live slots", () => {
  const ram = new Uint8Array(0x10000);
  for (let sfx = 0; sfx < 64; sfx += 1) {
    writeSfx(ram, sfx, { speed: 4, loopStart: 1, notes: 2 });
    writeSong(ram, sfx, [sfx, 0x40, 0x40, 0x40]);
  }
  writeSong(ram, 0, [0, 0x40, 0x40, 0x40], { start: true });
  writeSong(ram, 1, [1, 0x40, 0x40, 0x40], { loop: true });
  const synth = new PicoSfxSynth(ram);
  for (let pattern = 0; pattern < 64; pattern += 1) {
    synth.music(q16(pattern));
    assert.equal(synth.snapshotMusic().pattern, pattern);
  }

  synth.music(q16(0));
  synth.music(q16(64));
  synth.music(q16(-2));
  assert.equal(synth.snapshotMusic().pattern, 0, "invalid patterns must be no-ops");
  synth.renderSlices(1, 60);
  assert.equal(synth.snapshotMusic().pattern, 0);
  synth.renderSlices(1, 60);
  assert.equal(synth.snapshotMusic().pattern, 1);
  synth.renderSlices(2, 60);
  assert.equal(synth.snapshotMusic().pattern, 0);
  assert.equal(synth.snapshotMusic().patternsPlayed, 2);

  writeSong(ram, 0, [0, 0x40, 0xc0, 0x40], { start: true, stop: true });
  synth.music(q16(0));
  synth.renderSlices(2, 60);
  assert.equal(synth.snapshotMusic().playing, false);
  assert.equal(synth.snapshotChannels().every(({ active }) => !active), true);
});

test("channel masks reserve auto selection while explicit SFX interrupt and resume music", () => {
  const ram = new Uint8Array(0x10000);
  for (let sfx = 0; sfx < 6; sfx += 1) {
    writeSfx(ram, sfx, {
      speed: sfx < 4 ? 8 : 1,
      loopStart: sfx < 4 ? 0 : 1,
      loopEnd: sfx < 4 ? 2 : 0,
      notes: 2,
    });
  }
  writeSong(ram, 0, [0, 1, 2, 3], { start: true, loop: true });
  const synth = new PicoSfxSynth(ram);
  synth.music(q16(0), undefined, q16(3));
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [0, 1, 2, 3]);

  synth.sfx(q16(4));
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [0, 1, 4, 3]);
  synth.sfx(q16(5), q16(0));
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [5, 1, 4, 3]);
  synth.renderSlices(1, 60);
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [0, 1, 2, 3]);
  assert.equal(synth.snapshotMusic().musicChannels.every(Boolean), true);

  synth.sfx(q16(-1), q16(0));
  assert.equal(synth.snapshotChannels()[0].sfx, 0, "SFX stop must not stop music");
  synth.music(q16(0), undefined, q16(15));
  synth.sfx(q16(4));
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [0, 1, 2, 3]);
});

test("music fade is sample-clocked and P8SCII audio owns bounded ephemeral SFX 60..63", () => {
  const ram = new Uint8Array(0x10000);
  writeSfx(ram, 0, { speed: 16, loopStart: 0, loopEnd: 2 });
  writeSfx(ram, 12, { speed: 4, notes: 2 });
  writeSong(ram, 0, [0, 0x40, 0x40, 0x40], { start: true, loop: true });
  const synth = new PicoSfxSynth(ram);
  synth.music(q16(0), q16(1000));
  synth.renderSlices(15, 30);
  assert.ok(Math.abs(synth.snapshotMusic().fadeVolume - 0.5) < 1e-9);
  synth.renderSlices(15, 30);
  assert.equal(synth.snapshotMusic().fadeVolume, 1);
  synth.music(q16(-1), q16(1000));
  synth.renderSlices(15, 30);
  assert.ok(Math.abs(synth.snapshotMusic().fadeVolume - 0.5) < 1e-9);
  synth.renderSlices(15, 30);
  assert.equal(synth.snapshotMusic().playing, false);

  synth.playP8sciiAudio(encoder.encode("s4x5c1egc2"));
  const address = SFX_BASE + 60 * SFX_BYTES;
  assert.equal(ram[address + 65], 4);
  assert.deepEqual(
    [ram[address] & 0x3f, ram[address + 2] & 0x3f,
      ram[address + 4] & 0x3f, ram[address + 6] & 0x3f],
    [12, 16, 19, 24],
  );
  synth.playP8sciiAudio(encoder.encode("12"));
  assert.equal(synth.snapshotChannels().some(({ sfx }) => sfx === 12), true);
  synth.playP8sciiAudio(encoder.encode("c"));
  synth.playP8sciiAudio(encoder.encode("d"));
  synth.playP8sciiAudio(encoder.encode("e"));
  assert.equal(synth.snapshotChannels().filter(({ active }) => active).length, 4);
  assert.doesNotThrow(() => synth.playP8sciiAudio(new Uint8Array(257)));
});

test("music, SFX interruption, P8SCII and fade PCM match the deterministic project golden", async () => {
  const golden = JSON.parse(await readFile(
    new URL("../golden/music.json", import.meta.url),
    "utf8",
  ));
  const actual = buildGoldenTrace();
  assert.deepEqual(actual, golden);
  assert.deepEqual(buildGoldenTrace(), actual);
});

test("production Worker sends startup and catch-up PCM only over the dedicated generation port", () => {
  const records = [];
  const firstPort = recordingPort("first", records);
  const transport = new PcmOutput();
  transport.attach(firstPort, 1);
  const controller = createPlayerWorkerController(module, { audioTransport: transport });
  const cart = textCart(`
function seed()
 poke(0x3100,0,0x40,0x40,0x40)
 poke(0x3200,24,14)
 poke(0x3241,8)
end
function _init() seed() music(0) end
function _update60() end
function _draw() cls(1) end`);
  const ready = controller.handle(command("loadCart", {
    cartBytes: cart.slice().buffer,
    instructionBudget: 200000,
  }));
  assert.equal(ready[0].state, "ready");
  const firstChunks = records.filter(({ message }) => message.type === "audioChunk");
  assert.equal(firstChunks.length, 1);
  assert.deepEqual(
    [firstChunks[0].message.sequence, firstChunks[0].message.firstSample,
      firstChunks[0].message.frameCount],
    [0, "0", 735],
  );
  assert.equal("pcm16le" in ready[0], false);

  controller.handle(command("start", { requestId: 2 }));
  controller.handle(command("vsync", { requestId: 3, sequence: 1, timestampMs: 0 }));
  const tick = controller.handle(command("vsync", {
    requestId: 4,
    sequence: 2,
    timestampMs: 50,
  }));
  const frames = tick.filter(({ type }) => type === "frame");
  assert.equal(frames.length, 3);
  assert.equal(frames.every((frame) => !("audio" in frame) && !("pcm16le" in frame)), true);
  const chunks = records.filter(({ message }) => message.type === "audioChunk");
  assert.deepEqual(chunks.map(({ message }) => message.sequence), [0, 1, 2, 3]);
  assert.deepEqual(chunks.map(({ message }) => message.firstSample), ["0", "735", "1102", "1470"]);

  const secondPort = recordingPort("second", records);
  transport.attach(secondPort, 2);
  const reset = controller.handle(command("reset", { requestId: 5, sessionGeneration: 2 }));
  assert.equal(reset[0].state, "ready");
  assert.equal(firstPort.closed, 1);
  const secondChunks = records.filter(({ name, message }) =>
    name === "second" && message.type === "audioChunk");
  assert.deepEqual(
    [secondChunks[0].message.sequence, secondChunks[0].message.firstSample],
    [0, "0"],
  );

  const stalePort = recordingPort("stale", records);
  transport.attach(stalePort, 1);
  assert.equal(stalePort.closed, 1);
  assert.equal(secondPort.closed, 0);
  assert.equal(transport.sessionGeneration, 2);

  controller.handle(command("stop", { requestId: 6, sessionGeneration: 2 }));
  assert.equal(records.at(-1).message.type, "audioReset");
  controller.dispose();
  transport.dispose();
});

test("unattached production audio never blocks simulation and late attach starts at the current cursor", () => {
  const records = [];
  const transport = new PcmOutput();
  const controller = createPlayerWorkerController(module, { audioTransport: transport });
  const cart = textCart("function _update() end function _draw() end");
  const ready = controller.handle(command("loadCart", { cartBytes: cart.slice().buffer }));
  assert.equal(ready[0].state, "ready");
  const late = recordingPort("late", records);
  transport.attach(late, 1);
  assert.deepEqual(
    [records[0].message.type, records[0].message.nextSequence, records[0].message.firstSample],
    ["audioReset", 1, "735"],
  );
  controller.dispose();
  transport.dispose();
});

test("production VM faults and dispose reset the active Worklet generation", () => {
  const records = [];
  const transport = new PcmOutput();
  transport.attach(recordingPort("fault", records), 1);
  const controller = createPlayerWorkerController(module, { audioTransport: transport });
  const cart = textCart(`
function _update60() assert(false,"phase 3b fault") end
function _draw() end`);
  const ready = controller.handle(command("loadCart", {
    cartBytes: cart.slice().buffer,
  }));
  assert.equal(ready[0].state, "ready");
  controller.handle(command("start", { requestId: 2 }));
  controller.handle(command("vsync", { requestId: 3, sequence: 1, timestampMs: 0 }));
  const fault = controller.handle(command("vsync", {
    requestId: 4,
    sequence: 2,
    timestampMs: 17,
  }));
  assert.equal(fault.some(({ type }) => type === "fault"), true);
  assert.equal(records.at(-1).message.type, "audioReset");

  const disposed = controller.handle(command("dispose", { requestId: 5 }));
  assert.equal(disposed[0].state, "disposed");
  assert.equal(records.at(-1).message.type, "audioReset");
  controller.dispose();
  transport.dispose();
});
