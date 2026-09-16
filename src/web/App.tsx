import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_PLAYBACK_ADSR,
  applyPlaybackAdsr,
  DEFAULT_PARAMS,
  generateArrangement,
  renderArrangementAsync,
  renderSequencerAsync,
  sequenceCellDurations,
  type Arrangement,
  type Layer,
  type PcmAudio,
  type PlaybackAdsr,
  type SequenceStep,
  type Sequencer,
} from "../shared/audio";
import { loadPaulstretchModule, stretchWithPaulstretch } from "./paulstretch";
const MAIN_SEQUENCE_ID = "main-sequencer";

type SequencePlayback = { cellDurations: number[]; startedAt: number };
type ResizeState = { index: number; edge: "left" | "right"; startX: number; initialLength: number; pixelsPerLength: number };

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
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
  return { targetId, targetType: "layer", repeats: 1, gapSeconds: 0, length };
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

export function App() {
  const [source, setSource] = useState<PcmAudio | null>(null);
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [sequencers, setSequencers] = useState<Sequencer[]>([
    { id: MAIN_SEQUENCE_ID, name: "Main sequence", steps: [] },
  ]);
  const [selectedCellIndex, setSelectedCellIndex] = useState(0);
  const [generatedCount, setGeneratedCount] = useState(4);
  const [generatedSeed, setGeneratedSeed] = useState(23);
  const [generatedLinked, setGeneratedLinked] = useState(true);
  const [status, setStatus] = useState("Import an audio file to begin.");
  const [playing, setPlaying] = useState(false);
  const [sequencePlayback, setSequencePlayback] = useState<SequencePlayback | null>(null);
  const [sequenceProgress, setSequenceProgress] = useState<{ index: number; fraction: number } | null>(null);
  const [adsr, setAdsr] = useState<PlaybackAdsr>({ ...DEFAULT_PLAYBACK_ADSR });
  const contextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const arrangement = useMemo<Arrangement>(() => ({ layers, sequencers }), [layers, sequencers]);
  const activeSequencer = sequencers[0];
  const selectedCell = activeSequencer?.steps[selectedCellIndex];
  const layerNames = useMemo(() => new Map(layers.map((layer) => [layer.id, layer.name])), [layers]);

  useEffect(() => {
    if (!sequencePlayback) {
      setSequenceProgress(null);
      return;
    }
    let frameId = 0;
    const update = () => {
      const elapsed = (performance.now() - sequencePlayback.startedAt) / 1000;
      let cursor = 0;
      let progress = { index: sequencePlayback.cellDurations.length - 1, fraction: 1 };
      for (let index = 0; index < sequencePlayback.cellDurations.length; index += 1) {
        const cellDuration = Math.max(0, sequencePlayback.cellDurations[index]);
        if (elapsed < cursor + cellDuration || (cellDuration === 0 && elapsed <= cursor)) {
          progress = { index, fraction: cellDuration ? Math.min(1, Math.max(0, (elapsed - cursor) / cellDuration)) : 1 };
          break;
        }
        cursor += cellDuration;
      }
      setSequenceProgress(progress);
      if (elapsed < sequencePlayback.cellDurations.reduce((sum, value) => sum + Math.max(0, value), 0)) {
        frameId = requestAnimationFrame(update);
      }
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
  async function playPcm(audio: PcmAudio, label: string, cellDurations?: number[]): Promise<void> {
    const context = ensureContext();
    await context.resume();
    stopPlayback();
    const preparedAudio = applyPlaybackAdsr(audio, adsr);
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
    if (cellDurations) setSequencePlayback({ cellDurations, startedAt: performance.now() });
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
      setSequencers([{
        id: MAIN_SEQUENCE_ID,
        name: "Main sequence",
        steps: Array.from({ length: 4 }, () => createSequenceStep(initialLayer.id)),
      }]);
      setSelectedCellIndex(0);
      setStatus(`${file.name} ready · ${formatSeconds(nextDuration)} · ${decoded.sampleRate.toLocaleString()} Hz`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load that file or the upstream WASM core.");
    }
  }

  async function previewLayer(layer: Layer): Promise<void> {
    if (!source) return setStatus("Import a file before previewing.");
    setStatus(`Rendering ${layer.name} with upstream Paulstretch…`);
    try {
      await playPcm(await stretchWithPaulstretch(source, layer.segment, layer.params), layer.name);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Layer preview failed.");
    }
  }

  async function previewArrangement(): Promise<void> {
    if (!source) return setStatus("Import a file before playing layers.");
    if (!layers.length) return setStatus("Add at least one layer first.");
    setStatus("Rendering layers with upstream Paulstretch…");
    try {
      await playPcm(await renderArrangementAsync(source, arrangement, stretchWithPaulstretch), `${layers.length} layers`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Layer playback failed.");
    }
  }

  async function previewSequence(): Promise<void> {
    if (!source || !activeSequencer?.steps.length) return setStatus("Add a sequence cell first.");
    setStatus("Rendering sequence with upstream Paulstretch…");
    try {
      const cellDurations = sequenceCellDurations(source, arrangement, MAIN_SEQUENCE_ID);
      await playPcm(await renderSequencerAsync(source, arrangement, MAIN_SEQUENCE_ID, stretchWithPaulstretch), activeSequencer.name, cellDurations);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sequence playback failed.");
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
        ? sequence.steps.map((step) => step.targetType === "layer" && step.targetId === id ? { ...step, targetId: remaining[0].id } : step)
        : sequence.steps.filter((step) => step.targetType === "gap"),
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
        ? sequence.steps.map((step) => step.targetType === "layer" ? { ...step, targetId: generated.layers[0].id } : step)
        : Array.from({ length: 4 }, () => createSequenceStep(generated.layers[0].id)),
    })));
    setSelectedCellIndex(0);
    setStatus(`Generated ${generated.layers.length} ${generatedLinked ? "linked" : "independent"} layers.`);
  }

  function updateSequence(patch: Partial<Sequencer>): void {
    setSequencers((current) => current.map((sequence) => (
      sequence.id === MAIN_SEQUENCE_ID ? { ...sequence, ...patch } : sequence
    )));
  }

  function setCellCount(value: number): void {
    if (!layers.length) return setStatus("Add a layer before creating sequence cells.");
    const count = Math.max(1, Math.min(64, Math.floor(Number.isFinite(value) ? value : 1)));
    const fallbackLayerId = layers[0].id;
    updateSequence({ steps: Array.from({ length: count }, (_, index) => activeSequencer?.steps[index] ?? createSequenceStep(fallbackLayerId)) });
    setSelectedCellIndex((current) => Math.min(current, count - 1));
  }

  function updateStep(index: number, patch: Partial<SequenceStep>): void {
    updateSequence({
      steps: activeSequencer?.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)) ?? [],
    });
  }

  function setCellType(index: number, targetType: "layer" | "gap"): void {
    if (targetType === "gap") updateStep(index, { targetType, targetId: "", gapSeconds: 1 });
    else updateStep(index, { targetType, targetId: layers[0]?.id ?? "", gapSeconds: 0 });
  }

  function removeCell(index: number): void {
    if (!activeSequencer || activeSequencer.steps.length <= 1) return;
    updateSequence({ steps: activeSequencer.steps.filter((_, stepIndex) => stepIndex !== index) });
    setSelectedCellIndex((current) => Math.min(current, activeSequencer.steps.length - 2));
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>, index: number, edge: "left" | "right"): void {
    const step = activeSequencer?.steps[index];
    const cell = event.currentTarget.parentElement;
    if (!step || !cell) return;
    const width = cell.getBoundingClientRect().width;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      index,
      edge,
      startX: event.clientX,
      initialLength: Math.max(0.25, step.length),
      pixelsPerLength: width / Math.max(0.25, step.length),
    };
    setSelectedCellIndex(index);
  }

  function moveResize(event: ReactPointerEvent<HTMLButtonElement>, index: number, edge: "left" | "right"): void {
    const resize = resizeRef.current;
    if (!resize || resize.index !== index || resize.edge !== edge) return;
    const delta = (event.clientX - resize.startX) / Math.max(1, resize.pixelsPerLength);
    const length = Math.max(0.25, Math.min(16, resize.initialLength + (edge === "right" ? delta : -delta)));
    updateStep(index, { length: Math.round(length * 4) / 4 });
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
        <div className="hero-mark" aria-hidden="true"><span>∿</span><span>∿</span><span>∿</span></div>
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
        <section className="panel layers-panel">
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
                  <label>Loops <input type="number" min="1" max="32" step="1" value={layer.params.loops} onChange={(event) => updateLayerParams(layer.id, { loops: Number(event.target.value) })} /></label>
                  <label>Offset <input type="number" min="0" step="0.1" value={layer.offsetSeconds} onChange={(event) => updateLayer(layer.id, { offsetSeconds: Number(event.target.value) })} /></label>
                  <label>Gain <input type="number" min="0" max="2" step="0.05" value={layer.gain} onChange={(event) => updateLayer(layer.id, { gain: Number(event.target.value) })} /></label>
                </div>
                <button className="quiet-button layer-preview" onClick={() => void previewLayer(layer)} disabled={!source}>Preview layer</button>
              </article>
            ))}
          </div>
          <button className="primary-button" onClick={() => void previewArrangement()} disabled={!source || !layers.length}>Play layers together</button>
        </section>

        <section className="panel sequence-panel">
          <div className="panel-heading"><div><p className="section-kicker">02 · Sequence</p><h2>Sequence</h2></div><div className="panel-actions"><button className="primary-button compact" onClick={() => void previewSequence()} disabled={!source || !activeSequencer?.steps.length}>Play sequence</button><button className="stop-button" onClick={stopPlayback} disabled={!playing}>Stop</button></div></div>
          <div className="sequence-toolbar"><label>Name <input value={activeSequencer?.name ?? ""} onChange={(event) => updateSequence({ name: event.target.value })} /></label><label>Cells <input type="number" min="1" max="64" value={activeSequencer?.steps.length ?? 0} onChange={(event) => setCellCount(Number(event.target.value))} disabled={!layers.length} /></label></div>
          <div className="sequence-grid" aria-label="Sequence cells">
            {!activeSequencer?.steps.length && <div className="empty-state">Add a layer to create sequence cells.</div>}
            {activeSequencer?.steps.map((step, index) => {
              const progress = sequenceProgress?.index === index ? sequenceProgress.fraction : sequenceProgress && index < sequenceProgress.index ? 1 : 0;
              const label = step.targetType === "gap" ? "Gap" : layerNames.get(step.targetId) ?? "Unassigned";
              return (
                <div className={`sequence-cell ${index === selectedCellIndex ? "is-selected" : ""}`} key={`${activeSequencer.id}-cell-${index}`} style={{ flex: `${Math.max(0.25, step.length)} 1 0` }}>
                  <button className="sequence-cell-edge" type="button" aria-label={`Resize cell ${index + 1} left edge`} onPointerDown={(event) => beginResize(event, index, "left")} onPointerMove={(event) => moveResize(event, index, "left")} onPointerUp={endResize} onPointerCancel={endResize} />
                  <button className="sequence-cell-main" type="button" onClick={() => setSelectedCellIndex(index)} aria-label={`Cell ${index + 1}, ${label}`} aria-pressed={index === selectedCellIndex}>
                    <span className="sequence-cell-progress" style={{ width: `${(progress ?? 0) * 100}%` }} />
                    <span className="sequence-cell-content"><span>{String(index + 1).padStart(2, "0")}</span><strong>{label}</strong></span>
                  </button>
                  <button className="sequence-cell-edge" type="button" aria-label={`Resize cell ${index + 1} right edge`} onPointerDown={(event) => beginResize(event, index, "right")} onPointerMove={(event) => moveResize(event, index, "right")} onPointerUp={endResize} onPointerCancel={endResize} />
                </div>
              );
            })}
          </div>
          {selectedCell ? (
            <div className="cell-inspector">
              <div className="cell-inspector-heading"><strong>Cell {String(selectedCellIndex + 1).padStart(2, "0")}</strong><button className="icon-button" onClick={() => removeCell(selectedCellIndex)} disabled={activeSequencer.steps.length <= 1} aria-label="Remove selected cell">×</button></div>
              <div className="cell-fields">
                <label>Type <select value={selectedCell.targetType === "gap" ? "gap" : "layer"} onChange={(event) => setCellType(selectedCellIndex, event.target.value as "layer" | "gap")}><option value="layer">Layer</option><option value="gap">Gap</option></select></label>
                {selectedCell.targetType === "gap" ? <label>Gap duration <input type="number" min="0" step="0.1" value={selectedCell.gapSeconds} onChange={(event) => updateStep(selectedCellIndex, { gapSeconds: Math.max(0, Number(event.target.value)) })} /></label> : <label>Layer <select value={selectedCell.targetId} onChange={(event) => updateStep(selectedCellIndex, { targetId: event.target.value })}>{layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}</select></label>}
                <label>Relative length <input type="number" min="0.25" max="16" step="0.25" value={selectedCell.length} onChange={(event) => updateStep(selectedCellIndex, { length: Math.max(0.25, Number(event.target.value)) })} /></label>
                {selectedCell.targetType !== "gap" && <label>Repeats <input type="number" min="1" max="32" step="1" value={selectedCell.repeats} onChange={(event) => updateStep(selectedCellIndex, { repeats: Number(event.target.value) })} /></label>}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
