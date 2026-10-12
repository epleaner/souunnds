# souunnds

Build with `npm ci && npm run build`, then run `npm start` (serves the built app on `PORT`, default 4173). For Vite development, run the Node server on port 4173 alongside `npx vite`; `/api` requests are proxied to the Node server.

## Shareable projects

The **Share** action stores the workspace manifest in PostgreSQL configured by `DATABASE_URL`; the server creates its `share_projects` and `share_project_assets` tables on startup. Without a database, the local studio remains usable and project-sharing requests return `503`.

The share URL is read-only and publicly readable by anyone who has it. The edit capability is kept in the creator's browser storage and is never placed in the URL; losing that browser capability means the project cannot be edited or forked by its creator. Recipients can **Fork to edit**, creating a separately owned project.

Local audio inclusion is optional and requires checking **Include local audio** before sharing or forking. WAV and MP3 files are uploaded by a size-constrained presigned form POST to a private Railway Bucket (maximum 25 MiB per file); uploaded content is verified before the project references it. If omitted, the project keeps its source rows and arrangement but prompts recipients to relink audio. YouTube URLs are preserved and refetched on a best-effort basis. Removed audio is deleted; abandoned, unreferenced uploads expire after 24 hours.

Audio storage requires `RAILWAY_BUCKET_ENDPOINT`, `RAILWAY_BUCKET_NAME`, `RAILWAY_BUCKET_ACCESS_KEY_ID`, and `RAILWAY_BUCKET_SECRET_ACCESS_KEY`; `RAILWAY_BUCKET_REGION` defaults to `us-east-1`, and `RAILWAY_BUCKET_PATH_STYLE` defaults to `false` for current Railway buckets. Use the actual S3 bucket name (`BUCKET` in Railway's bucket variables), not its display name. Configure bucket CORS to allow `GET` and `POST` from the app origin before browser audio uploads/downloads. For example, with `aws` CLI credentials in the environment:

```sh
aws s3api put-bucket-cors \\
  --bucket "$RAILWAY_BUCKET_NAME" \\
  --endpoint-url "$RAILWAY_BUCKET_ENDPOINT" \\
  --cors-configuration '{"CORSRules":[{"AllowedHeaders":["*"],"AllowedMethods":["GET","POST"],"AllowedOrigins":["https://your-app.example"],"MaxAgeSeconds":3000}]}'
```

Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the bucket credentials for this command. Include each deployed app origin and any local development origin that needs direct bucket access.
## Audio sources

Each source's **Choose audio** menu accepts a local file or a YouTube video URL. YouTube imports require `yt-dlp` and `ffmpeg` installed on the **server** and available on its `PATH`. The server accepts individual videos with a direct HTTPS audio format, pipes `yt-dlp` into `ffmpeg`, and sends a bounded WAV response without writing the downloaded audio or cache to disk. Fragmented-only videos are rejected rather than downloaded to temporary files; imports may also fail if a video is unavailable or YouTube restricts server access. The browser keeps YouTube audio in memory for the current visit only; replacing a saved local source removes its old IndexedDB copy. Local file imports retain their existing browser-storage behavior.

A source with a cached local audio file shows a **Restore** action in its row. It reloads that file without changing an edited source name, including after automatic restoration on page load. Uncached and YouTube sources do not show the action.

The downloader uses yt-dlp's `web_embedded` client with Node as its JavaScript challenge runtime. This supports embeddable videos with direct HTTPS audio; videos that disallow embedding, expose only fragmented streams, or restrict server access remain unavailable.

Successful YouTube imports name the source after the video's title; you can still rename it.

Clicking the YouTube URL field keeps the same unobtrusive border as the menu buttons. Keyboard tabbing shows the accent focus ring on both controls.

## Pitch controls

Each layer has a **Pitch** control from −12 to +12 semitones. Each sequence clip has a matching control whose value is added to the layer's pitch setting; nested sequence clips accumulate their offsets. Pitch changes preserve clip duration, and both settings are saved with the project.

## Sequence generator

**Generate sequences** retains Rows and Columns (two seconds per column). **Density** fills fewer or more column slots: Sparse fills about a quarter, Balanced about five eighths, and Dense fills all; every row gets at least one clip. **Clip duration** controls each clip's span within its slot from Short (0.25–0.75 s) to Long (1.25–1.75 s).
