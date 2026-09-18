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
  sustainLevel: 0.7,
  releaseSeconds: 2,
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
  name: string;
  segment: Segment;
  params: StretchParams;
  offsetSeconds: number;
  gain: number;
  muted: boolean;
}

export interface SequenceStep {
  targetId: string;
  targetType: "layer" | "sequencer";
  repeats: number;
  length: number;
}

export interface Sequencer {
  id: string;
  name: string;
  baseLengthSeconds?: number;
  gapLengthSeconds?: number;
  loopLayers?: boolean;
  loopSequence?: boolean;
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

export function fitPcmDuration(audio: PcmAudio, durationSeconds: number): PcmAudio {
  const targetFrames = Math.max(1, Math.round(positive(durationSeconds, 0) * audio.sampleRate));
  const targetSamples = targetFrames * audio.channels;
  if (audio.samples.length === targetSamples) return audio;
  const samples = new Float32Array(targetSamples);
  samples.set(audio.samples.subarray(0, targetSamples));
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
        output[index] += item.audio.samples[frame * audio.channels + channel] * item.layer.gain;
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
): PcmAudio {
  return mixArrangementLayers(audio, arrangement.layers.map((layer) => ({
    layer,
    audio: stretch(audio, layer.segment, layer.params),
  })));
}

export async function renderArrangementAsync(
  audio: PcmAudio,
  arrangement: Arrangement,
  stretch: AsyncStretchFunction,
): Promise<PcmAudio> {
  const rendered: { layer: Layer; audio: PcmAudio }[] = [];
  for (const layer of arrangement.layers) {
    rendered.push({ layer, audio: await stretch(audio, layer.segment, layer.params) });
  }
  return mixArrangementLayers(audio, rendered);
}

function layerDuration(layer: Layer, sourceSampleRate: number, sourceFrames: number): number {
  const segmentFrames = Math.max(1, Math.ceil((layer.segment.end - layer.segment.start) * sourceSampleRate));
  return (segmentFrames * positive(layer.params.stretch, 1)) / sourceSampleRate;
}

export function scheduleSequencer(
  arrangement: Arrangement,
  sequencerId: string,
  layerDurations: Record<string, number>,
): ScheduledLayer[] {
  const sequencers = new Map(arrangement.sequencers.map((sequencer) => [sequencer.id, sequencer]));
  const layers = new Map(arrangement.layers.map((layer) => [layer.id, layer]));
  const scheduled: ScheduledLayer[] = [];
  const active = new Set<string>();

  const schedule = (id: string, start: number): number => {
    if (active.has(id)) throw new Error(`Sequencer cycle detected at ${id}.`);
    const sequencer = sequencers.get(id);
    if (!sequencer) return 0;
    active.add(id);
    let cursor = start;
    const gapLength = positive(sequencer.gapLengthSeconds ?? 0, 0);
    for (let stepIndex = 0; stepIndex < sequencer.steps.length; stepIndex += 1) {
      const step = sequencer.steps[stepIndex];
      const repeats = Math.max(1, Math.floor(step.repeats));
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const naturalDuration = step.targetType === "layer"
          ? layerDurations[step.targetId] ?? (layers.get(step.targetId)?.params.stretch ?? 1)
          : schedule(step.targetId, cursor);
        const baseDuration = step.targetType === "layer"
          ? positive(sequencer.baseLengthSeconds ?? 0, naturalDuration)
          : naturalDuration;
        const duration = baseDuration * positive(step.length, 1);
        if (step.targetType === "layer" && layers.has(step.targetId)) {
          scheduled.push({
            layerId: step.targetId,
            startSeconds: cursor,
            durationSeconds: duration,
            loop: sequencer.loopLayers !== false,
          });
        }
        const isLast = stepIndex === sequencer.steps.length - 1 && repeat === repeats - 1;
        cursor += duration + (isLast ? 0 : gapLength);
      }
    }
    active.delete(id);
    return Math.max(0, cursor - start);
  };

  schedule(sequencerId, 0);
  return scheduled;
}

function mixScheduledLayers(
  audio: PcmAudio,
  arrangement: Arrangement,
  schedule: ScheduledLayer[],
  rendered: Map<string, PcmAudio>,
  adsr?: PlaybackAdsr,
): PcmAudio {
  const layerMap = new Map(arrangement.layers.map((layer) => [layer.id, layer]));
  const envelope = adsr ? {
    attackFrames: Math.max(0, Math.round(adsr.attackSeconds * audio.sampleRate)),
    decayFrames: Math.max(0, Math.round(adsr.decaySeconds * audio.sampleRate)),
    sustainLevel: Math.min(1, Math.max(0, adsr.sustainLevel)),
    releaseFrames: Math.max(0, Math.round(adsr.releaseSeconds * audio.sampleRate)),
  } : null;
  const totalFrames = schedule.reduce((longest, item) => {
    const clip = rendered.get(item.layerId);
    return clip
      ? Math.max(longest, Math.floor(item.startSeconds * audio.sampleRate) + Math.max(1, Math.round(item.durationSeconds * audio.sampleRate)))
      : longest;
  }, 1);
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
          clip.samples[clipFrame * audio.channels + channel] * layer.gain * envelopeGain;
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
  audio: PcmAudio,
  arrangement: Arrangement,
  sequencerId: string,
): ScheduledLayer[] {
  const layerDurations = Object.fromEntries(
    arrangement.layers.map((layer) => [layer.id, layerDuration(layer, audio.sampleRate, frameCount(audio))]),
  );
  return scheduleSequencer(arrangement, sequencerId, layerDurations);
}
export function sequenceCellDurations(
  audio: PcmAudio,
  arrangement: Arrangement,
  sequencerId: string,
): number[] {
  const sequence = arrangement.sequencers.find((item) => item.id === sequencerId);
  const layerDurations = new Map(
    arrangement.layers.map((layer) => [layer.id, layerDuration(layer, audio.sampleRate, frameCount(audio))]),
  );
  const gapLength = positive(sequence?.gapLengthSeconds ?? 0, 0);
  return sequence?.steps.map((step, index) => {
    const naturalDuration = layerDurations.get(step.targetId) ?? 0;
    const baseDuration = positive(sequence.baseLengthSeconds ?? 0, naturalDuration);
    const repeats = Math.max(1, Math.floor(step.repeats));
    const gaps = repeats - 1 + (index < sequence.steps.length - 1 ? 1 : 0);
    return baseDuration * positive(step.length, 1) * repeats + gapLength * gaps;
  }) ?? [];
}

export function renderSequencer(
  audio: PcmAudio,
  arrangement: Arrangement,
  sequencerId: string,
  stretch: StretchFunction = stretchPcm,
  adsr?: PlaybackAdsr,
): PcmAudio {
  const schedule = sequenceSchedule(audio, arrangement, sequencerId);
  const rendered = new Map(
    arrangement.layers.map((layer) => [layer.id, stretch(audio, layer.segment, layer.params)]),
  );
  return mixScheduledLayers(audio, arrangement, schedule, rendered, adsr);
}

export async function renderSequencerAsync(
  audio: PcmAudio,
  arrangement: Arrangement,
  sequencerId: string,
  stretch: AsyncStretchFunction,
  adsr?: PlaybackAdsr,
  renderedLayers: Map<string, PcmAudio> = new Map(),
): Promise<PcmAudio> {
  const schedule = sequenceSchedule(audio, arrangement, sequencerId);
  const requiredLayerIds = new Set(schedule.map((item) => item.layerId));
  for (const layer of arrangement.layers) {
    if (requiredLayerIds.has(layer.id) && !renderedLayers.has(layer.id)) {
      renderedLayers.set(layer.id, await stretch(audio, layer.segment, layer.params));
    }
  }
  return mixScheduledLayers(audio, arrangement, schedule, renderedLayers, adsr);
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
  const count = Math.max(1, Math.floor(options.count));
  const sharedStretch = 2 + random() * 14;
  const layers: Layer[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = Math.max(0.15, durationSeconds * (0.08 + random() * 0.24));
    const start = audio
      ? audibleStart(audio, length, random)
      : durationSeconds <= length ? 0 : random() * (durationSeconds - length);
    const stretch = options.linked ? sharedStretch : 2 + random() * 18;
    layers.push({
      id: `generated-${index + 1}`,
      name: `Generated layer ${index + 1}`,
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
    });
  }
  return { layers, sequencers: [] };
}
