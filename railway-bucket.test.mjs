import { expect, it } from "vitest";
import { isValidAudioContent, RailwayBucket, audioAssetLimits } from "./src/server/railway-bucket.mjs";

const awsVector = {
  endpoint: "https://s3.amazonaws.com",
  bucket: "examplebucket",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  now: () => new Date("2013-05-24T00:00:00.000Z"),
  pathStyle: false,
};

function wavFixture() {
  const wav = Buffer.alloc(48);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(4, 40);
  return wav;
}

it("matches the AWS Signature V4 presigned URL example", () => {
  const signed = new RailwayBucket(awsVector).presignGet("test.txt", 86400);
  expect(signed.url).toBe("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});

it("signs an exact-size presigned POST policy for one staging key and audio type", () => {
  const bucket = new RailwayBucket({ ...awsVector, now: () => new Date("2026-10-11T12:00:00.000Z") });
  const signed = bucket.presignPost("project-1/asset_2.upload", "audio/wav", 48);
  const policy = JSON.parse(Buffer.from(signed.fields.policy, "base64").toString("utf8"));
  expect(signed.url).toBe("https://examplebucket.s3.amazonaws.com/");
  expect(signed.expiresIn).toBe(300);
  expect(policy.expiration).toBe("2026-10-11T12:05:00.000Z");
  expect(policy.conditions).toContainEqual(["content-length-range", 48, 48]);
  expect(policy.conditions).toContainEqual({ bucket: "examplebucket" });
  expect(policy.conditions).toContainEqual({ key: "project-1/asset_2.upload" });
  expect(policy.conditions).toContainEqual({ "Content-Type": "audio/wav" });
  expect(policy.conditions).toContainEqual({ "x-amz-credential": signed.fields["x-amz-credential"] });
  expect(signed.fields["x-amz-signature"]).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(signed)).not.toContain(awsVector.secretAccessKey);
  const maxPolicy = JSON.parse(Buffer.from(bucket.presignPost("project/max.upload", "audio/mpeg", audioAssetLimits.maxBytes).fields.policy, "base64"));
  expect(maxPolicy.conditions).toContainEqual(["content-length-range", audioAssetLimits.maxBytes, audioAssetLimits.maxBytes]);
  expect(() => bucket.presignPost("key", "audio/wav", audioAssetLimits.maxBytes + 1)).toThrow(/size/);
  expect(() => bucket.presignPost("key", "text/html", 48)).toThrow(/type/);
  expect(() => bucket.presignPost("key", "audio/wav", 48, 301)).toThrow(/expiry/);
  expect(() => bucket.presignGet("project-1/asset_2", 604801)).toThrow(/expiry/);
});

it("validates bounded WAV and MP3 content signatures rather than trusting MIME alone", () => {
  expect(audioAssetLimits.maxBytes).toBe(25 * 1024 * 1024);
  const wav = wavFixture();
  expect(isValidAudioContent("audio/wav", wav, wav.length)).toBe(true);
  expect(isValidAudioContent("audio/wav", Buffer.from("RIFFxxxxWAVE"), 12)).toBe(false);
  expect(isValidAudioContent("audio/wav", wav, wav.length + 4)).toBe(false);
  expect(isValidAudioContent("audio/mpeg", Buffer.from([0xff, 0xfb, 0x90, 0x64]), 4)).toBe(true);
  expect(isValidAudioContent("audio/mpeg", Buffer.from("<html>"), 6)).toBe(false);
  expect(isValidAudioContent("image/png", wav, wav.length)).toBe(false);
});

it("rejects sparse and ordinary ID3-only payloads without a following MPEG frame", () => {
  const header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 4]);
  const metadata = Buffer.concat([header, Buffer.alloc(4)]);
  expect(isValidAudioContent("audio/mpeg", metadata, metadata.length)).toBe(false);
  const sparse = Buffer.alloc(70000);
  sparse.set(Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 4, 0x22, 0x60]));
  expect(isValidAudioContent("audio/mpeg", sparse.subarray(0, 65536), sparse.length)).toBe(false);
  expect(isValidAudioContent("audio/mpeg", sparse, sparse.length)).toBe(false);
  expect(isValidAudioContent("audio/mpeg", Buffer.concat([metadata, Buffer.from([0xff, 0xfb, 0x90, 0x64])]), 18)).toBe(true);
});

it("reads only the declared object size and signs server-owned publication bytes", async () => {
  const wav = wavFixture();
  const calls = [];
  const bucket = new RailwayBucket({
    ...awsVector,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options });
      if (options.method === "GET") return new Response(wav, { headers: { "Content-Length": String(wav.length), "Content-Type": "audio/wav" } });
      return new Response(null, { status: 200 });
    },
  });
  const read = await bucket.readObject("project/staging.upload", wav.length);
  expect(read).toEqual({ size: wav.length, contentType: "audio/wav", bytes: wav });
  await bucket.publishObject("project/published", read.bytes, "audio/wav");
  expect(calls[1].url).toBe("https://examplebucket.s3.amazonaws.com/project/published");
  expect(calls[1].body).toEqual(wav);
  expect(calls[1].headers.Authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
  expect(calls[1].headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  const oversized = new RailwayBucket({
    ...awsVector,
    fetchImpl: async () => new Response(Buffer.alloc(wav.length + 1), {
      headers: { "Content-Length": String(wav.length), "Content-Type": "audio/wav" },
    }),
  });
  await expect(oversized.readObject("project/staging.upload", wav.length)).rejects.toThrow(/exceeds/);
});

it("requires HTTPS bucket endpoints outside local emulator hosts", () => {
  expect(() => new RailwayBucket({ ...awsVector, endpoint: "http://storage.example.com" })).toThrow(/HTTPS/);
  expect(() => new RailwayBucket({ ...awsVector, endpoint: "https://user:pass@storage.example.com" })).toThrow(/credentials/);
});
