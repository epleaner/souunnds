import { useMemo, useRef, useState } from "react";
import {
  DEFAULT_PARAMS,
  generateArrangement,
  renderArrangement,
  renderSequencer,
  stretchPcm,
  type Arrangement,
  type Layer,
  type PcmAudio,
  type SequenceStep,
  type Sequencer,
  type StretchParams,
} from "../shared/audio";

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
  const [segment, setSegment] = useState({ start: 0, end: 4 });
  const [params, setParams] = useState<StretchParams>({ ...DEFAULT_PARAMS });
  const [layers, setLayers] = useState<Layer[]>([]);
  const [sequencers, setSequencers] = useState<Sequencer[]>([
    { id: "main-sequencer", name: "Main sequence", steps: [] },
  ]);
  const [activeSequencerId, setActiveSequencerId] = useState("main-sequencer");
  const [generatedCount, setGeneratedCount] = useState(4);
  const [generatedSeed, setGeneratedSeed] = useState(23);
  const [generatedLinked, setGeneratedLinked] = useState(true);
  const [status, setStatus] = useState("Import an audio file to begin.");
  const [playing, setPlaying] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);

  const arrangement = useMemo<Arrangement>(() => ({ layers, sequencers }), [layers, sequencers]);
  const activeSequencer = sequencers.find((sequencer) => sequencer.id === activeSequencerId) ?? sequencers[0];

  function ensureContext(): AudioContext {
    if (!contextRef.current) contextRef.current = new AudioContext();
    return contextRef.current;
  }

  function stopPlayback(): void {
    sourceNodeRef.current?.stop();
    sourceNodeRef.current = null;
    setPlaying(false);
  }

  async function playPcm(audio: PcmAudio, label: string): Promise<void> {
    const context = ensureContext();
    await context.resume();
    stopPlayback();
    const node = context.createBufferSource();
    node.buffer = audioBufferFromPcm(context, audio);
    node.connect(context.destination);
    node.onended = () => {
      if (sourceNodeRef.current === node) {
        sourceNodeRef.current = null;
        setPlaying(false);
      }
    };
    sourceNodeRef.current = node;
    node.start();
    setPlaying(true);
    setStatus(`Playing ${label} · ${formatSeconds(audio.samples.length / audio.channels / audio.sampleRate)}`);
  }

  async function importFile(file: File): Promise<void> {
    try {
      const context = ensureContext();
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      const pcm = pcmFromAudioBuffer(decoded);
      const nextDuration = decoded.duration;
      setSource(pcm);
      setFileName(file.name);
      setDuration(nextDuration);
      setSegment({ start: 0, end: Math.min(4, nextDuration) });
      setLayers([createLayer(nextDuration, 0)]);
      setSequencers([{ id: "main-sequencer", name: "Main sequence", steps: [] }]);
      setActiveSequencerId("main-sequencer");
      setStatus(`${file.name} ready · ${formatSeconds(nextDuration)} · ${decoded.sampleRate.toLocaleString()} Hz`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not decode that file.");
    }
  }

  async function previewSelection(): Promise<void> {
    if (!source) return setStatus("Import a file before previewing.");
    setStatus("Rendering preview…");
    await playPcm(stretchPcm(source, segment, params), "selected segment");
  }

  async function previewArrangement(): Promise<void> {
    if (!source) return setStatus("Import a file before playing layers.");
    if (!layers.length) return setStatus("Add at least one layer first.");
    setStatus("Rendering layers…");
    await playPcm(renderArrangement(source, arrangement), `${layers.length} layers`);
  }

  async function previewSequence(): Promise<void> {
    if (!source || !activeSequencer) return setStatus("Add a sequence step first.");
    if (!activeSequencer.steps.length) return setStatus("Add a layer or nested sequence to the sequencer first.");
    setStatus("Rendering sequence…");
    await playPcm(renderSequencer(source, arrangement, activeSequencer.id), activeSequencer.name);
  }

  function updateParams(patch: Partial<StretchParams>): void {
    setParams((current) => ({ ...current, ...patch }));
  }

  function updateLayer(id: string, patch: Partial<Layer>): void {
    setLayers((current) => current.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)));
  }

  function updateLayerParams(id: string, patch: Partial<StretchParams>): void {
    setLayers((current) => current.map((layer) => (
      layer.id === id ? { ...layer, params: { ...layer.params, ...patch } } : layer
    )));
  }

  function addLayer(): void {
    if (!source) return setStatus("Import a file before adding layers.");
    setLayers((current) => [...current, createLayer(duration, current.length)]);
  }

  function generateLayers(): void {
    if (!source) return setStatus("Import a file before generating layers.");
    const generated = generateArrangement(duration, {
      count: generatedCount,
      seed: generatedSeed,
      linked: generatedLinked,
    });
    setLayers(generated.layers);
    setStatus(`Generated ${generated.layers.length} ${generatedLinked ? "linked" : "independent"} layers.`);
  }

  function updateSequencer(id: string, patch: Partial<Sequencer>): void {
    setSequencers((current) => current.map((sequencer) => (
      sequencer.id === id ? { ...sequencer, ...patch } : sequencer
    )));
  }

  function addStep(targetType: SequenceStep["targetType"]): void {
    if (!activeSequencer) return;
    const targetId = targetType === "layer" ? layers[0]?.id : sequencers.find((item) => item.id !== activeSequencer.id)?.id;
    if (!targetId) return setStatus(`Add a ${targetType === "layer" ? "layer" : "second sequencer"} first.`);
    const step: SequenceStep = { targetId, targetType, repeats: 1, gapSeconds: 0 };
    updateSequencer(activeSequencer.id, { steps: [...activeSequencer.steps, step] });
  }

  function updateStep(index: number, patch: Partial<SequenceStep>): void {
    if (!activeSequencer) return;
    updateSequencer(activeSequencer.id, {
      steps: activeSequencer.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)),
    });
  }

  function addSequencer(): void {
    const nextId = `sequencer-${sequencers.length + 1}`;
    setSequencers((current) => [...current, { id: nextId, name: `Sequence ${current.length + 1}`, steps: [] }]);
    setActiveSequencerId(nextId);
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">LOCAL AUDIO LAB · 01</p>
          <h1>Tunestretch</h1>
          <p className="hero-copy">Pull a moment out of a song. Stretch it until the grain becomes a landscape.</p>
        </div>
        <div className="hero-mark" aria-hidden="true"><span>∿</span><span>∿</span><span>∿</span></div>
      </header>

      <section className="import-card panel">
        <div>
          <p className="section-kicker">Source</p>
          <h2>{fileName || "Bring in a local file"}</h2>
          <p className="muted">Audio stays in your browser. Nothing is uploaded.</p>
        </div>
        <label className="file-button">
          Choose audio
          <input type="file" accept="audio/*" onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0])} />
        </label>
        <div className="status" role="status" aria-live="polite">{status}</div>
      </section>

      <div className="workspace">
        <section className="panel controls-panel">
          <div className="panel-heading"><div><p className="section-kicker">01 · Shape</p><h2>Stretch a segment</h2></div><span className="pill">{formatSeconds(duration)}</span></div>
          <div className="range-grid">
            <label>Start <input type="number" min="0" max={duration} step="0.01" value={segment.start} onChange={(event) => setSegment({ ...segment, start: Number(event.target.value) })} /></label>
            <label>End <input type="number" min="0.01" max={duration} step="0.01" value={segment.end} onChange={(event) => setSegment({ ...segment, end: Number(event.target.value) })} /></label>
          </div>
          <label className="range-label">Stretch <output>{params.stretch.toFixed(1)}×</output><input type="range" min="1" max="40" step="0.5" value={params.stretch} onChange={(event) => updateParams({ stretch: Number(event.target.value) })} /></label>
          <div className="range-grid">
            <label>Loops <input type="number" min="1" max="32" step="1" value={params.loops} onChange={(event) => updateParams({ loops: Number(event.target.value) })} /></label>
            <label>Seed <input type="number" min="1" step="1" value={params.seed} onChange={(event) => updateParams({ seed: Number(event.target.value) })} /></label>
          </div>
          <label className="range-label">Grain window <output>{params.windowSeconds.toFixed(2)}s</output><input type="range" min="0.05" max="1" step="0.01" value={params.windowSeconds} onChange={(event) => updateParams({ windowSeconds: Number(event.target.value) })} /></label>
          <label className="range-label">Overlap <output>{Math.round(params.overlap * 100)}%</output><input type="range" min="0" max="0.95" step="0.01" value={params.overlap} onChange={(event) => updateParams({ overlap: Number(event.target.value) })} /></label>
          <button className="primary-button" onClick={() => void previewSelection()} disabled={!source}>{playing ? "Preview / restart" : "Preview segment"}</button>
        </section>

        <section className="panel arrangement-panel">
          <div className="panel-heading"><div><p className="section-kicker">02 · Arrange</p><h2>Layer the drift</h2></div><button className="quiet-button" onClick={addLayer} disabled={!source}>+ Layer</button></div>
          <div className="generator-row">
            <div><strong>Generative pass</strong><span>Random segments, deterministic seed.</span></div>
            <label>Count <input type="number" min="1" max="12" value={generatedCount} onChange={(event) => setGeneratedCount(Number(event.target.value))} /></label>
            <label>Seed <input type="number" min="1" value={generatedSeed} onChange={(event) => setGeneratedSeed(Number(event.target.value))} /></label>
            <label className="toggle"><input type="checkbox" checked={generatedLinked} onChange={(event) => setGeneratedLinked(event.target.checked)} /> Linked</label>
            <button className="quiet-button" onClick={generateLayers} disabled={!source}>Generate</button>
          </div>
          <div className="layer-list">
            {!layers.length && <div className="empty-state">Import a file, then add a layer or generate an arrangement.</div>}
            {layers.map((layer, index) => (
              <article className={`layer-card ${layer.muted ? "is-muted" : ""}`} key={layer.id}>
                <div className="layer-title"><span className="layer-index">{String(index + 1).padStart(2, "0")}</span><input aria-label="Layer name" value={layer.name} onChange={(event) => updateLayer(layer.id, { name: event.target.value })} /><label className="toggle"><input type="checkbox" checked={!layer.muted} onChange={(event) => updateLayer(layer.id, { muted: !event.target.checked })} /> On</label><button className="icon-button" aria-label={`Remove ${layer.name}`} onClick={() => setLayers((current) => current.filter((item) => item.id !== layer.id))}>×</button></div>
                <div className="layer-fields">
                  <label>Start <input type="number" min="0" max={duration} step="0.01" value={layer.segment.start} onChange={(event) => updateLayer(layer.id, { segment: { ...layer.segment, start: Number(event.target.value) } })} /></label>
                  <label>End <input type="number" min="0.01" max={duration} step="0.01" value={layer.segment.end} onChange={(event) => updateLayer(layer.id, { segment: { ...layer.segment, end: Number(event.target.value) } })} /></label>
                  <label>Stretch <input type="number" min="1" max="40" step="0.5" value={layer.params.stretch} onChange={(event) => updateLayerParams(layer.id, { stretch: Number(event.target.value) })} /></label>
                  <label>Loops <input type="number" min="1" max="32" step="1" value={layer.params.loops} onChange={(event) => updateLayerParams(layer.id, { loops: Number(event.target.value) })} /></label>
                  <label>Offset <input type="number" min="0" step="0.1" value={layer.offsetSeconds} onChange={(event) => updateLayer(layer.id, { offsetSeconds: Number(event.target.value) })} /></label>
                  <label>Gain <input type="number" min="0" max="2" step="0.05" value={layer.gain} onChange={(event) => updateLayer(layer.id, { gain: Number(event.target.value) })} /></label>
                </div>
              </article>
            ))}
          </div>
          <button className="primary-button" onClick={() => void previewArrangement()} disabled={!source || !layers.length}>Play layers together</button>
        </section>
      </div>

      <section className="panel sequencer-panel">
        <div className="panel-heading"><div><p className="section-kicker">03 · Sequence</p><h2>Compose playback</h2></div><button className="quiet-button" onClick={addSequencer}>+ Sequencer</button></div>
        <div className="sequencer-toolbar"><label>Editing <select value={activeSequencerId} onChange={(event) => setActiveSequencerId(event.target.value)}>{sequencers.map((sequencer) => <option key={sequencer.id} value={sequencer.id}>{sequencer.name}</option>)}</select></label><label>Name <input value={activeSequencer?.name ?? ""} onChange={(event) => activeSequencer && updateSequencer(activeSequencer.id, { name: event.target.value })} /></label><button className="quiet-button" onClick={() => addStep("layer")} disabled={!layers.length}>+ Layer step</button><button className="quiet-button" onClick={() => addStep("sequencer")} disabled={sequencers.length < 2}>+ Nested step</button><button className="primary-button compact" onClick={() => void previewSequence()} disabled={!source || !activeSequencer?.steps.length}>Play sequence</button></div>
        <div className="sequence-list">
          {!activeSequencer?.steps.length && <div className="empty-state">Sequence steps can target layers or other sequencers, with repeats and gaps.</div>}
          {activeSequencer?.steps.map((step, index) => (
            <div className="sequence-step" key={`${activeSequencer.id}-${index}`}><span className="step-number">{index + 1}</span><select value={step.targetId} onChange={(event) => updateStep(index, { targetId: event.target.value })}>{(step.targetType === "layer" ? layers : sequencers.filter((sequencer) => sequencer.id !== activeSequencer.id)).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select><label>Repeats <input type="number" min="1" max="32" value={step.repeats} onChange={(event) => updateStep(index, { repeats: Number(event.target.value) })} /></label><label>Gap <input type="number" min="0" step="0.1" value={step.gapSeconds} onChange={(event) => updateStep(index, { gapSeconds: Number(event.target.value) })} /></label><button className="icon-button" aria-label="Remove sequence step" onClick={() => updateSequencer(activeSequencer.id, { steps: activeSequencer.steps.filter((_, stepIndex) => stepIndex !== index) })}>×</button></div>
          ))}
        </div>
      </section>

      <footer><span>Tunestretch runs locally in your browser.</span><button className="stop-button" onClick={stopPlayback} disabled={!playing}>Stop playback</button></footer>
    </main>
  );
}
