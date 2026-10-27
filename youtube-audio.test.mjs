import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";

const children = [];
const directories = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
  }
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
}

async function startServer(mode = "success") {
  const dir = await mkdtemp(join(tmpdir(), "youtube-audio-test-"));
  directories.push(dir);
  const downloader = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.CALL_MARKER, String(process.pid));
if (process.env.MODE !== 'missing-title') process.stderr.write('__TUNESTRETCH_TITLE__"Björk — 夏"\\n');
if (process.env.MODE === 'hang') setInterval(() => {}, 1000);
else process.stdout.write('encoded-audio');
`;
  const converter = `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => input += chunk.toString());
process.stdin.on('end', () => {
  if (input !== 'encoded-audio') process.exit(2);
  const pcm = Buffer.from([0, 0, 255, 127]);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(0xffffffff, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(0xffffffff, 40);
  pcm.copy(wav, 44);
  process.stdout.write(wav, () => {
    if (process.env.MODE === 'fail') process.exit(1);
  });
});
`;
  await Promise.all([
    writeFile(join(dir, "yt-dlp"), downloader),
    writeFile(join(dir, "ffmpeg"), converter),
  ]);
  await Promise.all([chmod(join(dir, "yt-dlp"), 0o755), chmod(join(dir, "ffmpeg"), 0o755)]);
  const port = await freePort();
  const child = spawn(process.execPath, [new URL("./media-server.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), PATH: `${dir}:${process.env.PATH}`, CALL_MARKER: join(dir, "called"), MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "close").then(() => { throw new Error("Server exited before listening"); }),
  ]);
  return { port, dir };
}

function request(port, url) {
  return fetch(`http://127.0.0.1:${port}/api/youtube/audio`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

it("rejects invalid and non-video URLs without launching any subprocess", async () => {
  const { port, dir } = await startServer();
  for (const url of ["https://youtube.com/playlist?list=PLabc", "https://youtube.com.evil.test/watch?v=abcdefghijk", "http://localhost/watch?v=abcdefghijk"]) {
    const response = await request(port, url);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).error).toMatch(/YouTube video URL/);
  }
  await expect(readFile(join(dir, "called"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("pipes downloader output into converter and returns finalized decodable WAV", async () => {
  const { port } = await startServer();
  const response = await request(port, "https://youtu.be/abcdefghijk");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/wav");
  expect(decodeURIComponent(response.headers.get("x-source-title"))).toBe("Björk — 夏");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const wav = Buffer.from(await response.arrayBuffer());
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  expect(wav.readInt16LE(46)).toBe(32767);
});

it("rejects a completed download without a video title", async () => {
  const { port } = await startServer("missing-title");
  const response = await request(port, "https://www.youtube.com/watch?v=abcdefghijk");
  expect(response.status).toBe(502);
  expect(response.headers.get("x-source-title")).toBeNull();
  expect(await response.json()).toEqual({ error: "Could not read video title" });
});

it("returns only JSON if conversion fails after writing WAV output", async () => {
  const { port } = await startServer("fail");
  const response = await request(port, "https://www.youtube.com/watch?v=abcdefghijk");
  expect(response.status).toBe(502);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: "Could not convert audio" });
});

it("terminates extraction processes when the client disconnects", async () => {
  const { port, dir } = await startServer("hang");
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/api/youtube/audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://youtu.be/abcdefghijk" }),
    signal: controller.signal,
  });
  const marker = join(dir, "called");
  await expect.poll(async () => {
    try { return Number(await readFile(marker, "utf8")); }
    catch { return 0; }
  }, { timeout: 5000 }).toBeGreaterThan(0);
  const pid = Number(await readFile(marker, "utf8"));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await expect.poll(() => {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }, { timeout: 5000 }).toBe(false);
}, 12000);
