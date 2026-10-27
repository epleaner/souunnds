import { createServer } from "node:http";
import { AudioRequestError, extractAudio, videoUrl } from "./youtube-audio.mjs";

createServer(async (request, response) => {
  if (request.url === "/health" && request.method === "GET") {
    response.writeHead(204).end();
    return;
  }
  if (request.url !== "/api/youtube/audio" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const controller = new AbortController();
  const disconnect = () => { if (!response.writableEnded) controller.abort(); };
  response.on("close", disconnect);
  try {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json"))
      throw new AudioRequestError(415, "Expected JSON request");
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2048) throw new AudioRequestError(413, "Request is too large");
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new AudioRequestError(400, "Invalid JSON"); }
    const url = videoUrl(body?.url);
    if (!url) throw new AudioRequestError(400, "Enter a valid YouTube video URL");
    const { audio, title } = await extractAudio(url, controller.signal);
    if (!response.destroyed) response.writeHead(200, {
      "Cache-Control": "no-store", "Content-Type": "audio/wav",
      "X-Source-Title": encodeURIComponent(title), "Content-Length": audio.length,
    }).end(audio);
  } catch (error) {
    if (!response.destroyed) {
      const status = error instanceof AudioRequestError && error.status !== 499 ? error.status : 500;
      response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: error instanceof AudioRequestError ? error.message : "Audio extraction failed" }));
    }
  } finally { response.off("close", disconnect); }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0", () => console.log("media ready"));
