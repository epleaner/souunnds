import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decodeWav, encodeWav, type PcmAudio } from "./shared/audio.js";

const ROOT = resolve(import.meta.dirname, "..");
const PASSTHROUGH_OPTIONS: Record<string, true> = {
  "--stretch": true, "--fft-size": true, "--window": true, "--onset": true, "--stretch-envelope": true,
  "--pitch-shift": true, "--octave": true, "--frequency-shift": true, "--compressor": true, "--filter": true,
  "--harmonics": true, "--spread": true, "--tonal-noise": true, "--arbitrary-filter": true, "--binaural": true,
  "--binaural-mono": true, "--binaural-mode": true, "--binaural-envelope": true,
};

function printHelp(): void {
  console.log(`souunnds — upstream Paulstretch CLI wrapper

Usage:
  npm run build:core
  npm run cli -- [upstream options] input.wav|input.mp3 output.wav

Input:
  WAV input is read directly. MP3 and other ffmpeg-supported audio inputs are
  decoded to a temporary WAV before rendering (requires ffmpeg on PATH).

Segment options:
  --start <seconds>     Crop the input segment before stretching (default: 0)
  --end <seconds>       Crop endpoint (default: full file)
  --loops <count>       Repeat the selected segment before stretching (default: 1)
  --output <path>       Alternative to the positional output path

Upstream options:
  --stretch <ratio>     Stretch ratio (default: 8)
  --fft-size <size>     FFT size (default: 4096)
  --window <type>       rectangular|hamming|hann|blackman|blackman-harris
  --onset <0-1>          Onset detection sensitivity
  --help                 Show this help

Additional upstream spectral and binaural options are passed through unchanged.
`);
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function numberValue(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${option} expects a number.`);
  return number;
}

function cropAndLoop(audio: PcmAudio, start: number, end: number, loops: number): PcmAudio {
  const startFrame = Math.floor(start * audio.sampleRate);
  const endFrame = Math.ceil(end * audio.sampleRate);
  const frameCount = Math.max(1, endFrame - startFrame);
  const samples = new Float32Array(frameCount * loops * audio.channels);
  const selected = audio.samples.subarray(
    startFrame * audio.channels,
    endFrame * audio.channels,
  );
  for (let loop = 0; loop < loops; loop += 1) {
    samples.set(selected, loop * selected.length);
  }
  return { ...audio, samples };
}

function nativeBinary(): string {
  const configured = process.env.SOUUNNDS_NATIVE;
  const defaultName = process.platform === "win32" ? "paulstretch.exe" : "paulstretch";
  const binary = configured ?? resolve(ROOT, "vendor/libpaulstretch/build-native", defaultName);
  if (!existsSync(binary)) {
    throw new Error(`Native Paulstretch renderer not found at ${binary}. Run npm run build:core first.`);
  }
  return binary;
}

function runProcess(command: string, args: string[], label: string): Promise<void> {
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", () => reject(new Error(`${label} is required and was not found on PATH.`)));
  child.on("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`${label} exited with ${code ?? `signal ${signal}`}.`));
  });
  return promise;
}

function runNative(binary: string, args: string[]): Promise<void> {
  return runProcess(binary, args, "Native Paulstretch renderer");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    printHelp();
    return;
  }

  let inputPath = "";
  let outputPath = "";
  let start = 0;
  let end = Number.POSITIVE_INFINITY;
  let loops = 1;
  const nativeArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      outputPath = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--start" || arg === "--end" || arg === "--loops") {
      const value = requiredValue(args, index, arg);
      const parsed = numberValue(value, arg);
      if (arg === "--start") start = parsed;
      if (arg === "--end") end = parsed;
      if (arg === "--loops") loops = parsed;
      index += 1;
    } else if (arg === "--filter-stop") {
      nativeArgs.push(arg);
    } else if (PASSTHROUGH_OPTIONS[arg]) {
      nativeArgs.push(arg, requiredValue(args, index, arg));
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option '${arg}'.`);
    } else if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    } else {
      throw new Error(`Unexpected argument '${arg}'.`);
    }
  }

  if (!inputPath) throw new Error("An input audio path is required.");
  if (!outputPath) outputPath = `${basename(inputPath, extname(inputPath))}-stretched.wav`;
  if (!Number.isInteger(loops) || loops < 1) throw new Error("--loops must be a positive integer.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "souunnds-"));
  try {
    let decodedInput = resolve(inputPath);
    if (extname(inputPath).toLowerCase() !== ".wav") {
      decodedInput = join(temporaryDirectory, "decoded.wav");
      await runProcess("ffmpeg", ["-y", "-i", resolve(inputPath), "-vn", "-acodec", "pcm_f32le", decodedInput], "ffmpeg");
    }
    const input = decodeWav(await readFile(decodedInput));
    const duration = input.samples.length / input.channels / input.sampleRate;
    const selectedEnd = Number.isFinite(end) ? end : duration;
    if (start < 0 || selectedEnd <= start || selectedEnd > duration) {
      throw new Error(`Segment must fit inside the ${duration.toFixed(2)}s input.`);
    }

    const needsPreparedInput = start !== 0 || selectedEnd !== duration || loops !== 1;
    const preparedInput = needsPreparedInput ? join(temporaryDirectory, "segment.wav") : decodedInput;
    if (needsPreparedInput) {
      await writeFile(preparedInput, encodeWav(cropAndLoop(input, start, selectedEnd, loops)));
    }
    await runNative(nativeBinary(), [...nativeArgs, preparedInput, resolve(outputPath)]);
    console.log(`Rendered with upstream libpaulstretch → ${resolve(outputPath)}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
