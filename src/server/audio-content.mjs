export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_AUDIO_CONTENT_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave"]);

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
        format = { code: signature.readUInt16LE(body), channels: signature.readUInt16LE(body + 2),
          rate: signature.readUInt32LE(body + 4), byteRate: signature.readUInt32LE(body + 8),
          blockAlign: signature.readUInt16LE(body + 12), bits: signature.readUInt16LE(body + 14) };
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
    return (format.code === 1 || format.code === 3) && format.channels >= 1 && format.channels <= 8
      && format.rate >= 8000 && format.rate <= 192000 && [8, 16, 24, 32].includes(format.bits)
      && format.blockAlign === format.channels * bytesPerSample
      && format.byteRate === format.rate * format.blockAlign && dataSize % format.blockAlign === 0;
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
