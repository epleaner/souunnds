import { createHash, createHmac } from "node:crypto";
export const SUPPORTED_AUDIO_CONTENT_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave"]);

const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const PRESIGN_TTL_SECONDS = 300;

function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(secret, date, region) {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}
function invalidObject(message) {
  return Object.assign(new Error(message), { invalidUpload: true });
}


function canonicalPath(endpoint, bucket, key, pathStyle) {
  const encodedKey = key.split("/").map(uriEncode).join("/");
  const encodedBucket = uriEncode(bucket);
  return pathStyle
    ? `${endpoint.pathname.replace(/\/$/, "")}/${encodedBucket}/${encodedKey}`
    : `${endpoint.pathname.replace(/\/$/, "")}/${encodedKey}`;
}

function canonicalQuery(entries) {
  return entries
    .map(([key, value]) => [uriEncode(key), uriEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalHeaderLines(headers) {
  const sorted = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, " ")])
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    lines: sorted.map(([name, value]) => `${name}:${value}\n`).join(""),
    names: sorted.map(([name]) => name).join(";"),
  };
}

function requestSignature({ method, path, query, headers, payloadHash, accessKey, secretKey, region, timestamp }) {
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const canonical = [method, path, query, headers.lines, headers.names, payloadHash].join("\n");
  const stringToSign = [ALGORITHM, timestamp, scope, sha256(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(secretKey, date, region)).update(stringToSign).digest("hex");
  return { signature, scope, signedHeaders: headers.names };
}

export class RailwayBucket {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region, fetchImpl = fetch, now = () => new Date(), pathStyle = false }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("Railway Bucket configuration is incomplete");
    this.endpoint = new URL(endpoint);
    if (this.endpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(this.endpoint.hostname)) {
      throw new Error("Railway Bucket endpoint must use HTTPS");
    }
    if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) {
      throw new Error("Railway Bucket endpoint must not contain credentials or query parameters");
    }
    this.endpoint.pathname = this.endpoint.pathname.replace(/\/$/, "");
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region || "us-east-1";
    this.fetch = fetchImpl;
    this.now = now;
    this.pathStyle = pathStyle;
  }

  presignPost(key, contentType, size, expiresIn = PRESIGN_TTL_SECONDS) {
    if (!Number.isSafeInteger(size) || size < 1 || size > audioAssetLimits.maxBytes) throw new Error("Invalid upload size");
    if (!SUPPORTED_AUDIO_CONTENT_TYPES.has(contentType)) throw new Error("Invalid audio content type");
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > PRESIGN_TTL_SECONDS) throw new Error("Invalid upload expiry");
    const target = this.#target(key);
    const instant = this.now();
    const timestamp = instant.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const scope = `${timestamp.slice(0, 8)}/${this.region}/s3/aws4_request`;
    const credential = `${this.accessKeyId}/${scope}`;
    const fields = {
      key,
      "Content-Type": contentType,
      "x-amz-algorithm": ALGORITHM,
      "x-amz-credential": credential,
      "x-amz-date": timestamp,
    };
    const policy = {
      expiration: new Date(instant.getTime() + expiresIn * 1000).toISOString(),
      conditions: [
        { bucket: this.bucket },
        ...Object.entries(fields).map(([name, value]) => ({ [name]: value })),
        ["content-length-range", size, size],
      ],
    };
    fields.policy = Buffer.from(JSON.stringify(policy)).toString("base64");
    fields["x-amz-signature"] = createHmac("sha256", signingKey(this.secretAccessKey, timestamp.slice(0, 8), this.region))
      .update(fields.policy).digest("hex");
    target.pathname = this.pathStyle
      ? `${this.endpoint.pathname}/${uriEncode(this.bucket)}`
      : this.endpoint.pathname || "/";
    return { url: target.toString(), fields, expiresIn };
  }


  presignGet(key, expiresIn = PRESIGN_TTL_SECONDS) {
    return this.#presign("GET", key, { expiresIn });
  }

  async readObject(key, expectedSize) {
    const response = await this.#request("GET", key);
    if (!response.ok) throw new Error(`Bucket read failed (${response.status})`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
    const declaredSize = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > audioAssetLimits.maxBytes
      || declaredSize !== expectedSize || !SUPPORTED_AUDIO_CONTENT_TYPES.has(contentType)) {
      throw invalidObject("Bucket content metadata does not match declared audio");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Bucket content response has no body");
    const bytes = Buffer.allocUnsafe(expectedSize);
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > expectedSize) throw invalidObject("Bucket content exceeds declared size");
        bytes.set(value, size);
        size += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (size !== expectedSize) throw invalidObject("Bucket content is incomplete");
    return { contentType, size, bytes };
  }

  async publishObject(key, bytes, contentType) {
    const response = await this.#request("PUT", key, { "Content-Type": contentType }, bytes);
    if (!response.ok) throw new Error(`Bucket publication failed (${response.status})`);
  }


  async deleteObject(key) {
    const response = await this.#request("DELETE", key);
    if (!response.ok && response.status !== 404) throw new Error(`Bucket object deletion failed (${response.status})`);
  }

  #target(key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(key)
      || key.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("Invalid object key");
    }
    const target = new URL(this.endpoint);
    if (!this.pathStyle) target.hostname = `${this.bucket}.${target.hostname}`;
    target.pathname = canonicalPath(this.endpoint, this.bucket, key, this.pathStyle);
    return target;
  }

  #presign(method, key, { contentType, expiresIn = PRESIGN_TTL_SECONDS } = {}) {
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) throw new Error("Invalid presigned URL expiry");
    const target = this.#target(key);
    const instant = this.now();
    const timestamp = instant.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = timestamp.slice(0, 8);
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const headers = { host: target.host };
    if (contentType) headers["content-type"] = contentType;
    const signed = canonicalHeaderLines(headers);
    const params = [
      ["X-Amz-Algorithm", ALGORITHM],
      ["X-Amz-Credential", `${this.accessKeyId}/${scope}`],
      ["X-Amz-Date", timestamp],
      ["X-Amz-Expires", String(expiresIn)],
      ["X-Amz-SignedHeaders", signed.names],
    ];
    const query = canonicalQuery(params);
    const { signature } = requestSignature({
      method,
      path: target.pathname,
      query,
      headers: signed,
      payloadHash: "UNSIGNED-PAYLOAD",
      accessKey: this.accessKeyId,
      secretKey: this.secretAccessKey,
      region: this.region,
      timestamp,
    });
    target.search = `${query}&X-Amz-Signature=${signature}`;
    return { url: target.toString(), headers: contentType ? { "Content-Type": contentType } : {}, expiresIn };
  }

  async #request(method, key, extraHeaders = {}, body) {
    const target = this.#target(key);
    const timestamp = this.now().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const payloadHash = body ? sha256(body) : EMPTY_SHA256;
    const headers = {
      host: target.host,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), value])),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
    };
    const signed = canonicalHeaderLines(headers);
    const { signature, scope } = requestSignature({
      method,
      path: target.pathname,
      query: "",
      headers: signed,
      payloadHash,
      accessKey: this.accessKeyId,
      secretKey: this.secretAccessKey,
      region: this.region,
      timestamp,
    });
    const authorization = `${ALGORITHM} Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signed.names}, Signature=${signature}`;
    const requestHeaders = { ...extraHeaders, "x-amz-content-sha256": payloadHash, "x-amz-date": timestamp, Authorization: authorization };
    return this.fetch(target, { method, headers: requestHeaders, body, redirect: "error" });
  }
}

export const audioAssetLimits = Object.freeze({ maxBytes: 25 * 1024 * 1024 });

export function isValidAudioContent(contentType, signature, size) {
  if (contentType === "audio/wav" || contentType === "audio/x-wav" || contentType === "audio/wave") {
    if (signature.length < 44 || signature.toString("ascii", 0, 4) !== "RIFF"
      || signature.toString("ascii", 8, 12) !== "WAVE" || signature.readUInt32LE(4) + 8 !== size) return false;
    let format = null;
    let dataSize = 0;
    let dataOffset = 0;
    for (let offset = 12; offset + 8 <= signature.length;) {
      const chunkName = signature.toString("ascii", offset, offset + 4);
      const chunkSize = signature.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (chunkName === "fmt ") {
        if (chunkSize < 16 || body + 16 > signature.length) return false;
        format = {
          code: signature.readUInt16LE(body),
          channels: signature.readUInt16LE(body + 2),
          rate: signature.readUInt32LE(body + 4),
          byteRate: signature.readUInt32LE(body + 8),
          blockAlign: signature.readUInt16LE(body + 12),
          bits: signature.readUInt16LE(body + 14),
        };
      } else if (chunkName === "data") {
        dataSize = chunkSize;
        dataOffset = body;
        break;
      }
      const next = body + chunkSize + (chunkSize & 1);
      if (next <= offset || next > size || next > signature.length) break;
      offset = next;
    }
    if (!format || dataSize < 1 || dataOffset + dataSize > size) return false;
    const bytesPerSample = Math.ceil(format.bits / 8);
    return (format.code === 1 || format.code === 3)
      && format.channels >= 1 && format.channels <= 8
      && format.rate >= 8000 && format.rate <= 192000
      && [8, 16, 24, 32].includes(format.bits)
      && format.blockAlign === format.channels * bytesPerSample
      && format.byteRate === format.rate * format.blockAlign
      && dataSize % format.blockAlign === 0;
  }
  if (contentType === "audio/mpeg") {
    if (signature.length < 4 || size < 4) return false;
    let offset = 0;
    if (signature.length >= 10 && signature.toString("ascii", 0, 3) === "ID3") {
      const version = signature[3];
      if (version < 2 || version > 4 || [6, 7, 8, 9].some((index) => signature[index] >= 0x80)) return false;
      const tagLength = ((signature[6] & 0x7f) << 21) | ((signature[7] & 0x7f) << 14)
        | ((signature[8] & 0x7f) << 7) | (signature[9] & 0x7f);
      offset = 10 + tagLength + (version === 4 && (signature[5] & 0x10) ? 10 : 0);
    }
    if (offset + 4 > size || offset + 4 > signature.length) return false;
    const version = (signature[offset + 1] >> 3) & 0x03;
    const layer = (signature[offset + 1] >> 1) & 0x03;
    const bitrate = (signature[offset + 2] >> 4) & 0x0f;
    const sampleRate = (signature[offset + 2] >> 2) & 0x03;
    return signature[offset] === 0xff && (signature[offset + 1] & 0xe0) === 0xe0
      && version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 0x0f && sampleRate !== 3;
  }
  return false;
}
