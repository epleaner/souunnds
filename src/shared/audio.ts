import { nextPastelLayerColor } from "./layer-colors";

export interface PcmAudio {
  sampleRate: number;
  channels: number;
  /** Interleaved samples in the range [-1, 1]. */
  samples: Float32Array;
}

export interface PlaybackAdsr {
  attackSeconds: number;
  decaySeconds: number;
  sustainLevel: number;
  releaseSeconds: number;
}

export const DEFAULT_PLAYBACK_ADSR: PlaybackAdsr = {
  attackSeconds: 1,
  decaySeconds: 0.8,
  sustainLevel: 0.72,
  releaseSeconds: 0.4,
};

function playbackAdsrGain(
  frame: number,
  frames: number,
  attackFrames: number,
  decayFrames: number,
  sustainLevel: number,
  releaseFrames: number,
): number {
  let gain = sustainLevel;
  if (attackFrames > 0 && frame < attackFrames) {
    gain = frame / attackFrames;
  } else if (decayFrames > 0 && frame < attackFrames + decayFrames) {
    gain = 1 - ((1 - sustainLevel) * (frame - attackFrames)) / decayFrames;
  }
  const releaseStart = Math.max(0, frames - releaseFrames);
  if (releaseFrames > 0 && frame >= releaseStart) {
    gain *= Math.max(0, (frames - frame - 1) / releaseFrames);
  }
  return gain;
}

export function applyPlaybackAdsr(audio: PcmAudio, adsr: PlaybackAdsr): PcmAudio {
  const attackFrames = Math.max(0, Math.round(adsr.attackSeconds * audio.sampleRate));
  const decayFrames = Math.max(0, Math.round(adsr.decaySeconds * audio.sampleRate));
  const releaseFrames = Math.max(0, Math.round(adsr.releaseSeconds * audio.sampleRate));
  const sustainLevel = Math.min(1, Math.max(0, adsr.sustainLevel));
  if (!attackFrames && !decayFrames && !releaseFrames && sustainLevel === 1) return audio;

  const frames = frameCount(audio);
  const output = new Float32Array(audio.samples.length);
  for (let frame = 0; frame < frames; frame += 1) {
    const gain = playbackAdsrGain(frame, frames, attackFrames, decayFrames, sustainLevel, releaseFrames);
    for (let channel = 0; channel < audio.channels; channel += 1) {
      output[frame * audio.channels + channel] = audio.samples[frame * audio.channels + channel] * gain;
    }
  }
  return { ...audio, samples: output };
}
export interface StretchParams {
  stretch: number;
  windowSeconds: number;
  overlap: number;
  onset: number;
  seed: number;
}

export interface Segment {
  start: number;
  end: number;
}

export interface Layer {
  id: string;
  sourceId?: string;
  name: string;
  color: string;
  segment: Segment;
  params: StretchParams;
  offsetSeconds: number;
  gain: number;
  muted: boolean;
  triggerMode: "gate" | "one-shot";
}

export interface SequenceStep {
  id: string;
  targetId: string;
  targetType: "layer" | "sequencer";
  startSeconds: number;
  durationSeconds: number;
  repeatFill: boolean;
  muted: boolean;
}

export interface Sequencer {
  id: string;
  name: string;
  muted: boolean;
  durationSeconds: number;
  steps: SequenceStep[];
}

export interface Arrangement {
  layers: Layer[];
  sequencers: Sequencer[];
}
export type StretchFunction = (audio: PcmAudio, segment: Segment, params: StretchParams) => PcmAudio;
export type AsyncStretchFunction = (audio: PcmAudio, segment: Segment, params: StretchParams) => Promise<PcmAudio>;

export interface ScheduledLayer {
  layerId: string;
  startSeconds: number;
  durationSeconds: number;
  loop: boolean;
}

export const DEFAULT_PARAMS: StretchParams = {
  stretch: 8,
  windowSeconds: 0.25,
  overlap: 0.75,
  onset: 0,
  seed: 11,
};

export function frameCount(audio: PcmAudio): number {
  return Math.floor(audio.samples.length / audio.channels);
}

export function fitPcmDuration(audio: PcmAudio, durationSeconds: number, loop = false): PcmAudio {
  const targetFrames = Math.max(1, Math.round(positive(durationSeconds, 0) * audio.sampleRate));
  const targetSamples = targetFrames * audio.channels;
  if (audio.samples.length === targetSamples) return audio;
  const samples = new Float32Array(targetSamples);
  if (!audio.samples.length || !loop) {
    samples.set(audio.samples.subarray(0, targetSamples));
    return { ...audio, samples };
  }
  for (let index = 0; index < targetSamples; index += 1) {
    samples[index] = audio.samples[index % audio.samples.length];
  }
  return { ...audio, samples };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function seededRandom(seed: number): () => number {
  let state = (Math.floor(seed) >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Decode a little-endian PCM WAV file. The CLI intentionally stays dependency-free
 * and supports the common 16-bit PCM and 32-bit float variants.
 */
export function decodeWav(input: ArrayBuffer | Uint8Array): PcmAudio {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));

  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE file.");
  }

  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
    } else if (id === "data") {
      dataOffset = chunkStart;
      dataSize = Math.min(size, view.byteLength - chunkStart);
      break;
    }
    offset = chunkStart + size + (size % 2);
  }

  if (!channels || !sampleRate || dataOffset < 0) {
    throw new Error("WAV file is missing format or audio data.");
  }
  if (format !== 1 && format !== 3) {
    throw new Error("Only PCM and IEEE float WAV files are supported.");
  }
  if ((format === 1 && bitsPerSample !== 16) || (format === 3 && bitsPerSample !== 32)) {
    throw new Error("Only 16-bit PCM or 32-bit float WAV files are supported.");
  }

  const bytesPerSample = bitsPerSample / 8;
  const sampleTotal = Math.floor(dataSize / bytesPerSample);
  const samples = new Float32Array(sampleTotal);
  for (let index = 0; index < sampleTotal; index += 1) {
    const position = dataOffset + index * bytesPerSample;
    samples[index] = format === 1
      ? view.getInt16(position, true) / 32768
      : clamp(view.getFloat32(position, true), -1, 1);
  }

  return { sampleRate, channels, samples };
}

export function encodeWav(audio: PcmAudio): Uint8Array {
  const dataSize = audio.samples.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, audio.channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * audio.channels * 2, true);
  view.setUint16(32, audio.channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < audio.samples.length; index += 1) {
    const sample = clamp(audio.samples[index], -1, 1);
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return bytes;
}

/**
 * Stretch a segment with deterministic windowed granular overlap/add. It is
 * deliberately stream-friendly: grains are short, overlap is configurable,
 * and the selected segment is rendered once.
 */
export function stretchPcm(audio: PcmAudio, segment: Segment, params: StretchParams): PcmAudio {
  const totalFrames = frameCount(audio);
  if (totalFrames === 0) return { ...audio, samples: new Float32Array() };

  const startFrame = clamp(Math.floor(Math.min(segment.start, segment.end) * audio.sampleRate), 0, totalFrames - 1);
  const endFrame = clamp(Math.ceil(Math.max(segment.start, segment.end) * audio.sampleRate), startFrame + 1, totalFrames);
  const sourceFrames = Math.max(1, endFrame - startFrame);
  const stretch = positive(params.stretch, 1);
  const targetFrames = Math.max(1, Math.round(sourceFrames * stretch));
  const grainFrames = clamp(Math.round(positive(params.windowSeconds, 0.25) * audio.sampleRate), 64, sourceFrames);
  const overlap = clamp(params.overlap, 0, 0.95);
  const hopFrames = Math.max(1, Math.round(grainFrames * (1 - overlap)));
  const output = new Float32Array(targetFrames * audio.channels);
  const weights = new Float32Array(targetFrames);
  const random = seededRandom(params.seed);

  for (let outputStart = 0; outputStart < targetFrames; outputStart += hopFrames) {
    const progress = outputStart / targetFrames;
    const sourceProgress = progress;
    const center = startFrame + Math.floor(sourceProgress * sourceFrames);
    const jitter = Math.floor((random() - 0.5) * grainFrames);
    const grainStart = center + jitter - Math.floor(grainFrames / 2);

    for (let grainIndex = 0; grainIndex < grainFrames; grainIndex += 1) {
      const outputFrame = outputStart + grainIndex;
      if (outputFrame >= targetFrames) break;
      const sourceFrame = startFrame + mod(grainStart + grainIndex - startFrame, sourceFrames);
      const normalized = grainIndex / Math.max(1, grainFrames - 1);
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * normalized);
      weights[outputFrame] += window;
      for (let channel = 0; channel < audio.channels; channel += 1) {
        output[outputFrame * audio.channels + channel] +=
          audio.samples[sourceFrame * audio.channels + channel] * window;
      }
    }
  }

  let peak = 0;
  for (let frame = 0; frame < targetFrames; frame += 1) {
    const weight = weights[frame] || 1;
    for (let channel = 0; channel < audio.channels; channel += 1) {
      const index = frame * audio.channels + channel;
      output[index] /= weight;
      peak = Math.max(peak, Math.abs(output[index]));
    }
  }
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let index = 0; index < output.length; index += 1) output[index] *= scale;
  }

  return { sampleRate: audio.sampleRate, channels: audio.channels, samples: output };
}

function sourceForLayer(
  audio: PcmAudio,
  layer: Layer,
  sources?: ReadonlyMap<string, PcmAudio>,
): PcmAudio {
  if (!sources || layer.sourceId === undefined) return audio;
  const source = sources.get(layer.sourceId);
  if (!source) throw new Error(`Audio source "${layer.sourceId}" for layer "${layer.id}" is missing.`);
  return source;
}

function mixedSample(clip: PcmAudio, frame: number, channel: number, outputChannels: number): number {
  const base = frame * clip.channels;
  if (outputChannels === 1 && clip.channels > 1) {
    let sum = 0;
    for (let index = 0; index < clip.channels; index += 1) sum += clip.samples[base + index];
    return sum / clip.channels;
  }
  return clip.samples[base + Math.min(channel, clip.channels - 1)];
}

function mixArrangementLayers(
  audio: PcmAudio,
  rendered: Array<{ layer: Layer; audio: PcmAudio }>,
): PcmAudio {
  const totalFrames = rendered.reduce((longest, item) => {
    if (item.layer.muted) return longest;
    return Math.max(longest, Math.floor(item.layer.offsetSeconds * audio.sampleRate) + frameCount(item.audio));
  }, 1);
  const output = new Float32Array(totalFrames * audio.channels);

  for (const item of rendered) {
    if (item.layer.muted) continue;
    const startFrame = Math.max(0, Math.floor(item.layer.offsetSeconds * audio.sampleRate));
    for (let frame = 0; frame < frameCount(item.audio); frame += 1) {
      const outputFrame = startFrame + frame;
      if (outputFrame >= totalFrames) break;
      for (let channel = 0; channel < audio.channels; channel += 1) {
        const index = outputFrame * audio.channels + channel;
        output[index] += mixedSample(item.audio, frame, channel, audio.channels) * item.layer.gain;
      }
    }
  }

  let peak = 0;
  for (const sample of output) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let index = 0; index < output.length; index += 1) output[index] *= scale;
  }
  return { sampleRate: audio.sampleRate, channels: audio.channels, samples: output };
}

export function renderArrangement(
  audio: PcmAudio,
  arrangement: Arrangement,
  stretch: StretchFunction = stretchPcm,
  sources?: ReadonlyMap<string, PcmAudio>,
): PcmAudio {
  const rendered: Array<{ layer: Layer; audio: PcmAudio }> = [];
  for (const layer of arrangement.layers) {
    if (layer.muted) continue;
    rendered.push({ layer, audio: stretch(sourceForLayer(audio, layer, sources), layer.segment, layer.params) });
  }
  return mixArrangementLayers(audio, rendered);
}

export async function renderArrangementAsync(
  audio: PcmAudio,
  arrangement: Arrangement,
  stretch: AsyncStretchFunction,
  sources?: ReadonlyMap<string, PcmAudio>,
): Promise<PcmAudio> {
  const rendered: { layer: Layer; audio: PcmAudio }[] = [];
  for (const layer of arrangement.layers) {
    if (layer.muted) continue;
    rendered.push({ layer, audio: await stretch(sourceForLayer(audio, layer, sources), layer.segment, layer.params) });
  }
  return mixArrangementLayers(audio, rendered);
}

export function scheduleSequencer(
  arrangement: Arrangement,
  sequencerId: string,
): ScheduledLayer[] {
  const sequencers = new Map(arrangement.sequencers.map((sequencer) => [sequencer.id, sequencer]));
  const layers = new Set(arrangement.layers.map((layer) => layer.id));
  const scheduled: ScheduledLayer[] = [];
  const active = new Set<string>();

  const schedule = (id: string, origin: number, durationLimit?: number): number => {
    if (active.has(id)) throw new Error(`Sequencer cycle detected at ${id}.`);
    const sequencer = sequencers.get(id);
    if (!sequencer) return 0;
    active.add(id);
    const timelineDuration = Math.min(
      positive(sequencer.durationSeconds, 0.25),
      durationLimit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, durationLimit),
    );
    const steps = [...sequencer.steps].sort((left, right) => left.startSeconds - right.startSeconds);
    for (const step of steps) {
      if (step.muted) continue;
      const relativeStart = Math.max(0, step.startSeconds);
      if (relativeStart >= timelineDuration) continue;
      const duration = Math.min(positive(step.durationSeconds, 0.25), timelineDuration - relativeStart);
      const start = origin + relativeStart;
      if (step.targetType === "layer") {
        if (layers.has(step.targetId)) {
          scheduled.push({
            layerId: step.targetId,
            startSeconds: start,
            durationSeconds: duration,
            loop: step.repeatFill,
          });
        }
        continue;
      }

      const childDuration = schedule(step.targetId, start, duration);
      if (step.repeatFill && childDuration > 0) {
        for (let offset = childDuration; offset < duration; offset += childDuration) {
          schedule(step.targetId, start + offset, Math.min(childDuration, duration - offset));
        }
      }
    }
    active.delete(id);
    return timelineDuration;
  };

  schedule(sequencerId, 0);
  return scheduled;
}

function mixScheduledLayers(
  audio: PcmAudio,
  arrangement: Arrangement,
  schedule: ScheduledLayer[],
  rendered: Map<string, PcmAudio>,
  durationSeconds: number,
  adsr?: PlaybackAdsr,
): PcmAudio {
  const layerMap = new Map(arrangement.layers.map((layer) => [layer.id, layer]));
  const envelope = adsr ? {
    attackFrames: Math.max(0, Math.round(adsr.attackSeconds * audio.sampleRate)),
    decayFrames: Math.max(0, Math.round(adsr.decaySeconds * audio.sampleRate)),
    sustainLevel: Math.min(1, Math.max(0, adsr.sustainLevel)),
    releaseFrames: Math.max(0, Math.round(adsr.releaseSeconds * audio.sampleRate)),
  } : null;
  const totalFrames = Math.max(1, Math.round(positive(durationSeconds, 0.25) * audio.sampleRate));
  const output = new Float32Array(totalFrames * audio.channels);
  for (const item of schedule) {
    const clip = rendered.get(item.layerId);
    const layer = layerMap.get(item.layerId);
    if (!clip || !layer || layer.muted) continue;
    const startFrame = Math.floor(item.startSeconds * audio.sampleRate);
    const clipFrames = frameCount(clip);
    if (!clipFrames) continue;
    const targetFrames = Math.max(1, Math.round(item.durationSeconds * audio.sampleRate));
    const framesToMix = item.loop ? targetFrames : Math.min(targetFrames, clipFrames);
    for (let frame = 0; frame < framesToMix; frame += 1) {
      const clipFrame = item.loop ? frame % clipFrames : frame;
      const outputFrame = startFrame + frame;
      if (outputFrame >= totalFrames) break;
      const envelopeGain = envelope
        ? playbackAdsrGain(frame, framesToMix, envelope.attackFrames, envelope.decayFrames, envelope.sustainLevel, envelope.releaseFrames)
        : 1;
      for (let channel = 0; channel < audio.channels; channel += 1) {
        output[outputFrame * audio.channels + channel] +=
          mixedSample(clip, clipFrame, channel, audio.channels) * layer.gain * envelopeGain;
      }
    }
  }
  let peak = 0;
  for (const sample of output) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let index = 0; index < output.length; index += 1) output[index] *= scale;
  }
  return { sampleRate: audio.sampleRate, channels: audio.channels, samples: output };
}

function sequenceSchedule(
  arrangement: Arrangement,
  sequencerId: string,
): ScheduledLayer[] {
  return scheduleSequencer(arrangement, sequencerId);
}

export function renderSequencer(
  audio: PcmAudio,
  arrangement: Arrangement,
  sequencerId: string,
  stretch: StretchFunction = stretchPcm,
  adsr?: PlaybackAdsr,
  sources?: ReadonlyMap<string, PcmAudio>,
): PcmAudio {
  const schedule = sequenceSchedule(arrangement, sequencerId);
  const sequenceDuration = arrangement.sequencers.find((sequence) => sequence.id === sequencerId)?.durationSeconds ?? 0.25;
  const requiredLayerIds = new Set(schedule.map((item) => item.layerId));
  const rendered = new Map<string, PcmAudio>();
  for (const layer of arrangement.layers) {
    if (layer.muted || !requiredLayerIds.has(layer.id)) continue;
    rendered.set(layer.id, stretch(sourceForLayer(audio, layer, sources), layer.segment, layer.params));
  }
  return mixScheduledLayers(audio, arrangement, schedule, rendered, sequenceDuration, adsr);
}

export async function renderSequencerAsync(
  audio: PcmAudio,
  arrangement: Arrangement,
  sequencerId: string,
  stretch: AsyncStretchFunction,
  adsr?: PlaybackAdsr,
  renderedLayers: Map<string, PcmAudio> = new Map(),
  sources?: ReadonlyMap<string, PcmAudio>,
): Promise<PcmAudio> {
  const schedule = sequenceSchedule(arrangement, sequencerId);
  const sequenceDuration = arrangement.sequencers.find((sequence) => sequence.id === sequencerId)?.durationSeconds ?? 0.25;
  const requiredLayerIds = new Set(schedule.map((item) => item.layerId));
  for (const layer of arrangement.layers) {
    if (!layer.muted && requiredLayerIds.has(layer.id) && !renderedLayers.has(layer.id)) {
      renderedLayers.set(layer.id, await stretch(sourceForLayer(audio, layer, sources), layer.segment, layer.params));
    }
  }
  return mixScheduledLayers(audio, arrangement, schedule, renderedLayers, sequenceDuration, adsr);
}

export function sourceSegmentRms(audio: PcmAudio, segment: Segment): number {
  const sourceFrames = frameCount(audio);
  const startFrame = Math.max(0, Math.min(sourceFrames, Math.floor(Math.min(segment.start, segment.end) * audio.sampleRate)));
  const endFrame = Math.max(startFrame + 1, Math.min(sourceFrames, Math.ceil(Math.max(segment.start, segment.end) * audio.sampleRate)));
  const segmentFrames = endFrame - startFrame;
  if (!segmentFrames) return 0;
  const step = Math.max(1, Math.floor(segmentFrames / 64));
  let energy = 0;
  let count = 0;
  for (let frame = 0; frame < segmentFrames; frame += step) {
    for (let channel = 0; channel < audio.channels; channel += 1) {
      const sample = audio.samples[(startFrame + frame) * audio.channels + channel];
      energy += sample * sample;
      count += 1;
    }
  }
  return count ? energy / count : 0;
}

export function findAudibleStart(audio: PcmAudio, lengthSeconds: number): number {
  const sourceFrames = frameCount(audio);
  const segmentFrames = Math.max(1, Math.min(sourceFrames, Math.ceil(lengthSeconds * audio.sampleRate)));
  const maxStart = Math.max(0, sourceFrames - segmentFrames);
  let bestStart = 0;
  let bestEnergy = -1;
  for (let attempt = 0; attempt <= 128; attempt += 1) {
    const start = Math.floor((attempt / 128) * maxStart);
    const energy = sourceSegmentRms(audio, { start: start / audio.sampleRate, end: (start + segmentFrames) / audio.sampleRate });
    if (energy > bestEnergy) {
      bestStart = start;
      bestEnergy = energy;
    }
  }
  return bestStart / audio.sampleRate;
}

function audibleStart(
  audio: PcmAudio,
  lengthSeconds: number,
  random: () => number,
): number {
  const sourceFrames = frameCount(audio);
  const segmentFrames = Math.max(1, Math.min(sourceFrames, Math.ceil(lengthSeconds * audio.sampleRate)));
  const maxStart = Math.max(0, sourceFrames - segmentFrames);
  let bestStart = Math.floor(findAudibleStart(audio, lengthSeconds) * audio.sampleRate);
  let bestEnergy = sourceSegmentRms(audio, { start: bestStart / audio.sampleRate, end: (bestStart + segmentFrames) / audio.sampleRate });
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const start = Math.floor(random() * (maxStart + 1));
    const energy = sourceSegmentRms(audio, { start: start / audio.sampleRate, end: (start + segmentFrames) / audio.sampleRate });
    if (energy > bestEnergy) {
      bestStart = start;
      bestEnergy = energy;
    }
  }
  return bestStart / audio.sampleRate;
}

export function generateArrangement(
  durationSeconds: number,
  options: { count: number; seed: number; linked: boolean },
  audio?: PcmAudio,
): Arrangement {
  const random = seededRandom(options.seed);
  const colorRandom = seededRandom(options.seed + 0x9e3779b9);
  const layerColors: string[] = [];
  const count = Math.max(1, Math.floor(options.count));
  const sharedStretch = 2 + random() * 14;
  const layers: Layer[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = Math.max(0.15, durationSeconds * (0.08 + random() * 0.24));
    const start = audio
      ? audibleStart(audio, length, random)
      : durationSeconds <= length ? 0 : random() * (durationSeconds - length);
    const stretch = options.linked ? sharedStretch : 2 + random() * 18;
    const color = nextPastelLayerColor(layerColors, colorRandom);
    layerColors.push(color);
    layers.push({
      id: `generated-${index + 1}`,
      name: `Layer ${index + 1}`,
      color,
      segment: { start, end: Math.min(durationSeconds, start + length) },
      params: {
        ...DEFAULT_PARAMS,
        stretch,
        windowSeconds: 0.12 + random() * 0.5,
        onset: random() * 0.5,
        seed: Math.floor(random() * 100000),
      },
      offsetSeconds: random() * 3,
      gain: 0.65 / Math.sqrt(count),
      muted: false,
      triggerMode: "one-shot",
    });
  }
  return { layers, sequencers: [] };
}
