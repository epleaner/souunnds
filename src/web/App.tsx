import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_PLAYBACK_ADSR,
  applyPlaybackAdsr,
  DEFAULT_PARAMS,
  generateArrangement,
  renderArrangementAsync,
  renderSequencerAsync,
  sequenceCellDurations,
  findAudibleStart,
  sourceSegmentRms,
  type Arrangement,
  type Layer,
  type PcmAudio,
  type PlaybackAdsr,
  type SequenceStep,
  type Sequencer,
} from "../shared/audio";
import { loadPaulstretchModule, stretchWithPaulstretch } from "./paulstretch";
const MAIN_SEQUENCE_ID = "main-sequencer";

type SequencePlayback = { tracks: Array<{ sequenceId: string; cellDurations: number[] }>; startedAt: number; simultaneous: boolean };
type ResizeState = { sequenceId: string; index: number; edge: "left" | "right"; startX: number; initialLength: number; pixelsPerLength: number };

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
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

function createLayer(duration: number, index: number): Layer {
  return {
    id: `layer-${Date.now()}-${index}`,
    name: `Layer ${index + 1}`,
    segment: { start: 0, end: Math.max(0.1, Math.min(duration, 4)) },
    params: { ...DEFAULT_PARAMS },
    offsetSeconds: 0,
    gain: 0.8,
    muted: false,
  };
}

function createSequenceStep(targetId: string, length = 1): SequenceStep {
  return { targetId, targetType: "layer", repeats: 1, length };
}
function createSequencer(id: string, name: string, layerId?: string): Sequencer {
  return {
    id,
    name,
    baseLengthSeconds: 1,
    gapLengthSeconds: 0,
    loopLayers: true,
    steps: layerId ? Array.from({ length: 4 }, () => createSequenceStep(layerId)) : [],
  };
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
function repairGeneratedLayers(audio: PcmAudio, layers: Layer[]): { layers: Layer[]; changed: boolean } {
  const sourceDuration = audio.samples.length / audio.channels / audio.sampleRate;
  let changed = false;
  const repaired = layers.map((layer) => {
    if (!layer.name.toLowerCase().startsWith("generated layer") || sourceSegmentRms(audio, layer.segment) > 1e-8) return layer;
    const length = Math.max(0.15, layer.segment.end - layer.segment.start);
    const start = findAudibleStart(audio, length);
    const end = Math.min(sourceDuration, start + length);
    if (start === layer.segment.start || end <= start) return layer;
    changed = true;
    return { ...layer, segment: { start, end } };
  });
  return { layers: repaired, changed };
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
export function App() {
  const [source, setSource] = useState<PcmAudio | null>(null);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [sequencers, setSequencers] = useState<Sequencer[]>([createSequencer(MAIN_SEQUENCE_ID, "Main sequence")]);
  const [activeSequencerId, setActiveSequencerId] = useState(MAIN_SEQUENCE_ID);
  const [selectedCellIndex, setSelectedCellIndex] = useState(0);
  const [generatedCount, setGeneratedCount] = useState(4);
  const [generatedSeed, setGeneratedSeed] = useState(23);
  const [generatedLinked, setGeneratedLinked] = useState(true);
  const [gridRows, setGridRows] = useState(1);
  const [gridColumns, setGridColumns] = useState(4);
  const [status, setStatus] = useState("Import an audio file to begin.");
  const [processing, setProcessing] = useState<string | null>(null);
  const [processingProgress, setProcessingProgress] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [sequencePlayback, setSequencePlayback] = useState<SequencePlayback | null>(null);
  const [sequenceProgress, setSequenceProgress] = useState<Array<{ sequenceId: string; index: number; fraction: number }>>([]);
  const arrangement = useMemo<Arrangement>(() => ({ layers, sequencers }), [layers, sequencers]);
  const activeSequencer = sequencers.find((sequence) => sequence.id === activeSequencerId) ?? sequencers[0];
  const selectedCell = activeSequencer?.steps[selectedCellIndex];
  const [activePanel, setActivePanel] = useState<"layers" | "sequence">("layers");
  const [adsr, setAdsr] = useState<PlaybackAdsr>({ ...DEFAULT_PLAYBACK_ADSR });
  const contextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const layerNames = useMemo(() => new Map(layers.map((layer) => [layer.id, layer.name])), [layers]);

  useEffect(() => {
    if (!sequencePlayback) {
      setSequenceProgress([]);
      return;
    }
    let frameId = 0;
    const trackDuration = (track: SequencePlayback["tracks"][number]) => track.cellDurations.reduce((sum, value) => sum + Math.max(0, value), 0);
    const totalDuration = sequencePlayback.simultaneous
      ? Math.max(...sequencePlayback.tracks.map(trackDuration))
      : sequencePlayback.tracks.reduce((total, track) => total + trackDuration(track), 0);
    const update = () => {
      const elapsed = (performance.now() - sequencePlayback.startedAt) / 1000;
      let cursor = 0;
      const progress = sequencePlayback.tracks.map((track) => {
        const duration = trackDuration(track);
        const trackElapsed = sequencePlayback.simultaneous ? elapsed : Math.max(0, elapsed - cursor);
        let localCursor = 0;
        let result = { sequenceId: track.sequenceId, index: Math.max(0, track.cellDurations.length - 1), fraction: 1 };
        for (let index = 0; index < track.cellDurations.length; index += 1) {
          const cellDuration = Math.max(0, track.cellDurations[index]);
          if (trackElapsed < localCursor + cellDuration || (cellDuration === 0 && trackElapsed <= localCursor)) {
            result = { sequenceId: track.sequenceId, index, fraction: cellDuration ? Math.min(1, Math.max(0, (trackElapsed - localCursor) / cellDuration)) : 1 };
            break;
          }
          localCursor += cellDuration;
        }
        if (!sequencePlayback.simultaneous) cursor += duration;
        return result;
      });
      setSequenceProgress(progress);
      if (elapsed < totalDuration) frameId = requestAnimationFrame(update);
    };
    frameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frameId);
  }, [sequencePlayback]);

  function ensureContext(): AudioContext {
    if (!contextRef.current) contextRef.current = new AudioContext();
    return contextRef.current;
  }

  function stopPlayback(): void {
    sourceNodeRef.current?.stop();
    sourceNodeRef.current = null;
    setPlaying(false);
    setSequencePlayback(null);
    setStatus("Playback stopped.");
  }
  async function playPcm(
    audio: PcmAudio,
    label: string,
    sequenceTracks?: SequencePlayback["tracks"],
    simultaneous = false,
    playbackAdsr: PlaybackAdsr | null = adsr,
  ): Promise<void> {
    const context = ensureContext();
    await context.resume();
    stopPlayback();
    const preparedAudio = playbackAdsr ? applyPlaybackAdsr(audio, playbackAdsr) : audio;
    const node = context.createBufferSource();
    node.buffer = audioBufferFromPcm(context, preparedAudio);
    node.connect(context.destination);
    node.onended = () => {
      if (sourceNodeRef.current === node) {
        sourceNodeRef.current = null;
        setPlaying(false);
        setSequencePlayback(null);
      }
    };
    sourceNodeRef.current = node;
    node.start();
    setPlaying(true);
    if (sequenceTracks) setSequencePlayback({ tracks: sequenceTracks, startedAt: performance.now(), simultaneous });
    setStatus(`Playing ${label} · ${formatSeconds(preparedAudio.samples.length / preparedAudio.channels / preparedAudio.sampleRate)}`);
  }

  async function importFile(file: File): Promise<void> {
    try {
      const context = ensureContext();
      setStatus("Loading upstream Paulstretch WASM…");
      await loadPaulstretchModule();
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      const pcm = pcmFromAudioBuffer(decoded);
      const nextDuration = decoded.duration;
      const initialLayer = createLayer(nextDuration, 0);
      setSource(pcm);
      setFileName(file.name);
      setDuration(nextDuration);
      setLayers([initialLayer]);
      setSequencers([createSequencer(MAIN_SEQUENCE_ID, "Main sequence", initialLayer.id)]);
      setActiveSequencerId(MAIN_SEQUENCE_ID);
      setSelectedCellIndex(0);
      setStatus(`${file.name} ready · ${formatSeconds(nextDuration)} · ${decoded.sampleRate.toLocaleString()} Hz`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load that file or the upstream WASM core.");
    }
  }
  function arrangementForPlayback(): Arrangement {
    if (!source) return arrangement;
    const repaired = repairGeneratedLayers(source, layers);
    if (!repaired.changed) return arrangement;
    setLayers(repaired.layers);
    setStatus("Moved silent generated layers to audible source regions.");
    return { ...arrangement, layers: repaired.layers };
  }

  async function beginProcessing(message: string): Promise<void> {
    setProcessing(message);
    setProcessingProgress(0);
    setStatus(message);
    await nextPaint();
  }

  async function previewLayer(layer: Layer): Promise<void> {
    if (!source) return setStatus("Import a file before previewing.");
    await beginProcessing(`Rendering ${layer.name} with upstream Paulstretch…`);
    try {
      const playbackArrangement = arrangementForPlayback();
      const playableLayer = playbackArrangement.layers.find((candidate) => candidate.id === layer.id) ?? layer;
      const rendered = await stretchForPlayback(source, playableLayer.segment, playableLayer.params);
      setProcessingProgress(100);
      await playPcm(rendered, playableLayer.name);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Layer preview failed.");
    } finally {
      setProcessing(null);
      setProcessingProgress(null);
    }
  }

  async function previewArrangement(): Promise<void> {
    if (!source) return setStatus("Import a file before playing layers.");
    if (!layers.length) return setStatus("Add at least one layer first.");
    await beginProcessing("Rendering layers with upstream Paulstretch…");
    try {
      const playbackArrangement = arrangementForPlayback();
      let completed = 0;
      const renderWithProgress = async (input: PcmAudio, segment: Layer["segment"], params: Layer["params"]): Promise<PcmAudio> => {
        const rendered = await stretchForPlayback(input, segment, params);
        completed += 1;
        setProcessingProgress(Math.round((completed / playbackArrangement.layers.length) * 100));
        return rendered;
      };
      await playPcm(await renderArrangementAsync(source, playbackArrangement, renderWithProgress), `${layers.length} layers`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Layer playback failed.");
    } finally {
      setProcessing(null);
      setProcessingProgress(null);
    }
  }

  async function previewSequence(): Promise<void> {
    if (!source || !activeSequencer?.steps.length) return setStatus("Add a sequence cell first.");
    await beginProcessing("Rendering sequence with upstream Paulstretch…");
    try {
      const playbackArrangement = arrangementForPlayback();
      const cellDurations = sequenceCellDurations(source, playbackArrangement, activeSequencer.id);
      const requiredLayerCount = new Set(activeSequencer.steps.map((step) => step.targetId)).size || 1;
      let completed = 0;
      const renderWithProgress = async (input: PcmAudio, segment: Layer["segment"], params: Layer["params"]): Promise<PcmAudio> => {
        const rendered = await stretchForPlayback(input, segment, params);
        completed += 1;
        setProcessingProgress(Math.min(95, Math.round((completed / requiredLayerCount) * 95)));
        return rendered;
      };
      const rendered = await renderSequencerAsync(source, playbackArrangement, activeSequencer.id, renderWithProgress, adsr);
      setProcessingProgress(100);
      await playPcm(rendered, activeSequencer.name, [{ sequenceId: activeSequencer.id, cellDurations }], false, null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sequence playback failed.");
    } finally {
      setProcessing(null);
      setProcessingProgress(null);
    }
  }

  async function previewAllSequences(): Promise<void> {
    if (!source) return setStatus("Import a file before playing sequences.");
    const playableSequences = sequencers.filter((sequence) => sequence.steps.length);
    if (!playableSequences.length) return setStatus("Add a sequence cell first.");
    await beginProcessing(`Rendering ${playableSequences.length} sequences with upstream Paulstretch…`);
    try {
      const playbackArrangement = arrangementForPlayback();
      const rendered: PcmAudio[] = [];
      const tracks = playableSequences.map((sequence) => ({
        sequenceId: sequence.id,
        cellDurations: sequenceCellDurations(source, playbackArrangement, sequence.id),
      }));
      for (const [index, sequence] of playableSequences.entries()) {
        rendered.push(await renderSequencerAsync(source, playbackArrangement, sequence.id, stretchForPlayback, adsr));
        setProcessingProgress(Math.round(((index + 1) / playableSequences.length) * 100));
      }
      await playPcm(mixPcm(rendered), `${playableSequences.length} sequences`, tracks, true, null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sequence playback failed.");
    } finally {
      setProcessing(null);
      setProcessingProgress(null);
    }
  }

  function updateLayer(id: string, patch: Partial<Layer>): void {
    setLayers((current) => current.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)));
  }

  function updateLayerParams(id: string, patch: Partial<Layer["params"]>): void {
    setLayers((current) => current.map((layer) => (
      layer.id === id ? { ...layer, params: { ...layer.params, ...patch } } : layer
    )));
  }

  function addLayer(): void {
    if (!source) return setStatus("Import a file before adding layers.");
    setLayers((current) => [...current, createLayer(duration, current.length)]);
  }

  function removeLayer(id: string): void {
    const remaining = layers.filter((layer) => layer.id !== id);
    setLayers(remaining);
    setSequencers((sequences) => sequences.map((sequence) => ({
      ...sequence,
      steps: remaining.length
        ? sequence.steps.map((step) => step.targetId === id ? { ...step, targetId: remaining[0].id } : step)
        : sequence.steps,
    })));
    setSelectedCellIndex(0);
  }

  function generateLayers(): void {
    if (!source) return setStatus("Import a file before generating layers.");
    const generated = generateArrangement(duration, {
      count: generatedCount,
      seed: generatedSeed,
      linked: generatedLinked,
    }, source);
    setLayers(generated.layers);
    setSequencers((current) => current.map((sequence) => ({
      ...sequence,
      steps: sequence.steps.length
        ? sequence.steps.map((step) => ({ ...step, targetId: generated.layers[0].id }))
        : Array.from({ length: 4 }, () => createSequenceStep(generated.layers[0].id)),
    })));
    setSelectedCellIndex(0);
    setStatus(`Generated ${generated.layers.length} ${generatedLinked ? "linked" : "independent"} layers.`);
  }

  function updateSequence(patch: Partial<Sequencer>): void {
    setSequencers((current) => current.map((sequence) => (
      sequence.id === activeSequencer?.id ? { ...sequence, ...patch } : sequence
    )));
  }

  function addSequence(): void {
    const id = `sequence-${Date.now()}-${sequencers.length + 1}`;
    const next = createSequencer(id, `Sequence ${sequencers.length + 1}`, layers[0]?.id);
    setSequencers((current) => [...current, next]);
    setActiveSequencerId(id);
    setSelectedCellIndex(0);
  }

  function removeActiveSequence(): void {
    if (!activeSequencer || sequencers.length <= 1) return;
    const remaining = sequencers.filter((sequence) => sequence.id !== activeSequencer.id);
    setSequencers(remaining);
    setActiveSequencerId(remaining[0].id);
    setSelectedCellIndex(0);
  }

  function randomizeSequence(): void {
    if (!activeSequencer?.steps.length || !layers.length) return;
    updateSequence({ steps: activeSequencer.steps.map(() => randomSequenceStep()) });
  }
  function randomSequenceStep(): SequenceStep {
    const targetId = layers[Math.floor(Math.random() * layers.length)]?.id ?? "";
    return {
      targetId,
      targetType: "layer",
      length: Math.round((0.25 + Math.random() * 3.75) * 4) / 4,
      repeats: 1 + Math.floor(Math.random() * 3),
    };
  }

  function randomizeGrid(): void {
    if (!layers.length) return setStatus("Add a layer before randomizing the sequence grid.");
    const rows = Math.max(1, Math.min(12, Math.floor(gridRows)));
    const columns = Math.max(1, Math.min(64, Math.floor(gridColumns)));
    const next = Array.from({ length: rows }, (_, rowIndex) => {
      const existing = sequencers[rowIndex];
      const sequence = existing ?? createSequencer(`sequence-${Date.now()}-${rowIndex + 1}`, `Sequence ${rowIndex + 1}`, layers[0].id);
      return { ...sequence, steps: Array.from({ length: columns }, () => randomSequenceStep()) };
    });
    setSequencers(next);
    setActiveSequencerId(next[0].id);
    setSelectedCellIndex(0);
    setStatus(`Randomized ${rows} × ${columns} sequence grid.`);
  }


  function setCellCount(value: number): void {
    if (!layers.length) return setStatus("Add a layer before creating sequence cells.");
    const count = Math.max(1, Math.min(64, Math.floor(Number.isFinite(value) ? value : 1)));
    const fallbackLayerId = layers[0].id;
    updateSequence({ steps: Array.from({ length: count }, (_, index) => activeSequencer?.steps[index] ?? createSequenceStep(fallbackLayerId)) });
    setSelectedCellIndex((current) => Math.min(current, count - 1));
  }

  function updateStep(index: number, patch: Partial<SequenceStep>, sequenceId = activeSequencer?.id): void {
    if (!sequenceId) return;
    setSequencers((current) => current.map((sequence) => (
      sequence.id === sequenceId
        ? { ...sequence, steps: sequence.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)) }
        : sequence
    )));
  }


  function removeCell(index: number): void {
    if (!activeSequencer || activeSequencer.steps.length <= 1) return;
    updateSequence({ steps: activeSequencer.steps.filter((_, stepIndex) => stepIndex !== index) });
    setSelectedCellIndex((current) => Math.min(current, activeSequencer.steps.length - 2));
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>, sequenceId: string, index: number, edge: "left" | "right"): void {
    const sequence = sequencers.find((item) => item.id === sequenceId);
    const step = sequence?.steps[index];
    const cell = event.currentTarget.parentElement;
    if (!step || !cell) return;
    const width = cell.getBoundingClientRect().width;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      sequenceId,
      index,
      edge,
      startX: event.clientX,
      initialLength: Math.max(0.25, step.length),
      pixelsPerLength: width / Math.max(0.25, step.length),
    };
    setActiveSequencerId(sequenceId);
    setSelectedCellIndex(index);
  }

  function moveResize(event: ReactPointerEvent<HTMLButtonElement>, index: number, edge: "left" | "right"): void {
    const resize = resizeRef.current;
    if (!resize || resize.index !== index || resize.edge !== edge) return;
    const delta = (event.clientX - resize.startX) / Math.max(1, resize.pixelsPerLength);
    const length = Math.max(0.25, Math.min(16, resize.initialLength + (edge === "right" ? delta : -delta)));
    updateStep(index, { length: Math.round(length * 4) / 4 }, resize.sequenceId);
  }

  function endResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (resizeRef.current) event.currentTarget.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">LOCAL AUDIO LAB · 01</p>
          <h1>Tunestretch</h1>
        </div>
      </header>

      <section className="import-card panel">
        <div>
          <p className="section-kicker">Source</p>
          <h2>{fileName || "No file selected"}</h2>
        </div>
        <div className="panel-actions">
          <label className="file-button">Choose audio<input type="file" accept=".mp3,.wav,audio/mpeg,audio/wav,audio/*" onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0])} /></label>
          <button className="stop-button" onClick={stopPlayback} disabled={!playing}>Stop</button>
        </div>
        <div className="status" role="status" aria-live="polite">{status}</div>
        <div className="global-playback-controls">
          <div>
            <p className="section-kicker">Global playback</p>
            <h3>ADSR envelope</h3>
          </div>
          <div className="adsr-grid">
            <label>Attack <output>{adsr.attackSeconds.toFixed(2)}s</output><input aria-label="Attack" type="range" min="0" max="4" step="0.01" value={adsr.attackSeconds} onChange={(event) => setAdsr({ ...adsr, attackSeconds: Number(event.target.value) })} /></label>
            <label>Decay <output>{adsr.decaySeconds.toFixed(2)}s</output><input aria-label="Decay" type="range" min="0" max="4" step="0.01" value={adsr.decaySeconds} onChange={(event) => setAdsr({ ...adsr, decaySeconds: Number(event.target.value) })} /></label>
            <label>Sustain <output>{Math.round(adsr.sustainLevel * 100)}%</output><input aria-label="Sustain" type="range" min="0" max="1" step="0.01" value={adsr.sustainLevel} onChange={(event) => setAdsr({ ...adsr, sustainLevel: Number(event.target.value) })} /></label>
            <label>Release <output>{adsr.releaseSeconds.toFixed(2)}s</output><input aria-label="Release" type="range" min="0" max="4" step="0.01" value={adsr.releaseSeconds} onChange={(event) => setAdsr({ ...adsr, releaseSeconds: Number(event.target.value) })} /></label>
          </div>
        </div>
      </section>
      <div className="studio">
        <div className="studio-tabs" role="tablist" aria-label="Workspace panels">
          <button id="layers-tab" type="button" role="tab" aria-controls="layers-panel" aria-selected={activePanel === "layers"} className={activePanel === "layers" ? "is-active" : ""} onClick={() => setActivePanel("layers")}>Layers</button>
          <button id="sequence-tab" type="button" role="tab" aria-controls="sequence-panel" aria-selected={activePanel === "sequence"} className={activePanel === "sequence" ? "is-active" : ""} onClick={() => setActivePanel("sequence")}>Sequence</button>
        </div>
        {activePanel === "layers" && (
        <section id="layers-panel" role="tabpanel" aria-labelledby="layers-tab" className="panel layers-panel">
          <div className="panel-heading"><div><p className="section-kicker">01 · Layers</p><h2>Layers</h2></div><div className="panel-actions"><button className="quiet-button" onClick={addLayer} disabled={!source}>+ Layer</button><button className="stop-button" onClick={stopPlayback} disabled={!playing}>Stop</button></div></div>
          <div className="generator-row">
            <div><strong>Generate layers</strong></div>
            <label>Count <input type="number" min="1" max="12" value={generatedCount} onChange={(event) => setGeneratedCount(Number(event.target.value))} /></label>
            <label>Seed <input type="number" min="1" value={generatedSeed} onChange={(event) => setGeneratedSeed(Number(event.target.value))} /></label>
            <label className="toggle"><input type="checkbox" checked={generatedLinked} onChange={(event) => setGeneratedLinked(event.target.checked)} /> Linked</label>
            <button className="quiet-button" onClick={generateLayers} disabled={!source}>Generate</button>
          </div>
          <div className="layer-list">
            {!layers.length && <div className="empty-state">Import a file, then add a layer.</div>}
            {layers.map((layer, index) => (
              <article className={`layer-card ${layer.muted ? "is-muted" : ""}`} key={layer.id}>
                <div className="layer-title"><span className="layer-index">{String(index + 1).padStart(2, "0")}</span><input aria-label="Layer name" value={layer.name} onChange={(event) => updateLayer(layer.id, { name: event.target.value })} /><label className="toggle"><input type="checkbox" checked={!layer.muted} onChange={(event) => updateLayer(layer.id, { muted: !event.target.checked })} /> On</label><button className="icon-button" aria-label={`Remove ${layer.name}`} onClick={() => removeLayer(layer.id)}>×</button></div>
                <div className="layer-fields">
                  <label>Start <input type="number" min="0" max={duration} step="0.01" value={layer.segment.start} onChange={(event) => updateLayer(layer.id, { segment: { ...layer.segment, start: Number(event.target.value) } })} /></label>
                  <label>End <input type="number" min="0.01" max={duration} step="0.01" value={layer.segment.end} onChange={(event) => updateLayer(layer.id, { segment: { ...layer.segment, end: Number(event.target.value) } })} /></label>
                  <label>Stretch <input type="number" min="1" max="40" step="0.5" value={layer.params.stretch} onChange={(event) => updateLayerParams(layer.id, { stretch: Number(event.target.value) })} /></label>
                  <label>Offset <input type="number" min="0" step="0.1" value={layer.offsetSeconds} onChange={(event) => updateLayer(layer.id, { offsetSeconds: Number(event.target.value) })} /></label>
                  <label>Gain <input type="number" min="0" max="2" step="0.05" value={layer.gain} onChange={(event) => updateLayer(layer.id, { gain: Number(event.target.value) })} /></label>
                </div>
                <button className="quiet-button layer-preview" onClick={() => void previewLayer(layer)} disabled={!source}>Preview layer</button>
              </article>
            ))}
          </div>
          <button className="primary-button" onClick={() => void previewArrangement()} disabled={!source || !layers.length}>Play layers together</button>
        </section>
        )}
        {activePanel === "sequence" && (
        <section id="sequence-panel" role="tabpanel" aria-labelledby="sequence-tab" className="panel sequence-panel">
          <div className="panel-heading"><div><p className="section-kicker">02 · Sequence</p><h2>Sequence</h2></div><div className="panel-actions"><button className="primary-button compact" onClick={() => void previewSequence()} disabled={!source || !activeSequencer?.steps.length}>Play sequence</button><button className="primary-button compact" onClick={() => void previewAllSequences()} disabled={!source || !sequencers.some((sequence) => sequence.steps.length)}>Play all</button><button className="stop-button" onClick={stopPlayback} disabled={!playing}>Stop</button></div></div>
          <div className="sequence-library">
            <strong className="sequence-library-label">Sequences</strong>
            <button className="quiet-button" type="button" onClick={addSequence}>+ Sequence</button>
            <button className="quiet-button" type="button" onClick={randomizeSequence} disabled={!activeSequencer?.steps.length || !layers.length}>Randomize</button>
            <label>Rows <input aria-label="Grid rows" type="number" min="1" max="12" value={gridRows} onChange={(event) => setGridRows(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} /></label>
            <label>Columns <input aria-label="Grid columns" type="number" min="1" max="64" value={gridColumns} onChange={(event) => setGridColumns(Math.max(1, Math.min(64, Number(event.target.value) || 1)))} /></label>
            <button className="quiet-button" type="button" onClick={randomizeGrid} disabled={!layers.length}>Randomize {gridRows}×{gridColumns}</button>
            <button className="icon-button" type="button" onClick={removeActiveSequence} disabled={sequencers.length <= 1} aria-label="Remove active sequence">×</button>
          </div>
          <div className="sequence-toolbar"><label>Name <input value={activeSequencer?.name ?? ""} onChange={(event) => updateSequence({ name: event.target.value })} /></label><label>Base length (s) <input type="number" min="0.05" max="60" step="0.05" value={activeSequencer?.baseLengthSeconds ?? 1} onChange={(event) => updateSequence({ baseLengthSeconds: Math.max(0.05, Math.min(60, Number(event.target.value))) })} /></label><label>Gap (s) <input type="number" min="0" max="60" step="0.05" value={activeSequencer?.gapLengthSeconds ?? 0} onChange={(event) => updateSequence({ gapLengthSeconds: Math.max(0, Math.min(60, Number(event.target.value))) })} /></label><label>Cells <input type="number" min="1" max="64" value={activeSequencer?.steps.length ?? 0} onChange={(event) => setCellCount(Number(event.target.value))} disabled={!layers.length} /></label><label className="toggle sequence-loop">Loop layers <input type="checkbox" checked={activeSequencer?.loopLayers !== false} onChange={(event) => updateSequence({ loopLayers: event.target.checked })} /></label></div>
          <div className="sequence-matrix" aria-label="All sequences">
            {sequencers.map((sequence) => {
              const isActive = sequence.id === activeSequencer?.id;
              return (
                <div className={`sequence-row ${isActive ? "is-active" : ""}`} key={sequence.id}>
                  <div className="sequence-grid" aria-label={`${sequence.name} cells`}>
                    {!sequence.steps.length && <div className="empty-state">Add a layer to create sequence cells.</div>}
                    {sequence.steps.map((step, index) => {
                      const trackProgress = sequenceProgress.find((track) => track.sequenceId === sequence.id);
                      const progress = trackProgress?.index === index ? trackProgress.fraction : trackProgress && index < trackProgress.index ? 1 : 0;
                      const label = layerNames.get(step.targetId) ?? "Unassigned";
                      return (
                        <div className={`sequence-cell ${isActive && index === selectedCellIndex ? "is-selected" : ""}`} key={`${sequence.id}-cell-${index}`} style={{ flex: `${Math.max(0.25, step.length)} 1 0` }}>
                          <span className="sequence-cell-progress" style={{ width: `${(progress ?? 0) * 100}%` }} />
                          <button className="sequence-cell-edge" type="button" aria-label={`Resize ${sequence.name} cell ${index + 1} left edge`} onPointerDown={(event) => beginResize(event, sequence.id, index, "left")} onPointerMove={(event) => moveResize(event, index, "left")} onPointerUp={endResize} onPointerCancel={endResize} />
                          <button className="sequence-cell-main" type="button" onClick={() => { setActiveSequencerId(sequence.id); setSelectedCellIndex(index); }} aria-label={`${sequence.name} cell ${index + 1}, ${label}`} aria-pressed={isActive && index === selectedCellIndex}>
                            <span className="sequence-cell-content"><strong>{label}</strong></span>
                          </button>
                          <button className="sequence-cell-edge" type="button" aria-label={`Resize ${sequence.name} cell ${index + 1} right edge`} onPointerDown={(event) => beginResize(event, sequence.id, index, "right")} onPointerMove={(event) => moveResize(event, index, "right")} onPointerUp={endResize} onPointerCancel={endResize} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {selectedCell ? (
            <div className="cell-inspector">
              <div className="cell-inspector-heading"><strong>Cell {String(selectedCellIndex + 1).padStart(2, "0")}</strong><button className="icon-button" onClick={() => removeCell(selectedCellIndex)} disabled={activeSequencer.steps.length <= 1} aria-label="Remove selected cell">×</button></div>
              <div className="cell-fields">
                <label>Layer <select value={selectedCell.targetId} onChange={(event) => updateStep(selectedCellIndex, { targetId: event.target.value })}>{layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}</select></label>
                <label>Relative length <input type="number" min="0.25" max="16" step="0.25" value={selectedCell.length} onChange={(event) => updateStep(selectedCellIndex, { length: Math.max(0.25, Number(event.target.value)) })} /></label>
                <label>Repeats <input type="number" min="1" max="32" step="1" value={selectedCell.repeats} onChange={(event) => updateStep(selectedCellIndex, { repeats: Number(event.target.value) })} /></label>
              </div>
            </div>
          ) : null}
        </section>
        )}
      </div>
      {processing && (
        <div className="processing-footer" role="status" aria-live="polite">
          <span className="processing-footer-label">Processing</span>
          <span>{processing}</span>
          <span className="processing-footer-percent">{processingProgress ?? 0}%</span>
        </div>
      )}
    </main>
  );
}
