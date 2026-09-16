import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  decodeWav,
  encodeWav,
  generateArrangement,
  renderArrangement,
  scheduleSequencer,
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

  it("stretches and repeats only the selected segment", () => {
    const stretched = stretchPcm(toneAudio(), { start: 0.5, end: 1.5 }, {
      ...DEFAULT_PARAMS,
      stretch: 2,
      loops: 2,
      windowSeconds: 0.5,
      overlap: 0.5,
    });
    expect(stretched.sampleRate).toBe(8);
    expect(stretched.samples.length).toBe(32);
    expect([...stretched.samples].every((sample) => Number.isFinite(sample))).toBe(true);
  });

  it("mixes layers at their requested offsets", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "a", name: "A", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1, loops: 1 }, offsetSeconds: 0, gain: 1, muted: false },
        { id: "b", name: "B", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1, loops: 1 }, offsetSeconds: 1, gain: 1, muted: false },
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
  it("schedules nested sequencers in order", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        { id: "child", name: "Child", steps: [{ targetId: "layer", targetType: "layer", repeats: 1, gapSeconds: 0.5, length: 1 }] },
        { id: "main", name: "Main", steps: [{ targetId: "child", targetType: "sequencer", repeats: 2, gapSeconds: 1, length: 1 }] },
      ],
    };
    expect(scheduleSequencer(arrangement, "main", { layer: 1 })).toEqual([
      { layerId: "layer", startSeconds: 0 },
      { layerId: "layer", startSeconds: 2.5 },
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
            { targetId: "layer", targetType: "layer", repeats: 1, gapSeconds: 0, length: 0.5 },
            { targetId: "layer", targetType: "layer", repeats: 1, gapSeconds: 0, length: 2 },
          ],
        },
      ],
    };
    expect(scheduleSequencer(arrangement, "main", { layer: 1 })).toEqual([
      { layerId: "layer", startSeconds: 0 },
      { layerId: "layer", startSeconds: 0.5 },
    ]);
  });

  it("schedules gap cells without a layer", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          steps: [
            { targetId: "layer", targetType: "layer", repeats: 1, gapSeconds: 0, length: 1 },
            { targetId: "", targetType: "gap", repeats: 1, gapSeconds: 2, length: 1 },
            { targetId: "layer", targetType: "layer", repeats: 1, gapSeconds: 0, length: 1 },
          ],
        },
      ],
    };
    expect(scheduleSequencer(arrangement, "main", { layer: 1 })).toEqual([
      { layerId: "layer", startSeconds: 0 },
      { layerId: "layer", startSeconds: 3 },
    ]);
  });
});
