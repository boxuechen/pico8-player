import {
  installPhase0FAsyncRuntimeWorker,
} from "../../apps/web-player/dist/worker/runtime-worker.js";
import {
  WorkerPcmTransport,
} from "../../apps/web-player/dist/worker/audio-transport.js";
import {
  createPhase0FFrameFixture,
} from "../fixtures/phase-0f/frame-fixture.mjs";

const audio = new WorkerPcmTransport();
const packedFixture = createPhase0FFrameFixture();
let audioSequence = 0;
let firstSample = 0;

function eventBase(command) {
  return {
    v: 1,
    requestId: command.requestId,
    sessionGeneration: command.sessionGeneration,
  };
}

function primeAudio() {
  audioSequence = 0;
  firstSample = 0;
  audio.reset(audioSequence, BigInt(firstSample));
  for (let chunkIndex = 0; chunkIndex < 30; chunkIndex += 1) {
    const frameCount = 735;
    const pcm16le = new ArrayBuffer(frameCount * 2);
    const view = new DataView(pcm16le);
    for (let index = 0; index < frameCount; index += 1) {
      view.setInt16(
        index * 2,
        Math.round(
          Math.sin(((firstSample + index) * 440 * Math.PI * 2) / 22_050) * 4096,
        ),
        true,
      );
    }
    audio.send({
      sequence: audioSequence,
      firstSample: BigInt(firstSample),
      frameCount,
      pcm16le,
    });
    audioSequence += 1;
    firstSample += frameCount;
  }
}

const controller = {
  handle(command) {
    if (command.type === "loadCart") {
      primeAudio();
      return {
        ...eventBase(command),
        type: "ready",
        mode: "callback",
        targetFps: 60,
      };
    }
    if (command.type === "step") {
      if (command.input.controllers[0] === 0x3f) {
        for (;;) {}
      }
      const packedScreen = packedFixture.slice().buffer;
      return {
        ...eventBase(command),
        type: "frame",
        frameId: 0,
        completedSlices: "3",
        timeRawBeforeStep: 3276,
        targetFps: 60,
        packedScreen,
      };
    }
    if (command.type === "hostResponse") {
      return { ...eventBase(command), type: "stopped" };
    }
    return { ...eventBase(command), type: "disposed" };
  },
  dispose() {},
};

installPhase0FAsyncRuntimeWorker(self, Promise.resolve(controller), audio);
