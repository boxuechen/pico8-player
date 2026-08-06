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

const encoder = new TextEncoder();
const SFX_BASE = 0x3200;
const SFX_BYTES = 68;
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

function createVm() {
  const router = createPicoApiHostRouter(module);
  return new Z8LuaFrameVm(module, router);
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
  { speed = 1, filters = 0, loopStart = 0, loopEnd = 0 } = {},
) {
  const metadata = SFX_BASE + sfx * SFX_BYTES + 64;
  ram[metadata] = filters;
  ram[metadata + 1] = speed;
  ram[metadata + 2] = loopStart;
  ram[metadata + 3] = loopEnd;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return hashBytes(Buffer.from(JSON.stringify(value)));
}

function proxyHost(base, overrides) {
  return new Proxy(base, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function buildGoldenRam() {
  const ram = new Uint8Array(0x10000);
  const filters = [0, 8, 24, 72];
  for (let sfx = 0; sfx < 4; sfx += 1) {
    writeSfx(ram, sfx, { speed: 1, filters: filters[sfx] });
    for (let note = 0; note < 8; note += 1) {
      writeNote(ram, sfx, note, {
        key: 18 + sfx * 3 + note,
        waveform: note,
        volume: 7 - (note % 3),
        effect: note,
      });
    }
  }

  // Custom instrument 5 reads its own live SFX program. The custom bit inside
  // SFX 5 deliberately proves recursion is bounded to one level.
  writeSfx(ram, 4, { speed: 2, filters: 16 });
  writeNote(ram, 4, 0, { key: 27, waveform: 5, volume: 7, effect: 4, custom: true });
  writeNote(ram, 4, 1, { key: 31, waveform: 5, volume: 6, effect: 5, custom: true });
  writeSfx(ram, 5, { speed: 1, filters: 48, loopStart: 0, loopEnd: 2 });
  writeNote(ram, 5, 0, { key: 24, waveform: 2, volume: 7, custom: true });
  writeNote(ram, 5, 1, { key: 29, waveform: 7, volume: 5, effect: 2 });

  writeSfx(ram, 6, { speed: 2, filters: 6 });
  writeNote(ram, 6, 0, { key: 36, waveform: 6, volume: 7, effect: 2 });
  writeNote(ram, 6, 1, { key: 30, waveform: 0, volume: 6, effect: 1 });
  return ram;
}

function createGoldenTrace() {
  const ram = buildGoldenRam();
  const synth = new PicoSfxSynth(ram);
  for (let channel = 0; channel < 4; channel += 1) {
    synth.sfx(q16(channel), q16(channel));
  }
  const channelTrace = [synth.snapshotChannels()];
  const primary = synth.renderSlices(2, 30);
  channelTrace.push(synth.snapshotChannels());

  synth.sfx(q16(4), q16(1));
  const custom = synth.renderSlices(3, 30);
  channelTrace.push(synth.snapshotChannels());

  ram[0x5f40] = 0x11;
  ram[0x5f41] = 0x11;
  ram[0x5f42] = 0x01;
  ram[0x5f43] = 0x10;
  synth.sfx(q16(6), q16(0));
  const hardware = synth.renderSlices(2, 30);
  channelTrace.push(synth.snapshotChannels());

  const pcm = Buffer.concat([
    Buffer.from(primary.pcm16le),
    Buffer.from(custom.pcm16le),
    Buffer.from(hardware.pcm16le),
  ]);
  return {
    slices: [primary, custom, hardware].map(({ firstSample, frameCount }) => ({
      firstSample,
      frameCount,
    })),
    pcmSha256: hashBytes(pcm),
    channelTraceSha256: hashJson(channelTrace),
  };
}

test("Phase 3A appends sfx binding 31 and preserves raw optional Q16 arguments through real WASM", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.bindings.at(-1), {
    id: 31,
    guestName: "sfx",
    hostMethod: "sfx",
    parameters: [
      { name: "sfxRaw", type: "q16.16-raw-i32" },
      { name: "channelRaw", type: "q16.16-raw-i32", optional: true },
      { name: "offsetRaw", type: "q16.16-raw-i32", optional: true },
      { name: "lengthRaw", type: "q16.16-raw-i32", optional: true },
    ],
    result: "void",
  });

  const rom = new Uint8Array(0x8000);
  for (const sfx of [1, 3, 5]) {
    writeSfx(rom, sfx, { speed: 8 });
    writeNote(rom, sfx, 0, { key: 24 + sfx, waveform: sfx & 7, volume: 7 });
  }
  const vm = createVm();
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  const calls = [];
  const host = proxyHost(base, {
    sfx(sfxRaw, channelRaw, offsetRaw, lengthRaw) {
      calls.push([sfxRaw, channelRaw, offsetRaw, lengthRaw]);
      base.sfx(sfxRaw, channelRaw, offsetRaw, lengthRaw);
    },
  });
  const runtime = new FrameSliceRuntime(vm, { picoApiHost: host });
  const boot = runtime.boot(sourceCart(`
function _init()
 sfx(3.5)
 sfx(1,2,3,4)
 sfx(-1,0)
 sfx(-2)
 sfx(5,nil,6)
end
function _update() end
function _draw() end`, rom));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.deepEqual(calls, [
    [q16(3.5), undefined, undefined, undefined],
    [q16(1), q16(2), q16(3), q16(4)],
    [q16(-1), q16(0), undefined, undefined],
    [q16(-2), undefined, undefined, undefined],
    [q16(5), undefined, q16(6), undefined],
  ]);
  assert.equal(boot.value.audio.firstSample, "0");
  assert.equal(boot.value.audio.frameCount, 735);
  runtime.dispose();
  assert.equal(base.snapshotAudioChannels().every(({ active }) => !active), true);
});

test("canonical clock commits exact 30/60 Hz PCM16LE slices without floating accumulation", () => {
  const thirty = new PicoSfxSynth(new Uint8Array(0x10000));
  const first30 = thirty.renderSlices(1, 30);
  const second30 = thirty.renderSlices(1, 30);
  assert.deepEqual(
    [first30.firstSample, first30.frameCount, second30.firstSample, second30.frameCount],
    ["0", 735, "735", 735],
  );
  assert.equal(first30.pcm16le.byteLength, 1470);
  assert.equal(first30.pcm16le.every((byte) => byte === 0), true);

  const audibleRam = new Uint8Array(0x10000);
  writeSfx(audibleRam, 0, { speed: 1 });
  writeNote(audibleRam, 0, 0, { key: 24, waveform: 0, volume: 7 });
  const audible = new PicoSfxSynth(audibleRam);
  audible.sfx(q16(0), q16(0));
  const firstAudible = audible.renderSlices(1, 30).pcm16le;
  assert.equal(new DataView(
    firstAudible.buffer,
    firstAudible.byteOffset,
    firstAudible.byteLength,
  ).getInt16(0, true), -8191);
  assert.deepEqual(firstAudible.slice(0, 2), Uint8Array.of(0x01, 0xe0));

  const sixty = new PicoSfxSynth(new Uint8Array(0x10000));
  const startup = sixty.renderSlices(2, 60);
  const frame0 = sixty.renderSlices(1, 60);
  const frame1 = sixty.renderSlices(1, 60);
  assert.deepEqual(
    [startup.firstSample, startup.frameCount, frame0.firstSample, frame0.frameCount,
      frame1.firstSample, frame1.frameCount],
    ["0", 735, "735", 367, "1102", 368],
  );
  assert.throws(() => sixty.renderSlices(121, 60), /0\.\.120/u);
  assert.throws(() => sixty.renderSlices(1, 30), /cannot change/u);
});

test("four channels implement auto selection, stealing, offset, length, stop and loop release", () => {
  const ram = new Uint8Array(0x10000);
  for (let sfx = 0; sfx < 8; sfx += 1) {
    writeSfx(ram, sfx, { speed: 10 + sfx * 10 });
    for (let note = 0; note < 8; note += 1) {
      writeNote(ram, sfx, note, { key: 20 + note, waveform: sfx & 7, volume: 7 });
    }
  }
  const synth = new PicoSfxSynth(ram);
  for (let sfx = 0; sfx < 4; sfx += 1) synth.sfx(q16(sfx));
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [0, 1, 2, 3]);
  synth.sfx(q16(4));
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [4, 1, 2, 3]);

  synth.sfx(q16(1), q16(3));
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [4, -1, 2, 1]);
  synth.sfx(q16(2), q16(-2));
  assert.deepEqual(synth.snapshotChannels().map(({ sfx }) => sfx), [4, -1, -1, 1]);
  synth.sfx(q16(-1), q16(3));
  assert.equal(synth.snapshotChannels()[3].active, false);

  writeSfx(ram, 7, { speed: 1 });
  synth.sfx(q16(7), q16(0), q16(2), q16(1));
  assert.equal(synth.snapshotChannels()[0].note, 2);
  synth.renderSlices(4, 30);
  assert.equal(synth.snapshotChannels()[0].active, false);

  writeSfx(ram, 6, { speed: 1, loopStart: 0, loopEnd: 1 });
  synth.sfx(q16(6), q16(0));
  synth.renderSlices(1, 30);
  assert.equal(synth.snapshotChannels()[0].looping, true);
  synth.sfx(q16(-2), q16(0));
  synth.renderSlices(1, 30);
  assert.equal(synth.snapshotChannels()[0].active, false);
});

test("all 64 live RAM SFX slots decode through the inclusive top address", () => {
  const ram = new Uint8Array(0x10000);
  const synth = new PicoSfxSynth(ram);
  for (let sfx = 0; sfx < 64; sfx += 1) {
    writeSfx(ram, sfx, { speed: 1 + (sfx % 8) });
    writeNote(ram, sfx, 0, {
      key: sfx & 0x3f,
      waveform: sfx & 7,
      volume: 7,
      effect: sfx & 7,
    });
    synth.sfx(q16(sfx), q16(0));
    assert.equal(synth.snapshotChannels()[0].sfx, sfx);
  }
  const topSlot = synth.renderSlices(1, 30);
  assert.equal(topSlot.pcm16le.some((byte) => byte !== 0), true);
});

test("live RAM mutation changes the next PCM slice while reset gives deterministic replay", () => {
  const original = new Uint8Array(0x10000);
  writeSfx(original, 0, { speed: 8 });
  writeNote(original, 0, 0, { key: 29, waveform: 0, volume: 7 });
  const changedRam = original.slice();
  const controlRam = original.slice();
  const changed = new PicoSfxSynth(changedRam);
  const control = new PicoSfxSynth(controlRam);
  changed.sfx(q16(0), q16(0));
  control.sfx(q16(0), q16(0));
  assert.deepEqual(changed.renderSlices(1, 60), control.renderSlices(1, 60));

  writeNote(changedRam, 0, 0, { key: 41, waveform: 3, volume: 7 });
  const mutated = changed.renderSlices(1, 60);
  const unchanged = control.renderSlices(1, 60);
  assert.notEqual(hashBytes(mutated.pcm16le), hashBytes(unchanged.pcm16le));

  controlRam.set(changedRam);
  changed.reset();
  control.reset();
  changed.sfx(q16(0), q16(0));
  control.sfx(q16(0), q16(0));
  assert.deepEqual(changed.renderSlices(2, 60), control.renderSlices(2, 60));
});

test("waveform, effect, filter and bounded custom-instrument traces match the project golden", async () => {
  const golden = JSON.parse(await readFile(
    new URL("../golden/phase-3a-sfx.json", import.meta.url),
    "utf8",
  ));
  const actual = createGoldenTrace();
  assert.deepEqual(actual.slices, golden.slices);
  assert.equal(actual.pcmSha256, golden.pcmSha256);
  assert.equal(actual.channelTraceSha256, golden.channelTraceSha256);
  assert.deepEqual(createGoldenTrace(), actual);
});

test("invalid calls are no-ops, speed zero is bounded, and VM faults clear audio state", () => {
  const ram = new Uint8Array(0x10000);
  writeSfx(ram, 0, { speed: 0 });
  writeNote(ram, 0, 0, { waveform: 6, volume: 7 });
  const synth = new PicoSfxSynth(ram);
  synth.sfx(q16(64));
  synth.sfx(q16(0), q16(4));
  synth.sfx(q16(0), q16(0), q16(32));
  assert.equal(synth.snapshotChannels().every(({ active }) => !active), true);
  synth.sfx(q16(0), q16(0));
  assert.doesNotThrow(() => synth.renderSlices(1, 30));
  assert.equal(synth.snapshotChannels()[0].active, false);

  const rom = new Uint8Array(0x8000);
  writeSfx(rom, 0, { speed: 8 });
  writeNote(rom, 0, 0, { waveform: 3, volume: 7 });
  const vm = createVm();
  const host = createPicoApiHost(vm.memory, vm.logicalMemory);
  const runtime = new FrameSliceRuntime(vm, { picoApiHost: host });
  const boot = runtime.boot(sourceCart(`
function _init()
 sfx(0)
 error("phase-3a-fault")
end
function _update() end
function _draw() end`, rom));
  assert.equal(boot.ok, false);
  assert.equal(boot.error.code, "E_VM_RUNTIME");
  assert.equal(host.snapshotAudioChannels().every(({ active }) => !active), true);
  runtime.dispose();
});
