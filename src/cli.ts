import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  DEFAULT_PARAMS,
  decodeWav,
  encodeWav,
  stretchPcm,
  type Segment,
  type StretchParams,
} from "./shared/audio.js";

function numberOption(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} expects a number.`);
  return value;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function printHelp(): void {
  console.log(`tunestretch — Paulstretch-style local audio processor

Usage:
  npm run cli -- input.wav [options]

Options:
  --output <path>       Output WAV path (default: <input>-stretched.wav)
  --start <seconds>     Segment start (default: 0)
  --end <seconds>       Segment end (default: full file)
  --stretch <factor>    Stretch factor (default: 8)
  --loops <count>       Segment loop count (default: 1)
  --window <seconds>    Grain window size (default: 0.25)
  --overlap <ratio>     Grain overlap from 0 to 0.95 (default: 0.75)
  --seed <integer>      Deterministic grain seed (default: 11)
  --help                Show this help
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    printHelp();
    return;
  }

  const inputPath = args.find((value) => !value.startsWith("--"));
  if (!inputPath) throw new Error("An input WAV path is required.");
  const input = decodeWav(await readFile(resolve(inputPath)));
  const duration = input.samples.length / input.channels / input.sampleRate;
  const start = numberOption(args, "--start", 0);
  const end = numberOption(args, "--end", duration);
  const params: StretchParams = {
    ...DEFAULT_PARAMS,
    stretch: numberOption(args, "--stretch", DEFAULT_PARAMS.stretch),
    loops: numberOption(args, "--loops", DEFAULT_PARAMS.loops),
    windowSeconds: numberOption(args, "--window", DEFAULT_PARAMS.windowSeconds),
    overlap: numberOption(args, "--overlap", DEFAULT_PARAMS.overlap),
    seed: numberOption(args, "--seed", DEFAULT_PARAMS.seed),
  };
  const segment: Segment = { start, end };
  const output = stretchPcm(input, segment, params);
  const defaultName = `${basename(inputPath, ".wav")}-stretched.wav`;
  const outputPath = resolve(option(args, "--output") ?? defaultName);
  await writeFile(outputPath, encodeWav(output));
  console.log(`Wrote ${outputPath}`);
  console.log(`Input ${duration.toFixed(2)}s → output ${(output.samples.length / output.channels / output.sampleRate).toFixed(2)}s`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
