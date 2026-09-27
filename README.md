# souunnds

Build with `npm ci && npm run build`, then run `npm start` (serves the built app on `PORT`, default 4173). For Vite development, run the Node server on port 4173 alongside `npx vite`; `/api` requests are proxied to the Node server.

## Audio sources

Each source's **Choose audio** menu accepts a local file or a YouTube video URL. YouTube imports require `yt-dlp` and `ffmpeg` installed on the **server** and available on its `PATH`. The server accepts individual videos with a direct HTTPS audio format, pipes `yt-dlp` into `ffmpeg`, and sends a bounded WAV response without writing the downloaded audio or cache to disk. Fragmented-only videos are rejected rather than downloaded to temporary files; imports may also fail if a video is unavailable or YouTube restricts server access. The browser keeps YouTube audio in memory for the current visit only; replacing a saved local source removes its old IndexedDB copy. Local file imports retain their existing browser-storage behavior.
