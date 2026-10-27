import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent as ReactSyntheticEvent } from "react";
import {
  DEFAULT_PLAYBACK_ADSR,
  applyPlaybackAdsr,
  DEFAULT_PARAMS,
  MAX_PITCH_SEMITONES,
  generateArrangement,
  renderArrangementAsync,
  renderSequencerAsync,
  fitPcmDuration,
  findAudibleStart,
  pitchShiftPcm,
  sourceSegmentRms,
  type Arrangement,
  type Layer,
  type PcmAudio,
  type PlaybackAdsr,
  type SequenceStep,
  type Sequencer,
} from "../shared/audio";
import { isPastelLayerColor, nextPastelLayerColor } from "../shared/layer-colors";
import { loadPaulstretchModule, stretchWithPaulstretch } from "./paulstretch";
import { ThemedSelect } from "./ThemedSelect";
const MAIN_SEQUENCE_ID = "main-sequencer";
const SOURCE_FILE_NAME_STORAGE_KEY = "souunnds.source-file-name";
const STUDIO_STATE_STORAGE_KEY = "souunnds.studio-state";
function studioStateStorageKey(): string {
  if (typeof window === "undefined") return STUDIO_STATE_STORAGE_KEY;
  try {
    const openProject = JSON.parse(window.sessionStorage.getItem("souunnds.open-project") ?? "null");
    return typeof openProject?.id === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(openProject.id)
      ? `souunnds.project-state.${openProject.id}`
      : STUDIO_STATE_STORAGE_KEY;
  } catch {
    return STUDIO_STATE_STORAGE_KEY;
  }
}
const MIN_CLIP_DURATION_SECONDS = 0.25;
const MIN_SEQUENCE_DURATION_SECONDS = 0.25;
const DEFAULT_CLIP_DURATION_SECONDS = 1;
const DEFAULT_SEQUENCE_DURATION_SECONDS = 8;
const SEQUENCE_DENSITY_LABELS = ["Sparse", "Balanced", "Dense"] as const;
const CLIP_DURATION_LABELS = ["Short", "Medium", "Long"] as const;

type SequenceTrack = { sequenceId: string; durationSeconds: number; loop: boolean };
type SequencePlayback = { tracks: SequenceTrack[]; startedAt: number; pausedAt?: number; simultaneous: boolean; loop: boolean };
type ResizeState = {
  sequenceId: string;
  index: number;
  edge: "left" | "right";
  startX: number;
  initialStartSeconds: number;
  initialDurationSeconds: number;
  pixelsPerSecond: number;
  initialSteps: SequenceStep[];
};
type SequenceResizeState = {
  sequenceId: string;
  startX: number;
  initialDurationSeconds: number;
  pixelsPerSecond: number;
  initialSteps: SequenceStep[];
};
type PlaybackTarget =
  | { kind: "source"; id: string }
  | { kind: "layer"; id: string }
  | { kind: "layers" }
  | { kind: "sequence"; id: string }
  | { kind: "sequence-clip"; sequenceId: string; clipId: string }
  | { kind: "sequences" };
type PlaybackEffects = {
  reverbMix: number;
  reverbDecaySeconds: number;
  reverbPreDelaySeconds: number;
  reverbDampingHz: number;
  delayMix: number;
  delaySeconds: number;
  delayFeedback: number;
  compressorLowAmount: number;
  compressorMidAmount: number;
  compressorHighAmount: number;
};
type PlaybackEffectNodes = {
  convolver: ConvolverNode;
  reverbPreDelay: DelayNode;
  reverbDamping: BiquadFilterNode;
  reverbDryGain: GainNode;
  reverbWetGain: GainNode;
  delayDryGain: GainNode;
  delayWetGain: GainNode;
  delay: DelayNode;
  feedback: GainNode;
  compressorLow: DynamicsCompressorNode;
  compressorMid: DynamicsCompressorNode;
  compressorHigh: DynamicsCompressorNode;
  compressorDryGain: GainNode;
  compressorWetGain: GainNode;
  disconnect: () => void;
};
type LayerTriggerMode = NonNullable<Layer["triggerMode"]>;
type KeyboardLayerVoice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  releaseSeconds: number;
  releasing: boolean;
};
type KeyboardPlaybackBus = {
  context: AudioContext;
  input: GainNode;
  effects: PlaybackEffectNodes;
};
const MAX_REVERB_DECAY_SECONDS = 60;
const DELAY_TAIL_SILENCE_GAIN = 0.001; // -60 dB
const DEFAULT_PLAYBACK_EFFECTS: PlaybackEffects = {
  reverbMix: 0,
  reverbDecaySeconds: 2.4,
  reverbPreDelaySeconds: 0.02,
  reverbDampingHz: 8000,
  delayMix: 0,
  delaySeconds: 0.3,
  delayFeedback: 0.35,
  compressorLowAmount: 0,
  compressorMidAmount: 0,
  compressorHighAmount: 0,
};
const reverbImpulseCache = new WeakMap<AudioContext, { decaySeconds: number; buffer: AudioBuffer }>();
const LAYER_TRIGGER_BINDINGS = [
  { code: "Digit1", label: "1" },
  { code: "Digit2", label: "2" },
  { code: "Digit3", label: "3" },
  { code: "Digit4", label: "4" },
  { code: "Digit5", label: "5" },
  { code: "Digit6", label: "6" },
  { code: "Digit7", label: "7" },
  { code: "Digit8", label: "8" },
  { code: "Digit9", label: "9" },
  { code: "Digit0", label: "0" },
  { code: "Minus", label: "−" },
  { code: "Equal", label: "=" },
] as const;
type PersistedLayer = Omit<Layer, "color" | "triggerMode"> & { color?: string; triggerMode?: Layer["triggerMode"] };
type PersistedSequenceStep = Partial<SequenceStep> & {
  targetId?: unknown;
  targetType?: unknown;
  length?: unknown;
  repeats?: unknown;
};
type PersistedSequencer = {
  id?: unknown;
  name?: unknown;
  muted?: unknown;
  durationSeconds?: unknown;
  baseLengthSeconds?: unknown;
  gapLengthSeconds?: unknown;
  steps?: unknown;
};
type AudioSource = { id: string; name: string; duration: number; audio: PcmAudio | null; sourceUrl?: string; assetId?: string };
type StoredSource = Pick<AudioSource, "id" | "name" | "duration" | "sourceUrl" | "assetId">;
type PersistedStudioState = {
  sources: StoredSource[];
  layers: Layer[];
  sequencers: Sequencer[];
  adsr: PlaybackAdsr;
  effects: PlaybackEffects;
  activeSequencerId: string;
  selectedCellIndex: number;
};

function readStoredSourceFileName(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(SOURCE_FILE_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTimelineSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isPersistedLayer(value: unknown): value is PersistedLayer {
  if (!value || typeof value !== "object") return false;
  const layer = value as PersistedLayer;
  return typeof layer.id === "string"
    && typeof layer.name === "string"
    && isFiniteNumber(layer.segment?.start)
    && isFiniteNumber(layer.segment?.end)
    && isFiniteNumber(layer.params?.stretch)
    && isFiniteNumber(layer.params?.windowSeconds)
    && isFiniteNumber(layer.params?.overlap)
    && isFiniteNumber(layer.params?.onset)
    && isFiniteNumber(layer.params?.seed)
    && isFiniteNumber(layer.offsetSeconds)
    && isFiniteNumber(layer.gain)
    && typeof layer.muted === "boolean"
    && (layer.color === undefined || typeof layer.color === "string")
    && (layer.sourceId === undefined || typeof layer.sourceId === "string")
    && (layer.pitchSemitones === undefined || isFiniteNumber(layer.pitchSemitones))
    && (layer.triggerMode === undefined || layer.triggerMode === "gate" || layer.triggerMode === "one-shot");
}

function normalizePersistedSequencer(value: unknown, sequenceIndex: number): Sequencer | null {
  if (!value || typeof value !== "object") return null;
  const sequencer = value as PersistedSequencer;
  if (typeof sequencer.id !== "string"
    || typeof sequencer.name !== "string"
    || !Array.isArray(sequencer.steps)
    || !sequencer.steps.length
    || (sequencer.muted !== undefined && typeof sequencer.muted !== "boolean")) return null;

  const baseLength = isFiniteNumber(sequencer.baseLengthSeconds) && sequencer.baseLengthSeconds > 0
    ? sequencer.baseLengthSeconds
    : 1;
  const gapLength = isFiniteNumber(sequencer.gapLengthSeconds) && sequencer.gapLengthSeconds > 0
    ? sequencer.gapLengthSeconds
    : 0;
  let legacyCursor = 0;
  const converted: SequenceStep[] = [];
  for (const [stepIndex, rawStep] of sequencer.steps.entries()) {
    if (!rawStep || typeof rawStep !== "object") return null;
    const step = rawStep as PersistedSequenceStep;
    if (typeof step.targetId !== "string" || (step.targetType !== "layer" && step.targetType !== "sequencer")) return null;
    const hasTimelineTiming = isFiniteNumber(step.startSeconds) && isFiniteNumber(step.durationSeconds);
    const repeats = isFiniteNumber(step.repeats) ? Math.max(1, Math.floor(step.repeats)) : 1;
    const legacyLength = isFiniteNumber(step.length) ? Math.max(MIN_CLIP_DURATION_SECONDS, step.length) : 1;
    const durationSeconds = hasTimelineTiming
      ? Math.max(MIN_CLIP_DURATION_SECONDS, step.durationSeconds as number)
      : baseLength * legacyLength * repeats;
    const startSeconds = hasTimelineTiming ? Math.max(0, step.startSeconds as number) : legacyCursor;
    converted.push({
      id: typeof step.id === "string" && step.id ? step.id : `${sequencer.id}-clip-${stepIndex + 1}`,
      targetId: step.targetId,
      targetType: step.targetType,
      startSeconds,
      durationSeconds,
      repeatFill: typeof step.repeatFill === "boolean" ? step.repeatFill : true,
      muted: step.muted === true,
      pitchSemitones: isFiniteNumber(step.pitchSemitones)
        ? clampNumber(step.pitchSemitones, -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES)
        : 0,
    });
    if (!hasTimelineTiming) legacyCursor += durationSeconds + (stepIndex < sequencer.steps.length - 1 ? gapLength : 0);
  }

  const latestClipEnd = converted.reduce((latest, step) => Math.max(latest, step.startSeconds + step.durationSeconds), 0);
  const requestedDuration = isFiniteNumber(sequencer.durationSeconds)
    ? sequencer.durationSeconds
    : latestClipEnd;
  const durationSeconds = roundTimelineSeconds(Math.max(MIN_SEQUENCE_DURATION_SECONDS, requestedDuration, latestClipEnd));
  let occupiedUntil = 0;
  const usedIds = new Set<string>();
  const steps = converted
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .flatMap((step, stepIndex) => {
      const startSeconds = roundTimelineSeconds(Math.max(occupiedUntil, step.startSeconds));
      const available = durationSeconds - startSeconds;
      if (available < MIN_CLIP_DURATION_SECONDS) return [];
      const normalizedDuration = roundTimelineSeconds(Math.min(Math.max(MIN_CLIP_DURATION_SECONDS, step.durationSeconds), available));
      occupiedUntil = startSeconds + normalizedDuration;
      const id = usedIds.has(step.id) ? `${sequencer.id}-clip-${sequenceIndex + 1}-${stepIndex + 1}` : step.id;
      usedIds.add(id);
      return [{ ...step, id, startSeconds, durationSeconds: normalizedDuration }];
    });
  return steps.length ? {
    id: sequencer.id,
    name: sequencer.name,
    muted: sequencer.muted === true,
    durationSeconds,
    steps,
  } : null;
}

function isPersistedAdsr(value: unknown): value is PlaybackAdsr {
  if (!value || typeof value !== "object") return false;
  const adsr = value as PlaybackAdsr;
  return isFiniteNumber(adsr.attackSeconds)
    && isFiniteNumber(adsr.decaySeconds)
    && isFiniteNumber(adsr.sustainLevel)
    && isFiniteNumber(adsr.releaseSeconds);
}
function readPersistedEffects(value: unknown): PlaybackEffects {
  if (!value || typeof value !== "object") return { ...DEFAULT_PLAYBACK_EFFECTS };
  const effects = value as Partial<PlaybackEffects>;
  return {
    reverbMix: isFiniteNumber(effects.reverbMix) ? clampNumber(effects.reverbMix, 0, 1) : DEFAULT_PLAYBACK_EFFECTS.reverbMix,
    reverbDecaySeconds: isFiniteNumber(effects.reverbDecaySeconds) ? clampNumber(effects.reverbDecaySeconds, 0.2, MAX_REVERB_DECAY_SECONDS) : DEFAULT_PLAYBACK_EFFECTS.reverbDecaySeconds,
    reverbPreDelaySeconds: isFiniteNumber(effects.reverbPreDelaySeconds) ? clampNumber(effects.reverbPreDelaySeconds, 0, 0.25) : DEFAULT_PLAYBACK_EFFECTS.reverbPreDelaySeconds,
    reverbDampingHz: isFiniteNumber(effects.reverbDampingHz) ? clampNumber(effects.reverbDampingHz, 500, 18000) : DEFAULT_PLAYBACK_EFFECTS.reverbDampingHz,
    delayMix: isFiniteNumber(effects.delayMix) ? clampNumber(effects.delayMix, 0, 1) : DEFAULT_PLAYBACK_EFFECTS.delayMix,
    delaySeconds: isFiniteNumber(effects.delaySeconds) ? clampNumber(effects.delaySeconds, 0.05, 1) : DEFAULT_PLAYBACK_EFFECTS.delaySeconds,
    delayFeedback: isFiniteNumber(effects.delayFeedback) ? clampNumber(effects.delayFeedback, 0, 0.85) : DEFAULT_PLAYBACK_EFFECTS.delayFeedback,
    compressorLowAmount: isFiniteNumber(effects.compressorLowAmount) ? clampNumber(effects.compressorLowAmount, 0, 1) : DEFAULT_PLAYBACK_EFFECTS.compressorLowAmount,
    compressorMidAmount: isFiniteNumber(effects.compressorMidAmount) ? clampNumber(effects.compressorMidAmount, 0, 1) : DEFAULT_PLAYBACK_EFFECTS.compressorMidAmount,
    compressorHighAmount: isFiniteNumber(effects.compressorHighAmount) ? clampNumber(effects.compressorHighAmount, 0, 1) : DEFAULT_PLAYBACK_EFFECTS.compressorHighAmount,
  };
}

function readPersistedStudioState(): PersistedStudioState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(studioStateStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedStudioState> & { duration?: number };
    const layerColors: string[] = [];
    const storedSources = Array.isArray(parsed.sources)
      ? parsed.sources.filter((item): item is StoredSource => !!item && typeof item.id === "string" && typeof item.name === "string" && isFiniteNumber(item.duration) && item.duration >= 0 && (item.sourceUrl === undefined || (typeof item.sourceUrl === "string" && item.sourceUrl.length <= 2048 && item.sourceUrl.startsWith("https://")) ) && (item.assetId === undefined || (typeof item.assetId === "string" && /^[A-Za-z0-9_-]{20,40}$/.test(item.assetId))) && !(item.sourceUrl && item.assetId))
      : [];
    const legacyName = readStoredSourceFileName();
    const sources = storedSources.length ? storedSources : [{ id: "source", name: legacyName, duration: isFiniteNumber(parsed.duration) ? parsed.duration : 0 }];
    const layers = Array.isArray(parsed.layers)
      ? parsed.layers.filter(isPersistedLayer).map((layer, index) => {
          const color = isPastelLayerColor(layer.color) && !layerColors.includes(layer.color.toLowerCase())
            ? layer.color.toLowerCase()
            : nextPastelLayerColor(layerColors);
          layerColors.push(color);
          return {
            ...layer,
            pitchSemitones: isFiniteNumber(layer.pitchSemitones)
              ? clampNumber(layer.pitchSemitones, -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES)
              : 0,
            name: `Layer ${index + 1}`,
            color,
            triggerMode: layer.triggerMode === "gate" ? "gate" as const : "one-shot" as const,
          };
        })
      : [];
    const sequencers = Array.isArray(parsed.sequencers)
      ? parsed.sequencers
          .map((sequencer, index) => normalizePersistedSequencer(sequencer, index))
          .filter((sequencer): sequencer is Sequencer => sequencer !== null)
      : [];
    const selectedCellIndex = parsed.selectedCellIndex;
    return {
      sources,
      layers,
      sequencers,
      adsr: isPersistedAdsr(parsed.adsr) ? parsed.adsr : { ...DEFAULT_PLAYBACK_ADSR },
      effects: readPersistedEffects(parsed.effects),
      activeSequencerId: typeof parsed.activeSequencerId === "string" ? parsed.activeSequencerId : MAIN_SEQUENCE_ID,
      selectedCellIndex: typeof selectedCellIndex === "number" && Number.isInteger(selectedCellIndex) && selectedCellIndex >= 0 ? selectedCellIndex : 0,
    };
  } catch {
    return null;
  }
}

const persistedStudioState = readPersistedStudioState();
const STORED_AUDIO_DB_NAME = "souunnds.audio";
const STORED_AUDIO_STORE_NAME = "files";
const STORED_AUDIO_KEY = "source";

type StoredAudioRecord = {
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
};

function openStoredAudioDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  if (typeof indexedDB === "undefined") {
    reject(new Error("IndexedDB is unavailable."));
    return promise;
  }
  const request = indexedDB.open(STORED_AUDIO_DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORED_AUDIO_STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
  return promise;
}

function activeAudioProjectId(): string | null {
  try {
    const opened = JSON.parse(window.sessionStorage.getItem("souunnds.open-project") ?? "null");
    return typeof opened?.id === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(opened.id) ? opened.id : null;
  } catch {
    return null;
  }
}

function audioStorageKey(id: string, projectId: string | null): string {
  return projectId ? `${projectId}:${id}` : id;
}

function ownsLocalProject(projectId: string): boolean {
  try {
    const owner = JSON.parse(window.localStorage.getItem(`souunnds.project-owner.${projectId}`) ?? "null");
    return typeof owner?.capability === "string";
  } catch {
    return false;
  }
}

async function storeAudioFile(id: string, file: File, projectId = activeAudioProjectId()): Promise<boolean> {
  let database: IDBDatabase | null = null;
  try {
    database = await openStoredAudioDb();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const transaction = database.transaction(STORED_AUDIO_STORE_NAME, "readwrite");
    transaction.objectStore(STORED_AUDIO_STORE_NAME).put({
      blob: file,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
    } satisfies StoredAudioRecord, audioStorageKey(id, projectId));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not store the audio file."));
    await promise;
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

async function readStoredAudioFile(id: string, projectId = activeAudioProjectId(), allowLegacyOwnerFile = true): Promise<File | null> {
  let database: IDBDatabase | null = null;
  try {
    database = await openStoredAudioDb();
    const read = (key: string) => new Promise<StoredAudioRecord | undefined>((resolve) => {
      const transaction = database!.transaction(STORED_AUDIO_STORE_NAME, "readonly");
      const request = transaction.objectStore(STORED_AUDIO_STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as StoredAudioRecord | undefined);
      request.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
    });
    let record = await read(audioStorageKey(id, projectId));
    // Existing owner projects may still have browser audio under the pre-share source key.
    if (allowLegacyOwnerFile && !record && projectId && ownsLocalProject(projectId)) record = await read(id);
    return record ? new File([record.blob], record.name, { type: record.type, lastModified: record.lastModified }) : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

async function deleteStoredAudioFile(id: string, projectId = activeAudioProjectId()): Promise<void> {
  let database: IDBDatabase | null = null;
  try {
    database = await openStoredAudioDb();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const transaction = database.transaction(STORED_AUDIO_STORE_NAME, "readwrite");
    transaction.objectStore(STORED_AUDIO_STORE_NAME).delete(audioStorageKey(id, projectId));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove stored audio."));
    await promise;
  } finally {
    database?.close();
  }
}








function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "00:00";
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
function mixPcm(audios: PcmAudio[]): PcmAudio {
  const first = audios[0];
  if (!first) throw new Error("No sequences are available to play.");
  const sampleCount = Math.max(...audios.map((audio) => audio.samples.length));
  const samples = new Float32Array(sampleCount);
  for (const audio of audios) {
    for (let index = 0; index < audio.samples.length; index += 1) samples[index] += audio.samples[index];
  }
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let index = 0; index < samples.length; index += 1) samples[index] *= scale;
  }
  return { sampleRate: first.sampleRate, channels: first.channels, samples };
}

function createLayer(duration: number, index: number, existingColors: Iterable<string> = [], sourceId?: string): Layer {
  return {
    id: `layer-${Date.now()}-${index}`,
    name: `Layer ${index + 1}`,
    color: nextPastelLayerColor(existingColors),
    sourceId,
    segment: { start: 0, end: Math.max(0.1, Math.min(duration, 4)) },
    params: { ...DEFAULT_PARAMS },
    pitchSemitones: 0,
    offsetSeconds: 0,
    gain: 0.8,
    muted: false,
    triggerMode: "one-shot",
  };
}

let sequenceClipIdCounter = 0;

function nextSequenceClipId(): string {
  sequenceClipIdCounter += 1;
  return `clip-${Date.now()}-${sequenceClipIdCounter}`;
}

function createSequenceStep(
  targetId: string,
  startSeconds = 0,
  durationSeconds = DEFAULT_CLIP_DURATION_SECONDS,
  repeatFill = true,
): SequenceStep {
  return {
    id: nextSequenceClipId(),
    targetId,
    targetType: "layer",
    startSeconds: roundTimelineSeconds(Math.max(0, startSeconds)),
    durationSeconds: roundTimelineSeconds(Math.max(MIN_CLIP_DURATION_SECONDS, durationSeconds)),
    repeatFill,
    muted: false,
    pitchSemitones: 0,
  };
}

function createSequencer(id: string, name: string, layerId: string): Sequencer {
  return {
    id,
    name,
    muted: false,
    durationSeconds: DEFAULT_SEQUENCE_DURATION_SECONDS,
    steps: [createSequenceStep(layerId)],
  };
}

function resizeSequencerDuration(
  sequence: Sequencer,
  requestedDuration: number,
  sourceSteps: SequenceStep[] = sequence.steps,
): Sequencer {
  const sortedSteps = [...sourceSteps].sort((left, right) => left.startSeconds - right.startSeconds);
  if (!sortedSteps.length) return sequence;
  let durationSeconds = roundTimelineSeconds(Math.max(MIN_SEQUENCE_DURATION_SECONDS, requestedDuration));
  let steps = sortedSteps.flatMap((step) => {
    const availableDuration = durationSeconds - step.startSeconds;
    if (availableDuration < MIN_CLIP_DURATION_SECONDS) return [];
    return [{
      ...step,
      durationSeconds: roundTimelineSeconds(Math.min(step.durationSeconds, availableDuration)),
    }];
  });
  if (!steps.length) {
    const firstStep = sortedSteps[0];
    durationSeconds = roundTimelineSeconds(Math.max(
      durationSeconds,
      firstStep.startSeconds + MIN_CLIP_DURATION_SECONDS,
    ));
    steps = [{ ...firstStep, durationSeconds: MIN_CLIP_DURATION_SECONDS }];
  }
  return { ...sequence, durationSeconds, steps };
}

function sequenceGaps(sequence: Sequencer): Array<{ startSeconds: number; endSeconds: number }> {
  const gaps: Array<{ startSeconds: number; endSeconds: number }> = [];
  const sortedSteps = [...sequence.steps].sort((left, right) => left.startSeconds - right.startSeconds);
  let cursor = 0;
  for (const step of sortedSteps) {
    if (step.startSeconds - cursor >= MIN_CLIP_DURATION_SECONDS) {
      gaps.push({ startSeconds: cursor, endSeconds: step.startSeconds });
    }
    cursor = Math.max(cursor, step.startSeconds + step.durationSeconds);
  }
  if (sequence.durationSeconds - cursor >= MIN_CLIP_DURATION_SECONDS) {
    gaps.push({ startSeconds: cursor, endSeconds: sequence.durationSeconds });
  }
  return gaps;
}

function sequenceClipKey(sequenceId: string, clipId: string): string {
  return `${sequenceId}:${clipId}`;
}

function pcmFromAudioBuffer(buffer: AudioBuffer): PcmAudio {
  const samples = new Float32Array(buffer.length * buffer.numberOfChannels);
  for (let frame = 0; frame < buffer.length; frame += 1) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      samples[frame * buffer.numberOfChannels + channel] = buffer.getChannelData(channel)[frame];
    }
  }
  return { sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, samples };
}

function audioBufferFromPcm(context: AudioContext, audio: PcmAudio): AudioBuffer {
  const buffer = context.createBuffer(audio.channels, audio.samples.length / audio.channels, audio.sampleRate);
  for (let channel = 0; channel < audio.channels; channel += 1) {
    const channelData = buffer.getChannelData(channel);
    for (let frame = 0; frame < channelData.length; frame += 1) {
      channelData[frame] = audio.samples[frame * audio.channels + channel];
    }
  }
  return buffer;
}
function reverbImpulse(context: AudioContext, decaySeconds: number): AudioBuffer {
  const normalizedDecay = clampNumber(decaySeconds, 0.2, MAX_REVERB_DECAY_SECONDS);
  const cached = reverbImpulseCache.get(context);
  if (cached?.decaySeconds === normalizedDecay) return cached.buffer;
  const length = Math.ceil(context.sampleRate * normalizedDecay);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  let seed = 0x6d2b79f5;
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const samples = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = seed / 0xffffffff * 2 - 1;
      samples[index] = noise * Math.pow(1 - index / length, 2.4);
    }
  }
  reverbImpulseCache.set(context, { decaySeconds: normalizedDecay, buffer: impulse });
  return impulse;
}
function effectMixGains(mix: number): { dry: number; wet: number } {
  const normalized = clampNumber(mix, 0, 1);
  return {
    dry: Math.cos(normalized * Math.PI * 0.5),
    wet: Math.sin(normalized * Math.PI * 0.5),
  };
}
function normalizedCompressorAmount(value: unknown): number {
  return isFiniteNumber(value) ? clampNumber(value, 0, 1) : 0;
}
function compressorThreshold(amount: unknown): number {
  return -60 * normalizedCompressorAmount(amount);
}
function compressorEnabled(effects: PlaybackEffects): boolean {
  return normalizedCompressorAmount(effects.compressorLowAmount) > 0
    || normalizedCompressorAmount(effects.compressorMidAmount) > 0
    || normalizedCompressorAmount(effects.compressorHighAmount) > 0;
}
function configureCompressor(node: DynamicsCompressorNode, amount: number): void {
  node.threshold.value = compressorThreshold(amount);
  node.knee.value = 30;
  node.ratio.value = 6;
  node.attack.value = 0.003;
  node.release.value = 0.25;
}
function playbackTargetMatches(current: PlaybackTarget | null, target: PlaybackTarget): boolean {
  if (!current || current.kind !== target.kind) return false;
  if (target.kind === "sequence-clip") {
    return current.kind === "sequence-clip"
      && current.sequenceId === target.sequenceId
      && current.clipId === target.clipId;
  }
  return "id" in target ? "id" in current && current.id === target.id : true;
}
function isSequenceDerivedPlayback(target: PlaybackTarget | null): boolean {
  return target?.kind === "sequence" || target?.kind === "sequences" || target?.kind === "sequence-clip";
}
function isLayerDerivedPlayback(target: PlaybackTarget | null): boolean {
  return target?.kind === "layer" || target?.kind === "layers";
}
function isArrangementDerivedPlayback(target: PlaybackTarget | null): boolean {
  return isLayerDerivedPlayback(target) || isSequenceDerivedPlayback(target);
}


function connectPlaybackEffects(context: AudioContext, source: AudioNode, effects: PlaybackEffects): PlaybackEffectNodes {
  const convolver = context.createConvolver();
  const reverbPreDelay = context.createDelay(1);
  const reverbDamping = context.createBiquadFilter();
  const reverbDryGain = context.createGain();
  const reverbWetGain = context.createGain();
  const reverbOutput = context.createGain();
  const delay = context.createDelay(1);
  const delayDryGain = context.createGain();
  const delayWetGain = context.createGain();
  const feedback = context.createGain();
  const effectOutput = context.createGain();
  const compressorDryGain = context.createGain();
  const compressorWetGain = context.createGain();
  const lowMidFilter = context.createBiquadFilter();
  const highFilter = context.createBiquadFilter();
  const lowFilter = context.createBiquadFilter();
  const midFilter = context.createBiquadFilter();
  const compressorLow = context.createDynamicsCompressor();
  const compressorMid = context.createDynamicsCompressor();
  const compressorHigh = context.createDynamicsCompressor();
  const reverbMix = effectMixGains(effects.reverbMix);
  const delayMix = effectMixGains(effects.delayMix);
  const compressionEnabled = compressorEnabled(effects);
  convolver.buffer = reverbImpulse(context, effects.reverbDecaySeconds);
  reverbPreDelay.delayTime.value = effects.reverbPreDelaySeconds;
  reverbDamping.type = "lowpass";
  reverbDamping.frequency.value = effects.reverbDampingHz;
  reverbDamping.Q.value = Math.SQRT1_2;
  reverbDryGain.gain.value = reverbMix.dry;
  reverbWetGain.gain.value = reverbMix.wet;
  delay.delayTime.value = effects.delaySeconds;
  delayDryGain.gain.value = delayMix.dry;
  delayWetGain.gain.value = delayMix.wet;
  feedback.gain.value = effects.delayFeedback;
  compressorDryGain.gain.value = compressionEnabled ? 0 : 1;
  compressorWetGain.gain.value = compressionEnabled ? 1 : 0;
  lowMidFilter.type = "lowpass";
  lowMidFilter.frequency.value = 4000;
  lowMidFilter.Q.value = 0.5;
  highFilter.type = "highpass";
  highFilter.frequency.value = 4000;
  highFilter.Q.value = 0.5;
  lowFilter.type = "lowpass";
  lowFilter.frequency.value = 250;
  lowFilter.Q.value = 0.5;
  midFilter.type = "highpass";
  midFilter.frequency.value = 250;
  midFilter.Q.value = 0.5;
  configureCompressor(compressorLow, effects.compressorLowAmount);
  configureCompressor(compressorMid, effects.compressorMidAmount);
  configureCompressor(compressorHigh, effects.compressorHighAmount);
  source.connect(reverbDryGain);
  reverbDryGain.connect(reverbOutput);
  source.connect(reverbPreDelay);
  reverbPreDelay.connect(convolver);
  convolver.connect(reverbDamping);
  reverbDamping.connect(reverbWetGain);
  reverbWetGain.connect(reverbOutput);
  reverbOutput.connect(delayDryGain);
  delayDryGain.connect(effectOutput);
  reverbOutput.connect(delay);
  delay.connect(delayWetGain);
  delayWetGain.connect(effectOutput);
  delay.connect(feedback);
  feedback.connect(delay);
  effectOutput.connect(compressorDryGain);
  compressorDryGain.connect(context.destination);
  effectOutput.connect(lowMidFilter);
  effectOutput.connect(highFilter);
  lowMidFilter.connect(lowFilter);
  lowMidFilter.connect(midFilter);
  lowFilter.connect(compressorLow);
  midFilter.connect(compressorMid);
  highFilter.connect(compressorHigh);
  compressorLow.connect(compressorWetGain);
  compressorMid.connect(compressorWetGain);
  compressorHigh.connect(compressorWetGain);
  compressorWetGain.connect(context.destination);
  return {
    convolver,
    reverbPreDelay,
    reverbDamping,
    reverbDryGain,
    reverbWetGain,
    delayDryGain,
    delayWetGain,
    delay,
    feedback,
    compressorLow,
    compressorMid,
    compressorHigh,
    compressorDryGain,
    compressorWetGain,
    disconnect: () => {
      source.disconnect();
      convolver.disconnect();
      reverbPreDelay.disconnect();
      reverbDamping.disconnect();
      reverbDryGain.disconnect();
      reverbWetGain.disconnect();
      reverbOutput.disconnect();
      delay.disconnect();
      delayDryGain.disconnect();
      delayWetGain.disconnect();
      feedback.disconnect();
      effectOutput.disconnect();
      compressorDryGain.disconnect();
      compressorWetGain.disconnect();
      lowMidFilter.disconnect();
      highFilter.disconnect();
      lowFilter.disconnect();
      midFilter.disconnect();
      compressorLow.disconnect();
      compressorMid.disconnect();
      compressorHigh.disconnect();
    },
  };
}

function updatePlaybackEffectNodes(nodes: PlaybackEffectNodes, effects: PlaybackEffects, now: number): void {
  const reverbMix = effectMixGains(effects.reverbMix);
  const delayMix = effectMixGains(effects.delayMix);
  const compressionEnabled = compressorEnabled(effects);
  nodes.reverbDryGain.gain.setTargetAtTime(reverbMix.dry, now, 0.01);
  nodes.reverbWetGain.gain.setTargetAtTime(reverbMix.wet, now, 0.01);
  nodes.reverbPreDelay.delayTime.setTargetAtTime(effects.reverbPreDelaySeconds, now, 0.01);
  nodes.reverbDamping.frequency.setTargetAtTime(effects.reverbDampingHz, now, 0.01);
  nodes.delayDryGain.gain.setTargetAtTime(delayMix.dry, now, 0.01);
  nodes.delayWetGain.gain.setTargetAtTime(delayMix.wet, now, 0.01);
  nodes.delay.delayTime.setTargetAtTime(effects.delaySeconds, now, 0.01);
  nodes.feedback.gain.setTargetAtTime(effects.delayFeedback, now, 0.01);
  nodes.compressorLow.threshold.setTargetAtTime(compressorThreshold(effects.compressorLowAmount), now, 0.01);
  nodes.compressorMid.threshold.setTargetAtTime(compressorThreshold(effects.compressorMidAmount), now, 0.01);
  nodes.compressorHigh.threshold.setTargetAtTime(compressorThreshold(effects.compressorHighAmount), now, 0.01);
  nodes.compressorDryGain.gain.setTargetAtTime(compressionEnabled ? 0 : 1, now, 0.01);
  nodes.compressorWetGain.gain.setTargetAtTime(compressionEnabled ? 1 : 0, now, 0.01);
}

function playbackEffectTailSeconds(effects: PlaybackEffects): number {
  const reverbSeconds = effects.reverbMix > 0 ? effects.reverbPreDelaySeconds + effects.reverbDecaySeconds : 0;
  let delaySeconds = 0;
  if (effects.delayMix > 0) {
    const feedback = Math.min(effects.delayFeedback, 0.85);
    const repeats = feedback > 0 ? Math.max(1, Math.ceil(Math.log(DELAY_TAIL_SILENCE_GAIN) / Math.log(feedback))) : 1;
    delaySeconds = effects.delaySeconds * repeats;
  }
  const tailSeconds = reverbSeconds + delaySeconds;
  return tailSeconds > 0 ? tailSeconds + 0.05 : 0;
}

function repairGeneratedLayer(audio: PcmAudio, layer: Layer): Layer {
  if (!layer.id.startsWith("generated-") || sourceSegmentRms(audio, layer.segment) > 1e-8) return layer;
  const sourceDuration = audio.samples.length / audio.channels / audio.sampleRate;
  const length = Math.max(0.15, layer.segment.end - layer.segment.start);
  const start = findAudibleStart(audio, length);
  const end = Math.min(sourceDuration, start + length);
  return start === layer.segment.start || end <= start ? layer : { ...layer, segment: { start, end } };
}
function hasSignal(audio: PcmAudio): boolean {
  for (const sample of audio.samples) if (Math.abs(sample) > 1e-6) return true;
  return false;
}

async function stretchForPlayback(audio: PcmAudio, segment: Layer["segment"], params: Layer["params"]): Promise<PcmAudio> {
  try {
    const rendered = await stretchWithPaulstretch(audio, segment, params);
    if (hasSignal(rendered)) return rendered;
  } catch {
    // Retry generated/legacy values with a bounded, audible fallback below.
  }
  const length = Math.max(0.15, Math.min(4, segment.end - segment.start));
  const start = findAudibleStart(audio, length);
  const fallbackSegment = { start, end: Math.min(audio.samples.length / audio.channels / audio.sampleRate, start + length) };
  const fallbackParams = {
    ...DEFAULT_PARAMS,
    stretch: Math.min(4, Math.max(2, params.stretch)),
    windowSeconds: 0.25,
    seed: params.seed,
  };
  return stretchWithPaulstretch(audio, fallbackSegment, fallbackParams);
}


function PlayIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <path d="M2 1.25 8.25 5 2 8.75Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <rect x="2" y="1.25" width="2.25" height="7.5" />
      <rect x="5.75" y="1.25" width="2.25" height="7.5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <rect x="1.5" y="1.5" width="7" height="7" />
    </svg>
  );
}
function RestoreIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 5a4.25 4.25 0 1 1 .75 3.7M2 2.5V5h2.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="m2 2 6 6M8 2 2 8" />
    </svg>
  );
}

function IconButton({
  ariaLabel,
  children,
  className = "",
  disabled = false,
  expanded,
  onClick,
  pressed,
  allowReadOnly = false,
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  expanded?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  pressed?: boolean;
  allowReadOnly?: boolean;
}) {
  return (
    <button
      className={`icon-button ${className}`.trim()}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      title={ariaLabel}
      data-readonly-action={allowReadOnly ? "true" : undefined}
    >
      {children}
    </button>
  );
}

function RowActionsMenu({
  ariaLabel,
  children,
  className = "",
  panelClassName = "",
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={menuRef} className={`row-actions-menu ${className} ${open ? "is-open" : ""}`.trim()}>
      <IconButton className="row-actions-menu-trigger" expanded={open} ariaLabel={ariaLabel} onClick={() => setOpen((current) => !current)}>
        <span aria-hidden="true">•••</span>
      </IconButton>
      <div className={`row-actions-menu-panel ${panelClassName}`.trim()}>
        {children}
      </div>
    </div>
  );
}

function PlayButton({
  ariaLabel,
  className = "",
  disabled = false,
  isPaused = false,
  isPlaying = false,
  onClick,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  isPaused?: boolean;
  isPlaying?: boolean;
  onClick: () => void;
}) {
  const actionLabel = isPlaying
    ? ariaLabel.replace(/^Play /, "Pause ")
    : isPaused
      ? ariaLabel.replace(/^Play /, "Resume ")
      : ariaLabel;
  return (
    <IconButton className={`play-icon-button ${isPlaying ? "is-playing" : ""} ${className}`.trim()} onClick={onClick} disabled={disabled} ariaLabel={actionLabel} allowReadOnly>
      {isPlaying ? <PauseIcon /> : <PlayIcon />}
    </IconButton>
  );
}

function RangeField({
  ariaLabel,
  className = "",
  label,
  max,
  min,
  onChange,
  output,
  step,
  value,
  valueText,
}: {
  ariaLabel?: string;
  className?: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  output: string;
  step: number;
  value: number;
  valueText?: string;
}) {
  return (
    <label className={`range-field ${className}`.trim()}>
      <span className="range-field-label">{label}</span>
      <input aria-label={ariaLabel ?? label} aria-valuetext={valueText} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <output>{output}</output>
    </label>
  );
}

function ActionIcon({ children }: { children: ReactNode }) {
  return (
    <svg className="action-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function TriggerModeIcon({ mode }: { mode: LayerTriggerMode }) {
  return mode === "gate" ? (
    <ActionIcon>
      <path d="M2 11V8h3V4h6v4h3v3" />
    </ActionIcon>
  ) : (
    <ActionIcon>
      <path d="m3 3.5 7 4.5-7 4.5Z" />
      <path d="M12.5 3.5v9" />
    </ActionIcon>
  );
}


function HeadphonesIcon() {
  return (
    <ActionIcon>
      <path d="M2.5 8.5a5.5 5.5 0 0 1 11 0v3" />
      <path d="M2.5 8.5h1.25A1.25 1.25 0 0 1 5 9.75v1.5a1.25 1.25 0 0 1-1.25 1.25H3.5a1 1 0 0 1-1-1v-3Z" />
      <path d="M13.5 8.5h-1.25A1.25 1.25 0 0 0 11 9.75v1.5a1.25 1.25 0 0 0 1.25 1.25h.25a1 1 0 0 0 1-1v-3Z" />
    </ActionIcon>
  );
}

function ChainLinkIcon() {
  return (
    <ActionIcon>
      <path d="m6.25 9.75-1.5 1.5a2.25 2.25 0 0 1-3.18-3.18l2.1-2.1a2.25 2.25 0 0 1 3.18 0" />
      <path d="m9.75 6.25 1.5-1.5a2.25 2.25 0 0 1 3.18 3.18l-2.1 2.1a2.25 2.25 0 0 1-3.18 0" />
      <path d="m5.75 10.25 4.5-4.5" />
    </ActionIcon>
  );
}

function ShuffleIcon() {
  return (
    <ActionIcon>
      <path d="M2 4h2c2.5 0 3 8 5.5 8H14" />
      <path d="m11.5 10 2.5 2-2.5 2" />
      <path d="M2 12h2c2.5 0 3-8 5.5-8H14" />
      <path d="m11.5 2 2.5 2-2.5 2" />
    </ActionIcon>
  );
}

function SectionMarker({ expanded }: { expanded: boolean }) {
  return <span className="section-marker" aria-hidden="true">{expanded ? "−" : "+"}</span>;
}

function SectionHeader({
  actions,
  controlsId,
  expanded,
  label,
  onToggle,
}: {
  actions?: ReactNode;
  controlsId: string;
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <div className="section-action-row">
      <button
        className="section-toggle label-caps"
        type="button"
        aria-expanded={expanded}
        aria-controls={controlsId}
        onClick={onToggle}
        data-readonly-action="true"
      >
        <span>{label}</span>
        <SectionMarker expanded={expanded} />
      </button>
      {actions}
    </div>
  );
}

function DropdownPanel({ className, children }: { className: string; children: ReactNode }) {
  return <div className={`control-popover ${className}`}>{children}</div>;
}

const ENVELOPE_LEFT = 4;
const ENVELOPE_RIGHT = 184;
const ENVELOPE_BOTTOM = 46;
const ENVELOPE_TOP = 4;
const ENVELOPE_DEFAULT_SUSTAIN = 0.72;
type EnvelopeNode = "attack" | "decay" | "release";

function clampEnvelope(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function envelopePoints(adsr: PlaybackAdsr): Array<{ x: number; y: number }> {
  const attackX = clampEnvelope(ENVELOPE_LEFT + adsr.attackSeconds * 60, ENVELOPE_LEFT, ENVELOPE_RIGHT);
  const decayX = clampEnvelope(64 + adsr.decaySeconds * 60, attackX + 4, ENVELOPE_RIGHT);
  const sustainY = ENVELOPE_BOTTOM - adsr.sustainLevel * 42;
  const attackY = clampEnvelope(ENVELOPE_TOP + (ENVELOPE_DEFAULT_SUSTAIN - adsr.sustainLevel) * 42, ENVELOPE_TOP, ENVELOPE_BOTTOM);
  const releaseX = clampEnvelope(ENVELOPE_RIGHT - adsr.releaseSeconds * 60, decayX + 4, ENVELOPE_RIGHT);
  return [
    { x: ENVELOPE_LEFT, y: ENVELOPE_BOTTOM },
    { x: attackX, y: attackY },
    { x: decayX, y: sustainY },
    { x: releaseX, y: sustainY },
    { x: ENVELOPE_RIGHT, y: ENVELOPE_BOTTOM },
  ];
}

function updateAdsrFromEnvelope(
  current: PlaybackAdsr,
  node: EnvelopeNode,
  x: number,
  y: number,
): PlaybackAdsr {
  const next = { ...current };
  if (node === "attack") {
    next.attackSeconds = clampEnvelope((x - ENVELOPE_LEFT) / 60, 0, 4);
    next.sustainLevel = clampEnvelope(ENVELOPE_DEFAULT_SUSTAIN - (y - ENVELOPE_TOP) / 42, 0, 1);
  }
  if (node === "decay") next.decaySeconds = clampEnvelope((x - 64) / 60, 0, 4);
  if (node === "release") next.releaseSeconds = clampEnvelope((ENVELOPE_RIGHT - x) / 60, 0, 4);
  if (node === "decay" || node === "release") next.sustainLevel = clampEnvelope((ENVELOPE_BOTTOM - y) / 42, 0, 1);
  return next;
}

function EnvelopeGraph({ adsr, onChange }: { adsr: PlaybackAdsr; onChange: (next: PlaybackAdsr) => void }) {
  const graphRef = useRef<SVGSVGElement | null>(null);
  const [nodeYScale, setNodeYScale] = useState(1);
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const updateScale = () => {
      const bounds = graph.getBoundingClientRect();
      const scale = (bounds.width / 200) / (bounds.height / 48);
      setNodeYScale(Number.isFinite(scale) && scale > 0 ? scale : 1);
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(graph);
    return () => observer.disconnect();
  }, []);
  const points = envelopePoints(adsr);
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
  const nodeNames: Array<EnvelopeNode | null> = [null, "attack", "decay", "release", null];

  function eventPoint(event: ReactPointerEvent<SVGCircleElement>): { x: number; y: number } {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * 200,
      y: ((event.clientY - bounds.top) / bounds.height) * 48,
    };
  }

  function updateFromPointer(event: ReactPointerEvent<SVGCircleElement>, node: EnvelopeNode): void {
    const point = eventPoint(event);
    onChange(updateAdsrFromEnvelope(adsr, node, point.x, point.y));
  }

  function updateFromKeyboard(event: ReactKeyboardEvent<SVGCircleElement>, node: EnvelopeNode): void {
    const step = event.shiftKey ? 0.1 : 0.01;
    const horizontal = event.key === "ArrowRight" || event.key === "ArrowLeft";
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const delta = event.key === "ArrowRight" || event.key === "ArrowUp" ? step : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    onChange({
      ...adsr,
      ...(node === "attack" && horizontal ? { attackSeconds: clampEnvelope(adsr.attackSeconds + delta, 0, 4) } : {}),
      ...(node === "decay" && horizontal ? { decaySeconds: clampEnvelope(adsr.decaySeconds + delta, 0, 4) } : {}),
      ...(node === "release" && horizontal ? { releaseSeconds: clampEnvelope(adsr.releaseSeconds - delta, 0, 4) } : {}),
      ...((node === "attack" || node === "decay" || node === "release") && vertical
        ? { sustainLevel: clampEnvelope(adsr.sustainLevel + delta, 0, 1) }
        : {}),
    });
  }

  return (
    <svg ref={graphRef} className="envelope-graph" viewBox="0 0 200 48" preserveAspectRatio="none" role="group" aria-label="ADSR envelope editor">
      <path d={path} />
      {points.map((point, index) => {
        const node = nodeNames[index];
        const transform = `translate(${point.x} ${point.y}) scale(1 ${nodeYScale}) translate(${-point.x} ${-point.y})`;
        if (!node) return <circle key={index} cx={point.x} cy={point.y} r="1.5" transform={transform} aria-hidden="true" />;
        const value = node === "attack" ? adsr.attackSeconds : node === "decay" ? adsr.decaySeconds : adsr.releaseSeconds;
        const text = node === "attack" ? `${adsr.attackSeconds.toFixed(2)} seconds` : node === "decay" ? `${adsr.decaySeconds.toFixed(2)} seconds, sustain ${adsr.sustainLevel.toFixed(2)}` : `${adsr.releaseSeconds.toFixed(2)} seconds, sustain ${adsr.sustainLevel.toFixed(2)}`;
        return (
          <circle
            key={node}
            className="envelope-node"
            transform={transform}
            cx={point.x}
            cy={point.y}
            r="2"
            role="slider"
            tabIndex={0}
            aria-label={`${node} envelope node`}
            aria-valuemin={0}
            aria-valuemax={4}
            aria-valuenow={value}
            aria-valuetext={text}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              updateFromPointer(event, node);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(event, node);
            }}
            onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            onPointerCancel={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            onKeyDown={(event) => updateFromKeyboard(event, node)}
          />
        );
      })}
    </svg>
  );
}

export function App() {
  const [sources, setSources] = useState<AudioSource[]>(() =>
    (persistedStudioState?.sources ?? [{ id: "source", name: readStoredSourceFileName(), duration: 0 }]).map((item) => ({ ...item, audio: null }))
  );
  const source = sources.find((item) => item.audio)?.audio ?? null;
  const duration = sources.find((item) => item.audio)?.duration ?? sources[0]?.duration ?? 0;
  const sourceMap = useMemo(() => new Map(sources.flatMap((item) => item.audio ? [[item.id, item.audio] as const] : [])), [sources]);
  function sourceForLayer(layer: Layer): PcmAudio | null {
    return layer.sourceId ? sourceMap.get(layer.sourceId) ?? null : source;
  }
  function durationForLayer(layer: Layer): number {
    return layer.sourceId ? sources.find((item) => item.id === layer.sourceId)?.duration ?? 0 : duration;
  }
  const [layers, setLayers] = useState<Layer[]>(() => persistedStudioState?.layers ?? []);
  const [sequencers, setSequencers] = useState<Sequencer[]>(() => persistedStudioState?.sequencers ?? []);
  const [activeSequencerId, setActiveSequencerId] = useState(() => {
    const savedSequences = persistedStudioState?.sequencers ?? [];
    return savedSequences.some((sequence) => sequence.id === persistedStudioState?.activeSequencerId)
      ? persistedStudioState?.activeSequencerId ?? MAIN_SEQUENCE_ID
      : savedSequences[0]?.id ?? MAIN_SEQUENCE_ID;
  });
  const [selectedCellIndex, setSelectedCellIndex] = useState(() => persistedStudioState?.selectedCellIndex ?? 0);
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(() => {
    const savedSequences = persistedStudioState?.sequencers ?? [];
    const activeId = savedSequences.some((sequence) => sequence.id === persistedStudioState?.activeSequencerId)
      ? persistedStudioState?.activeSequencerId
      : savedSequences[0]?.id;
    const sequence = savedSequences.find((candidate) => candidate.id === activeId);
    const step = sequence?.steps[persistedStudioState?.selectedCellIndex ?? 0];
    return sequence && step ? new Set([sequenceClipKey(sequence.id, step.id)]) : new Set();
  });
  const [generatedCount, setGeneratedCount] = useState(4);
  const [generatedSeed, setGeneratedSeed] = useState(23);
  const [generatedLinked, setGeneratedLinked] = useState(true);
  const [generatedSequenceRows, setGeneratedSequenceRows] = useState(4);
  const [generatedSequenceColumns, setGeneratedSequenceColumns] = useState(8);
  const [generatedSequenceDensity, setGeneratedSequenceDensity] = useState(3);
  const [generatedClipDuration, setGeneratedClipDuration] = useState(2);
  const sequenceDensityLabel = SEQUENCE_DENSITY_LABELS[generatedSequenceDensity - 1];
  const clipDurationLabel = CLIP_DURATION_LABELS[generatedClipDuration - 1];
  const [status, setStatus] = useState("Import an audio file to begin.");
  const [ownerProject, setOwnerProject] = useState<{ id: string; capability: string; revision: number } | null>(() => {
    try {
      const opened = JSON.parse(window.sessionStorage.getItem("souunnds.open-project") ?? "null");
      if (!opened || typeof opened.id !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(opened.id)) return null;
      const owner = JSON.parse(window.localStorage.getItem(`souunnds.project-owner.${opened.id}`) ?? "null");
      return owner && typeof owner.capability === "string" && Number.isSafeInteger(opened.revision)
        ? { id: opened.id, capability: owner.capability, revision: opened.revision }
        : null;
    } catch {
      return null;
    }
  });
  const [openedProjectId, setOpenedProjectId] = useState<string | null>(() => {
    try {
      const opened = JSON.parse(window.sessionStorage.getItem("souunnds.open-project") ?? "null");
      return typeof opened?.id === "string" ? opened.id : null;
    } catch {
      return null;
    }
  });
  const [remoteConflictRevision, setRemoteConflictRevision] = useState<number | null>(() => {
    try {
      const opened = JSON.parse(window.sessionStorage.getItem("souunnds.open-project") ?? "null");
      return Number.isSafeInteger(opened?.conflictRevision) && opened.conflictRevision > opened.revision
        ? opened.conflictRevision as number : null;
    } catch {
      return null;
    }
  });
  const [shareStatus, setShareStatus] = useState("");
  const [includeSourceAudio, setIncludeSourceAudio] = useState(false);
  const projectRevisionRef = useRef(ownerProject?.revision ?? 1);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveTimerRef = useRef<number | null>(null);
  const saveSnapshotRef = useRef<() => Promise<void>>(async () => {});
  const saveErrorRef = useRef(false);
  const [processing, setProcessing] = useState<string | null>(null);
  const [processingProgress, setProcessingProgress] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [keyboardPlaying, setKeyboardPlaying] = useState(false);
  const [playbackTarget, setPlaybackTarget] = useState<PlaybackTarget | null>(null);
  const [sequencePlayback, setSequencePlayback] = useState<SequencePlayback | null>(null);
  const [sequenceProgress, setSequenceProgress] = useState<Array<{ sequenceId: string; elapsedSeconds: number }>>([]);
  const arrangement = useMemo<Arrangement>(() => ({ layers, sequencers }), [layers, sequencers]);
  const activeSequencer = sequencers.find((sequence) => sequence.id === activeSequencerId) ?? sequencers[0];
  const [expandedSections, setExpandedSections] = useState({ sources: true, layers: true, sequence: true, adsr: true });
  const selectedClips = useMemo(() => sequencers.flatMap((sequence) => (
    sequence.steps.flatMap((step, index) => (
      selectedClipIds.has(sequenceClipKey(sequence.id, step.id))
        ? [{ sequenceId: sequence.id, index, step }]
        : []
    ))
  )), [selectedClipIds, sequencers]);
  const allSelectedClipsMuted = selectedClips.length > 0 && selectedClips.every(({ step }) => step.muted);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [sequenceGeneratorOpen, setSequenceGeneratorOpen] = useState(false);
  const [selectedCellOpen, setSelectedCellOpen] = useState(false);
  const [sequenceDurationMenuId, setSequenceDurationMenuId] = useState<string | null>(null);
  const [adsr, setAdsr] = useState<PlaybackAdsr>(() => persistedStudioState?.adsr ?? { ...DEFAULT_PLAYBACK_ADSR });
  const [effects, setEffects] = useState<PlaybackEffects>(() => persistedStudioState?.effects ?? { ...DEFAULT_PLAYBACK_EFFECTS });
  const compressorLowAmount = normalizedCompressorAmount(effects.compressorLowAmount);
  const compressorMidAmount = normalizedCompressorAmount(effects.compressorMidAmount);
  const compressorHighAmount = normalizedCompressorAmount(effects.compressorHighAmount);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [tailPlaying, setTailPlaying] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const effectNodesRef = useRef<PlaybackEffectNodes | null>(null);
  const latestEffectsRef = useRef(effects);
  const effectInputRef = useRef<GainNode | null>(null);
  const effectTailTimeoutRef = useRef<number | null>(null);
  const playbackStartedAtRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedSourceIdRef = useRef("source");
  const audioPopoverRef = useRef<HTMLDivElement | null>(null);
  const audioPickerButtonRef = useRef<HTMLButtonElement | null>(null);
  const audioPickerPointerOpenedRef = useRef(false);
  const youtubeRequestsRef = useRef(new Map<string, AbortController>());
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [youtubeError, setYoutubeError] = useState<{ id: string; message: string } | null>(null);
  const [youtubeLoadingId, setYoutubeLoadingId] = useState<string | null>(null);
  const [audioMenuSourceId, setAudioMenuSourceId] = useState<string | null>(null);
  const keyboardBusRef = useRef<KeyboardPlaybackBus | null>(null);
  const keyboardVoicesRef = useRef(new Map<string, KeyboardLayerVoice>());
  const pendingKeyboardTriggersRef = useRef(new Map<string, symbol>());
  const activeTriggerCodesRef = useRef(new Map<string, { layerId: string; mode: LayerTriggerMode }>());
  const playbackRequestRef = useRef(0);
  const processingRequestRef = useRef<number | null>(null);
  const sourceLoadRequestRef = useRef(new Map<string, symbol>());
  const sourceStorePendingRef = useRef(new Map<string, Promise<boolean>>());
  const [cachedSourceIds, setCachedSourceIds] = useState<Set<string>>(() => new Set());
  const restoringSourceIdsRef = useRef(new Set<string>());
  function markCachedSource(id: string, cached: boolean): void {
    setCachedSourceIds((current) => {
      if (current.has(id) === cached) return current;
      const next = new Set(current);
      if (cached) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const initialArrangementCreatedRef = useRef(layers.length > 0 || sequencers.length > 0);

  const renderCacheRef = useRef(new WeakMap<PcmAudio, Map<string, Promise<PcmAudio>>>());

  async function renderLayerCached(audio: PcmAudio, segment: Layer["segment"], params: Layer["params"]): Promise<PcmAudio> {
    let cache = renderCacheRef.current.get(audio);
    if (!cache) {
      cache = new Map();
      renderCacheRef.current.set(audio, cache);
    }
    const key = JSON.stringify([segment.start, segment.end, params.stretch, params.windowSeconds, params.overlap, params.onset, params.seed]);
    const cached = cache.get(key);
    if (cached) return cached;
    if (cache.size >= 64) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    const pending = stretchForPlayback(audio, segment, params);
    cache.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }
  const resizeRef = useRef<ResizeState | null>(null);
  const sequenceResizeRef = useRef<SequenceResizeState | null>(null);

  const layerNames = useMemo(() => new Map(layers.map((layer) => [layer.id, layer.name])), [layers]);
  const layerColors = useMemo(() => new Map(layers.map((layer) => [layer.id, layer.color])), [layers]);
  const sourceSelectOptions = useMemo(() => sources.map((item, index) => ({
    value: item.id,
    label: `${index + 1} · ${item.name || "Choose audio"}`,
    disabled: !item.audio,
  })), [sources]);
  const layerSelectOptions = useMemo(() => layers.map((layer) => ({
    value: layer.id,
    label: layer.name,
    color: layer.color,
  })), [layers]);


  const readOnlySharedProject = openedProjectId !== null && ownerProject?.id !== openedProjectId;
  useEffect(() => {
    const validClipIds = new Set(sequencers.flatMap((sequence) => (
      sequence.steps.map((step) => sequenceClipKey(sequence.id, step.id))
    )));
    setSelectedClipIds((current) => {
      const next = new Set([...current].filter((id) => validClipIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [sequencers]);

  // This is a one-time bootstrap. Forking changes project state explicitly; re-reading the
  // module's original manifest after that transition would restore stale asset IDs.
  useEffect(() => {
    let cancelled = false;
    for (const item of persistedStudioState?.sources ?? [{ id: "source", name: readStoredSourceFileName(), duration: 0 }]) {
      if (item.assetId) {
        void loadHostedAudio(item.id, item.name, item.assetId);
        continue;
      }
      if (item.sourceUrl) {
        void loadYoutubeAudio(item.id, item.sourceUrl);
        continue;
      }
      if (readOnlySharedProject) continue;
      void readStoredAudioFile(item.id).then(async (file) => {
        if (!file || cancelled || sourceLoadRequestRef.current.has(item.id)) return;
        markCachedSource(item.id, true);
        const token = Symbol(item.id);
        sourceLoadRequestRef.current.set(item.id, token);
        try {
          const decoded = await ensureContext().decodeAudioData(await file.arrayBuffer());
          if (cancelled || sourceLoadRequestRef.current.get(item.id) !== token) return;
          setSources((current) => current.map((candidate) =>
            candidate.id === item.id ? { ...candidate, audio: pcmFromAudioBuffer(decoded), duration: decoded.duration } : candidate
          ));
        } catch {
          if (!cancelled) setStatus(`Could not restore ${item.name}. Choose audio to replace it.`);
        } finally {
          if (sourceLoadRequestRef.current.get(item.id) === token) sourceLoadRequestRef.current.delete(item.id);
        }
      });
    }
    return () => { cancelled = true; };
  }, []);


  const studioState = {
    sources: sources.map(({ id, name, duration: length, sourceUrl, assetId }) => ({ id, name, duration: length, ...(sourceUrl ? { sourceUrl } : {}), ...(assetId ? { assetId } : {}) })),
    layers,
    sequencers,
    adsr,
    effects: {
      ...effects,
      compressorLowAmount,
      compressorMidAmount,
      compressorHighAmount,
    },
    activeSequencerId,
    selectedCellIndex,
  };
  const lastPersistedStateRef = useRef<string | null>(null);
  useEffect(() => {
    const serializedState = JSON.stringify(studioState);
    try {
      window.localStorage.setItem(studioStateStorageKey(), serializedState);
      if (ownerProject && lastPersistedStateRef.current !== null && serializedState !== lastPersistedStateRef.current) {
        window.localStorage.setItem(`souunnds.project-dirty.${ownerProject.id}`, "true");
      }
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
    lastPersistedStateRef.current = serializedState;
  }, [activeSequencerId, adsr, effects, layers, ownerProject?.id, selectedCellIndex, sequencers, sources]);

  useEffect(() => {
    if (!ownerProject) return;
    const stateSnapshot = JSON.stringify(studioState);
    const manifest = {
      version: 1,
      sources: studioState.sources.map((source) => source.sourceUrl
        ? { id: source.id, name: source.name, duration: source.duration, kind: "youtube" as const, url: source.sourceUrl }
        : source.assetId
          ? { id: source.id, name: source.name, duration: source.duration, kind: "asset" as const, assetId: source.assetId }
          : { id: source.id, name: source.name, duration: source.duration, kind: "missing" as const }),
      state: studioState,
    };
    saveSnapshotRef.current = async () => {
      saveErrorRef.current = false;
      const response = await fetch(`/api/projects/${ownerProject.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerProject.capability}`,
          "If-Match": `"${projectRevisionRef.current}"`,
        },
        body: JSON.stringify({ manifest }),
      });
      if (response.status === 409) {
        saveErrorRef.current = true;
        try {
          const latestResponse = await fetch(`/api/projects/${ownerProject.id}`, { cache: "no-store" });
          if (latestResponse.ok) {
            const latest = await latestResponse.json() as { revision: number };
            if (Number.isSafeInteger(latest.revision) && latest.revision > projectRevisionRef.current) {
              setRemoteConflictRevision(latest.revision);
              window.sessionStorage.setItem("souunnds.open-project", JSON.stringify({
                id: ownerProject.id,
                revision: projectRevisionRef.current,
                conflictRevision: latest.revision,
              }));
              setShareStatus("The online project has newer changes. Your local draft is preserved.");
              return;
            }
          }
        } catch {
          // Keep the local draft and revision if the online version cannot be read.
        }
        setShareStatus("This project changed elsewhere. Your local draft is preserved.");
        return;
      }
      if (!response.ok) throw new Error("Could not save the shared project.");
      const saved = await response.json() as { revision: number };
      projectRevisionRef.current = saved.revision;
      window.sessionStorage.setItem("souunnds.open-project", JSON.stringify({ id: ownerProject.id, revision: saved.revision }));
      try {
        window.localStorage.setItem(`souunnds.project-revision.${ownerProject.id}`, String(saved.revision));
        const currentState = window.localStorage.getItem(`souunnds.project-state.${ownerProject.id}`);
        window.localStorage.setItem(`souunnds.project-dirty.${ownerProject.id}`, currentState === stateSnapshot ? "false" : "true");
      } catch {
        // The remote save still succeeded if local metadata storage is unavailable.
      }
      setRemoteConflictRevision(null);
      setShareStatus("Saved");
    };
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveQueueRef.current = saveQueueRef.current
        .then(() => saveSnapshotRef.current())
        .catch(() => {
          saveErrorRef.current = true;
          setShareStatus("Could not save online. Your local copy is still saved.");
        });
    }, 900);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, [activeSequencerId, adsr, effects, layers, ownerProject?.capability, ownerProject?.id, selectedCellIndex, sequencers, sources]);


  useEffect(() => {
    if (!sequencePlayback) {
      setSequenceProgress([]);
      return;
    }
    let frameId = 0;
    const trackDuration = (track: SequencePlayback["tracks"][number]) => Math.max(0, track.durationSeconds);
    const totalDuration = sequencePlayback.simultaneous
      ? Math.max(...sequencePlayback.tracks.map(trackDuration))
      : sequencePlayback.tracks.reduce((total, track) => total + trackDuration(track), 0);
    const update = () => {
      const now = sequencePlayback.pausedAt ?? performance.now();
      const rawElapsed = (now - sequencePlayback.startedAt) / 1000;
      const elapsed = sequencePlayback.loop && totalDuration > 0 ? rawElapsed % totalDuration : rawElapsed;
      let cursor = 0;
      const progress = sequencePlayback.tracks.map((track) => {
        const duration = trackDuration(track);
        const relativeElapsed = sequencePlayback.simultaneous ? elapsed : Math.max(0, elapsed - cursor);
        const trackElapsed = track.loop && duration > 0 ? relativeElapsed % duration : Math.min(relativeElapsed, duration);
        if (!sequencePlayback.simultaneous) cursor += duration;
        return { sequenceId: track.sequenceId, elapsedSeconds: trackElapsed };
      });
      setSequenceProgress(progress);
      if (sequencePlayback.pausedAt === undefined && elapsed < totalDuration) frameId = requestAnimationFrame(update);
    };
    frameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frameId);
  }, [sequencePlayback]);
  useEffect(() => {
    if (!playing) {
      playbackStartedAtRef.current = null;
      return;
    }
    let frameId = 0;
    const update = () => {
      if (playbackStartedAtRef.current !== null) {
        setElapsedSeconds((performance.now() - playbackStartedAtRef.current) / 1000);
      }
      frameId = requestAnimationFrame(update);
    };
    frameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frameId);
  }, [playing]);
  useEffect(() => {
    latestEffectsRef.current = effects;
    const nodes = effectNodesRef.current;
    const context = contextRef.current;
    if (nodes && context) updatePlaybackEffectNodes(nodes, effects, context.currentTime);
    const keyboardBus = keyboardBusRef.current;
    if (keyboardBus) updatePlaybackEffectNodes(keyboardBus.effects, effects, keyboardBus.context.currentTime);
  }, [effects]);
  useEffect(() => {
    const nodes = effectNodesRef.current;
    const context = contextRef.current;
    if (!nodes || !context || effectTailTimeoutRef.current === null) return;
    if (!retirePlaybackEffectsAfterTail(nodes, context, effects)) {
      setTailPlaying(false);
      setPlaybackTarget(null);
      setStatus("Effects tail finished.");
    }
  }, [effects.reverbMix, effects.reverbDecaySeconds, effects.reverbPreDelaySeconds, effects.delayMix, effects.delaySeconds, effects.delayFeedback]);
  useEffect(() => {
    const nodes = effectNodesRef.current;
    const context = contextRef.current;
    const keyboardBus = keyboardBusRef.current;
    if ((!nodes || !context) && !keyboardBus) return;
    const timeoutId = window.setTimeout(() => {
      if (nodes && context && effectNodesRef.current === nodes) {
        nodes.convolver.buffer = reverbImpulse(context, effects.reverbDecaySeconds);
      }
      if (keyboardBusRef.current === keyboardBus && keyboardBus) {
        keyboardBus.effects.convolver.buffer = reverbImpulse(keyboardBus.context, effects.reverbDecaySeconds);
      }
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, [effects.reverbDecaySeconds]);
  useEffect(() => {
    if (!selectedCellOpen && !sequenceDurationMenuId) return;
    const closePopovers = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".cell-inspector, .sequence-cell-main, .sequence-duration-popover, .sequence-end-anchor, .themed-select-content")) return;
      setSelectedCellOpen(false);
      setSequenceDurationMenuId(null);
    };
    document.addEventListener("pointerdown", closePopovers);
    return () => document.removeEventListener("pointerdown", closePopovers);
  }, [selectedCellOpen, sequenceDurationMenuId]);
  useEffect(() => {
    const validLayerIds = new Set(layers.map((layer) => layer.id));
    for (const layerId of keyboardVoicesRef.current.keys()) {
      if (!validLayerIds.has(layerId)) stopKeyboardLayerVoice(layerId);
    }
    for (const layerId of pendingKeyboardTriggersRef.current.keys()) {
      if (!validLayerIds.has(layerId)) pendingKeyboardTriggersRef.current.delete(layerId);
    }
  }, [layers]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || isEditableTriggerTarget(event.target)) return;
      const triggerIndex = LAYER_TRIGGER_BINDINGS.findIndex((binding) => binding.code === event.code);
      const layer = layers[triggerIndex];
      if (triggerIndex < 0 || !layer || !sourceForLayer(layer) || layer.muted || activeTriggerCodesRef.current.has(event.code)) return;
      const mode: LayerTriggerMode = layer.triggerMode === "gate" ? "gate" : "one-shot";
      activeTriggerCodesRef.current.set(event.code, { layerId: layer.id, mode });
      event.preventDefault();
      void triggerLayerFromKeyboard(layer, event.code, mode);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      const active = activeTriggerCodesRef.current.get(event.code);
      if (!active) return;
      activeTriggerCodesRef.current.delete(event.code);
      if (active.mode === "gate") {
        pendingKeyboardTriggersRef.current.delete(active.layerId);
        stopKeyboardLayerVoice(active.layerId, true);
      }
      event.preventDefault();
    };
    const handleBlur = () => {
      for (const active of activeTriggerCodesRef.current.values()) {
        if (active.mode === "gate") {
          pendingKeyboardTriggersRef.current.delete(active.layerId);
          stopKeyboardLayerVoice(active.layerId, true);
        }
      }
      activeTriggerCodesRef.current.clear();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [adsr, effects, layers, sources]);
  useEffect(() => () => {
    if (effectTailTimeoutRef.current !== null) window.clearTimeout(effectTailTimeoutRef.current);
    effectTailTimeoutRef.current = null;
    const source = sourceNodeRef.current;
    sourceNodeRef.current = null;
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    effectNodesRef.current?.disconnect();
    effectNodesRef.current = null;
    effectInputRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    void context?.close();
    stopAllKeyboardLayerVoices(false);
    const keyboardBus = keyboardBusRef.current;
    keyboardBusRef.current = null;
    keyboardBus?.effects.disconnect();
    void keyboardBus?.context.close();
  }, []);

  function isEditableTriggerTarget(target: EventTarget | null): boolean {
    return target instanceof Element && (target.closest("input, select, textarea, button") !== null || (target instanceof HTMLElement && target.isContentEditable));
  }

  function ensureContext(): AudioContext {
    if (!contextRef.current) contextRef.current = new AudioContext();
    return contextRef.current;
  }

  function ensureKeyboardBus(): KeyboardPlaybackBus {
    const current = keyboardBusRef.current;
    if (current && current.context.state !== "closed") return current;
    const context = new AudioContext();
    const input = context.createGain();
    const keyboardBus = { context, input, effects: connectPlaybackEffects(context, input, effects) };
    keyboardBusRef.current = keyboardBus;
    return keyboardBus;
  }

  function stopKeyboardLayerVoice(layerId: string, useAdsrRelease = false, updateState = true): void {
    const voice = keyboardVoicesRef.current.get(layerId);
    if (!voice || (useAdsrRelease && voice.releasing)) return;
    const now = voice.source.context.currentTime;
    const releaseSeconds = useAdsrRelease ? voice.releaseSeconds : 0.005;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    if (releaseSeconds > 0) voice.gain.gain.linearRampToValueAtTime(0, now + releaseSeconds);
    if (useAdsrRelease && releaseSeconds > 0) {
      voice.releasing = true;
    } else {
      keyboardVoicesRef.current.delete(layerId);
      if (updateState) setKeyboardPlaying(keyboardVoicesRef.current.size > 0);
    }
    try {
      voice.source.stop(now + releaseSeconds);
    } catch {
      keyboardVoicesRef.current.delete(layerId);
      voice.source.disconnect();
      voice.gain.disconnect();
      if (updateState) setKeyboardPlaying(keyboardVoicesRef.current.size > 0);
    }
  }
  function stopAllKeyboardLayerVoices(updateState = true): void {
    pendingKeyboardTriggersRef.current.clear();
    activeTriggerCodesRef.current.clear();
    for (const layerId of [...keyboardVoicesRef.current.keys()]) stopKeyboardLayerVoice(layerId, false, false);
    if (updateState) setKeyboardPlaying(false);
  }

  async function triggerLayerFromKeyboard(layer: Layer, code: string, mode: LayerTriggerMode): Promise<void> {
    if (!sourceForLayer(layer)) return;
    const token = Symbol(layer.id);
    pendingKeyboardTriggersRef.current.set(layer.id, token);
    try {
      const playbackArrangement = arrangementForPlayback();
      const playableLayer = playbackArrangement.layers.find((candidate) => candidate.id === layer.id) ?? layer;
      const stretched = await renderLayerCached(sourceForLayer(playableLayer)!, playableLayer.segment, playableLayer.params);
      const rendered = pitchShiftPcm(stretched, playableLayer.pitchSemitones ?? 0);
      if (pendingKeyboardTriggersRef.current.get(layer.id) !== token) return;
      if (mode === "gate" && activeTriggerCodesRef.current.get(code)?.layerId !== layer.id) return;
      const keyboardBus = ensureKeyboardBus();
      await keyboardBus.context.resume();
      if (pendingKeyboardTriggersRef.current.get(layer.id) !== token) return;
      stopKeyboardLayerVoice(layer.id);
      const preparedAudio = applyPlaybackAdsr(rendered, adsr);
      const node = keyboardBus.context.createBufferSource();
      const gain = keyboardBus.context.createGain();
      node.buffer = audioBufferFromPcm(keyboardBus.context, preparedAudio);
      gain.gain.value = playableLayer.gain;
      node.connect(gain);
      gain.connect(keyboardBus.input);
      const voice: KeyboardLayerVoice = { source: node, gain, releaseSeconds: Math.max(0, adsr.releaseSeconds), releasing: false };
      keyboardVoicesRef.current.set(layer.id, voice);
      setKeyboardPlaying(true);
      pendingKeyboardTriggersRef.current.delete(layer.id);
      node.onended = () => {
        node.disconnect();
        gain.disconnect();
        if (keyboardVoicesRef.current.get(layer.id) === voice) {
          keyboardVoicesRef.current.delete(layer.id);
          setKeyboardPlaying(keyboardVoicesRef.current.size > 0);
        }
      };
      node.start();
    } catch (error) {
      if (pendingKeyboardTriggersRef.current.get(layer.id) === token) pendingKeyboardTriggersRef.current.delete(layer.id);
      setStatus(error instanceof Error ? error.message : `Could not trigger ${layer.name}.`);
    }
  }

  function cancelPendingPlaybackRender(): boolean {
    if (processingRequestRef.current === null) return false;
    playbackRequestRef.current += 1;
    processingRequestRef.current = null;
    clearProcessing();
    return true;
  }

  function cancelArrangementPlayback(): void {
    const cancelledRender = cancelPendingPlaybackRender();
    if (isArrangementDerivedPlayback(playbackTarget)) {
      stopActivePlayback();
      setStatus("Playback stopped.");
    } else if (cancelledRender) {
      setStatus("Playback rendering canceled.");
    }
  }
  function cancelSequencePlayback(): void {
    const cancelledRender = cancelPendingPlaybackRender();
    if (isSequenceDerivedPlayback(playbackTarget)) {
      stopActivePlayback();
      setStatus("Playback stopped.");
    } else if (cancelledRender) {
      setStatus("Playback rendering canceled.");
    }
  }


  function clearProcessing(): void {
    processingRequestRef.current = null;
    setProcessing(null);
    setProcessingProgress(null);
  }

  function stopActivePlayback(preserveEffects = false): void {
    stopAllKeyboardLayerVoices();
    if (contextRef.current?.state === "suspended") void contextRef.current.resume();
    const node = sourceNodeRef.current;
    sourceNodeRef.current = null;
    if (node) {
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    if (effectTailTimeoutRef.current !== null) window.clearTimeout(effectTailTimeoutRef.current);
    effectTailTimeoutRef.current = null;
    if (!preserveEffects) {
      effectNodesRef.current?.disconnect();
      effectNodesRef.current = null;
      effectInputRef.current = null;
    }
    playbackStartedAtRef.current = null;
    setPlaying(false);
    setPaused(false);
    setTailPlaying(false);
    setElapsedSeconds(0);
    setSequencePlayback(null);
    setPlaybackTarget(null);
  }

  function retirePlaybackEffectsAfterTail(nodes: PlaybackEffectNodes, context: AudioContext, currentEffects: PlaybackEffects): boolean {
    if (effectTailTimeoutRef.current !== null) window.clearTimeout(effectTailTimeoutRef.current);
    effectTailTimeoutRef.current = null;
    const tailSeconds = playbackEffectTailSeconds(currentEffects);
    if (!tailSeconds) {
      nodes.disconnect();
      effectNodesRef.current = null;
      effectInputRef.current = null;
      return false;
    }
    const expiresAt = context.currentTime + tailSeconds;
    const retire = () => {
      if (effectNodesRef.current !== nodes || sourceNodeRef.current) return;
      const remaining = expiresAt - context.currentTime;
      if (remaining > 0 && context.state !== "closed") {
        effectTailTimeoutRef.current = window.setTimeout(retire, Math.max(20, Math.ceil(remaining * 1000)));
        return;
      }
      effectTailTimeoutRef.current = null;
      nodes.disconnect();
      effectNodesRef.current = null;
      effectInputRef.current = null;
      setTailPlaying(false);
      setPlaybackTarget(null);
      setStatus("Effects tail finished.");
    };
    effectTailTimeoutRef.current = window.setTimeout(retire, Math.ceil(tailSeconds * 1000));
    return true;
  }

  function stopPlayback(): void {
    playbackRequestRef.current += 1;
    clearProcessing();
    stopActivePlayback();
    setStatus("Playback stopped.");
  }
  async function playPcm(
    audio: PcmAudio,
    label: string,
    target: PlaybackTarget,
    sequenceTracks?: SequencePlayback["tracks"],
    simultaneous = false,
    playbackAdsr: PlaybackAdsr | null = adsr,
    loop = false,
    requestId = playbackRequestRef.current,
  ): Promise<void> {
    const context = ensureContext();
    await context.resume();
    if (requestId !== playbackRequestRef.current) return;
    const preparedAudio = playbackAdsr ? applyPlaybackAdsr(audio, playbackAdsr) : audio;
    const node = context.createBufferSource();
    node.buffer = audioBufferFromPcm(context, preparedAudio);
    node.loop = loop;
    stopActivePlayback(true);
    const effectInput = effectInputRef.current ?? context.createGain();
    let effectNodes = effectNodesRef.current;
    if (effectNodes) {
      updatePlaybackEffectNodes(effectNodes, effects, context.currentTime);
      const impulse = reverbImpulse(context, effects.reverbDecaySeconds);
      if (effectNodes.convolver.buffer !== impulse) effectNodes.convolver.buffer = impulse;
    } else {
      effectNodes = connectPlaybackEffects(context, effectInput, effects);
      effectNodesRef.current = effectNodes;
      effectInputRef.current = effectInput;
    }
    node.connect(effectInput);
    node.onended = () => {
      if (sourceNodeRef.current === node) {
        sourceNodeRef.current = null;
        node.disconnect();
        const hasTail = effectNodesRef.current === effectNodes && retirePlaybackEffectsAfterTail(effectNodes, context, latestEffectsRef.current);
        playbackStartedAtRef.current = null;
        setPlaying(false);
        setPaused(false);
        setTailPlaying(hasTail);
        setElapsedSeconds(0);
        setSequencePlayback(null);
        if (hasTail) setStatus("Effects tail playing.");
        else {
          setPlaybackTarget(null);
          setStatus("Playback finished.");
        }
      }
    };
    sourceNodeRef.current = node;
    node.start();
    playbackStartedAtRef.current = performance.now();
    setElapsedSeconds(0);
    setPaused(false);
    setPlaybackTarget(target);
    setPlaying(true);
    if (sequenceTracks) setSequencePlayback({ tracks: sequenceTracks, startedAt: performance.now(), simultaneous, loop });
    setStatus(`Playing ${label} · ${formatSeconds(preparedAudio.samples.length / preparedAudio.channels / preparedAudio.sampleRate)}`);
  }

  async function pausePlayback(): Promise<void> {
    const context = contextRef.current;
    if (!context || !sourceNodeRef.current || !playing) return;
    if (playbackStartedAtRef.current !== null) {
      setElapsedSeconds((performance.now() - playbackStartedAtRef.current) / 1000);
    }
    playbackStartedAtRef.current = null;
    const pausedAt = performance.now();
    setSequencePlayback((current) => current ? { ...current, pausedAt } : current);
    await context.suspend();
    setPlaying(false);
    setPaused(true);
    setStatus("Playback paused.");
  }

  async function resumePlayback(): Promise<void> {
    const context = contextRef.current;
    if (!context || !sourceNodeRef.current || !paused) return;
    const resumedAt = performance.now();
    setSequencePlayback((current) => current?.pausedAt === undefined
      ? current
      : { ...current, startedAt: current.startedAt + resumedAt - current.pausedAt, pausedAt: undefined });
    await context.resume();
    playbackStartedAtRef.current = performance.now() - elapsedSeconds * 1000;
    setPaused(false);
    setPlaying(true);
    setStatus("Playback resumed.");
  }

  async function toggleTargetPlayback(target: PlaybackTarget, start: () => Promise<void>): Promise<void> {
    if (playbackTargetMatches(playbackTarget, target)) {
      if (playing) return pausePlayback();
      if (paused) return resumePlayback();
    }
    return start();
  }

  function targetPlaybackState(target: PlaybackTarget): { isPlaying: boolean; isPaused: boolean } {
    const active = playbackTargetMatches(playbackTarget, target);
    return { isPlaying: active && playing, isPaused: active && paused };
  }

  async function togglePlayback(id: string): Promise<void> {
    return toggleTargetPlayback({ kind: "source", id }, () => playSource(id));
  }

  function setDecodedSource(id: string, name: string, decoded: AudioBuffer, sourceRef: { sourceUrl?: string; assetId?: string } = {}): void {
    const pcm = pcmFromAudioBuffer(decoded);
    const nextDuration = decoded.duration;
    stopPlayback();
    setSources((current) => current.map((item) =>
      item.id === id ? { id, name, duration: nextDuration, audio: pcm, ...sourceRef } : item
    ));
    if (readOnlySharedProject) return;
    // Claim initial setup synchronously so another load started from this render cannot reset edited layers.
    if (!initialArrangementCreatedRef.current) {
      initialArrangementCreatedRef.current = true;
      const initialLayer = createLayer(nextDuration, 0, [], id);
      const initialSequence = createSequencer(MAIN_SEQUENCE_ID, "Main sequence", initialLayer.id);
      setLayers([initialLayer]);
      setSequencers([initialSequence]);
      setActiveSequencerId(MAIN_SEQUENCE_ID);
      setSelectedCellIndex(0);
      setSelectedClipIds(new Set([sequenceClipKey(initialSequence.id, initialSequence.steps[0].id)]));
    } else {
      setLayers((current) => current.map((layer) => {
        if (layer.sourceId !== id && (layer.sourceId || sources[0]?.id !== id)) return layer;
        const end = Math.min(nextDuration, Math.max(0.1, layer.segment.end));
        return { ...layer, sourceId: id, segment: { start: Math.min(layer.segment.start, Math.max(0, end - 0.01)), end } };
      }));
    }
  }

  async function restoreCachedAudio(id: string, button: HTMLButtonElement): Promise<void> {
    if (restoringSourceIdsRef.current.has(id)) return;
    restoringSourceIdsRef.current.add(id);
    const token = Symbol(id);
    youtubeRequestsRef.current.get(id)?.abort();
    sourceLoadRequestRef.current.set(id, token);
    setStatus("Restoring cached audio…");
    try {
      const pendingStore = sourceStorePendingRef.current.get(id);
      if (pendingStore) await pendingStore;
      if (sourceLoadRequestRef.current.get(id) !== token) return;
      const file = await readStoredAudioFile(id);
      if (sourceLoadRequestRef.current.get(id) !== token) return;
      if (!file) {
        if (document.activeElement === button) {
          button.parentElement?.querySelector<HTMLButtonElement>(".source-picker-button")?.focus();
        }
        markCachedSource(id, false);
        setStatus("Cached audio is no longer available. Choose audio to replace it.");
        return;
      }
      const decoded = await ensureContext().decodeAudioData(await file.arrayBuffer());
      if (sourceLoadRequestRef.current.get(id) !== token) return;
      stopPlayback();
      setSources((current) => current.map((item) =>
        item.id === id ? { ...item, audio: pcmFromAudioBuffer(decoded), duration: decoded.duration } : item
      ));
      setStatus(`${file.name} restored · ${formatSeconds(decoded.duration)} · ${decoded.sampleRate.toLocaleString()} Hz`);
    } catch {
      if (sourceLoadRequestRef.current.get(id) === token) setStatus("Could not restore cached audio. Choose audio to replace it.");
    } finally {
      if (sourceLoadRequestRef.current.get(id) === token) sourceLoadRequestRef.current.delete(id);
      restoringSourceIdsRef.current.delete(id);
    }
  }

  async function importFile(file: File, id: string): Promise<void> {
    const token = Symbol(id);
    youtubeRequestsRef.current.get(id)?.abort();
    sourceLoadRequestRef.current.set(id, token);
    stopPlayback();
    try {
      const context = ensureContext();
      setStatus(`Loading ${file.name}…`);
      await loadPaulstretchModule();
      if (sourceLoadRequestRef.current.get(id) !== token) return;
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      if (sourceLoadRequestRef.current.get(id) !== token) return;
      const previousStore = sourceStorePendingRef.current.get(id);
      if (previousStore) await previousStore;
      if (sourceLoadRequestRef.current.get(id) !== token) return;
      const saving = storeAudioFile(id, file);
      sourceStorePendingRef.current.set(id, saving);
      const stored = await saving;
      if (sourceStorePendingRef.current.get(id) === saving) sourceStorePendingRef.current.delete(id);
      if (sourceLoadRequestRef.current.get(id) !== token) return;
      if (stored) markCachedSource(id, true);
      setDecodedSource(id, file.name, decoded);
      setStatus(`${file.name} ready · ${formatSeconds(decoded.duration)} · ${decoded.sampleRate.toLocaleString()} Hz${stored ? "" : " · not saved for next visit"}`);
    } catch (error) {
      if (sourceLoadRequestRef.current.get(id) === token) {
        setStatus(error instanceof Error ? error.message : "Could not load that file or the upstream WASM core.");
      }
    } finally {
      if (sourceLoadRequestRef.current.get(id) === token) sourceLoadRequestRef.current.delete(id);
    }
  }

  function chooseAudio(id: string, button: HTMLButtonElement): void {
    const panel = audioPopoverRef.current;
    const wasOpenOnPointerDown = audioPickerPointerOpenedRef.current;
    audioPickerPointerOpenedRef.current = false;
    if (!panel) return;
    if (wasOpenOnPointerDown || (panel.matches(":popover-open") && audioPickerButtonRef.current === button)) {
      if (panel.matches(":popover-open")) panel.hidePopover();
      return;
    }
    selectedSourceIdRef.current = id;
    audioPickerButtonRef.current = button;
    setAudioMenuSourceId(id);
    setYoutubeUrl("");
    setYoutubeError(null);
    const bounds = button.getBoundingClientRect();
    const scale = Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
    const width = Math.min(300, window.innerWidth - 16);
    panel.style.width = `${width / scale}px`;
    if (!panel.matches(":popover-open")) panel.showPopover();
    const height = panel.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8));
    const top = bounds.bottom + height + 8 <= window.innerHeight
      ? bounds.bottom + 4
      : Math.max(8, bounds.top - height - 4);
    panel.style.left = `${left / scale}px`;
    panel.style.top = `${top / scale}px`;
    panel.querySelector<HTMLButtonElement>(".source-local-button")?.focus();
  }

  function chooseLocalFile(): void {
    youtubeRequestsRef.current.get(selectedSourceIdRef.current)?.abort();
    sourceLoadRequestRef.current.delete(selectedSourceIdRef.current);
    setYoutubeLoadingId((current) => current === selectedSourceIdRef.current ? null : current);
    audioPopoverRef.current?.hidePopover();
    audioPickerButtonRef.current?.focus();
    if (fileInputRef.current) fileInputRef.current.value = "";
    fileInputRef.current?.click();
  }

  async function loadHostedAudio(id: string, name: string, assetId: string): Promise<void> {
    const projectId = (() => {
      try {
        const opened = JSON.parse(window.sessionStorage.getItem("souunnds.open-project") ?? "null") as { id?: unknown } | null;
        return typeof opened?.id === "string" ? opened.id : null;
      } catch {
        return null;
      }
    })();
    if (!projectId) return;
    const token = Symbol(id);
    sourceLoadRequestRef.current.set(id, token);
    const isCurrentProjectLoad = () => activeAudioProjectId() === projectId;
    setStatus(`Loading shared audio ${name}…`);
    try {
      const response = await fetch(`/api/projects/${projectId}/assets/${assetId}`, { cache: "no-store" });
      if (sourceLoadRequestRef.current.get(id) !== token || !isCurrentProjectLoad()) return;
      if (!response.ok) throw new Error("Shared audio is unavailable. Ask the project owner to check the file.");
      const { url } = await response.json() as { url: string };
      const audioResponse = await fetch(url);
      if (sourceLoadRequestRef.current.get(id) !== token || !isCurrentProjectLoad()) return;
      if (!audioResponse.ok) throw new Error("Could not download shared audio. Try reloading the project.");
      const decoded = await ensureContext().decodeAudioData(await audioResponse.arrayBuffer());
      if (sourceLoadRequestRef.current.get(id) !== token || !isCurrentProjectLoad()) return;
      setDecodedSource(id, name, decoded, { assetId });
      setStatus(`${name} restored from shared project · ${formatSeconds(decoded.duration)} · ${decoded.sampleRate.toLocaleString()} Hz`);
    } catch (error) {
      if (sourceLoadRequestRef.current.get(id) === token && isCurrentProjectLoad() && ownerProject?.id === projectId) {
        const cached = await readStoredAudioFile(id, projectId, false);
        if (cached && sourceLoadRequestRef.current.get(id) === token && isCurrentProjectLoad()) {
          try {
            const decoded = await ensureContext().decodeAudioData(await cached.arrayBuffer());
            if (sourceLoadRequestRef.current.get(id) === token && isCurrentProjectLoad()) {
              markCachedSource(id, true);
              setDecodedSource(id, name, decoded, { assetId });
              setStatus(`${name} restored from this browser's saved audio · ${formatSeconds(decoded.duration)} · ${decoded.sampleRate.toLocaleString()} Hz`);
              return;
            }
          } catch {
            // Report the hosted-load failure when the local copy is also unusable.
          }
        }
      }
      if (sourceLoadRequestRef.current.get(id) === token && isCurrentProjectLoad()) {
        setStatus(error instanceof Error ? error.message : "Could not restore shared audio.");
      }
    } finally {
      if (sourceLoadRequestRef.current.get(id) === token) sourceLoadRequestRef.current.delete(id);
    }
  }

  async function loadYoutubeAudio(id: string, url: string): Promise<void> {
    youtubeRequestsRef.current.get(id)?.abort();
    const controller = new AbortController();
    youtubeRequestsRef.current.set(id, controller);
    const token = Symbol(id);
    sourceLoadRequestRef.current.set(id, token);
    setYoutubeError(null);
    setYoutubeLoadingId(id);
    setStatus("Loading YouTube audio…");
    try {
      const response = await fetch("/api/youtube/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error : "Could not get audio from that video.";
        throw new Error(message);
      }
      const encodedTitle = response.headers.get("X-Source-Title");
      if (!encodedTitle) throw new Error("Could not read video title.");
      const title = decodeURIComponent(encodedTitle);
      const decoded = await ensureContext().decodeAudioData(await response.arrayBuffer());
      if (sourceLoadRequestRef.current.get(id) !== token || controller.signal.aborted) return;
      await loadPaulstretchModule();
      if (sourceLoadRequestRef.current.get(id) !== token || controller.signal.aborted) return;
      const previousStore = sourceStorePendingRef.current.get(id);
      if (previousStore) await previousStore;
      if (sourceLoadRequestRef.current.get(id) !== token || controller.signal.aborted) return;
      // Serialize deletion with any later local import so an old blob cannot reappear on reload.
      const deleting = (typeof indexedDB === "undefined"
        ? Promise.resolve()
        : deleteStoredAudioFile(id)).then(() => true, () => {
        throw new Error("Could not remove the previously saved audio. Check browser storage and try again.");
      });
      sourceStorePendingRef.current.set(id, deleting);
      try {
        await deleting;
      } finally {
        if (sourceStorePendingRef.current.get(id) === deleting) sourceStorePendingRef.current.delete(id);
      }
      markCachedSource(id, false);
      if (sourceLoadRequestRef.current.get(id) !== token || controller.signal.aborted) return;
      setDecodedSource(id, title, decoded, { sourceUrl: url.trim() });
      if (selectedSourceIdRef.current === id) {
        if (audioPopoverRef.current?.matches(":popover-open")) audioPopoverRef.current.hidePopover();
        setYoutubeUrl("");
      }
      setStatus(`YouTube audio ready · ${formatSeconds(decoded.duration)} · ${decoded.sampleRate.toLocaleString()} Hz · not saved for next visit`);
    } catch (error) {
      if (sourceLoadRequestRef.current.get(id) === token && !controller.signal.aborted) {
        const message = `${error instanceof Error ? error.message : "Could not load YouTube audio"} — try another video URL or a local file.`;
        setYoutubeError({ id, message });
        setStatus(message);
        if (selectedSourceIdRef.current === id && audioPopoverRef.current?.matches(":popover-open")) {
          audioPopoverRef.current.querySelector<HTMLInputElement>(".source-youtube-url")?.focus();
        }
      }
    } finally {
      if (sourceLoadRequestRef.current.get(id) === token) sourceLoadRequestRef.current.delete(id);
      if (youtubeRequestsRef.current.get(id) === controller) {
        youtubeRequestsRef.current.delete(id);
        setYoutubeLoadingId((current) => current === id ? [...youtubeRequestsRef.current.keys()].at(-1) ?? null : current);
      }
    }
  }

  function addSource(): void {
    setSources((current) => [...current, { id: crypto.randomUUID(), name: "", duration: 0, audio: null }]);
    setExpandedSections((current) => ({ ...current, sources: true }));
  }

  function removeSource(id: string): void {
    markCachedSource(id, false);
    sourceLoadRequestRef.current.delete(id);
    youtubeRequestsRef.current.get(id)?.abort();
    if (selectedSourceIdRef.current === id && audioPopoverRef.current?.matches(":popover-open")) audioPopoverRef.current.hidePopover();
    stopPlayback();
    const remaining = sources.filter((item) => item.id !== id);
    const next = remaining[0];
    setSources(remaining.length ? remaining : [{ id: crypto.randomUUID(), name: "", duration: 0, audio: null }]);
    setLayers((current) => current.map((layer) => (
      layer.sourceId === id || (!layer.sourceId && sources[0]?.id === id)
        ? { ...layer, sourceId: next?.id, segment: { start: 0, end: Math.max(0.1, Math.min(next?.duration ?? 4, 4)) } }
        : layer
    )));
    const pendingStore = sourceStorePendingRef.current.get(id);
    void (async () => {
      if (pendingStore) await pendingStore;
      await deleteStoredAudioFile(id);
    })().catch(() => setStatus("Could not remove the saved audio file."));
  }

  async function playSource(id: string): Promise<void> {
    const item = sources.find((candidate) => candidate.id === id);
    if (!item?.audio) return setStatus("Choose audio before playing this source.");
    playbackRequestRef.current += 1;
    clearProcessing();
    await playPcm(item.audio, item.name || "source", { kind: "source", id }, undefined, false, adsr, false, playbackRequestRef.current);
  }
  function arrangementForPlayback(): Arrangement {
    const repaired = layers.map((layer) => {
      const audio = sourceForLayer(layer);
      return audio ? repairGeneratedLayer(audio, layer) : layer;
    });
    if (repaired.every((layer, index) => layer === layers[index]) || readOnlySharedProject) return arrangement;
    setLayers(repaired);
    setStatus("Moved silent generated layers to audible source regions.");
    return { ...arrangement, layers: repaired };
  }

  function isCurrentPlaybackRequest(requestId: number): boolean {
    return playbackRequestRef.current === requestId;
  }

  function updateProcessingProgress(requestId: number, progress: number): void {
    if (isCurrentPlaybackRequest(requestId)) setProcessingProgress(progress);
  }

  function finishProcessing(requestId: number): void {
    if (isCurrentPlaybackRequest(requestId)) clearProcessing();
  }

  function reportPlaybackError(requestId: number, error: unknown, fallback: string): void {
    if (isCurrentPlaybackRequest(requestId)) setStatus(error instanceof Error ? error.message : fallback);
  }

  async function beginProcessing(message: string): Promise<number> {
    playbackRequestRef.current += 1;
    const requestId = playbackRequestRef.current;
    processingRequestRef.current = requestId;
    setProcessing(message);
    setProcessingProgress(0);
    setStatus(message);
    await nextPaint();
    return requestId;
  }

  async function previewLayer(layer: Layer): Promise<void> {
    if (!sourceForLayer(layer)) return setStatus("Choose audio for this layer before previewing.");
    const requestId = await beginProcessing(`Rendering ${layer.name} with upstream Paulstretch…`);
    if (!isCurrentPlaybackRequest(requestId)) return;
    try {
      const playbackArrangement = arrangementForPlayback();
      const playableLayer = playbackArrangement.layers.find((candidate) => candidate.id === layer.id) ?? layer;
      const stretched = await renderLayerCached(sourceForLayer(playableLayer)!, playableLayer.segment, playableLayer.params);
      const rendered = pitchShiftPcm(stretched, playableLayer.pitchSemitones ?? 0);
      if (!isCurrentPlaybackRequest(requestId)) return;
      updateProcessingProgress(requestId, 100);
      await playPcm(rendered, playableLayer.name, { kind: "layer", id: playableLayer.id }, undefined, false, adsr, false, requestId);
    } catch (error) {
      reportPlaybackError(requestId, error, "Layer preview failed.");
    } finally {
      finishProcessing(requestId);
    }
  }

  async function previewArrangement(): Promise<void> {
    if (!source) return setStatus("Import a file before playing layers.");
    const playableLayers = layers.filter((layer) => !layer.muted);
    if (!playableLayers.length) return setStatus(layers.length ? "Unmute at least one layer." : "Add at least one layer first.");
    const requestId = await beginProcessing("Rendering layers with upstream Paulstretch…");
    if (!isCurrentPlaybackRequest(requestId)) return;
    try {
      const playbackArrangement = { ...arrangementForPlayback(), layers: playableLayers };
      let completed = 0;
      const renderWithProgress = async (input: PcmAudio, segment: Layer["segment"], params: Layer["params"]): Promise<PcmAudio> => {
        const rendered = await renderLayerCached(input, segment, params);
        completed += 1;
        updateProcessingProgress(requestId, Math.round((completed / playableLayers.length) * 100));
        await nextPaint();
        return rendered;
      };
      const rendered = await renderArrangementAsync(source, playbackArrangement, renderWithProgress, sourceMap);
      if (!isCurrentPlaybackRequest(requestId)) return;
      await playPcm(rendered, `${playableLayers.length} layers`, { kind: "layers" }, undefined, false, adsr, false, requestId);
    } catch (error) {
      reportPlaybackError(requestId, error, "Layer playback failed.");
    } finally {
      finishProcessing(requestId);
    }
  }

  async function previewSequence(sequenceId = activeSequencer?.id): Promise<void> {
    const sequence = sequencers.find((candidate) => candidate.id === sequenceId);
    if (!source || !sequence?.steps.some((step) => !step.muted)) return setStatus("Unmute a sequence clip before playing.");
    const requestId = await beginProcessing("Rendering sequence with upstream Paulstretch…");
    if (!isCurrentPlaybackRequest(requestId)) return;
    try {
      const playbackArrangement = arrangementForPlayback();
      const requiredLayerCount = new Set(sequence.steps.map((step) => step.targetId)).size || 1;
      let completed = 0;
      const renderWithProgress = async (input: PcmAudio, segment: Layer["segment"], params: Layer["params"]): Promise<PcmAudio> => {
        const rendered = await renderLayerCached(input, segment, params);
        completed += 1;
        updateProcessingProgress(requestId, Math.min(95, Math.round((completed / requiredLayerCount) * 95)));
        await nextPaint();
        return rendered;
      };
      const rendered = await renderSequencerAsync(source, playbackArrangement, sequence.id, renderWithProgress, adsr, undefined, sourceMap);
      if (!isCurrentPlaybackRequest(requestId)) return;
      updateProcessingProgress(requestId, 100);
      await playPcm(rendered, sequence.name, { kind: "sequence", id: sequence.id }, [{ sequenceId: sequence.id, durationSeconds: sequence.durationSeconds, loop: true }], false, null, true, requestId);
    } catch (error) {
      reportPlaybackError(requestId, error, "Sequence playback failed.");
    } finally {
      finishProcessing(requestId);
    }
  }

  async function previewSequenceClip(sequenceId: string, clipId: string): Promise<void> {
    const sequence = sequencers.find((candidate) => candidate.id === sequenceId);
    const stepIndex = sequence?.steps.findIndex((candidate) => candidate.id === clipId) ?? -1;
    const step = sequence?.steps[stepIndex];
    if (!source || !sequence || !step) return setStatus("Add a sequence clip first.");
    const requestId = await beginProcessing(`Rendering ${sequence.name} clip ${stepIndex + 1} with upstream Paulstretch…`);
    if (!isCurrentPlaybackRequest(requestId)) return;
    try {
      const playbackArrangement = arrangementForPlayback();
      const previewSequence: Sequencer = {
        ...sequence,
        id: `${sequence.id}-clip-preview`,
        durationSeconds: step.durationSeconds,
        steps: [{ ...step, startSeconds: 0 }],
      };
      const arrangementWithPreview = {
        ...playbackArrangement,
        sequencers: [...playbackArrangement.sequencers, previewSequence],
      };
      const rendered = await renderSequencerAsync(
        source,
        arrangementWithPreview,
        previewSequence.id,
        async (input, segment, params) => {
          const renderedLayer = await renderLayerCached(input, segment, params);
          updateProcessingProgress(requestId, 95);
          await nextPaint();
          return renderedLayer;
        },
        adsr,
        undefined,
        sourceMap,
      );
      if (!isCurrentPlaybackRequest(requestId)) return;
      updateProcessingProgress(requestId, 100);
      await playPcm(
        rendered,
        `${sequence.name} clip ${stepIndex + 1}`,
        { kind: "sequence-clip", sequenceId, clipId },
        undefined,
        false,
        null,
        false,
        requestId,
      );
    } catch (error) {
      reportPlaybackError(requestId, error, "Sequence clip playback failed.");
    } finally {
      finishProcessing(requestId);
    }
  }

  async function previewAllSequences(): Promise<void> {
    if (!source) return setStatus("Import a file before playing sequences.");
    const playableSequences = sequencers.filter((sequence) => !sequence.muted && sequence.steps.some((step) => !step.muted));
    if (!playableSequences.length) return setStatus(sequencers.length ? "Unmute at least one sequence clip." : "Add a sequence clip first.");
    const requestId = await beginProcessing(`Rendering ${playableSequences.length} sequences with upstream Paulstretch…`);
    if (!isCurrentPlaybackRequest(requestId)) return;
    try {
      const playbackArrangement = arrangementForPlayback();
      const rendered: PcmAudio[] = [];
      const tracks: SequenceTrack[] = playableSequences.map((sequence) => ({
        sequenceId: sequence.id,
        durationSeconds: sequence.durationSeconds,
        loop: true,
      }));
      const renderedLayers = new Map<string, PcmAudio>();
      for (const [index, sequence] of playableSequences.entries()) {
        rendered.push(await renderSequencerAsync(source, playbackArrangement, sequence.id, renderLayerCached, adsr, renderedLayers, sourceMap));
        updateProcessingProgress(requestId, Math.round(((index + 1) / playableSequences.length) * 100));
        if (!isCurrentPlaybackRequest(requestId)) return;
        await nextPaint();
      }
      const targetDuration = Math.max(0, ...tracks.map((track) => track.durationSeconds));
      await playPcm(
        mixPcm(rendered.map((audio) => fitPcmDuration(audio, targetDuration, true))),
        `${playableSequences.length} sequences`,
        { kind: "sequences" },
        tracks,
        true,
        null,
        true,
        requestId,
      );
    } catch (error) {
      reportPlaybackError(requestId, error, "Sequence playback failed.");
    } finally {
      finishProcessing(requestId);
    }
  }

  function updateLayer(id: string, patch: Partial<Layer>): void {
    const affectsPlayback = patch.segment !== undefined
      || patch.offsetSeconds !== undefined
      || patch.gain !== undefined
      || patch.sourceId !== undefined
      || patch.muted !== undefined;
    if (affectsPlayback) cancelArrangementPlayback();
    if (patch.muted !== undefined || patch.sourceId !== undefined) {
      pendingKeyboardTriggersRef.current.delete(id);
      if (keyboardVoicesRef.current.has(id)) stopKeyboardLayerVoice(id);
    }
    setLayers((current) => current.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)));
  }

  function updateLayerParams(id: string, patch: Partial<Layer["params"]>): void {
    cancelArrangementPlayback();
    setLayers((current) => current.map((layer) => (
      layer.id === id ? { ...layer, params: { ...layer.params, ...patch } } : layer
    )));
  }

  function addLayer(): void {
    const first = sources.find((item) => item.audio);
    if (!first) return setStatus("Import a file before adding layers.");
    cancelArrangementPlayback();
    initialArrangementCreatedRef.current = true;
    setLayers((current) => [...current, createLayer(first.duration, current.length, current.map((layer) => layer.color), first.id)]);
  }

  function addSequence(): void {
    if (!source || !layers.length) return setStatus("Add a layer before adding a sequence.");
    const nextSequenceNumber = sequencers.reduce((highest, item) => {
      const match = /^Sequence (\d+)$/.exec(item.name);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    const sequence = createSequencer(`sequence-${Date.now()}`, `Sequence ${nextSequenceNumber}`, layers[0].id);
    cancelSequencePlayback();
    setSequencers((current) => [...current, sequence]);
    setActiveSequencerId(sequence.id);
    setSelectedCellIndex(0);
    setSelectedClipIds(new Set([sequenceClipKey(sequence.id, sequence.steps[0].id)]));
    setSelectedCellOpen(false);
    setStatus(`Added ${sequence.name}.`);
  }

  function removeLayer(id: string): void {
    const remainingLayers = layers.filter((layer) => layer.id !== id);
    const remainingSequences = sequencers
      .map((sequence) => ({
        ...sequence,
        steps: sequence.steps.filter((step) => step.targetType !== "layer" || step.targetId !== id),
      }))
      .filter((sequence) => sequence.steps.length > 0);
    cancelArrangementPlayback();
    setLayers(remainingLayers);
    setSequencers(remainingSequences);
    if (!remainingSequences.some((sequence) => sequence.id === activeSequencerId)) {
      setActiveSequencerId(remainingSequences[0]?.id ?? MAIN_SEQUENCE_ID);
    }
    setSelectedCellIndex(0);
    setSelectedCellOpen(false);
  }

  function generateLayers(): void {
    const first = sources.find((item) => item.audio);
    if (!first?.audio) return setStatus("Import a file before generating layers.");
    cancelArrangementPlayback();
    const generated = generateArrangement(first.duration, {
      count: generatedCount,
      seed: generatedSeed,
      linked: generatedLinked,
    }, first.audio);
    initialArrangementCreatedRef.current = true;
    generated.layers.forEach((layer) => { layer.sourceId = first.id; });
    setLayers(generated.layers);
    const generatedSequences = generated.layers.map((layer, index) => ({
      ...createSequencer(`sequence-${Date.now()}-${index + 1}`, `Generated layer ${index + 1}`, layer.id),
      durationSeconds: 16,
      steps: Array.from({ length: 8 }, (_, clipIndex) => createSequenceStep(layer.id, clipIndex * 2)),
    }));
    setSequencers(generatedSequences);
    setActiveSequencerId(generatedSequences[0]?.id ?? MAIN_SEQUENCE_ID);
    setSelectedCellIndex(0);
    const firstGeneratedStep = generatedSequences[0]?.steps[0];
    setSelectedClipIds(firstGeneratedStep
      ? new Set([sequenceClipKey(generatedSequences[0].id, firstGeneratedStep.id)])
      : new Set());
    setSelectedCellOpen(false);
    setGeneratorOpen(false);
    setStatus(`Generated ${generated.layers.length} ${generatedLinked ? "linked" : "independent"} layers.`);
  }

  function updateSequence(patch: Partial<Sequencer>, sequenceId = activeSequencer?.id): void {
    const affectsPlayback = patch.steps !== undefined
      || patch.durationSeconds !== undefined
      || patch.muted !== undefined;
    if (affectsPlayback) cancelSequencePlayback();
    setSequencers((current) => current.map((sequence) => (
      sequence.id === sequenceId ? { ...sequence, ...patch } : sequence
    )));
  }

  function randomizeLayer(layerId: string): void {
    const layer = layers.find((candidate) => candidate.id === layerId);
    cancelArrangementPlayback();
    if (!layer) return;
    const sourceDuration = Math.max(0.15, durationForLayer(layer));
    const length = Math.min(sourceDuration, Math.max(0.15, sourceDuration * (0.08 + Math.random() * 0.24)));
    const start = sourceDuration > length ? Math.random() * (sourceDuration - length) : 0;
    setLayers((current) => current.map((candidate) => (
      candidate.id === layerId
        ? {
            ...candidate,
            segment: { start, end: start + length },
            params: {
              ...candidate.params,
              stretch: 2 + Math.random() * 18,
              windowSeconds: 0.12 + Math.random() * 0.5,
              onset: Math.random() * 0.5,
              seed: Math.floor(Math.random() * 100000),
            },
            offsetSeconds: Math.random() * 3,
            gain: 0.55 + Math.random() * 0.45,
          }
        : candidate
    )));
    setStatus(`Randomized ${layer.name}.`);
  }

  function randomizeSequence(sequenceId = activeSequencer?.id): void {
    const sequence = sequencers.find((candidate) => candidate.id === sequenceId);
    if (!sequence?.steps.length || !layers.length) return;
    updateSequence({
      steps: sequence.steps.map((step) => ({
        ...step,
        targetId: layers[Math.floor(Math.random() * layers.length)]?.id ?? step.targetId,
        targetType: "layer",
        repeatFill: Math.random() >= 0.35,
      })),
    }, sequence.id);
    setStatus(`Randomized ${sequence.name}.`);
  }

  function randomSequenceStep(slotStartSeconds: number, durationLevel: number, slotDuration = 2): SequenceStep {
    const targetId = layers[Math.floor(Math.random() * layers.length)]?.id ?? "";
    const durationSeconds = roundTimelineSeconds(Math.min(
      slotDuration - MIN_CLIP_DURATION_SECONDS,
      MIN_CLIP_DURATION_SECONDS + (durationLevel - 1) * 0.5 + Math.random() * 0.5,
    ));
    const availableStartRange = Math.max(0, slotDuration - durationSeconds);
    const startSeconds = roundTimelineSeconds(slotStartSeconds + Math.random() * availableStartRange);
    return createSequenceStep(targetId, startSeconds, durationSeconds, Math.random() >= 0.35);
  }

  function randomSequenceSteps(columnCount: number, clipCount: number, durationLevel: number): SequenceStep[] {
    const steps: SequenceStep[] = [];
    let remaining = clipCount;
    for (let column = 0; column < columnCount; column += 1) {
      if (Math.random() * (columnCount - column) >= remaining) continue;
      steps.push(randomSequenceStep(column * 2, durationLevel));
      remaining -= 1;
    }
    return steps;
  }

  function generateSequences(): void {
    if (!source || !layers.length) return setStatus("Add a layer before generating sequences.");
    const rowCount = isFiniteNumber(generatedSequenceRows) ? Math.round(clampNumber(generatedSequenceRows, 1, 12)) : 1;
    const columnCount = isFiniteNumber(generatedSequenceColumns) ? Math.round(clampNumber(generatedSequenceColumns, 1, 32)) : 1;
    const clipsPerSequence = Math.max(1, Math.round(columnCount * (0.25 + (generatedSequenceDensity - 1) * 0.375)));
    const generatedAt = Date.now();
    const durationSeconds = Math.max(DEFAULT_SEQUENCE_DURATION_SECONDS, columnCount * 2);
    const generatedSequences = Array.from({ length: rowCount }, (_, index) => ({
      ...createSequencer(`sequence-${generatedAt}-${index + 1}`, `Sequence ${index + 1}`, layers[0].id),
      durationSeconds,
      steps: randomSequenceSteps(columnCount, clipsPerSequence, generatedClipDuration),
    }));
    setGeneratedSequenceRows(rowCount);
    setGeneratedSequenceColumns(columnCount);
    cancelSequencePlayback();
    setSequencers(generatedSequences);
    setActiveSequencerId(generatedSequences[0].id);
    setSelectedCellIndex(0);
    const firstGeneratedStep = generatedSequences[0].steps[0];
    setSelectedClipIds(new Set([sequenceClipKey(generatedSequences[0].id, firstGeneratedStep.id)]));
    setSelectedCellOpen(false);
    setSequenceGeneratorOpen(false);
    setStatus(`Generated ${rowCount} sequences with ${clipsPerSequence} ${clipsPerSequence === 1 ? "clip" : "clips"} each.`);
  }

  function removeSequence(sequenceId = activeSequencer?.id): void {
    const sequence = sequencers.find((candidate) => candidate.id === sequenceId);
    if (!sequence) return;
    const remaining = sequencers.filter((candidate) => candidate.id !== sequence.id);
    cancelSequencePlayback();
    setSequencers(remaining);
    if (activeSequencerId === sequence.id) setActiveSequencerId(remaining[0]?.id ?? MAIN_SEQUENCE_ID);
    setSelectedCellIndex(0);
    setSelectedCellOpen(false);
    setStatus(`Removed ${sequence.name}.`);
  }

  function updateStep(index: number, patch: Partial<SequenceStep>, sequenceId = activeSequencer?.id): void {
    if (!sequenceId) return;
    cancelSequencePlayback();
    setSequencers((current) => current.map((sequence) => (
      sequence.id === sequenceId
        ? { ...sequence, steps: sequence.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)) }
        : sequence
    )));
  }

  function selectSequenceClip(
    event: ReactMouseEvent<HTMLButtonElement>,
    sequenceId: string,
    index: number,
    clipId: string,
  ): void {
    setActiveSequencerId(sequenceId);
    setSelectedCellIndex(index);
    const key = sequenceClipKey(sequenceId, clipId);
    if (event.shiftKey) {
      setSelectedClipIds((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setSelectedCellOpen(false);
    } else {
      setSelectedClipIds(new Set([key]));
      setSelectedCellOpen(true);
    }
    setSequenceDurationMenuId(null);
  }

  function removeCell(sequenceId: string, index: number): void {
    const sequence = sequencers.find((candidate) => candidate.id === sequenceId);
    if (!sequence) return;
    const removedStep = sequence.steps[index];
    if (
      removedStep
      && playbackTarget?.kind === "sequence-clip"
      && playbackTarget.sequenceId === sequenceId
      && playbackTarget.clipId === removedStep.id
    ) stopPlayback();
    if (sequence.steps.length === 1) {
      removeSequence(sequence.id);
      return;
    }
    updateSequence({ steps: sequence.steps.filter((_, stepIndex) => stepIndex !== index) }, sequence.id);
    setSelectedCellIndex((current) => Math.min(current, sequence.steps.length - 2));
    setSelectedCellOpen(false);
  }
  function muteSelectedClips(): void {
    if (selectedClips.length < 2) return;
    cancelSequencePlayback();
    const muted = !allSelectedClipsMuted;
    setSequencers((current) => current.map((sequence) => ({
      ...sequence,
      steps: sequence.steps.map((step) => (
        selectedClipIds.has(sequenceClipKey(sequence.id, step.id)) ? { ...step, muted } : step
      )),
    })));
    setStatus(`${muted ? "Muted" : "Unmuted"} ${selectedClips.length} selected clips.`);
  }

  function removeSelectedClips(): void {
    if (selectedClips.length < 2) return;
    cancelSequencePlayback();
    const remainingSequences = sequencers.flatMap((sequence) => {
      const steps = sequence.steps.filter((step) => !selectedClipIds.has(sequenceClipKey(sequence.id, step.id)));
      return steps.length ? [{ ...sequence, steps }] : [];
    });
    setSequencers(remainingSequences);
    if (!remainingSequences.some((sequence) => sequence.id === activeSequencerId)) {
      setActiveSequencerId(remainingSequences[0]?.id ?? MAIN_SEQUENCE_ID);
    }
    setSelectedClipIds(new Set());
    setSelectedCellIndex(0);
    setSelectedCellOpen(false);
    setSequenceDurationMenuId(null);
    setStatus(`Deleted ${selectedClips.length} selected clips.`);
  }


  function resizeClipFromSnapshot(
    sequenceId: string,
    index: number,
    edge: "left" | "right",
    boundarySeconds: number,
    initialSteps: SequenceStep[],
  ): void {
    setSequencers((current) => current.map((sequence) => {
      if (sequence.id !== sequenceId) return sequence;
      const steps = initialSteps.map((step) => ({ ...step }));
      const step = steps[index];
      if (!step) return sequence;
      if (edge === "left") {
        const fixedEnd = step.startSeconds + step.durationSeconds;
        let startSeconds = roundTimelineSeconds(clampNumber(
          boundarySeconds,
          0,
          fixedEnd - MIN_CLIP_DURATION_SECONDS,
        ));
        const previous = steps[index - 1];
        if (previous && startSeconds < previous.startSeconds + previous.durationSeconds) {
          startSeconds = Math.max(startSeconds, previous.startSeconds + MIN_CLIP_DURATION_SECONDS);
          previous.durationSeconds = roundTimelineSeconds(startSeconds - previous.startSeconds);
        }
        step.startSeconds = startSeconds;
        step.durationSeconds = roundTimelineSeconds(fixedEnd - startSeconds);
      } else {
        const fixedStart = step.startSeconds;
        let endSeconds = roundTimelineSeconds(clampNumber(
          boundarySeconds,
          fixedStart + MIN_CLIP_DURATION_SECONDS,
          sequence.durationSeconds,
        ));
        const next = steps[index + 1];
        if (next && endSeconds > next.startSeconds) {
          const nextEnd = next.startSeconds + next.durationSeconds;
          endSeconds = Math.min(endSeconds, nextEnd - MIN_CLIP_DURATION_SECONDS);
          next.startSeconds = endSeconds;
          next.durationSeconds = roundTimelineSeconds(nextEnd - endSeconds);
        }
        step.durationSeconds = roundTimelineSeconds(endSeconds - fixedStart);
      }
      return { ...sequence, steps };
    }));
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>, sequenceId: string, index: number, edge: "left" | "right"): void {
    if (event.button !== 0) return;
    const sequence = sequencers.find((item) => item.id === sequenceId);
    const step = sequence?.steps[index];
    const timeline = event.currentTarget.closest(".sequence-grid");
    if (!sequence || !step || !(timeline instanceof HTMLElement)) return;
    cancelSequencePlayback();
    const width = timeline.getBoundingClientRect().width;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      sequenceId,
      index,
      edge,
      startX: event.clientX,
      initialStartSeconds: step.startSeconds,
      initialDurationSeconds: step.durationSeconds,
      pixelsPerSecond: width / sequence.durationSeconds,
      initialSteps: sequence.steps.map((candidate) => ({ ...candidate })),
    };
    setActiveSequencerId(sequenceId);
    setSelectedCellIndex(index);
    setSelectedCellOpen(false);
    setSelectedClipIds(new Set([sequenceClipKey(sequenceId, step.id)]));
    setSequenceDurationMenuId(null);
  }

  function moveResize(event: ReactPointerEvent<HTMLButtonElement>, index: number, edge: "left" | "right"): void {
    const resize = resizeRef.current;
    if (!resize || resize.index !== index || resize.edge !== edge) return;
    const deltaSeconds = (event.clientX - resize.startX) / Math.max(1, resize.pixelsPerSecond);
    const boundarySeconds = edge === "left"
      ? resize.initialStartSeconds + deltaSeconds
      : resize.initialStartSeconds + resize.initialDurationSeconds + deltaSeconds;
    resizeClipFromSnapshot(resize.sequenceId, index, edge, boundarySeconds, resize.initialSteps);
  }

  function endResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (resizeRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeRef.current = null;
  }

  function updateSequenceDuration(sequenceId: string, requestedDuration: number, sourceSteps?: SequenceStep[]): void {
    if (!Number.isFinite(requestedDuration)) return;
    if (sourceSteps === undefined) cancelSequencePlayback();
    const currentSequence = sequencers.find((sequence) => sequence.id === sequenceId);
    if (currentSequence && sequenceId === activeSequencerId) {
      const resized = resizeSequencerDuration(currentSequence, requestedDuration, sourceSteps);
      if (selectedCellIndex >= resized.steps.length) {
        setSelectedCellIndex(Math.max(0, resized.steps.length - 1));
        setSelectedCellOpen(false);
      }
    }
    setSequencers((current) => current.map((sequence) => (
      sequence.id === sequenceId
        ? resizeSequencerDuration(sequence, requestedDuration, sourceSteps)
        : sequence
    )));
  }

  function beginSequenceResize(event: ReactPointerEvent<HTMLButtonElement>, sequence: Sequencer): void {
    const timeline = event.currentTarget.closest(".sequence-grid");
    if (event.button !== 0) return;
    if (!(timeline instanceof HTMLElement)) return;
    cancelSequencePlayback();
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    sequenceResizeRef.current = {
      sequenceId: sequence.id,
      startX: event.clientX,
      initialDurationSeconds: sequence.durationSeconds,
      pixelsPerSecond: timeline.getBoundingClientRect().width / sequence.durationSeconds,
      initialSteps: sequence.steps.map((step) => ({ ...step })),
    };
    setActiveSequencerId(sequence.id);
    setSelectedCellOpen(false);
    setSequenceDurationMenuId(null);
  }

  function moveSequenceResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    const resize = sequenceResizeRef.current;
    if (!resize) return;
    const deltaSeconds = (event.clientX - resize.startX) / Math.max(1, resize.pixelsPerSecond);
    updateSequenceDuration(resize.sequenceId, resize.initialDurationSeconds + deltaSeconds, resize.initialSteps);
  }

  function endSequenceResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (sequenceResizeRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    sequenceResizeRef.current = null;
  }

  function addClipInGap(
    event: ReactMouseEvent<HTMLButtonElement>,
    sequence: Sequencer,
    gap: { startSeconds: number; endSeconds: number },
  ): void {
    const gapDuration = gap.endSeconds - gap.startSeconds;
    if (gapDuration < MIN_CLIP_DURATION_SECONDS) return;
    const clipDuration = Math.min(DEFAULT_CLIP_DURATION_SECONDS, gapDuration);
    const clickedSeconds = event.detail === 0
      ? gap.startSeconds
      : gap.startSeconds + clampNumber(
        (event.clientX - event.currentTarget.getBoundingClientRect().left)
          / Math.max(1, event.currentTarget.getBoundingClientRect().width),
        0,
        1,
      ) * gapDuration;
    const startSeconds = roundTimelineSeconds(clampNumber(
      clickedSeconds,
      gap.startSeconds,
      gap.endSeconds - clipDuration,
    ));
    const step = createSequenceStep(layers[0]?.id ?? "", startSeconds, clipDuration);
    const steps = [...sequence.steps, step].sort((left, right) => left.startSeconds - right.startSeconds);
    updateSequence({ steps }, sequence.id);
    setActiveSequencerId(sequence.id);
    setSelectedCellIndex(steps.findIndex((candidate) => candidate.id === step.id));
    setSelectedClipIds(new Set([sequenceClipKey(sequence.id, step.id)]));
    setSelectedCellOpen(true);
    window.requestAnimationFrame(() => {
      const sourceSelect = document.querySelector<HTMLButtonElement>(".cell-inspector button[role='combobox']");
      sourceSelect?.focus();
    });
    setSequenceDurationMenuId(null);
    setStatus(`Added clip at ${formatSeconds(step.startSeconds)}.`);
  }

  async function shareOrFork(): Promise<void> {
    const createManifest = (projectSources: StoredSource[], state: PersistedStudioState) => ({
      version: 1,
      sources: projectSources.map((source) => source.sourceUrl
        ? { id: source.id, name: source.name, duration: source.duration, kind: "youtube" as const, url: source.sourceUrl }
        : source.assetId
          ? { id: source.id, name: source.name, duration: source.duration, kind: "asset" as const, assetId: source.assetId }
          : { id: source.id, name: source.name, duration: source.duration, kind: "missing" as const }),
      state,
    });
    if (ownerProject) {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      saveQueueRef.current = saveQueueRef.current
        .then(() => saveSnapshotRef.current())
        .catch(() => {
          saveErrorRef.current = true;
          setShareStatus("Could not save online. Your local copy is still saved.");
        });
      await saveQueueRef.current;
      if (saveErrorRef.current) return;
      const url = `${window.location.origin}/p/${ownerProject.id}`;
      try {
        await navigator.clipboard.writeText(url);
        setShareStatus("Share link copied.");
      } catch {
        setShareStatus(url);
      }
      return;
    }

    let created: { project: { id: string; revision: number }; capability: string } | undefined;
    setShareStatus(openedProjectId ? "Creating your editable fork…" : "Creating share link…");
    try {
      const initialSources: StoredSource[] = studioState.sources.map(({ assetId: _assetId, ...source }) => source);
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: createManifest(initialSources, { ...studioState, sources: initialSources }) }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not create the shared project.");
      }
      created = await response.json() as { project: { id: string; revision: number }; capability: string };

      let finalSources: StoredSource[] = initialSources;
      if (includeSourceAudio) {
        finalSources = [];
        for (const source of studioState.sources) {
          const loadedSource = sources.find((item) => item.id === source.id);
          if (source.sourceUrl) {
            finalSources.push(source);
            continue;
          }
          let file = await readStoredAudioFile(source.id);
          if (!file && source.assetId && openedProjectId) {
            const metadata = await fetch(`/api/projects/${openedProjectId}/assets/${source.assetId}`, { cache: "no-store" });
            if (metadata.ok) {
              const sharedAsset = await metadata.json() as { url: string; contentType: string; fileName: string };
              const audioResponse = await fetch(sharedAsset.url);
              if (audioResponse.ok) file = new File([await audioResponse.blob()], sharedAsset.fileName, { type: sharedAsset.contentType });
            }
          }
          if (!file) {
            if (loadedSource?.audio || source.assetId) throw new Error(`Could not retrieve audio for ${source.name || "a source"}.`);
            finalSources.push(source);
            continue;
          }
          const fileName = file.name || source.name || "audio";
          const reportedType = file.type.toLowerCase().split(";", 1)[0];
          const contentType = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave"].includes(reportedType)
            ? reportedType
            : /\.mp3$/i.test(fileName) ? "audio/mpeg" : /\.wav$/i.test(fileName) ? "audio/wav" : "";
          if (!contentType) throw new Error(`${fileName} is not a supported WAV or MP3 file.`);
          const uploadResponse = await fetch(`/api/projects/${created.project.id}/assets`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.capability}` },
            body: JSON.stringify({ fileName, contentType, size: file.size }),
          });
          if (!uploadResponse.ok) {
            const payload = await uploadResponse.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? `Could not prepare audio upload for ${fileName}.`);
          }
          const upload = await uploadResponse.json() as { assetId: string; uploadUrl: string };
          const uploaded = await fetch(upload.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": contentType, Authorization: `Bearer ${created.capability}` },
            body: file,
          });
          if (!uploaded.ok) throw new Error(`Could not upload ${fileName} (${uploaded.status}).`);
          const completeResponse = await fetch(`/api/projects/${created.project.id}/assets/${upload.assetId}/complete`, {
            method: "POST", headers: { Authorization: `Bearer ${created.capability}` },
          });
          if (!completeResponse.ok) {
            const payload = await completeResponse.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? `Could not verify uploaded audio ${fileName}.`);
          }
          finalSources.push({ ...source, assetId: upload.assetId });
        }
      }

      const finalState = { ...studioState, sources: finalSources };
      const saveResponse = await fetch(`/api/projects/${created.project.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${created.capability}`,
          "If-Match": `"${created.project.revision}"`,
        },
        body: JSON.stringify({ manifest: createManifest(finalSources, finalState) }),
      });
      if (!saveResponse.ok) {
        const payload = await saveResponse.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not save the shared project.");
      }
      const saved = await saveResponse.json() as { revision: number };
      for (const source of studioState.sources) {
        const localFile = await readStoredAudioFile(source.id, openedProjectId);
        if (localFile) await storeAudioFile(source.id, localFile, created.project.id);
      }
      window.localStorage.setItem(`souunnds.project-owner.${created.project.id}`, JSON.stringify({ capability: created.capability }));
      window.localStorage.setItem(`souunnds.project-state.${created.project.id}`, JSON.stringify(finalState));
      window.localStorage.setItem(`souunnds.project-revision.${created.project.id}`, String(saved.revision));
      window.localStorage.setItem(`souunnds.project-dirty.${created.project.id}`, "false");
      window.sessionStorage.setItem("souunnds.open-project", JSON.stringify({ id: created.project.id, revision: saved.revision }));
      setOpenedProjectId(created.project.id);
      projectRevisionRef.current = saved.revision;
      setSources((current) => current.map((source) => {
        const persisted = finalSources.find((candidate) => candidate.id === source.id);
        return { ...source, sourceUrl: persisted?.sourceUrl, assetId: persisted?.assetId };
      }));
      setOwnerProject({ id: created.project.id, capability: created.capability, revision: saved.revision });
      const url = `${window.location.origin}/p/${created.project.id}`;
      window.history.replaceState(null, "", `/p/${created.project.id}`);
      try {
        await navigator.clipboard.writeText(url);
        setShareStatus(includeSourceAudio ? "Share link copied. Included available local audio." : "Share link copied. Local audio was not included; recipients can relink it.");
      } catch {
        setShareStatus(`Share link: ${url}${includeSourceAudio ? "" : " · Local audio was not included."}`);
      }
    } catch (error) {
      if (created) {
        await fetch(`/api/projects/${created.project.id}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${created.capability}` },
        }).catch(() => undefined);
      }
      setShareStatus(error instanceof Error ? error.message : "Could not create the shared project.");
    }
  }

  async function replaceRemoteProjectWithDraft(): Promise<void> {
    if (!ownerProject) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    await saveQueueRef.current;
    try {
      const response = await fetch(`/api/projects/${ownerProject.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not read the latest online project.");
      const latest = await response.json() as { revision: number };
      if (!Number.isSafeInteger(latest.revision) || latest.revision < 1) throw new Error("The online project revision is invalid.");
      projectRevisionRef.current = latest.revision;
      window.sessionStorage.setItem("souunnds.open-project", JSON.stringify({ id: ownerProject.id, revision: latest.revision }));
      window.localStorage.setItem(`souunnds.project-revision.${ownerProject.id}`, String(latest.revision));
      window.localStorage.setItem(`souunnds.project-dirty.${ownerProject.id}`, "true");
      setRemoteConflictRevision(null);
      saveErrorRef.current = false;
      await saveSnapshotRef.current();
    } catch (error) {
      setShareStatus(error instanceof Error ? error.message : "Could not save the local draft.");
    }
  }

  async function discardLocalDraftForLatest(): Promise<void> {
    if (!ownerProject) return;
    try {
      const response = await fetch(`/api/projects/${ownerProject.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not read the latest online project.");
      const latest = await response.json() as { revision: number; manifest: { state: unknown } };
      if (!Number.isSafeInteger(latest.revision) || latest.revision < 1
        || !latest.manifest?.state || typeof latest.manifest.state !== "object") {
        throw new Error("The online project is invalid.");
      }
      window.localStorage.setItem(`souunnds.project-state.${ownerProject.id}`, JSON.stringify(latest.manifest.state));
      window.localStorage.setItem(`souunnds.project-revision.${ownerProject.id}`, String(latest.revision));
      window.localStorage.setItem(`souunnds.project-dirty.${ownerProject.id}`, "false");
      window.sessionStorage.setItem("souunnds.open-project", JSON.stringify({ id: ownerProject.id, revision: latest.revision }));
      window.location.reload();
    } catch (error) {
      setShareStatus(error instanceof Error ? error.message : "Could not load the latest online project.");
    }
  }


  function blockReadOnlyMutation(event: ReactSyntheticEvent): void {
    if (!readOnlySharedProject) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("[data-readonly-action]")) return;
    const control = target.closest("button,input,select,textarea,[role='button'],[role='combobox'],[role='option'],[role='slider'],[contenteditable='true']");
    if (!control) return;
    if (event.type === "focus") {
      (control as HTMLElement).blur?.();
    } else {
      event.preventDefault();
    }
    event.stopPropagation();
  }
  return (
    <main className="app-shell">
      <header className="project-toolbar">
        <strong>{readOnlySharedProject ? "Read-only shared project" : ownerProject ? "Your shared project" : "Local project"}</strong>
        {!ownerProject && (
          <label className="share-audio-option">
            <input type="checkbox" checked={includeSourceAudio} onChange={(event) => setIncludeSourceAudio(event.target.checked)} />
            <span>Include local audio</span>
          </label>
        )}
        <button className="make-button label-caps" type="button" onClick={() => void shareOrFork()}>
          {readOnlySharedProject ? "Fork to edit" : ownerProject ? "Copy share link" : "Share"}
        </button>
        <span className="project-share-status" role="status" aria-live="polite">{shareStatus}</span>
      </header>
      {ownerProject && remoteConflictRevision !== null && (
        <div className="project-conflict" role="alert">
          <span>Your local draft is preserved, but the online project has newer changes. Choose which version to keep.</span>
          <button className="make-button label-caps" type="button" onClick={() => void replaceRemoteProjectWithDraft()}>Replace online with my draft</button>
          <button className="make-button label-caps" type="button" onClick={() => void discardLocalDraftForLatest()}>Discard draft and load online</button>
        </div>
      )}
      <div
        className="project-editor-content"
        inert={remoteConflictRevision !== null || undefined}
        data-read-only={readOnlySharedProject || undefined}
        onClickCapture={blockReadOnlyMutation}
        onPointerDownCapture={blockReadOnlyMutation}
        onChangeCapture={blockReadOnlyMutation}
        onKeyDownCapture={blockReadOnlyMutation}
        onFocusCapture={blockReadOnlyMutation}
      >
      <section className="workspace-section sources-section">
        <SectionHeader
          controlsId="sources-content"
          expanded={expandedSections.sources}
          label="SOURCES"
          onToggle={() => setExpandedSections((current) => ({ ...current, sources: !current.sources }))}
          actions={(
            <div className="section-action-group">
              <button className="make-button label-caps section-action-control" type="button" onClick={addSource} aria-label="Add source" title="Add source">
                <span className="wide-control-label">+ Source</span>
                <span className="compact-control-label">+</span>
              </button>
            </div>
          )}
        />
        {expandedSections.sources && (
          <div id="sources-content" className="section-content source-list">
            {sources.map((item, index) => (
              <div className={`source-row${index === sources.length - 1 ? " source-row-last" : ""}`} key={item.id}>
                <span className="source-number mono">{`source ${index + 1}`}</span>
                {item.name || item.audio ? (
                  <input
                    className="source-filename"
                    aria-label={`Source ${index + 1} name`}
                    value={item.name}
                    size={Math.max(1, item.name.length)}
                    title={item.name}
                    onChange={(event) => setSources((current) => current.map((candidate) =>
                      candidate.id === item.id ? { ...candidate, name: event.target.value } : candidate
                    ))}
                  />
                ) : <span className="source-empty-name" aria-hidden="true" />}
                {!item.audio && <span className="source-relink-status">Audio unavailable · choose audio to relink</span>}
                <div className="source-row-actions">
                  <button className="source-picker-button label-caps" type="button" onPointerDownCapture={(event) => {
                    audioPickerPointerOpenedRef.current = audioPopoverRef.current?.matches(":popover-open") === true && audioPickerButtonRef.current === event.currentTarget;
                  }} onClick={(event) => chooseAudio(item.id, event.currentTarget)} aria-expanded={audioMenuSourceId === item.id} aria-controls="source-audio-popover" aria-label={`Choose audio for source ${index + 1}`} title="Choose audio">
                    <span className="wide-control-label">Choose audio</span>
                    <span className="compact-control-label">Audio</span>
                  </button>
                  {cachedSourceIds.has(item.id) && <IconButton onClick={(event) => void restoreCachedAudio(item.id, event.currentTarget)} ariaLabel={`Restore cached audio for source ${index + 1}`}><RestoreIcon /></IconButton>}
                  <span className="source-duration mono" aria-label={`Source ${index + 1} length ${formatSeconds(item.duration)}`}>{formatSeconds(item.duration)}</span>
                  <PlayButton onClick={() => void togglePlayback(item.id)} disabled={!item.audio} ariaLabel={`Play source ${index + 1}`} {...targetPlaybackState({ kind: "source", id: item.id })} />
                  <IconButton allowReadOnly className="transport-stop-button" onClick={stopPlayback} disabled={!playbackTargetMatches(playbackTarget, { kind: "source", id: item.id }) || (!playing && !paused && !tailPlaying)} ariaLabel={`Stop source ${index + 1}`}><StopIcon /></IconButton>
                  <IconButton className="destructive-button" onClick={() => removeSource(item.id)} ariaLabel={`Remove source ${index + 1}`}><CloseIcon /></IconButton>
                </div>
              </div>
            ))}
            <input ref={fileInputRef} className="source-picker-input" type="file" accept=".mp3,.wav,audio/mpeg,audio/wav,audio/*" aria-label="Audio file" onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0], selectedSourceIdRef.current)} />
            <div
              ref={audioPopoverRef}
              id="source-audio-popover"
              className="control-popover source-audio-popover"
              popover="auto"
              role="group"
              aria-label="Choose source audio"
              onToggle={(event) => {
                if (event.newState === "closed" && !event.currentTarget.matches(":popover-open")) setAudioMenuSourceId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  audioPopoverRef.current?.hidePopover();
                  audioPickerButtonRef.current?.focus();
                  event.stopPropagation();
                }
              }}
            >
              <button className="make-button source-local-button" type="button" onClick={chooseLocalFile}>Local file…</button>
              <form onSubmit={(event) => {
                event.preventDefault();
                if (!youtubeUrl.trim()) return;
                void loadYoutubeAudio(selectedSourceIdRef.current, youtubeUrl);
              }}>
                <label htmlFor="source-youtube-url" onPointerDown={(event) => { event.currentTarget.control?.setAttribute("data-pointer-focus", ""); }}>YouTube video URL</label>
                <input
                  id="source-youtube-url"
                  className="source-youtube-url"
                  name="youtube-url"
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=…"
                  autoComplete="url"
                  required
                  value={youtubeUrl}
                  aria-invalid={youtubeError?.id === selectedSourceIdRef.current}
                  aria-describedby={youtubeError?.id === selectedSourceIdRef.current ? "source-youtube-error" : undefined}
                  onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = ""; }}
                  onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
                  onChange={(event) => { setYoutubeUrl(event.target.value); setYoutubeError(null); }}
                />
                {youtubeError?.id === selectedSourceIdRef.current && <p id="source-youtube-error" className="source-youtube-error" role="alert">{youtubeError.message}</p>}
                {youtubeLoadingId === selectedSourceIdRef.current && <p className="source-youtube-status" role="status">Loading audio… Your current source is still available.</p>}
                <button className="make-button" type="submit">Load YouTube audio</button>
              </form>
            </div>
          </div>
        )}
      </section>

      <section className="workspace-section layers-section">
        <SectionHeader
          controlsId="layers-content"
          expanded={expandedSections.layers}
          label="LAYERS"
          onToggle={() => setExpandedSections((current) => ({ ...current, layers: !current.layers }))}
          actions={(
            <div className="layer-generation-actions section-action-group">
              <PlayButton className="section-action-control" onClick={() => void toggleTargetPlayback({ kind: "layers" }, previewArrangement)} disabled={!source || !layers.some((layer) => !layer.muted)} ariaLabel="Play all layers" {...targetPlaybackState({ kind: "layers" })} />
              <button className="make-button label-caps section-action-control" type="button" onClick={addLayer} disabled={!source} aria-label="Add layer" title="Add layer">
                <span className="wide-control-label">+ Layer</span>
                <span className="compact-control-label">+</span>
              </button>
              <button className="popover-trigger label-caps section-action-control" type="button" aria-expanded={generatorOpen} aria-label="Generate layers" title="Generate layers" disabled={!source} onClick={() => { setSelectedCellOpen(false); setSequenceGeneratorOpen(false); setGeneratorOpen((open) => !open); }}>
                <span className="wide-control-label">Generate layers</span>
                <span className="compact-control-label">Gen</span>
              </button>
            </div>
          )}
        />
        {expandedSections.layers && (
          <div id="layers-content" className="section-content layers-content">
            {generatorOpen && (
              <DropdownPanel className="generator-popover">
                <div className="generator-form-row">
                  <label>Count<input type="number" min="1" max="12" value={generatedCount} onChange={(event) => setGeneratedCount(Number(event.target.value))} /></label>
                  <label>Seed<input type="number" min="1" value={generatedSeed} onChange={(event) => setGeneratedSeed(Number(event.target.value))} /></label>
                  <IconButton className={`generator-link-button ${generatedLinked ? "is-linked" : ""}`} pressed={generatedLinked} ariaLabel={generatedLinked ? "Unlink generated layers" : "Link generated layers"} onClick={() => setGeneratedLinked((linked) => !linked)}><ChainLinkIcon /></IconButton>
                  <button className="make-button label-caps" type="button" onClick={generateLayers} disabled={!source}>Generate</button>
                </div>
              </DropdownPanel>
            )}
            <div className="layer-list">
              {!layers.length && <div className="empty-state">Import a file, then add a layer.</div>}
              {layers.map((layer, index) => (
                <article className="layer-row" key={layer.id} aria-label={layer.name}>
                  <span className="layer-color-marker" style={{ backgroundColor: layer.color }} aria-hidden="true" />
                  <div className="layer-row-main">
                    <div className="layer-inline-fields">
                      <RangeField label="Start" output={durationForLayer(layer) > 0 ? `${Math.round((layer.segment.start / durationForLayer(layer)) * 100)}%` : "0%"} ariaLabel={`${layer.name} start`} min={0} max={durationForLayer(layer)} step={0.01} value={layer.segment.start} onChange={(value) => updateLayer(layer.id, { segment: { ...layer.segment, start: value } })} />
                      <RangeField label="End" output={durationForLayer(layer) > 0 ? `${Math.round((layer.segment.end / durationForLayer(layer)) * 100)}%` : "0%"} ariaLabel={`${layer.name} end`} min={0.01} max={Math.max(0.01, durationForLayer(layer))} step={0.01} value={layer.segment.end} onChange={(value) => updateLayer(layer.id, { segment: { ...layer.segment, end: value } })} />
                      <RangeField label="Stretch" output={`${layer.params.stretch.toFixed(2)}×`} ariaLabel={`${layer.name} stretch`} min={1} max={40} step={0.5} value={layer.params.stretch} onChange={(value) => updateLayerParams(layer.id, { stretch: value })} />
                      <RangeField label="Offset" output={`${Math.round(layer.offsetSeconds * 1000)}ms`} ariaLabel={`${layer.name} offset`} min={0} max={16} step={0.001} value={layer.offsetSeconds} onChange={(value) => updateLayer(layer.id, { offsetSeconds: value })} />
                      <RangeField label="Gain" output={`${(20 * Math.log10(Math.max(0.0001, layer.gain))).toFixed(2)}dB`} ariaLabel={`${layer.name} gain`} min={0} max={2} step={0.05} value={layer.gain} onChange={(value) => updateLayer(layer.id, { gain: value })} />
                      <RangeField label="Pitch" output={`${(layer.pitchSemitones ?? 0) > 0 ? "+" : ""}${layer.pitchSemitones ?? 0} st`} ariaLabel={`${layer.name} pitch shift`} min={-MAX_PITCH_SEMITONES} max={MAX_PITCH_SEMITONES} step={1} value={layer.pitchSemitones ?? 0} onChange={(value) => updateLayer(layer.id, { pitchSemitones: value })} />
                    </div>
                    <div className="layer-row-actions">
                      <div className="layer-trigger-controls">
                        <kbd className="layer-trigger-key" title={`Keyboard trigger ${LAYER_TRIGGER_BINDINGS[index]?.label ?? "unassigned"}`}>{LAYER_TRIGGER_BINDINGS[index]?.label ?? "—"}</kbd>
                        <PlayButton onClick={() => void toggleTargetPlayback({ kind: "layer", id: layer.id }, () => previewLayer(layer))} disabled={!sourceForLayer(layer)} ariaLabel={`Play ${layer.name}`} {...targetPlaybackState({ kind: "layer", id: layer.id })} />
                        <ThemedSelect
                          variant="source"
                          ariaLabel={`${layer.name} src`}
                          value={layer.sourceId ?? sources.find((item) => item.audio)?.id ?? ""}
                          options={sourceSelectOptions}
                          placeholder="No audio"
                          onValueChange={(value) => {
                            const selected = sources.find((item) => item.id === value);
                            if (!selected) return;
                            updateLayer(layer.id, {
                              sourceId: selected.id,
                              segment: { start: 0, end: Math.max(0.1, Math.min(selected.duration, 4)) },
                            });
                          }}
                        />
                        <IconButton
                          className="layer-trigger-mode"
                          pressed={layer.triggerMode === "gate"}
                          ariaLabel={`${layer.name} trigger mode: ${layer.triggerMode === "gate" ? "Gate" : "One-shot"}. Switch to ${layer.triggerMode === "gate" ? "One-shot" : "Gate"}`}
                          onClick={() => updateLayer(layer.id, { triggerMode: layer.triggerMode === "gate" ? "one-shot" : "gate" })}
                        >
                          <TriggerModeIcon mode={layer.triggerMode === "gate" ? "gate" : "one-shot"} />
                        </IconButton>
                      </div>
                      <RowActionsMenu ariaLabel={`${layer.name} actions`}>
                        <div className="row-icon-actions">
                          <IconButton pressed={!layer.muted} ariaLabel={`${layer.muted ? "Unmute" : "Mute"} ${layer.name}`} onClick={() => updateLayer(layer.id, { muted: !layer.muted })}><HeadphonesIcon /></IconButton>
                          <IconButton onClick={() => randomizeLayer(layer.id)} ariaLabel={`Randomize ${layer.name}`}><ShuffleIcon /></IconButton>
                          <IconButton className="destructive-button" onClick={() => removeLayer(layer.id)} ariaLabel={`Remove ${layer.name}`}><CloseIcon /></IconButton>
                        </div>
                      </RowActionsMenu>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className={`workspace-section sequence-section${sequencers.length ? "" : " is-empty"}${expandedSections.sequence ? "" : " is-collapsed"}`}>
        <SectionHeader
          controlsId="sequence-content"
          expanded={expandedSections.sequence}
          label="SEQUENCE"
          onToggle={() => setExpandedSections((current) => ({ ...current, sequence: !current.sequence }))}
          actions={(
            <div className="sequence-section-actions section-action-group">
              <PlayButton className="section-action-control" onClick={() => void toggleTargetPlayback({ kind: "sequences" }, previewAllSequences)} disabled={!source || !sequencers.some((sequence) => !sequence.muted && sequence.steps.some((step) => !step.muted))} ariaLabel="Play all sequences" {...targetPlaybackState({ kind: "sequences" })} />
              <button className="make-button label-caps section-action-control" type="button" onClick={addSequence} disabled={!source || !layers.length} aria-label="Add sequence" title="Add sequence">
                <span className="wide-control-label">+ Sequence</span>
                <span className="compact-control-label">+</span>
              </button>
              <button className="popover-trigger label-caps section-action-control" type="button" aria-expanded={sequenceGeneratorOpen} onClick={() => { setSelectedCellOpen(false); setGeneratorOpen(false); setExpandedSections((current) => ({ ...current, sequence: true })); setSequenceGeneratorOpen((open) => !open); }} disabled={!source || !layers.length} aria-label="Generate sequences" title="Generate sequences">
                <span className="wide-control-label">Generate sequences</span>
                <span className="compact-control-label">Gen</span>
              </button>
            </div>
          )}
        />
        {expandedSections.sequence && (
          <div id="sequence-content" className="section-content sequence-content">
            {sequenceGeneratorOpen && (
              <DropdownPanel className="generator-popover sequence-generator-popover">
                <div className="generator-form-row">
                  <label>Rows<input aria-label="Sequence rows" type="number" min="1" max="12" value={generatedSequenceRows} onChange={(event) => setGeneratedSequenceRows(Number(event.target.value))} /></label>
                  <label>Columns<input aria-label="Sequence columns" type="number" min="1" max="32" value={generatedSequenceColumns} onChange={(event) => setGeneratedSequenceColumns(Number(event.target.value))} /></label>
                </div>
                <div className="sequence-generator-controls">
                  <RangeField label="Density" min={1} max={3} step={1} value={generatedSequenceDensity} onChange={setGeneratedSequenceDensity} output={sequenceDensityLabel} valueText={sequenceDensityLabel} />
                  <RangeField label="Clip duration" min={1} max={3} step={1} value={generatedClipDuration} onChange={setGeneratedClipDuration} output={clipDurationLabel} valueText={clipDurationLabel} />
                </div>
                <div className="generator-form-row sequence-generator-actions">
                  <button className="make-button label-caps" type="button" onClick={generateSequences} disabled={!source || !layers.length}>Generate</button>
                </div>
              </DropdownPanel>
            )}
            <div className="sequence-matrix" aria-label="All sequences">
              {sequencers.map((sequence) => {
                const isActive = sequence.id === activeSequencer?.id;
                const trackProgress = sequenceProgress.find((track) => track.sequenceId === sequence.id);
                const playheadPercent = trackProgress
                  ? clampNumber((trackProgress.elapsedSeconds / sequence.durationSeconds) * 100, 0, 100)
                  : 0;
                const firstClipStart = sequence.steps.reduce(
                  (earliest, step) => Math.min(earliest, step.startSeconds),
                  sequence.steps[0]?.startSeconds ?? 0,
                );
                const minimumSequenceDuration = roundTimelineSeconds(Math.max(
                  MIN_SEQUENCE_DURATION_SECONDS,
                  firstClipStart + MIN_CLIP_DURATION_SECONDS,
                ));
                return (
                  <div className={`sequence-row ${isActive ? "is-active" : ""}`} key={sequence.id}>
                    <div className="sequence-row-content">
                      <div className="sequence-grid" aria-label={`${sequence.name} timeline, ${sequence.durationSeconds.toFixed(2)} seconds`}>
                        {sequenceGaps(sequence).map((gap) => {
                          const left = (gap.startSeconds / sequence.durationSeconds) * 100;
                          const width = ((gap.endSeconds - gap.startSeconds) / sequence.durationSeconds) * 100;
                          return (
                            <button
                              className="sequence-gap-surface"
                              key={`${gap.startSeconds}-${gap.endSeconds}`}
                              type="button"
                              style={{ left: `${left}%`, width: `${width}%` }}
                              aria-label={`Add clip to empty space from ${gap.startSeconds.toFixed(2)} to ${gap.endSeconds.toFixed(2)} seconds in ${sequence.name}`}
                              title={`Add clip between ${gap.startSeconds.toFixed(2)} and ${gap.endSeconds.toFixed(2)} seconds`}
                              onClick={(event) => addClipInGap(event, sequence, gap)}
                            />
                          );
                        })}
                        {trackProgress && <span className="sequence-playhead" style={{ left: `${playheadPercent}%` }} />}
                        {sequence.steps.map((step, index) => {
                          const label = layerNames.get(step.targetId) ?? "Unassigned";
                          const left = (step.startSeconds / sequence.durationSeconds) * 100;
                          const width = (step.durationSeconds / sequence.durationSeconds) * 100;
                          const nextStep = sequence.steps[index + 1];
                          const joinsNext = nextStep
                            ? Math.abs(step.startSeconds + step.durationSeconds - nextStep.startSeconds) < 0.001
                            : false;
                          return (
                            <div
                              className={`sequence-cell ${step.repeatFill ? "is-repeat-fill" : ""} ${step.muted ? "is-muted" : ""} ${selectedClipIds.has(sequenceClipKey(sequence.id, step.id)) ? "is-selected" : ""}`}
                              key={step.id}
                              style={{
                                left: `${left}%`,
                                width: joinsNext ? `calc(${width}% + 1px)` : `${width}%`,
                                backgroundColor: layerColors.get(step.targetId),
                              }}
                            >
                              <button className="sequence-cell-edge" type="button" aria-label={`Resize ${sequence.name} clip ${index + 1} left edge`} title={`Resize ${sequence.name} clip ${index + 1} left edge`} onPointerDown={(event) => beginResize(event, sequence.id, index, "left")} onPointerMove={(event) => moveResize(event, index, "left")} onPointerUp={endResize} onPointerCancel={endResize} />
                              <button
                                className="sequence-cell-main"
                                type="button"
                                onClick={(event) => selectSequenceClip(event, sequence.id, index, step.id)}
                                aria-label={`${sequence.name} clip ${index + 1}, ${label}, ${step.startSeconds.toFixed(2)} to ${(step.startSeconds + step.durationSeconds).toFixed(2)} seconds${step.repeatFill ? ", repeat fill" : ""}${step.muted ? ", muted" : ""}`}
                                title={`Edit ${sequence.name} clip ${index + 1} (${label}). Shift-click to toggle selection.`}
                                data-readonly-action="true"
                              >
                                <span className="sequence-cell-content" aria-hidden="true" />
                              </button>
                              <button className="sequence-cell-edge" type="button" aria-label={`Resize ${sequence.name} clip ${index + 1} right edge`} title={`Resize ${sequence.name} clip ${index + 1} right edge`} onPointerDown={(event) => beginResize(event, sequence.id, index, "right")} onPointerMove={(event) => moveResize(event, index, "right")} onPointerUp={endResize} onPointerCancel={endResize} />
                              {isActive && index === selectedCellIndex && selectedCellOpen && (
                                <DropdownPanel className={`cell-inspector ${left > 60 ? "align-right" : ""}`.trim()}>
                                  <div className="cell-inspector-header">
                                    <div className="cell-settings-subtitle">{step.startSeconds.toFixed(2)}–{(step.startSeconds + step.durationSeconds).toFixed(2)}s</div>
                                    <div className="cell-inspector-actions">
                                      <PlayButton
                                        className="cell-inspector-action"
                                        onClick={() => void toggleTargetPlayback(
                                          { kind: "sequence-clip", sequenceId: sequence.id, clipId: step.id },
                                          () => previewSequenceClip(sequence.id, step.id),
                                        )}
                                        disabled={!source || step.muted}
                                        ariaLabel={`Play ${sequence.name} clip ${index + 1}`}
                                        {...targetPlaybackState({ kind: "sequence-clip", sequenceId: sequence.id, clipId: step.id })}
                                      />
                                      <IconButton
                                        className="cell-inspector-action"
                                        pressed={!step.muted}
                                        ariaLabel={`${step.muted ? "Unmute" : "Mute"} ${sequence.name} clip ${index + 1}`}
                                        onClick={() => updateStep(index, { muted: !step.muted }, sequence.id)}
                                      >
                                        <HeadphonesIcon />
                                      </IconButton>
                                      <IconButton
                                        className="cell-inspector-action destructive-button"
                                        ariaLabel={`Remove ${sequence.name} clip ${index + 1}`}
                                        onClick={() => removeCell(sequence.id, index)}
                                      >
                                        <CloseIcon />
                                      </IconButton>
                                    </div>
                                  </div>
                                  <div className="cell-fields">
                                    <label>
                                      Layer source
                                      <ThemedSelect
                                        variant="clip"
                                        ariaLabel="Clip layer source"
                                        value={step.targetId}
                                        options={layerSelectOptions}
                                        onValueChange={(value) => updateStep(index, { targetId: value, targetType: "layer" }, sequence.id)}
                                      />
                                    </label>
                                    <label>
                                      Duration
                                      <div className="duration-input-with-unit">
                                        <input
                                          aria-label="Clip duration in seconds"
                                          type="number"
                                          min={MIN_CLIP_DURATION_SECONDS}
                                          max={sequence.durationSeconds - step.startSeconds}
                                          step={0.01}
                                          value={step.durationSeconds}
                                          onChange={(event) => resizeClipFromSnapshot(sequence.id, index, "right", step.startSeconds + Number(event.target.value), sequence.steps)}
                                        />
                                        <span className="duration-unit" aria-hidden="true">s</span>
                                      </div>
                                    </label>
                                    <RangeField
                                      label="Pitch"
                                      output={`${(step.pitchSemitones ?? 0) > 0 ? "+" : ""}${step.pitchSemitones ?? 0} st`}
                                      ariaLabel={`${sequence.name} clip ${index + 1} pitch shift`}
                                      min={-MAX_PITCH_SEMITONES}
                                      max={MAX_PITCH_SEMITONES}
                                      step={1}
                                      value={step.pitchSemitones ?? 0}
                                      onChange={(value) => updateStep(index, { pitchSemitones: value }, sequence.id)}
                                    />
                                    <label className="checkbox-field">
                                      <input type="checkbox" checked={step.repeatFill} onChange={(event) => updateStep(index, { repeatFill: event.target.checked }, sequence.id)} />
                                      Repeat fill
                                    </label>
                                  </div>
                                </DropdownPanel>
                              )}
                            </div>
                          );
                        })}
                        <div className="sequence-end-control">
                          <button
                            className="sequence-end-anchor"
                            type="button"
                            aria-label={`Resize ${sequence.name} duration, currently ${sequence.durationSeconds.toFixed(2)} seconds`}
                            aria-expanded={sequenceDurationMenuId === sequence.id}
                            title="Drag to resize. Right-click to enter duration."
                            onPointerDown={(event) => beginSequenceResize(event, sequence)}
                            onPointerMove={moveSequenceResize}
                            onPointerUp={endSequenceResize}
                            onPointerCancel={endSequenceResize}
                            onClick={(event) => {
                              if (event.detail === 0) setSequenceDurationMenuId((current) => current === sequence.id ? null : sequence.id);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setActiveSequencerId(sequence.id);
                              setSelectedCellOpen(false);
                              setSequenceDurationMenuId(sequence.id);
                            }}
                          />
                          {sequenceDurationMenuId === sequence.id && (
                            <DropdownPanel className="sequence-duration-popover">
                              <label>
                                Duration
                                <div className="duration-input-with-unit">
                                  <input
                                    aria-label={`${sequence.name} duration in seconds`}
                                    type="number"
                                    min={minimumSequenceDuration}
                                    step={0.01}
                                    value={sequence.durationSeconds}
                                    onChange={(event) => updateSequenceDuration(sequence.id, Number(event.target.value))}
                                  />
                                  <span className="duration-unit" aria-hidden="true">s</span>
                                </div>
                              </label>
                            </DropdownPanel>
                          )}
                        </div>
                      </div>
                    </div>
                    <RowActionsMenu className="sequence-row-actions" panelClassName="row-icon-actions" ariaLabel={`${sequence.name} actions`}>
                      <PlayButton onClick={() => void toggleTargetPlayback({ kind: "sequence", id: sequence.id }, () => previewSequence(sequence.id))} disabled={!source || !sequence.steps.some((step) => !step.muted)} ariaLabel={`Play ${sequence.name}`} {...targetPlaybackState({ kind: "sequence", id: sequence.id })} />
                      <IconButton pressed={!sequence.muted} ariaLabel={`${sequence.muted ? "Unmute" : "Mute"} ${sequence.name}`} onClick={() => updateSequence({ muted: !sequence.muted }, sequence.id)}><HeadphonesIcon /></IconButton>
                      <IconButton onClick={() => randomizeSequence(sequence.id)} disabled={!source || !layers.length} ariaLabel={`Randomize ${sequence.name}`}><ShuffleIcon /></IconButton>
                      <IconButton className="destructive-button" onClick={() => removeSequence(sequence.id)} ariaLabel={`Remove ${sequence.name}`}><CloseIcon /></IconButton>
                    </RowActionsMenu>
                  </div>
                );
              })}
            </div>
            {selectedClips.length >= 2 && (
              <div className="sequence-bulk-controls" role="toolbar" aria-label="Selected sequence clips">
                <span className="sequence-bulk-count">{selectedClips.length} clips selected</span>
                <div className="sequence-bulk-actions">
                  <button className="make-button label-caps" type="button" onClick={muteSelectedClips}>
                    {allSelectedClipsMuted ? "Unmute selected" : "Mute selected"}
                  </button>
                  <button className="make-button label-caps destructive-button" type="button" onClick={removeSelectedClips}>
                    Delete selected
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="workspace-section adsr-section">
        <SectionHeader
          controlsId="adsr-content"
          expanded={expandedSections.adsr}
          label="ADSR / EFFECTS"
          onToggle={() => setExpandedSections((current) => ({ ...current, adsr: !current.adsr }))}
        />
        {expandedSections.adsr && (
          <div id="adsr-content" className="section-content adsr-content">
            <div className="adsr-controls">
              <div className="adsr-grid">
                <RangeField label="Attack" output={`${adsr.attackSeconds.toFixed(2)}s`} min={0} max={4} step={0.01} value={adsr.attackSeconds} onChange={(value) => setAdsr({ ...adsr, attackSeconds: value })} />
                <RangeField label="Decay" output={`${adsr.decaySeconds.toFixed(2)}s`} min={0} max={4} step={0.01} value={adsr.decaySeconds} onChange={(value) => setAdsr({ ...adsr, decaySeconds: value })} />
                <RangeField label="Sustain" output={adsr.sustainLevel.toFixed(2)} min={0} max={1} step={0.01} value={adsr.sustainLevel} onChange={(value) => setAdsr({ ...adsr, sustainLevel: value })} />
                <RangeField label="Release" output={`${adsr.releaseSeconds.toFixed(2)}s`} min={0} max={4} step={0.01} value={adsr.releaseSeconds} onChange={(value) => setAdsr({ ...adsr, releaseSeconds: value })} />
              </div>
              <div className="effects-grid">
                <div className="effect-row reverb-effect-row">
                  <span className="effect-name">Reverb</span>
                  <RangeField label="Decay" ariaLabel="Reverb decay" output={`${effects.reverbDecaySeconds.toFixed(1)}s`} min={0.2} max={MAX_REVERB_DECAY_SECONDS} step={0.1} value={effects.reverbDecaySeconds} onChange={(value) => setEffects({ ...effects, reverbDecaySeconds: value })} />
                  <RangeField label="Pre-delay" ariaLabel="Reverb pre-delay" output={`${Math.round(effects.reverbPreDelaySeconds * 1000)}ms`} min={0} max={0.25} step={0.005} value={effects.reverbPreDelaySeconds} onChange={(value) => setEffects({ ...effects, reverbPreDelaySeconds: value })} />
                  <RangeField label="Damping" ariaLabel="Reverb damping" output={`${(effects.reverbDampingHz / 1000).toFixed(1)}kHz`} min={500} max={18000} step={100} value={effects.reverbDampingHz} onChange={(value) => setEffects({ ...effects, reverbDampingHz: value })} />
                  <RangeField label="Wet / dry" ariaLabel="Reverb wet dry" output={`${Math.round(effects.reverbMix * 100)}%`} min={0} max={1} step={0.01} value={effects.reverbMix} onChange={(value) => setEffects({ ...effects, reverbMix: value })} />
                </div>
                <div className="effect-row delay-effect-row">
                  <span className="effect-name">Delay</span>
                  <RangeField label="Time" ariaLabel="Delay time" output={`${Math.round(effects.delaySeconds * 1000)}ms`} min={0.05} max={1} step={0.01} value={effects.delaySeconds} onChange={(value) => setEffects({ ...effects, delaySeconds: value })} />
                  <RangeField label="Feedback" ariaLabel="Delay feedback" output={`${Math.round(effects.delayFeedback * 100)}%`} min={0} max={0.85} step={0.01} value={effects.delayFeedback} onChange={(value) => setEffects({ ...effects, delayFeedback: value })} />
                  <RangeField label="Wet / dry" ariaLabel="Delay wet dry" output={`${Math.round(effects.delayMix * 100)}%`} min={0} max={1} step={0.01} value={effects.delayMix} onChange={(value) => setEffects({ ...effects, delayMix: value })} />
                </div>
                <div className="effect-row compressor-effect-row">
                  <span className="effect-name">Compressor</span>
                  <RangeField label="Low" ariaLabel="Low compressor" output={`${Math.round(compressorLowAmount * 100)}%`} min={0} max={1} step={0.01} value={compressorLowAmount} onChange={(value) => setEffects({ ...effects, compressorLowAmount: value })} />
                  <RangeField label="Mid" ariaLabel="Mid compressor" output={`${Math.round(compressorMidAmount * 100)}%`} min={0} max={1} step={0.01} value={compressorMidAmount} onChange={(value) => setEffects({ ...effects, compressorMidAmount: value })} />
                  <RangeField label="High" ariaLabel="High compressor" output={`${Math.round(compressorHighAmount * 100)}%`} min={0} max={1} step={0.01} value={compressorHighAmount} onChange={(value) => setEffects({ ...effects, compressorHighAmount: value })} />
                </div>
              </div>
            </div>
            <EnvelopeGraph adsr={adsr} onChange={(next) => setAdsr(next)} />
          </div>
        )}
      </section>

      </div>
      <div className="processing-footer">
        <div className="footer-status" role="status" aria-live="polite">
          <span className="processing-footer-label">{processing ? "PROCESSING" : playing ? "PLAYING" : paused ? "PAUSED" : tailPlaying ? "TAIL" : "STOPPED"}</span>
          <span className="footer-divider" aria-hidden="true" />
          <span className="mono">{formatSeconds(elapsedSeconds)}</span>
          <span className="footer-divider" aria-hidden="true" />
          <span className="processing-footer-percent">{processingProgress ?? (playing || tailPlaying ? 100 : 42)}%</span>
        </div>
        <IconButton allowReadOnly className="transport-stop-button footer-stop-button" onClick={stopPlayback} disabled={!playing && !paused && !tailPlaying && !keyboardPlaying && !processing} ariaLabel="Stop playback"><StopIcon /></IconButton>
      </div>
      <div className="sr-only" aria-live="polite">{status}</div>
    </main>
  );
}
