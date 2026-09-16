import type { PcmAudio, Segment, StretchParams } from "../shared/audio";
import { frameCount } from "../shared/audio";
interface PaulstretchModule {
  Window: { Hann: number };
  OfflineRenderer: new (
    stretch: number,
    fftSize: number,
    sampleRate: number,
    window: number,
    onsetSensitivity: number,
  ) => {
    renderMono(input: Float32Array): Float32Array;
    renderStereo(left: Float32Array, right: Float32Array): { left: Float32Array; right: Float32Array };
    delete(): void;
  };
}

type PaulstretchFactory = (options: { locateFile: (path: string) => string }) => Promise<PaulstretchModule>;

const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

let modulePromise: Promise<PaulstretchModule> | undefined;

export function loadPaulstretchModule(): Promise<PaulstretchModule> {
  modulePromise ??= (async () => {
    // The generated Emscripten module is a runtime asset produced by npm run build:wasm.
    // Its path is intentionally runtime-selected so Vite does not bundle a generated binary.
    const moduleUrl = new URL("/paulstretch/paulstretch.js", document.baseURI).href;
    const imported = await import(/* @vite-ignore */ moduleUrl) as { default?: PaulstretchFactory };
    const factory = imported.default;
    if (!factory) throw new Error("Upstream Paulstretch WASM factory is missing.");
    const wasmFile = WebAssembly.validate(SIMD_PROBE)
      ? "paulstretch.wasm"
      : "paulstretch.nosimd.wasm";
    return factory({ locateFile: (path) => path.endsWith(".wasm") ? `/paulstretch/${wasmFile}` : path });
  })();
  return modulePromise;
}

function fftSizeForWindow(windowSeconds: number, sampleRate: number): number {
  const requested = Math.min(65536, Math.max(256, windowSeconds * sampleRate));
  return 2 ** Math.ceil(Math.log2(requested));
}

function loopSegment(audio: PcmAudio, segment: Segment, loops: number): PcmAudio {
  const startFrame = Math.max(0, Math.min(frameCount(audio) - 1, Math.floor(Math.min(segment.start, segment.end) * audio.sampleRate)));
  const endFrame = Math.max(startFrame + 1, Math.min(frameCount(audio), Math.ceil(Math.max(segment.start, segment.end) * audio.sampleRate)));
  const selected = audio.samples.subarray(startFrame * audio.channels, endFrame * audio.channels);
  const samples = new Float32Array(selected.length * loops);
  for (let loop = 0; loop < loops; loop += 1) samples.set(selected, loop * selected.length);
  return { ...audio, samples };
}

export async function stretchWithPaulstretch(
  audio: PcmAudio,
  segment: Segment,
  params: StretchParams,
): Promise<PcmAudio> {
  if (audio.channels > 2) {
    throw new Error("Upstream Paulstretch supports mono and stereo files only.");
  }
  const module = await loadPaulstretchModule();
  const prepared = loopSegment(audio, segment, Math.max(1, Math.floor(params.loops)));
  const frames = frameCount(prepared);
  const left = new Float32Array(frames);
  const right = prepared.channels > 1 ? new Float32Array(frames) : undefined;
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = prepared.samples[frame * prepared.channels];
    if (right) right[frame] = prepared.samples[frame * prepared.channels + 1];
  }

  const renderer = new module.OfflineRenderer(
    Math.max(1, params.stretch),
    fftSizeForWindow(params.windowSeconds, prepared.sampleRate),
    prepared.sampleRate,
    module.Window.Hann,
    Math.max(0, Math.min(1, params.onset)),
  );
  try {
    if (!right) {
      const output = renderer.renderMono(left);
      return { sampleRate: prepared.sampleRate, channels: 1, samples: output };
    }
    const output = renderer.renderStereo(left, right);
    const samples = new Float32Array(output.left.length * 2);
    for (let frame = 0; frame < output.left.length; frame += 1) {
      samples[frame * 2] = output.left[frame];
      samples[frame * 2 + 1] = output.right[frame];
    }
    return { sampleRate: prepared.sampleRate, channels: 2, samples };
  } finally {
    renderer.delete();
  }
}
