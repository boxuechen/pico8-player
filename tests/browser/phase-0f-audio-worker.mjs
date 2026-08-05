import {
  WorkerPcmTransport,
} from "../../apps/web-player/dist/worker/audio-transport.js";

const transport = new WorkerPcmTransport();
const CANONICAL_RATE = 22_050;
const CHUNK_FRAMES = 735;
let sequence = 0;
let generatedSamples = 0;
let timer;
let startTime;
let startGeneratedSamples;

function makePcm(firstSample, frameCount) {
  const buffer = new ArrayBuffer(frameCount * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < frameCount; index += 1) {
    const sampleIndex = firstSample + index;
    const value = Math.round(
      Math.sin((sampleIndex * 440 * Math.PI * 2) / CANONICAL_RATE) * 8192,
    );
    view.setInt16(index * 2, value, true);
  }
  return buffer;
}

function sendUntil(targetSample) {
  while (generatedSamples < targetSample) {
    const frameCount = Math.min(CHUNK_FRAMES, targetSample - generatedSamples);
    const pcm16le = makePcm(generatedSamples, frameCount);
    transport.send({
      sequence,
      firstSample: BigInt(generatedSamples),
      frameCount,
      pcm16le,
    });
    sequence = (sequence + 1) >>> 0;
    generatedSamples += frameCount;
  }
}

function stopProducer() {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  self.postMessage({
    type: "producerStopped",
    generatedSamples,
    sequence,
  });
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "attach") {
    transport.attach(message.port, message.sessionGeneration);
    self.postMessage({ type: "attached" });
    return;
  }
  if (message?.type === "prime") {
    sendUntil(message.frameCount);
    self.postMessage({ type: "primed", generatedSamples, sequence });
    return;
  }
  if (message?.type === "start") {
    startTime = performance.now();
    startGeneratedSamples = generatedSamples;
    timer = setInterval(() => {
      const elapsedSeconds = (performance.now() - startTime) / 1000;
      sendUntil(
        startGeneratedSamples + Math.ceil(elapsedSeconds * CANONICAL_RATE),
      );
    }, 20);
    self.postMessage({ type: "producerStarted" });
    return;
  }
  if (message?.type === "stop") {
    stopProducer();
    return;
  }
  if (message?.type === "dispose") {
    stopProducer();
    transport.dispose();
    self.close();
  }
});
