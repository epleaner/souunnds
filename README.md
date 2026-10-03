# souunnds

Build with `npm ci && npm run build`, then run `npm start` (serves the built app on `PORT`, default 4173). For Vite development, run the Node server on port 4173 alongside `npx vite`; `/api` requests are proxied to the Node server.

## Audio sources

Each source's **Choose audio** menu accepts a local file or a YouTube video URL. YouTube imports require `yt-dlp` and `ffmpeg` installed on the **server** and available on its `PATH`. The server accepts individual videos with a direct HTTPS audio format, pipes `yt-dlp` into `ffmpeg`, and sends a bounded WAV response without writing the downloaded audio or cache to disk. Fragmented-only videos are rejected rather than downloaded to temporary files; imports may also fail if a video is unavailable or YouTube restricts server access. The browser keeps YouTube audio in memory for the current visit only; replacing a saved local source removes its old IndexedDB copy. Local file imports retain their existing browser-storage behavior.

A source with a cached local audio file shows a **Restore** action in its row. It reloads that file without changing an edited source name, including after automatic restoration on page load. Uncached and YouTube sources do not show the action.

The downloader uses yt-dlp's `web_embedded` client with Node as its JavaScript challenge runtime. This supports embeddable videos with direct HTTPS audio; videos that disallow embedding, expose only fragmented streams, or restrict server access remain unavailable.

Successful YouTube imports name the source after the video's title; you can still rename it.

Clicking the YouTube URL field keeps the same unobtrusive border as the menu buttons. Keyboard tabbing shows the accent focus ring on both controls.

## Sequence generator

**Generate sequences** retains Rows and Columns (two seconds per column). **Density** fills fewer or more column slots: Sparse fills about a quarter, Balanced about five eighths, and Dense fills all; every row gets at least one clip. **Clip duration** controls each clip's span within its slot from Short (0.25–0.75 s) to Long (1.25–1.75 s).
