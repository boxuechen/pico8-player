import assert from "node:assert/strict";
import test from "node:test";

import {
  isAudioDeviceStatsMessage,
  isAudioPortAttachmentEnvelope,
  isAudioTransportMessage,
} from "../../apps/player/dist/transport/public.js";
import {
  PcmOutput,
} from "../../apps/player/dist/runtime/audio-transport.js";
import {
  Pcm16Queue,
  PcmDeviceRenderer,
} from "../../apps/player/dist/worklet/pcm-queue.js";

function pcm16le(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return buffer;
}

function reset(sessionGeneration = 1, nextSequence = 0, firstSample = "0") {
  return { v: 1, type: "audioReset", sessionGeneration, nextSequence, firstSample };
}

function chunk({
  sessionGeneration = 1,
  sequence = 0,
  firstSample = "0",
  samples = [1, 2, 3, 4],
} = {}) {
  return {
    v: 1,
    type: "audioChunk",
    sessionGeneration,
    sequence,
    firstSample,
    sampleRate: 22_050,
    frameCount: samples.length,
    pcm16le: pcm16le(samples),
  };
}

test("audio protocol validators lock version, canonical rate, lengths and attachment metadata", () => {
  const validChunk = chunk();
  assert.equal(isAudioTransportMessage(reset()), true);
  assert.equal(isAudioTransportMessage(validChunk), true);
  assert.equal(
    isAudioTransportMessage({ ...validChunk, sampleRate: 44_100 }),
    false,
  );
  assert.equal(
    isAudioTransportMessage({ ...validChunk, frameCount: 3 }),
    false,
  );
  assert.equal(
    isAudioPortAttachmentEnvelope({
      v: 1,
      type: "attachAudioPort",
      sessionGeneration: 4,
      port: {},
    }),
    true,
  );
});

test("bounded PCM queue rejects stale chunks, resyncs discontinuities and enforces high water", () => {
  const queue = new Pcm16Queue({
    capacityFrames: 8,
    prebufferFrames: 4,
    lowWaterFrames: 2,
    highWaterFrames: 6,
  });
  queue.reset(reset());
  assert.deepEqual(queue.push(chunk()), { accepted: true, resynced: false });
  assert.equal(queue.beginRenderQuantum(), true);
  assert.equal(queue.dequeue(), 1);
  assert.equal(queue.dequeue(), 2);
  assert.deepEqual(
    queue.push(
      chunk({ sequence: 1, firstSample: "4", samples: [5, 6, 7, 8, 9, 10] }),
    ),
    { accepted: true, resynced: false },
  );
  assert.equal(queue.queuedFrames, 6);
  assert.deepEqual(
    queue.push(chunk({ sessionGeneration: 0, sequence: 2, firstSample: "10" })),
    { accepted: false, resynced: false },
  );
  assert.deepEqual(
    queue.push(chunk({ sequence: 4, firstSample: "99" })),
    { accepted: true, resynced: true },
  );
  const stats = queue.snapshot(48_000);
  assert.equal(stats.overruns, 1);
  assert.equal(stats.droppedSourceFrames, 2);
  assert.equal(stats.staleChunks, 1);
  assert.equal(stats.discontinuities, 1);
  assert.equal(stats.queuedSourceFrames, 4);
  assert.equal(isAudioDeviceStatsMessage(stats), true);
});

test("device renderer linearly resamples canonical PCM and duplicates mono to channels", () => {
  const queue = new Pcm16Queue({
    capacityFrames: 16,
    prebufferFrames: 4,
    lowWaterFrames: 1,
    highWaterFrames: 16,
  });
  queue.reset(reset());
  queue.push(
    chunk({ samples: [0, 32_767, 0, -32_768, 0, 16_384, 0, -16_384] }),
  );
  const renderer = new PcmDeviceRenderer(queue);
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  assert.equal(renderer.render([left, right], 44_100), true);
  assert.deepEqual([...right], [...left]);
  assert.ok(Math.abs(left[0]) < 1e-7);
  assert.ok(Math.abs(left[1] - 0.49998474) < 1e-6);
  assert.ok(Math.abs(left[2] - 0.99996948) < 1e-6);
  assert.ok(Math.abs(left[3] - 0.49998474) < 1e-6);
  assert.equal(queue.snapshot(44_100).steadyUnderruns, 0);
});

test("Worker PCM adapter transfers canonical chunks and closes replaced/disposed ports", () => {
  const records = [];
  function port(name) {
    return {
      closed: 0,
      started: 0,
      postMessage(message, transfer = []) {
        records.push({ name, message, transfer });
      },
      start() {
        this.started += 1;
      },
      close() {
        this.closed += 1;
      },
    };
  }
  const first = port("first");
  const second = port("second");
  const stale = port("stale");
  const transport = new PcmOutput();
  transport.attach(first, 7);
  assert.equal(first.started, 1);
  assert.equal(records[0].message.type, "audioReset");
  const pcm = pcm16le([10, 20, 30]);
  transport.send({ sequence: 0, firstSample: 0n, frameCount: 3, pcm16le: pcm });
  assert.equal(records[1].message.type, "audioChunk");
  assert.deepEqual(records[1].transfer, [pcm]);

  transport.attach(second, 8);
  assert.equal(first.closed, 1);
  assert.equal(transport.sessionGeneration, 8);
  transport.attach(stale, 7);
  assert.equal(stale.closed, 1);
  assert.equal(second.closed, 0);
  assert.equal(transport.sessionGeneration, 8);
  transport.dispose();
  transport.dispose();
  assert.equal(second.closed, 1);
  assert.throws(() => transport.attach(port("late"), 9), /disposed/u);
});
