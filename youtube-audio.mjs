import { spawn } from "node:child_process";

const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 90_000;
const MAX_ACTIVE = 2;
let active = 0;

export class AudioRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function videoUrl(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  let id;
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    if (parsed.pathname === "/watch") id = parsed.searchParams.get("v");
    else id = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1];
  } else if (["youtu.be", "www.youtu.be"].includes(host)) {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1];
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id || "")
    ? `https://www.youtube.com/watch?v=${id}`
    : null;
}

// WAV streamed to stdout has unknown RIFF/data lengths. Replace them after the
// bounded in-memory capture so browser decoders receive an ordinary WAV file.
function finalizeWav(chunks, length) {
  const wav = Buffer.concat(chunks, length);
  if (length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new AudioRequestError(502, "Audio conversion failed");
  }
  let offset = 12;
  let dataOffset = -1;
  while (offset + 8 <= length) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString("ascii", offset, offset + 4) === "data") {
      dataOffset = offset;
      break;
    }
    const next = offset + 8 + size + (size & 1);
    if (next > length || next <= offset) break;
    offset = next;
  }
  if (dataOffset < 0 || dataOffset + 8 >= length) {
    throw new AudioRequestError(502, "Audio conversion failed");
  }
  wav.writeUInt32LE(length - 8, 4);
  wav.writeUInt32LE(length - dataOffset - 8, dataOffset + 4);
  return wav;
}

export async function extractAudio(url, signal) {
  if (active >= MAX_ACTIVE) throw new AudioRequestError(503, "Audio service is busy; try again later");
  active++;
  try {
    return await runConversion(url, signal);
  } finally {
    active--;
  }
}

function runConversion(url, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AudioRequestError(499, "Request cancelled"));
      return;
    }
    const downloader = spawn("yt-dlp", [
      "--no-config", "--no-cache-dir", "--no-playlist", "--quiet", "--no-warnings",
      // Fragmented streams write temporary -FragN files even with "-o -"; only direct HTTPS uses stdout.
      "-f", "bestaudio[protocol=https]", "-o", "-", url,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    const converter = spawn("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vn", "-map_metadata", "-1", "-bitexact",
      "-f", "wav", "-acodec", "pcm_s16le", "-ac", "2", "-ar", "44100", "pipe:1",
    ], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    let length = 0;
    let downloaderClosed = false;
    let converterClosed = false;
    let settled = false;
    const stop = () => {
      downloader.kill("SIGKILL");
      converter.kill("SIGKILL");
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        stop();
        reject(error);
      } else {
        try {
          resolve(finalizeWav(chunks, length));
        } catch (cause) {
          reject(cause);
        }
      }
    };
    const abort = () => finish(new AudioRequestError(499, "Request cancelled"));
    const timer = setTimeout(() => finish(new AudioRequestError(504, "Audio extraction timed out")), TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    downloader.stdout.pipe(converter.stdin);
    for (const stream of [downloader.stdout, converter.stdin, converter.stdout]) {
      stream.on("error", () => finish(new AudioRequestError(502, "Audio conversion failed")));
    }
    converter.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_AUDIO_BYTES) finish(new AudioRequestError(413, "Audio is too large"));
      else chunks.push(chunk);
    });
    downloader.on("error", () => finish(new AudioRequestError(503, "yt-dlp is unavailable")));
    converter.on("error", () => finish(new AudioRequestError(503, "ffmpeg is unavailable")));
    downloader.on("close", (code) => {
      downloaderClosed = true;
      if (code !== 0) finish(new AudioRequestError(502, "Could not download audio"));
      else if (converterClosed) finish();
    });
    converter.on("close", (code) => {
      converterClosed = true;
      if (code !== 0) finish(new AudioRequestError(502, "Could not convert audio"));
      else if (downloaderClosed) finish();
    });
  });
}
