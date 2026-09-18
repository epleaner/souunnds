import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  applyPlaybackAdsr,
  decodeWav,
  encodeWav,
  generateArrangement,
  findAudibleStart,
  renderArrangement,
  renderSequencerAsync,
  scheduleSequencer,
  sourceSegmentRms,
  stretchPcm,
  type Arrangement,
  type PcmAudio,
} from "./audio";

function toneAudio(): PcmAudio {
  const samples = new Float32Array(16);
  for (let index = 0; index < samples.length; index += 1) samples[index] = index / samples.length;
  return { sampleRate: 8, channels: 1, samples };
}

describe("audio core", () => {
  it("round-trips PCM WAV data with its format metadata", () => {
    const decoded = decodeWav(encodeWav(toneAudio()));
    expect(decoded.sampleRate).toBe(8);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(16);
    expect(decoded.samples[15]).toBeCloseTo(15 / 16, 3);
  });

  it("stretches the selected segment once", () => {
    const stretched = stretchPcm(toneAudio(), { start: 0.5, end: 1.5 }, {
      ...DEFAULT_PARAMS,
      stretch: 2,
      windowSeconds: 0.5,
      overlap: 0.5,
    });
    expect(stretched.sampleRate).toBe(8);
    expect(stretched.samples.length).toBe(16);
    expect([...stretched.samples].every((sample) => Number.isFinite(sample))).toBe(true);
  });

  it("mixes layers at their requested offsets", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "a", name: "A", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false },
        { id: "b", name: "B", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 1, gain: 1, muted: false },
      ],
      sequencers: [],
    };
    const mixed = renderArrangement(toneAudio(), arrangement);
    expect(mixed.samples.length).toBe(16);
    expect(mixed.samples[1]).not.toBe(0);
    expect(mixed.samples[9]).not.toBe(0);
  });

  it("generates the same arrangement for the same seed", () => {
    const first = generateArrangement(20, { count: 3, seed: 42, linked: false });
    const second = generateArrangement(20, { count: 3, seed: 42, linked: false });
    expect(second).toEqual(first);
  });


  it("chooses audible source regions for generated layers", () => {
    const samples = new Float32Array(1000);
    samples.fill(1, 200, 800);
    const source = { sampleRate: 100, channels: 1, samples };
    const arrangement = generateArrangement(10, { count: 3, seed: 42, linked: false }, source);
    for (const layer of arrangement.layers) {
      const start = Math.floor(layer.segment.start * source.sampleRate);
      const end = Math.ceil(layer.segment.end * source.sampleRate);
      expect(source.samples.subarray(start, end).some((sample) => sample !== 0)).toBe(true);
    }
  });

  it("applies a global playback ADSR envelope", () => {
    const audio: PcmAudio = { sampleRate: 4, channels: 1, samples: new Float32Array([1, 1, 1, 1, 1, 1]) };
    const enveloped = applyPlaybackAdsr(audio, { attackSeconds: 0.25, decaySeconds: 0.25, sustainLevel: 0.5, releaseSeconds: 0.25 });
    expect([...enveloped.samples]).toEqual([0, 1, 0.5, 0.5, 0.5, 0]);
  });
  it("restarts playback ADSR for each sequence cell", async () => {
    const audio: PcmAudio = { sampleRate: 4, channels: 1, samples: new Float32Array(8).fill(1) };
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          baseLengthSeconds: 1,
          steps: [
            { targetId: "layer", targetType: "layer", repeats: 1, length: 1 },
            { targetId: "layer", targetType: "layer", repeats: 1, length: 1 },
          ],
        },
      ],
    };
    const rendered = await renderSequencerAsync(audio, arrangement, "main", async (input) => input, {
      attackSeconds: 0.25,
      decaySeconds: 0,
      sustainLevel: 0.5,
      releaseSeconds: 0.25,
    });
    expect([...rendered.samples]).toEqual([0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0]);
  });

  it("finds a non-silent window even when audio is sparse", () => {
    const samples = new Float32Array(1000);
    samples.fill(1, 800, 900);
    const source = { sampleRate: 100, channels: 1, samples };
    const start = findAudibleStart(source, 0.5);
    expect(sourceSegmentRms(source, { start, end: start + 0.5 })).toBeGreaterThan(0);
  });
  it("schedules nested sequencers in order", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        { id: "child", name: "Child", steps: [{ targetId: "layer", targetType: "layer", repeats: 1, length: 1 }] },
        { id: "main", name: "Main", gapLengthSeconds: 1, steps: [{ targetId: "child", targetType: "sequencer", repeats: 2, length: 1 }] },
      ],
    };
    expect(scheduleSequencer(arrangement, "main", { layer: 1 })).toEqual([
      { layerId: "layer", startSeconds: 0, durationSeconds: 1, loop: true },
      { layerId: "layer", startSeconds: 2, durationSeconds: 1, loop: true },
    ]);
  });

  it("scales sequence cell timing by relative length", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          steps: [
            { targetId: "layer", targetType: "layer", repeats: 1, length: 0.5 },
            { targetId: "layer", targetType: "layer", repeats: 1, length: 2 },
          ],
        },
      ],
    };
    expect(scheduleSequencer(arrangement, "main", { layer: 1 })).toEqual([
      { layerId: "layer", startSeconds: 0, durationSeconds: 0.5, loop: true },
      { layerId: "layer", startSeconds: 0.5, durationSeconds: 2, loop: true },
    ]);
  });

  it("multiplies relative lengths by the sequence base length", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          baseLengthSeconds: 2,
          steps: [
            { targetId: "layer", targetType: "layer", repeats: 1, length: 0.5 },
            { targetId: "layer", targetType: "layer", repeats: 1, length: 1.5 },
          ],
        },
      ],
    };
    expect(scheduleSequencer(arrangement, "main", { layer: 1 })).toEqual([
      { layerId: "layer", startSeconds: 0, durationSeconds: 1, loop: true },
      { layerId: "layer", startSeconds: 1, durationSeconds: 3, loop: true },
    ]);
  });

  it("loops rendered layer audio to fill longer cells", async () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          steps: [{ targetId: "layer", targetType: "layer", repeats: 1, length: 2 }],
        },
      ],
    };
    const rendered = await renderSequencerAsync(toneAudio(), arrangement, "main", async (audio, segment, params) => stretchPcm(audio, segment, params));
    expect(rendered.samples.length).toBe(16);
    expect(rendered.samples[9]).toBeCloseTo(rendered.samples[1], 5);
  });

  it("plays through once when sequence looping is disabled", async () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          baseLengthSeconds: 2,
          loopLayers: false,
          steps: [{ targetId: "layer", targetType: "layer", repeats: 1, length: 1 }],
        },
      ],
    };
    const rendered = await renderSequencerAsync(toneAudio(), arrangement, "main", async (audio, segment, params) => stretchPcm(audio, segment, params));
    expect(rendered.samples.length).toBe(16);
    expect(rendered.samples[9]).toBe(0);
  });

  it("renders only layers referenced by a sequence", async () => {
    let renderCount = 0;
    const arrangement: Arrangement = {
      layers: [
        { id: "used", name: "Used", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false },
        { id: "unused", name: "Unused", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        { id: "main", name: "Main", steps: [{ targetId: "used", targetType: "layer", repeats: 1, length: 1 }] },
      ],
    };
    await renderSequencerAsync(toneAudio(), arrangement, "main", async (audio, segment, params) => {
      renderCount += 1;
      return stretchPcm(audio, segment, params);
    });
    expect(renderCount).toBe(1);
  });

  it("reuses rendered layers across sequences when a cache is provided", async () => {
    let renderCount = 0;
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        { id: "first", name: "First", steps: [{ targetId: "layer", targetType: "layer", repeats: 1, length: 1 }] },
        { id: "second", name: "Second", steps: [{ targetId: "layer", targetType: "layer", repeats: 1, length: 1 }] },
      ],
    };
    const renderedLayers = new Map<string, PcmAudio>();
    const stretch = async (audio: PcmAudio, segment: Arrangement["layers"][number]["segment"], params: Arrangement["layers"][number]["params"]) => {
      renderCount += 1;
      return stretchPcm(audio, segment, params);
    };
    await renderSequencerAsync(toneAudio(), arrangement, "first", stretch, undefined, renderedLayers);
    await renderSequencerAsync(toneAudio(), arrangement, "second", stretch, undefined, renderedLayers);
    expect(renderCount).toBe(1);
  });

  it("applies a per-sequence gap between cells", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          gapLengthSeconds: 2,
          steps: [
            { targetId: "layer", targetType: "layer", repeats: 1, length: 1 },
            { targetId: "layer", targetType: "layer", repeats: 1, length: 1 },
          ],
        },
      ],
    };
    expect(scheduleSequencer(arrangement, "main", { layer: 1 })).toEqual([
      { layerId: "layer", startSeconds: 0, durationSeconds: 1, loop: true },
      { layerId: "layer", startSeconds: 3, durationSeconds: 1, loop: true },
    ]);
  });
});
