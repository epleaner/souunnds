import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  applyPlaybackAdsr,
  decodeWav,
  encodeWav,
  fitPcmDuration,
  generateArrangement,
  findAudibleStart,
  renderArrangement,
  renderArrangementAsync,
  renderSequencer,
  renderSequencerAsync,
  scheduleSequencer,
  sourceSegmentRms,
  pitchShiftPcm,
  stretchPcm,
  type Arrangement,
  type PcmAudio,
  type SequenceStep,
} from "./audio";
import {
  MIN_LAYER_COLOR_CONTRAST,
  layerColorContrast,
  layerColorDistance,
  nextPastelLayerColor,
} from "./layer-colors";

function toneAudio(): PcmAudio {
  const samples = new Float32Array(16);
  for (let index = 0; index < samples.length; index += 1) samples[index] = index / samples.length;
  return { sampleRate: 8, channels: 1, samples };
}

function sineAudio(frequency: number, seconds = 0.2, sampleRate = 48000): PcmAudio {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let frame = 0; frame < samples.length; frame += 1) {
    samples[frame] = Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  }
  return { sampleRate, channels: 1, samples };
}

function positiveZeroCrossings(audio: PcmAudio): number {
  let crossings = 0;
  for (let frame = 1; frame < audio.samples.length; frame += 1) {
    if (audio.samples[frame - 1] <= 0 && audio.samples[frame] > 0) crossings += 1;
  }
  return crossings;
}

function sequenceClip(
  id: string,
  startSeconds: number,
  durationSeconds: number,
  targetId = "layer",
  repeatFill = true,
  targetType: SequenceStep["targetType"] = "layer",
  muted = false,
): SequenceStep {
  return { id, targetId, targetType, startSeconds, durationSeconds, repeatFill, muted };
}

describe("audio core", () => {
  it("allocates distinct pastel colors with accessible dark-background contrast", () => {
    const colors: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      colors.push(nextPastelLayerColor(colors, () => (index + 0.5) / 12));
    }
    expect(new Set(colors).size).toBe(colors.length);
    expect(Math.min(...colors.map(layerColorContrast))).toBeGreaterThanOrEqual(MIN_LAYER_COLOR_CONTRAST);
    const distances = colors.flatMap((color, index) => colors.slice(index + 1).map((other) => layerColorDistance(color, other)));
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(5);
  });
  it("round-trips PCM WAV data with its format metadata", () => {
    const decoded = decodeWav(encodeWav(toneAudio()));
    expect(decoded.sampleRate).toBe(8);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(16);
    expect(decoded.samples[15]).toBeCloseTo(15 / 16, 3);
  });

  it("fits PCM audio to shared durations with optional looping", () => {
    const audio = toneAudio();
    const fitted = fitPcmDuration(audio, 3);
    expect(fitted.samples.length).toBe(24);
    expect([...fitted.samples.slice(0, audio.samples.length)]).toEqual([...audio.samples]);
    expect(fitted.samples.slice(audio.samples.length).every((sample) => sample === 0)).toBe(true);
    const looped = fitPcmDuration(audio, 3, true);
    expect([...looped.samples.slice(audio.samples.length)]).toEqual([...audio.samples.slice(0, 8)]);
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
        { id: "a", name: "A", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
        { id: "b", name: "B", color: "#e6c5df", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 1, gain: 1, muted: false, triggerMode: "one-shot" },
      ],
      sequencers: [],
    };
    const mixed = renderArrangement(toneAudio(), arrangement);
    expect(mixed.samples.length).toBe(16);
    expect(mixed.samples[1]).not.toBe(0);
    expect(mixed.samples[9]).not.toBe(0);
  });

  it("renders each layer and sequence clip from its assigned source across channel layouts", async () => {
    const fallback: PcmAudio = { sampleRate: 4, channels: 2, samples: new Float32Array(8).fill(0.05) };
    const mono: PcmAudio = { sampleRate: 4, channels: 1, samples: new Float32Array(4).fill(0.1) };
    const stereo: PcmAudio = { sampleRate: 4, channels: 2, samples: new Float32Array([0.2, 0.4, 0.2, 0.4, 0.2, 0.4, 0.2, 0.4]) };
    const sources = new Map([["mono", mono], ["stereo", stereo]]);
    const arrangement: Arrangement = {
      layers: [
        { id: "a", sourceId: "mono", name: "A", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
        { id: "b", sourceId: "stereo", name: "B", color: "#e6c5df", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 1, gain: 1, muted: false, triggerMode: "one-shot" },
      ],
      sequencers: [{ id: "main", name: "Main", muted: false, durationSeconds: 2, steps: [
        sequenceClip("first", 0, 1, "a", false),
        sequenceClip("second", 1, 1, "b", false),
      ] }],
    };
    const expectSamples = (actual: PcmAudio, expected: number[]) => {
      expect(actual.samples.length).toBe(expected.length);
      expected.forEach((sample, index) => expect(actual.samples[index]).toBeCloseTo(sample));
    };
    const expected = [
      ...Array(4).fill([0.1, 0.1]).flat(),
      ...Array(4).fill([0.2, 0.4]).flat(),
    ];
    expectSamples(renderArrangement(fallback, arrangement, (input) => input, sources), expected);
    expectSamples(await renderArrangementAsync(fallback, arrangement, async (input) => input, sources), expected);
    expectSamples(renderSequencer(fallback, arrangement, "main", (input) => input, undefined, sources), expected);
    expectSamples(await renderSequencerAsync(fallback, arrangement, "main", async (input) => input, undefined, new Map(), sources), expected);

    const monoOutput: PcmAudio = { sampleRate: 4, channels: 1, samples: new Float32Array(4) };
    expectSamples(renderArrangement(monoOutput, { ...arrangement, layers: [arrangement.layers[1]] }, (input) => input, sources),
      [0, 0, 0, 0, 0.3, 0.3, 0.3, 0.3]);
    expectSamples(renderSequencer(monoOutput, arrangement, "main", (input) => input, undefined, sources),
      [0.1, 0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 0.3]);

    expect([...renderArrangement(fallback, { ...arrangement, layers: [arrangement.layers[0]] }, (input) => input).samples])
      .toEqual([...fallback.samples]);
  });

  it("rejects missing assigned sources rather than rendering fallback audio", async () => {
    const audio = toneAudio();
    const arrangement: Arrangement = {
      layers: [{ id: "a", sourceId: "missing", name: "A", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" }],
      sequencers: [{ id: "main", name: "Main", muted: false, durationSeconds: 1, steps: [sequenceClip("first", 0, 1, "a")] }],
    };
    const sources = new Map<string, PcmAudio>();
    expect(() => renderArrangement(audio, arrangement, (input) => input, sources)).toThrow(/missing.*a.*missing/i);
    await expect(renderArrangementAsync(audio, arrangement, async (input) => input, sources)).rejects.toThrow(/missing.*a.*missing/i);
    expect(() => renderSequencer(audio, arrangement, "main", (input) => input, undefined, sources)).toThrow(/missing.*a.*missing/i);
    await expect(renderSequencerAsync(audio, arrangement, "main", async (input) => input, undefined, new Map(), sources)).rejects.toThrow(/missing.*a.*missing/i);
  });

  it("renders audible layers when another referenced layer is muted and its source is unavailable", async () => {
    const audio: PcmAudio = { sampleRate: 4, channels: 1, samples: new Float32Array([0.2, 0.2, 0.2, 0.2]) };
    const arrangement: Arrangement = {
      layers: [
        { id: "audible", sourceId: "present", name: "Audible", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
        { id: "silent", sourceId: "missing", name: "Silent", color: "#e6c5df", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: true, triggerMode: "one-shot" },
      ],
      sequencers: [{ id: "main", name: "Main", muted: false, durationSeconds: 1, steps: [
        sequenceClip("first", 0, 1, "audible", false),
        sequenceClip("second", 0, 1, "silent", false),
      ] }],
    };
    const sources = new Map([["present", audio]]);
    const results = [
      renderArrangement(audio, arrangement, (input) => input, sources),
      await renderArrangementAsync(audio, arrangement, async (input) => input, sources),
      renderSequencer(audio, arrangement, "main", (input) => input, undefined, sources),
      await renderSequencerAsync(audio, arrangement, "main", async (input) => input, undefined, new Map(), sources),
    ];
    for (const result of results) expect([...result.samples]).toEqual([...audio.samples]);
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
  it("restarts playback ADSR for each sequence clip", async () => {
    const audio: PcmAudio = { sampleRate: 4, channels: 1, samples: new Float32Array(8).fill(1) };
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          muted: false,
          durationSeconds: 2,
          steps: [
            sequenceClip("first", 0, 1),
            sequenceClip("second", 1, 1),
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
  it("schedules clips at absolute positions and preserves empty gaps", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          muted: false,
          durationSeconds: 5,
          steps: [
            sequenceClip("first", 0.63, 1.17),
            sequenceClip("second", 3.14, 1.37, "layer", false),
          ],
        },
      ],
    };
    expect(scheduleSequencer(arrangement, "main")).toEqual([
      { layerId: "layer", startSeconds: 0.63, durationSeconds: 1.17, loop: true, pitchSemitones: 0 },
      { layerId: "layer", startSeconds: 3.14, durationSeconds: 1.37, loop: false, pitchSemitones: 0 },
    ]);
  });

  it("omits muted sequence clips from scheduling and rendering", async () => {
    const audio: PcmAudio = { sampleRate: 4, channels: 1, samples: new Float32Array(8).fill(1) };
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
      ],
      sequencers: [
        {
          id: "main",
          name: "Main",
          muted: false,
          durationSeconds: 2,
          steps: [
            sequenceClip("audible", 0, 1),
            sequenceClip("muted", 1, 1, "layer", true, "layer", true),
          ],
        },
      ],
    };
    expect(scheduleSequencer(arrangement, "main")).toEqual([
      { layerId: "layer", startSeconds: 0, durationSeconds: 1, loop: true, pitchSemitones: 0 },
    ]);
    const rendered = await renderSequencerAsync(audio, arrangement, "main", async (input) => input);
    expect(rendered.samples.slice(0, 4).every((sample) => sample > 0.9)).toBe(true);
    expect(rendered.samples.slice(4).every((sample) => sample === 0)).toBe(true);
  });

  it("accumulates nested clip pitch offsets before applying the effective limit", () => {
    const arrangement: Arrangement = {
      layers: [
        { id: "layer", name: "Layer", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
      ],
      sequencers: [
        { id: "deepest", name: "Deepest", muted: false, durationSeconds: 1, steps: [{ ...sequenceClip("leaf", 0, 1), pitchSemitones: -12 }] },
        { id: "grand", name: "Grand", muted: false, durationSeconds: 1, steps: [{ ...sequenceClip("grand-clip", 0, 1, "deepest", true, "sequencer"), pitchSemitones: 12 }] },
        { id: "child", name: "Child", muted: false, durationSeconds: 1, steps: [{ ...sequenceClip("child-clip", 0, 1, "grand", true, "sequencer"), pitchSemitones: 12 }] },
        { id: "main", name: "Main", muted: false, durationSeconds: 4, steps: [{ ...sequenceClip("nested", 1, 2.5, "child", true, "sequencer"), pitchSemitones: 12 }] },
      ],
    };
    expect(scheduleSequencer(arrangement, "main")).toEqual([
      { layerId: "layer", startSeconds: 1, durationSeconds: 1, loop: true, pitchSemitones: 24 },
      { layerId: "layer", startSeconds: 2, durationSeconds: 1, loop: true, pitchSemitones: 24 },
      { layerId: "layer", startSeconds: 3, durationSeconds: 0.5, loop: true, pitchSemitones: 24 },
    ]);
  });

  it("renders the full sequence duration while repeat fill controls clip looping", async () => {
    const audio: PcmAudio = { sampleRate: 4, channels: 1, samples: new Float32Array([1, 1, 1, 1]) };
    const base = {
      layers: [
        { id: "layer", name: "Layer", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" as const },
      ],
    };
    const render = (repeatFill: boolean) => renderSequencerAsync(audio, {
      ...base,
      sequencers: [
        { id: "main", name: "Main", muted: false, durationSeconds: 3, steps: [sequenceClip("clip", 0, 2, "layer", repeatFill)] },
      ],
    }, "main", async (input) => input);
    const repeated = await render(true);
    const single = await render(false);
    expect(repeated.samples.length).toBe(12);
    expect(repeated.samples.slice(0, 8).every((sample) => sample > 0.9)).toBe(true);
    expect(single.samples.slice(0, 4).every((sample) => sample > 0.9)).toBe(true);
    expect(single.samples.slice(4).every((sample) => sample === 0)).toBe(true);
  });

  it("renders only layers referenced by a sequence", async () => {
    let renderCount = 0;
    const arrangement: Arrangement = {
      layers: [
        { id: "used", name: "Used", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
        { id: "unused", name: "Unused", color: "#e6c5df", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
      ],
      sequencers: [
        { id: "main", name: "Main", muted: false, durationSeconds: 1, steps: [sequenceClip("clip", 0, 1, "used")] },
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
        { id: "layer", name: "Layer", color: "#b9dfe3", segment: { start: 0, end: 1 }, params: { ...DEFAULT_PARAMS, stretch: 1 }, offsetSeconds: 0, gain: 1, muted: false, triggerMode: "one-shot" },
      ],
      sequencers: [
        { id: "first", name: "First", muted: false, durationSeconds: 1, steps: [sequenceClip("first-clip", 0, 1)] },
        { id: "second", name: "Second", muted: false, durationSeconds: 1, steps: [sequenceClip("second-clip", 0, 1)] },
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

  it("applies layer pitch in sync and async arrangements without changing duration", async () => {
    const audio = sineAudio(440);
    const arrangement: Arrangement = {
      layers: [{
        id: "layer",
        name: "Layer",
        color: "#b9dfe3",
        segment: { start: 0, end: 0.2 },
        params: { ...DEFAULT_PARAMS, stretch: 1 },
        pitchSemitones: 12,
        offsetSeconds: 0,
        gain: 1,
        muted: false,
        triggerMode: "one-shot",
      }],
      sequencers: [],
    };
    const sync = renderArrangement(audio, arrangement, (input) => input);
    const asyncRendered = await renderArrangementAsync(audio, arrangement, async (input) => input);
    for (const output of [sync, asyncRendered]) {
      expect(output.sampleRate).toBe(audio.sampleRate);
      expect(output.samples.length).toBe(audio.samples.length);
      expect(positiveZeroCrossings(output)).toBeGreaterThan(positiveZeroCrossings(audio) * 1.9);
      expect(positiveZeroCrossings(output)).toBeLessThan(positiveZeroCrossings(audio) * 2.1);
    }
    const down = renderArrangement(audio, {
      ...arrangement,
      layers: arrangement.layers.map((layer) => ({ ...layer, pitchSemitones: -12 })),
    }, (input) => input);
    expect(down.samples.length).toBe(audio.samples.length);
    expect(positiveZeroCrossings(down)).toBeGreaterThan(positiveZeroCrossings(audio) * 0.45);
    expect(positiveZeroCrossings(down)).toBeLessThan(positiveZeroCrossings(audio) * 0.55);
  });

  it("adds a sequence clip pitch offset to its layer setting", async () => {
    const audio = sineAudio(440);
    const arrangement: Arrangement = {
      layers: [{
        id: "layer",
        name: "Layer",
        color: "#b9dfe3",
        segment: { start: 0, end: 0.2 },
        params: { ...DEFAULT_PARAMS, stretch: 1 },
        pitchSemitones: 7,
        offsetSeconds: 0,
        gain: 1,
        muted: false,
        triggerMode: "one-shot",
      }],
      sequencers: [{
        id: "main",
        name: "Main",
        muted: false,
        durationSeconds: 0.2,
        steps: [{ ...sequenceClip("clip", 0, 0.2, "layer", false), pitchSemitones: 5 }],
      }],
    };
    const sync = renderSequencer(audio, arrangement, "main", (input) => input);
    const asyncRendered = await renderSequencerAsync(audio, arrangement, "main", async (input) => input);
    for (const output of [sync, asyncRendered]) {
      expect(output.samples.length).toBe(audio.samples.length);
      expect(positiveZeroCrossings(output)).toBeGreaterThan(positiveZeroCrossings(audio) * 1.9);
      expect(positiveZeroCrossings(output)).toBeLessThan(positiveZeroCrossings(audio) * 2.1);
    }
  });
});
