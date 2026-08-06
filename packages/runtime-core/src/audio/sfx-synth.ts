export const PICO_AUDIO_SAMPLE_RATE = 22_050 as const;
export const PICO_AUDIO_CHANNELS = 4 as const;

const SFX_BASE = 0x3200;
const SFX_COUNT = 64;
const SFX_BYTES = 68;
const MUSIC_BASE = 0x3100;
const MUSIC_COUNT = 64;
const MUSIC_CHANNELS = 4;
const NOTES_PER_SFX = 32;
const NOTE_BYTES = 2;
const NOTE_SAMPLES_PER_SPEED = 183;
const SOUND_PAUSE = 0x5f2f;
const AUDIO_HALF_RATE = 0x5f40;
const AUDIO_REVERB = 0x5f41;
const AUDIO_DISTORT = 0x5f42;
const AUDIO_LOWPASS = 0x5f43;
const MAX_RENDER_SLICES = 120;
const MASTER_SFX_GAIN = 0.5;
const BASE_NOISE_SEED = 0x6d2b79f5;

export interface CanonicalAudioSlice {
  readonly firstSample: string;
  readonly frameCount: number;
  readonly pcm16le: Uint8Array;
}

export interface AudioChannelSnapshot {
  readonly channel: number;
  readonly active: boolean;
  readonly sfx: number;
  readonly note: number;
  readonly offset: number;
  readonly looping: boolean;
}

export interface AudioMusicSnapshot {
  readonly playing: boolean;
  readonly pattern: number;
  readonly patternsPlayed: number;
  readonly tick: number;
  readonly channelMask: number;
  readonly fadeVolume: number;
  readonly musicChannels: readonly boolean[];
}

export interface AudioSynth {
  reset(): void;
  sfx(
    sfxRaw: number,
    channelRaw?: number,
    offsetRaw?: number,
    lengthRaw?: number,
  ): void;
  music(patternRaw: number, fadeLengthRaw?: number, channelMaskRaw?: number): void;
  playP8sciiAudio(bytes: Uint8Array): void;
  renderSlices(sliceCount: number, targetFps: 30 | 60): CanonicalAudioSlice;
  snapshotChannels(): readonly AudioChannelSnapshot[];
  snapshotMusic(): AudioMusicSnapshot;
}

interface VoiceState {
  sfx: number;
  offset: number;
  /** Monotonic notes elapsed since launch; unlike offset this never loops. */
  time: number;
  elapsed: number;
  previousKey: number;
  previousVolume: number;
  phase: number;
  noiseState: number;
  noiseValue: number;
  loopEpoch: number;
}

interface SynthParameters {
  readonly note: number;
  readonly key: number;
  readonly instrument: number;
  readonly custom: boolean;
  readonly effect: number;
  readonly filters: number;
  readonly frequency: number;
  readonly volume: number;
}

interface ChannelState {
  readonly main: VoiceState;
  readonly custom: VoiceState;
  length: number;
  canLoop: boolean;
  isMusic: boolean;
  parkedMusicSfx: number;
  lastMainNote: number;
  lastMainKey: number;
  lastMainVolume: number;
  lastMainLoopEpoch: number;
  readonly reverb2: Float64Array;
  readonly reverb4: Float64Array;
  reverbIndex: number;
  readonly damp1: BiquadFilter;
  readonly damp2: BiquadFilter;
}

interface MusicState {
  pattern: number;
  patternsPlayed: number;
  channelMask: number;
  tick: number;
  lengthTicks: number;
  fadeVolume: number;
  fadeStepPerSample: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function q16Integer(raw: number): number {
  return raw >> 16;
}

function keyToFrequency(key: number): number {
  return 440 * 2 ** ((key - 33) / 12);
}

function p8sciiParameter(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x7a) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x37;
  return 0;
}

function noteSemitone(byte: number): number {
  switch (byte) {
    case 0x63: return 0;
    case 0x64: return 2;
    case 0x65: return 4;
    case 0x66: return 5;
    case 0x67: return 7;
    case 0x61: return 9;
    case 0x62: return 11;
    default: return -1;
  }
}

function mixSeed(channel: number, custom: boolean): number {
  const mixed = (BASE_NOISE_SEED ^ Math.imul(channel + 1, 0x9e3779b9) ^
    (custom ? 0xa511e9b3 : 0)) >>> 0;
  return mixed === 0 ? BASE_NOISE_SEED : mixed;
}

function createVoice(channel: number, custom: boolean): VoiceState {
  return {
    sfx: -1,
    offset: 0,
    time: 0,
    elapsed: 0,
    previousKey: 24,
    previousVolume: 0,
    phase: 0,
    noiseState: mixSeed(channel, custom),
    noiseValue: 0,
    loopEpoch: 0,
  };
}

class BiquadFilter {
  readonly #c1: number;
  readonly #c2: number;
  readonly #c3: number;
  readonly #c4: number;
  readonly #c5: number;
  #lastInput = 0;
  #previousInput = 0;
  #lastOutput = 0;
  #previousOutput = 0;

  constructor(frequency: number, q: number, gain: number) {
    const w0 = Math.PI * 2 * frequency / PICO_AUDIO_SAMPLE_RATE;
    const cosine = Math.cos(w0);
    const a = 10 ** (gain / 40);
    const alpha = Math.sin(w0) / 2 * Math.sqrt((a + 1 / a) * (1 / q - 1) + 2);
    const squareRootA = 2 * Math.sqrt(a) * alpha;
    const a0 = (a + 1) - (a - 1) * cosine + squareRootA;
    const a1 = 2 * ((a - 1) - (a + 1) * cosine);
    const a2 = (a + 1) - (a - 1) * cosine - squareRootA;
    const b0 = a * ((a + 1) + (a - 1) * cosine + squareRootA);
    const b1 = -2 * a * ((a - 1) + (a + 1) * cosine);
    const b2 = a * ((a + 1) + (a - 1) * cosine - squareRootA);
    this.#c1 = b0 / a0;
    this.#c2 = b1 / a0;
    this.#c3 = b2 / a0;
    this.#c4 = a1 / a0;
    this.#c5 = a2 / a0;
  }

  reset(): void {
    this.#lastInput = 0;
    this.#previousInput = 0;
    this.#lastOutput = 0;
    this.#previousOutput = 0;
  }

  run(input: number): number {
    const output = this.#c1 * input + this.#c2 * this.#lastInput +
      this.#c3 * this.#previousInput - this.#c4 * this.#lastOutput -
      this.#c5 * this.#previousOutput;
    this.#previousInput = this.#lastInput;
    this.#lastInput = input;
    this.#previousOutput = this.#lastOutput;
    this.#lastOutput = output;
    return output;
  }
}

function createChannel(channel: number): ChannelState {
  return {
    main: createVoice(channel, false),
    custom: createVoice(channel, true),
    length: 0,
    canLoop: true,
    isMusic: false,
    parkedMusicSfx: -1,
    lastMainNote: -1,
    lastMainKey: -1,
    lastMainVolume: 0,
    lastMainLoopEpoch: 0,
    reverb2: new Float64Array(366),
    reverb4: new Float64Array(732),
    reverbIndex: 0,
    damp1: new BiquadFilter(2400, 1, -6),
    damp2: new BiquadFilter(1000, 1, -12),
  };
}

/** Browser-neutral, deterministic four-channel SFX synthesizer over live Pico RAM. */
export class PicoSfxSynth implements AudioSynth {
  readonly #ram: Uint8Array;
  readonly #channels: ChannelState[];
  readonly #music: MusicState = {
    pattern: -1,
    patternsPlayed: -1,
    channelMask: 0,
    tick: -1,
    lengthTicks: 0,
    fadeVolume: 0,
    fadeStepPerSample: 0,
  };
  #sampleIndex = 0n;
  #sampleRemainder = 0;
  #targetFps: 0 | 30 | 60 = 0;

  constructor(ram: Uint8Array) {
    if (!(ram instanceof Uint8Array) || ram.byteLength !== 0x10000) {
      throw new RangeError("PicoSfxSynth requires the physical 64 KiB Pico RAM view");
    }
    this.#ram = ram;
    this.#channels = Array.from(
      { length: PICO_AUDIO_CHANNELS },
      (_, channel) => createChannel(channel),
    );
  }

  reset(): void {
    this.#sampleIndex = 0n;
    this.#sampleRemainder = 0;
    this.#targetFps = 0;
    for (let index = 0; index < this.#channels.length; index += 1) {
      this.#resetChannel(this.#channels[index]!, index);
    }
    Object.assign(this.#music, {
      pattern: -1,
      patternsPlayed: -1,
      channelMask: 0,
      tick: -1,
      lengthTicks: 0,
      fadeVolume: 0,
      fadeStepPerSample: 0,
    });
  }

  sfx(
    sfxRaw: number,
    channelRaw?: number,
    offsetRaw?: number,
    lengthRaw?: number,
  ): void {
    const sfx = q16Integer(sfxRaw);
    let channel = channelRaw === undefined ? -1 : q16Integer(channelRaw);
    const offset = offsetRaw === undefined ? 0 : q16Integer(offsetRaw);
    const length = lengthRaw === undefined ? 0 : q16Integer(lengthRaw);
    if (sfx < -2 || sfx >= SFX_COUNT || channel < -2 || channel >= PICO_AUDIO_CHANNELS || offset > 31) {
      return;
    }
    if (channel === -2) {
      if (sfx < 0) return;
      for (const state of this.#channels) {
        if (state.main.sfx === sfx) this.#silenceChannel(state);
      }
      return;
    }
    if (sfx === -1) {
      if (channel === -1) {
        for (const state of this.#channels) this.#stopManualSfx(state);
      } else {
        this.#stopManualSfx(this.#channels[channel]!);
      }
      return;
    }
    if (sfx === -2) {
      if (channel === -1) {
        for (const state of this.#channels) state.canLoop = false;
      } else {
        this.#channels[channel]!.canLoop = false;
      }
      return;
    }
    if (channel === -1) {
      channel = this.#selectChannel(sfx);
      if (channel < 0) return;
    }
    for (const state of this.#channels) {
      if (state.main.sfx === sfx) this.#silenceChannel(state);
    }
    const state = this.#channels[channel]!;
    if (state.main.sfx >= 0 && state.isMusic) state.parkedMusicSfx = state.main.sfx;
    this.#launch(
      state,
      channel,
      sfx,
      Math.max(0, offset),
      Math.max(0, length),
      false,
    );
  }

  music(patternRaw: number, fadeLengthRaw?: number, channelMaskRaw?: number): void {
    const pattern = q16Integer(patternRaw);
    const fadeLengthMs = Math.max(0, fadeLengthRaw === undefined ? 0 : q16Integer(fadeLengthRaw));
    const channelMask = channelMaskRaw === undefined ? 0 : q16Integer(channelMaskRaw) & 0x0f;
    if (pattern < -1 || pattern >= MUSIC_COUNT) return;
    if (pattern === -1) {
      if (this.#music.pattern < 0) return;
      if (fadeLengthMs === 0) {
        this.#setMusicPattern(-1);
      } else {
        this.#music.fadeStepPerSample = -this.#music.fadeVolume /
          (fadeLengthMs * PICO_AUDIO_SAMPLE_RATE / 1000);
      }
      return;
    }
    this.#music.patternsPlayed = 0;
    this.#music.channelMask = channelMask;
    this.#music.fadeVolume = fadeLengthMs === 0 ? 1 : 0;
    this.#music.fadeStepPerSample = fadeLengthMs === 0
      ? 0
      : 1 / (fadeLengthMs * PICO_AUDIO_SAMPLE_RATE / 1000);
    this.#setMusicPattern(pattern);
  }

  playP8sciiAudio(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256) return;
    this.#playP8sciiAudio(bytes);
  }

  renderSlices(sliceCount: number, targetFps: 30 | 60): CanonicalAudioSlice {
    if (!Number.isInteger(sliceCount) || sliceCount < 0 || sliceCount > MAX_RENDER_SLICES) {
      throw new RangeError(`audio sliceCount must be an integer in 0..${MAX_RENDER_SLICES}`);
    }
    if (targetFps !== 30 && targetFps !== 60) {
      throw new RangeError("audio targetFps must be 30 or 60");
    }
    if (this.#targetFps !== 0 && this.#targetFps !== targetFps) {
      throw new Error("audio targetFps cannot change within a runtime generation");
    }
    this.#targetFps = targetFps;
    const numerator = this.#sampleRemainder + sliceCount * PICO_AUDIO_SAMPLE_RATE;
    const frameCount = Math.floor(numerator / targetFps);
    this.#sampleRemainder = numerator % targetFps;
    const pcm16le = new Uint8Array(frameCount * 2);
    const view = new DataView(pcm16le.buffer);
    for (let frame = 0; frame < frameCount; frame += 1) {
      view.setInt16(frame * 2, this.#renderSample(), true);
    }
    const firstSample = this.#sampleIndex.toString();
    this.#sampleIndex += BigInt(frameCount);
    return { firstSample, frameCount, pcm16le };
  }

  snapshotChannels(): readonly AudioChannelSnapshot[] {
    return this.#channels.map((state, channel) => ({
      channel,
      active: state.main.sfx >= 0,
      sfx: state.main.sfx,
      note: state.main.sfx < 0 ? -1 : Math.min(31, Math.floor(state.main.offset)),
      offset: state.main.offset,
      looping: state.main.sfx >= 0 && state.canLoop && this.#hasLoop(state.main.sfx),
    }));
  }

  snapshotMusic(): AudioMusicSnapshot {
    return {
      playing: this.#music.pattern >= 0,
      pattern: this.#music.pattern,
      patternsPlayed: this.#music.patternsPlayed,
      tick: this.#music.pattern < 0 ? -1 : Math.floor(this.#music.tick),
      channelMask: this.#music.channelMask,
      fadeVolume: this.#music.fadeVolume,
      musicChannels: this.#channels.map((state) => state.isMusic),
    };
  }

  #resetChannel(state: ChannelState, channel: number): void {
    Object.assign(state.main, createVoice(channel, false));
    Object.assign(state.custom, createVoice(channel, true));
    state.length = 0;
    state.canLoop = true;
    state.isMusic = false;
    state.parkedMusicSfx = -1;
    state.lastMainNote = -1;
    state.lastMainKey = -1;
    state.lastMainVolume = 0;
    state.lastMainLoopEpoch = 0;
    state.reverb2.fill(0);
    state.reverb4.fill(0);
    state.reverbIndex = 0;
    state.damp1.reset();
    state.damp2.reset();
  }

  #silenceChannel(state: ChannelState): void {
    state.main.sfx = -1;
    state.custom.sfx = -1;
    state.length = 0;
    state.canLoop = true;
    state.isMusic = false;
    state.lastMainNote = -1;
    state.lastMainKey = -1;
    state.lastMainVolume = 0;
  }

  #stopManualSfx(state: ChannelState): void {
    if (state.main.sfx < 0 || state.isMusic) return;
    this.#silenceChannel(state);
  }

  #launch(
    state: ChannelState,
    channel: number,
    sfx: number,
    offset: number,
    length: number,
    isMusic: boolean,
  ): void {
    const phase = state.main.phase;
    const noiseState = state.main.noiseState;
    Object.assign(state.main, createVoice(channel, false), {
      sfx,
      offset,
      phase,
      noiseState,
    });
    state.custom.sfx = -1;
    state.length = length;
    state.canLoop = true;
    state.isMusic = isMusic;
    state.lastMainNote = -1;
    state.lastMainKey = -1;
    state.lastMainVolume = 0;
    state.lastMainLoopEpoch = 0;
  }

  #launchCustom(state: ChannelState, channel: number, sfx: number): void {
    const phase = state.custom.phase;
    const noiseState = state.custom.noiseState;
    Object.assign(state.custom, createVoice(channel, true), {
      sfx,
      phase,
      noiseState,
    });
  }

  #advanceMusic(): void {
    if (this.#music.pattern < 0) return;
    if (this.#music.fadeStepPerSample !== 0) {
      this.#music.fadeVolume = clamp(
        this.#music.fadeVolume + this.#music.fadeStepPerSample,
        0,
        1,
      );
      if (this.#music.fadeStepPerSample < 0 && this.#music.fadeVolume === 0) {
        this.#setMusicPattern(-1);
        return;
      }
      if (this.#music.fadeStepPerSample > 0 && this.#music.fadeVolume === 1) {
        this.#music.fadeStepPerSample = 0;
      }
    }
    const rateScale = (this.#ram[AUDIO_HALF_RATE]! & 1) !== 0 ? 0.5 : 1;
    this.#music.tick += rateScale / NOTE_SAMPLES_PER_SPEED;
    if (this.#music.tick < this.#music.lengthTicks) return;

    const pattern = this.#music.pattern;
    const address = MUSIC_BASE + pattern * MUSIC_CHANNELS;
    let nextPattern = pattern + 1;
    if ((this.#ram[address + 2]! & 0x80) !== 0) {
      nextPattern = -1;
    } else if ((this.#ram[address + 1]! & 0x80) !== 0) {
      nextPattern = pattern + 1;
      do {
        nextPattern -= 1;
      } while (
        nextPattern > 0 &&
        (this.#ram[MUSIC_BASE + nextPattern * MUSIC_CHANNELS]! & 0x80) === 0
      );
    }
    this.#music.patternsPlayed += 1;
    this.#setMusicPattern(nextPattern);
  }

  #setMusicPattern(pattern: number): void {
    for (const state of this.#channels) {
      if (state.isMusic) this.#silenceChannel(state);
      state.parkedMusicSfx = -1;
    }
    if (pattern < 0 || pattern >= MUSIC_COUNT) {
      Object.assign(this.#music, {
        pattern: -1,
        patternsPlayed: -1,
        channelMask: 0,
        tick: -1,
        lengthTicks: 0,
        fadeVolume: 0,
        fadeStepPerSample: 0,
      });
      return;
    }

    const songAddress = MUSIC_BASE + pattern * MUSIC_CHANNELS;
    const songChannels = Array.from(
      { length: MUSIC_CHANNELS },
      (_, channel) => this.#ram[songAddress + channel]! & 0x7f,
    );
    let loopingDuration = -1;
    let nonLoopingDuration = -1;
    for (const encoded of songChannels) {
      if ((encoded & 0x40) !== 0) continue;
      const sfx = encoded & 0x3f;
      const base = this.#sfxAddress(sfx);
      const speed = Math.max(1, this.#ram[base + 65]!);
      const loopStart = this.#ram[base + 66]!;
      const loopEnd = this.#ram[base + 67]!;
      if (loopEnd > loopStart) {
        loopingDuration = Math.max(loopingDuration, NOTES_PER_SFX * speed);
      } else {
        const end = loopEnd === 0 && loopStart > 0
          ? Math.min(NOTES_PER_SFX, loopStart)
          : NOTES_PER_SFX;
        nonLoopingDuration = end * speed;
        break;
      }
    }
    const duration = nonLoopingDuration > 0 ? nonLoopingDuration : loopingDuration;
    this.#music.pattern = pattern;
    this.#music.tick = 0;
    this.#music.lengthTicks = duration > 0 ? duration : NOTES_PER_SFX;

    for (let channel = 0; channel < MUSIC_CHANNELS; channel += 1) {
      const encoded = songChannels[channel]!;
      if ((encoded & 0x40) !== 0) continue;
      const sfx = encoded & 0x3f;
      const state = this.#channels[channel]!;
      if (state.main.sfx < 0) {
        this.#launch(state, channel, sfx, 0, 0, true);
      } else {
        state.parkedMusicSfx = sfx;
      }
    }
  }

  #resumeParkedMusic(state: ChannelState, channel: number): void {
    if (state.main.sfx >= 0 || state.parkedMusicSfx < 0 || this.#music.pattern < 0) return;
    const sfx = state.parkedMusicSfx;
    const base = this.#sfxAddress(sfx);
    const speed = Math.max(1, this.#ram[base + 65]!);
    let offset = this.#music.tick / speed;
    const loopStart = this.#ram[base + 66]!;
    const loopEnd = this.#ram[base + 67]!;
    if (loopEnd > loopStart && offset > loopStart) {
      offset = ((offset - loopStart) % (loopEnd - loopStart)) + loopStart;
    }
    state.parkedMusicSfx = -1;
    if (offset > NOTES_PER_SFX) return;
    this.#launch(state, channel, sfx, offset, 0, true);
  }

  #playP8sciiAudio(bytes: Uint8Array): void {
    let cursor = 0;
    let selected = -1;
    if (bytes[cursor] !== undefined && bytes[cursor]! >= 0x30 && bytes[cursor]! <= 0x39) {
      selected = 0;
      for (let digits = 0; digits < 2; digits += 1) {
        const byte = bytes[cursor];
        if (byte === undefined || byte < 0x30 || byte > 0x39) break;
        selected = selected * 10 + byte - 0x30;
        cursor += 1;
      }
      if (selected >= SFX_COUNT) return;
      if (cursor === bytes.byteLength) {
        this.sfx(selected << 16);
        return;
      }
    } else {
      selected = this.#selectEphemeralSfx();
      if (selected < 0) return;
    }

    const base = this.#sfxAddress(selected);
    this.#ram.fill(0, base, base + SFX_BYTES);
    let speed = 16;
    let loopStart = 0;
    let loopEnd = 0;
    let instrument = 5;
    let volume = 5;
    let effect = 0;
    let octave = 3;
    let note = 0;
    while (cursor < bytes.byteLength && note < NOTES_PER_SFX) {
      const byte = bytes[cursor++]!;
      const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
      if (lower === 0x73 && note === 0) {
        const value = bytes[cursor++];
        if (value !== undefined) speed = clamp(p8sciiParameter(value), 1, 255);
        continue;
      }
      if (lower === 0x6c && note === 0) {
        const start = bytes[cursor++];
        const end = bytes[cursor++];
        if (start !== undefined) loopStart = clamp(p8sciiParameter(start), 0, 31);
        if (end !== undefined) loopEnd = clamp(p8sciiParameter(end), 0, 32);
        continue;
      }
      if (lower === 0x69 || lower === 0x76 || lower === 0x78) {
        const value = bytes[cursor++];
        if (value === undefined) continue;
        const parsed = p8sciiParameter(value);
        if (lower === 0x69) instrument = clamp(parsed, 0, 7);
        else if (lower === 0x76) volume = clamp(parsed, 0, 7);
        else effect = clamp(parsed, 0, 7);
        continue;
      }
      if (lower === 0x3c) {
        volume = Math.max(0, volume - 1);
        continue;
      }
      if (lower === 0x3e) {
        volume = Math.min(7, volume + 1);
        continue;
      }
      if (lower === 0x2e) {
        this.#writeP8sciiNote(base, note++, 0, instrument, 0, effect);
        continue;
      }
      const semitone = noteSemitone(lower);
      if (semitone < 0) continue;
      let adjusted = semitone;
      if (bytes[cursor] === 0x23) {
        adjusted += 1;
        cursor += 1;
      } else if (bytes[cursor] === 0x2d) {
        adjusted -= 1;
        cursor += 1;
      }
      const octaveByte = bytes[cursor];
      if (octaveByte !== undefined && octaveByte >= 0x30 && octaveByte <= 0x35) {
        octave = octaveByte - 0x30;
        cursor += 1;
      }
      this.#writeP8sciiNote(
        base,
        note++,
        clamp(octave * 12 + adjusted, 0, 63),
        instrument,
        volume,
        effect,
      );
    }
    if (note === 0) this.#writeP8sciiNote(base, 0, octave * 12, instrument, volume, effect);
    this.#ram[base + 65] = speed;
    this.#ram[base + 66] = loopStart;
    this.#ram[base + 67] = loopEnd;
    this.sfx(selected << 16);
  }

  #selectEphemeralSfx(): number {
    for (let sfx = 60; sfx < 64; sfx += 1) {
      if (this.#channels.every((state) => state.main.sfx !== sfx)) return sfx;
    }
    return -1;
  }

  #writeP8sciiNote(
    base: number,
    note: number,
    key: number,
    instrument: number,
    volume: number,
    effect: number,
  ): void {
    const address = base + note * NOTE_BYTES;
    this.#ram[address] = (key & 0x3f) | ((instrument & 3) << 6);
    this.#ram[address + 1] = ((instrument >>> 2) & 1) |
      ((volume & 7) << 1) |
      ((effect & 7) << 4);
  }

  #selectChannel(sfx: number): number {
    for (let channel = 0; channel < this.#channels.length; channel += 1) {
      if ((this.#music.channelMask & (1 << channel)) !== 0) continue;
      const playing = this.#channels[channel]!.main.sfx;
      if (playing === -1 || playing === sfx) return channel;
    }
    for (let channel = 0; channel < this.#channels.length; channel += 1) {
      if ((this.#music.channelMask & (1 << channel)) !== 0) continue;
      if (this.#channels[channel]!.isMusic) return channel;
    }
    let selected = -1;
    let fastest = 256;
    for (let channel = 0; channel < this.#channels.length; channel += 1) {
      if ((this.#music.channelMask & (1 << channel)) !== 0) continue;
      const playing = this.#channels[channel]!.main.sfx;
      if (playing < 0) continue;
      const speed = this.#ram[this.#sfxAddress(playing) + 65]!;
      if (speed <= fastest) {
        fastest = speed;
        selected = channel;
      }
    }
    return selected;
  }

  #renderSample(): number {
    if (this.#ram[SOUND_PAUSE] === 1) return 0;
    this.#advanceMusic();
    let mixed = 0;
    for (let channel = 0; channel < this.#channels.length; channel += 1) {
      mixed += this.#renderChannel(this.#channels[channel]!, channel);
    }
    return Math.trunc(clamp(mixed, -32767, 32767));
  }

  #renderChannel(state: ChannelState, channel: number): number {
    this.#resumeParkedMusic(state, channel);
    const main = this.#prepareVoice(state.main, channel, 1, state.length, state.canLoop, false);
    let value = 0;
    let filters = 0;
    if (main !== undefined) {
      filters = main.filters;
      if (main.volume > 0) {
        if (main.custom) {
          const noteChanged = main.note !== state.lastMainNote ||
            state.main.loopEpoch !== state.lastMainLoopEpoch;
          const retrigger = state.custom.sfx !== main.instrument ||
            (noteChanged && (
              main.key !== state.lastMainKey ||
              state.lastMainVolume === 0 ||
              main.effect === 3 ||
              state.main.loopEpoch !== state.lastMainLoopEpoch
            ));
          if (retrigger) this.#launchCustom(state, channel, main.instrument);
          const custom = this.#prepareVoice(
            state.custom,
            channel,
            main.frequency / keyToFrequency(24),
            0,
            true,
            true,
          );
          if (custom !== undefined && custom.volume > 0) {
            filters = custom.filters;
            value = this.#sampleWaveform(custom, state.custom) * custom.volume * main.volume;
          }
          this.#advanceVoice(state.custom, channel, 0, true, false);
        } else {
          state.custom.sfx = -1;
          value = this.#sampleWaveform(main, state.main) * main.volume;
        }
      }
      state.lastMainNote = main.note;
      state.lastMainKey = main.key;
      state.lastMainVolume = main.volume;
      state.lastMainLoopEpoch = state.main.loopEpoch;
      this.#advanceVoice(state.main, channel, state.length, state.canLoop, state.isMusic);
    }

    const gain = state.isMusic
      ? MASTER_SFX_GAIN * this.#music.fadeVolume
      : MASTER_SFX_GAIN;
    value = clamp(value * gain, -1, 1);
    const reverbMode = Math.floor(filters / 24) % 3;
    const dampenMode = Math.floor(filters / 72) % 3;
    const hardwareReverb = this.#ram[AUDIO_REVERB]!;
    const hardwareLowpass = this.#ram[AUDIO_LOWPASS]!;
    const useReverb2 = reverbMode === 1 || (hardwareReverb & (1 << (channel + 4))) !== 0;
    const useReverb4 = reverbMode === 2 || (hardwareReverb & (1 << channel)) !== 0;
    const reverbIndex2 = state.reverbIndex % state.reverb2.length;
    const reverbIndex4 = state.reverbIndex % state.reverb4.length;
    if (useReverb2) value += state.reverb2[reverbIndex2]! * 0.5;
    if (useReverb4) value += state.reverb4[reverbIndex4]! * 0.5;
    state.reverb2[reverbIndex2] = value;
    state.reverb4[reverbIndex4] = value;
    state.reverbIndex += 1;

    const damp1 = state.damp1.run(value);
    const damp2 = state.damp2.run(value);
    if (dampenMode === 1 || (hardwareLowpass & (1 << (channel + 4))) !== 0) value = damp1;
    if (dampenMode === 2 || (hardwareLowpass & (1 << channel)) !== 0) value = damp2;

    let sample = Math.trunc(32767.99 * clamp(value, -0.99, 0.99));
    const distort = this.#ram[AUDIO_DISTORT]!;
    if ((distort & (1 << channel)) !== 0) {
      sample = Math.trunc(sample / 0x1000) * 0x1249;
    } else if ((distort & (1 << (channel + 4))) !== 0) {
      sample = Math.trunc((sample - (sample < 0 ? 0x1000 : 0)) / 0x1000) * 0x1249;
    }
    return sample;
  }

  #prepareVoice(
    voice: VoiceState,
    channel: number,
    frequencyFactor: number,
    length: number,
    canLoop: boolean,
    ignoreCustom: boolean,
  ): SynthParameters | undefined {
    if (voice.sfx < 0 || voice.sfx >= SFX_COUNT || voice.offset < 0 || voice.offset >= NOTES_PER_SFX) {
      voice.sfx = -1;
      return undefined;
    }
    const note = Math.floor(voice.offset);
    const address = this.#sfxAddress(voice.sfx) + note * NOTE_BYTES;
    const byte0 = this.#ram[address]!;
    const byte1 = this.#ram[address + 1]!;
    const key = byte0 & 0x3f;
    const instrument = (byte0 >>> 6) | ((byte1 & 1) << 2);
    const volumeValue = (byte1 >>> 1) & 7;
    const effect = (byte1 >>> 4) & 7;
    const filters = this.#ram[this.#sfxAddress(voice.sfx) + 64]!;
    const fraction = voice.offset - note;
    let volume = volumeValue / 7;
    let frequency = keyToFrequency(key) * frequencyFactor;
    if (volume > 0) {
      switch (effect) {
        case 1:
          frequency = keyToFrequency(voice.previousKey) * frequencyFactor * (1 - fraction) +
            frequency * fraction;
          if (voice.previousVolume > 0) {
            volume = voice.previousVolume * (1 - fraction) + volume * fraction;
          }
          break;
        case 2: {
          const cycle = voice.elapsed * 7.5 / PICO_AUDIO_SAMPLE_RATE;
          const triangle = 1 - 4 * Math.abs((cycle % 1) - 0.5);
          frequency *= 2 ** (triangle * 0.5 / 12);
          break;
        }
        case 3:
          frequency *= 1 - fraction;
          break;
        case 4:
          volume *= fraction;
          break;
        case 5:
          volume *= 1 - fraction;
          break;
        case 6:
        case 7: {
          const speed = Math.max(1, this.#ram[this.#sfxAddress(voice.sfx) + 65]!);
          const subdivisions = effect === 6 ? (speed <= 8 ? 2 : 4) : (speed <= 8 ? 4 : 8);
          const arpNote = (note & ~3) | (Math.floor(fraction * subdivisions) & 3);
          const arpAddress = this.#sfxAddress(voice.sfx) + arpNote * NOTE_BYTES;
          frequency = keyToFrequency(this.#ram[arpAddress]! & 0x3f) * frequencyFactor;
          break;
        }
      }
    }
    if ((this.#ram[AUDIO_HALF_RATE]! & (1 << (channel + 4))) !== 0) frequency *= 0.5;
    return {
      note,
      key,
      instrument,
      custom: !ignoreCustom && (byte1 & 0x80) !== 0,
      effect,
      filters,
      frequency,
      volume,
    };
  }

  #advanceVoice(
    voice: VoiceState,
    channel: number,
    length: number,
    canLoop: boolean,
    isMusic: boolean,
  ): void {
    if (voice.sfx < 0) return;
    const base = this.#sfxAddress(voice.sfx);
    const speed = Math.max(1, this.#ram[base + 65]!);
    const rateScale = (this.#ram[AUDIO_HALF_RATE]! & (1 << channel)) !== 0 ? 0.5 : 1;
    const step = rateScale / (NOTE_SAMPLES_PER_SPEED * speed);
    const oldNote = Math.floor(voice.offset);
    let nextOffset = voice.offset + step;
    voice.time += step;
    voice.elapsed += 1;
    const loopStart = this.#ram[base + 66]!;
    const loopEnd = this.#ram[base + 67]!;
    if (canLoop && loopEnd > loopStart && nextOffset >= loopEnd) {
      nextOffset = ((nextOffset - loopStart) % (loopEnd - loopStart)) + loopStart;
      voice.loopEpoch += 1;
    }
    if (Math.floor(nextOffset) !== oldNote && oldNote >= 0 && oldNote < NOTES_PER_SFX) {
      const noteAddress = base + oldNote * NOTE_BYTES;
      voice.previousKey = this.#ram[noteAddress]! & 0x3f;
      voice.previousVolume = ((this.#ram[noteAddress + 1]! >>> 1) & 7) / 7;
    }
    voice.offset = nextOffset;
    let end = NOTES_PER_SFX;
    if (length > 0) end = Math.min(end, length);
    if (!isMusic && loopEnd === 0 && loopStart > 0) end = Math.min(end, loopStart);
    if (!isMusic && !(canLoop && loopEnd > loopStart)) {
      end = Math.min(end, this.#lastAudibleNote(voice.sfx));
    }
    if (voice.time >= end || voice.offset >= NOTES_PER_SFX) voice.sfx = -1;
  }

  #sampleWaveform(parameters: SynthParameters, voice: VoiceState): number {
    const primary = this.#waveform(parameters.instrument, parameters.key, parameters.filters, voice, 1);
    const detune = Math.floor(parameters.filters / 8) % 3;
    let waveform = primary;
    if (detune !== 0 && parameters.instrument !== 6) {
      let factor: number;
      if (parameters.instrument === 0) factor = detune === 1 ? 3 / 4 : 3 / 2;
      else if (parameters.instrument === 5) factor = detune === 1 ? 200 / 199 : 800 / 199;
      else if (parameters.instrument === 7) factor = detune === 1 ? 49 / 50 : 400 / 199;
      else factor = detune === 1 ? 200 / 199 : 400 / 199;
      const secondInstrument = detune === 2 && parameters.instrument === 5
        ? 0
        : parameters.instrument;
      waveform += this.#waveform(secondInstrument, parameters.key, parameters.filters, voice, factor) * 0.5;
    }
    voice.phase += parameters.frequency / PICO_AUDIO_SAMPLE_RATE;
    if (voice.phase >= 4096) voice.phase %= 1;
    return waveform;
  }

  #waveform(
    instrument: number,
    key: number,
    filters: number,
    voice: VoiceState,
    phaseFactor: number,
  ): number {
    const phase = voice.phase * phaseFactor;
    const t = phase - Math.floor(phase);
    const noiseMode = (filters & 0x2) !== 0;
    const buzz = (filters & 0x4) !== 0;
    switch (instrument) {
      case 0: {
        let result = 1 - Math.abs(4 * t - 2);
        if (buzz) {
          const edge = 0.875;
          const tilted = t < edge ? 2 * t / edge - 1 : 2 * (1 - t) / (1 - edge) - 1;
          result = result * 0.75 + tilted * 0.25;
        }
        return result * 0.5;
      }
      case 1: {
        const edge = buzz ? 0.975 : 0.875;
        return (t < edge ? 2 * t / edge - 1 : 2 * (1 - t) / (1 - edge) - 1) * 0.5;
      }
      case 2: {
        let result = t < 0.5 ? t : t - 1;
        if (buzz) result = result * 0.83 - (Math.abs((phase % 2) - 1) < 0.5 ? 0.085 : 0);
        return result * 0.653;
      }
      case 3:
        return t < (buzz ? 0.4 : 0.5) ? 0.25 : -0.25;
      case 4:
        return t < (buzz ? 0.255 : 0.316) ? 0.25 : -0.25;
      case 5: {
        let result = t < 0.5 ? 3 - Math.abs(24 * t - 6) : 1 - Math.abs(16 * t - 12);
        if (buzz) {
          result = t < 0.5 ? result * 2 + 3 : result;
          result = t < 0.5 && result > -1.875 ? result * 0.2 - 1 : result + 0.5;
        }
        return result / 9;
      }
      case 6: {
        let state = voice.noiseState >>> 0;
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        voice.noiseState = state >>> 0 || BASE_NOISE_SEED;
        const random = voice.noiseState / 0x7fff_ffff - 1;
        const smoothing = clamp(keyToFrequency(key) * 8.858923 / PICO_AUDIO_SAMPLE_RATE, 0, 1);
        voice.noiseValue += (random - voice.noiseValue) * smoothing;
        let result = voice.noiseValue * 1.5 * (1 + (1 - key / 63) ** 2);
        if (noiseMode) result *= 2 * (t < 0.5 ? t : t - 1);
        return result;
      }
      case 7: {
        let result = 2 - Math.abs(8 * t - 4);
        result += 1 - Math.abs(4 * ((phase * 109 / 110) % 1) - 2);
        if (buzz) {
          result += 0.25 - Math.abs(((phase * 2 + 0.5) % 1) - 0.5);
          result += 0.125 - Math.abs(0.5 * ((phase * 4) % 1) - 0.25);
        }
        return result / 6;
      }
      default:
        return 0;
    }
  }

  #sfxAddress(sfx: number): number {
    return SFX_BASE + sfx * SFX_BYTES;
  }

  #hasLoop(sfx: number): boolean {
    const base = this.#sfxAddress(sfx);
    return this.#ram[base + 67]! > this.#ram[base + 66]!;
  }

  #lastAudibleNote(sfx: number): number {
    const base = this.#sfxAddress(sfx);
    let last = 0;
    for (let note = 0; note < NOTES_PER_SFX; note += 1) {
      if (((this.#ram[base + note * NOTE_BYTES + 1]! >>> 1) & 7) !== 0) last = note + 1;
    }
    return last;
  }
}
