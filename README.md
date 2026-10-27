# souunnds

Install from the repository root with `npm ci` using Node 24.22.0 (the
repository's `.npmrc` selects npm's linked install strategy so each Cloudflare
workspace has a local Wrangler delegate, while `package-lock.json` remains
the single authoritative lockfile). Build the
native core with CMake (`npm run build:core`), SIMD and non-SIMD WASM with
Emscripten 6.0.13 (`npm run build:wasm`), then the Vite client (`npm run build`);
`npm run build:all` runs those steps in order. The independent Cloudflare
workspaces in `config/production` and `config/preview` share that compiled
client. Use `npm run build:cloudflare:production` or
`npm run build:cloudflare:preview` for a complete local build. To deploy,
use `npm run deploy:production` or `npm run deploy:preview` (builds source
and then deploys that environment's prebuilt Worker), with Docker running
for its linux/amd64 media image. The manually dispatched CI job reuses its
verified `dist/` artifact and rebuilds only the selected Cloudflare Worker.
Its account token and environment approvals are managed outside this repository.

Production runs at `https://souunnds.elipleaner.com`; the fresh sharing preview
is `https://souunnds-preview.elipleaner.com`. Both also retain their respective
`epleaner-souunnds` and `epleaner-souunnds-shareable` workers.dev URLs. The media
Containers use Durable Object scheduling, a fixed `youtube` instance name per
Worker, explicit `standard-1` sizing, and five-minute inactivity shutdown.
This account rejects the default Container scheduling policy. Durable Object
scheduling does not expose a platform `maxInstances` cap; the fixed name keeps
the public API on one Container per Worker. Client cancellation uses
`enable_request_signal` and `request_signal_passthrough` in both configs.
CI requires a whitespace-free account API token; a locally signed-in operator
can deploy using `cf` OAuth.

## Shareable projects

Production (`epleaner-souunnds`) deliberately has no sharing bindings and returns
`503 {\"error\":\"Project sharing is not configured\"}` for `/api/projects`.
The separate preview (`epleaner-souunnds-shareable`) binds D1
`epleaner-souunnds-sharing` and private R2 `epleaner-souunnds-audio`.
Apply `migrations/0001_sharing.sql` to **preview only**; the target D1 was
initialized with this schema and intentionally starts with no imported projects.
Its previous PostgreSQL projects
and edit capabilities are **not** imported, and previous share links will not
resolve in the new database. The source bucket was empty at migration review.
No production sharing database or bucket is implied.

The three preview D1 tables retain the sharing contract: binary 32-byte owner
hashes, validated JSON manifest, monotonically increasing revision, asset
completion state, expiring upload grants and cascading project deletion.
Creator capabilities remain in browser localStorage scoped to the origin on
which they were created; switching origins does not transfer those credentials.
Do not infer creator ownership from a public share URL.

Anyone with a shared project URL can read or fork it. Only the browser holding
its bearer edit capability may update, delete, or upload to the original.
Updates use `If-Match: \"<revision>\"`; concurrent/stale writes return 409.
The **Include local audio** option uploads WAV/MP3 (maximum 25 MiB) via a
same-origin bearer-authorized PUT to an R2 staging key, then verifies size,
type and audio signature before publishing it. The project must reference
the completed asset before the public same-origin audio GET succeeds.
Staged grants expire in five minutes; six-hourly scheduled cleanup removes
unreferenced assets after 24 hours and orphaned R2 keys. Forks have independent
ownership. No bucket credentials, presigned form POST, or browser CORS rule
are required.

## Audio sources

The studio accepts local files and YouTube video URLs. The Worker validates
individual HTTPS YouTube URLs before forwarding only normalized video URLs to
its private media container. The container uses yt-dlp and ffmpeg, caps active
conversions at two, kills work at 90 seconds or on disconnect, bounds output
at 64 MiB, and returns WAV with `X-Source-Title`. It sleeps after five minutes
idle; filesystem contents are ephemeral and contain no project data.
The downloader selects direct HTTPS audio from yt-dlp's `web_embedded`
client; unavailable, embedding-restricted, or fragmented-only streams may
fail. Imported YouTube audio remains in browser memory for the current visit.
Locally chosen audio retains the existing browser-storage behavior.

The existing Railway production deployment has no media API route; its
shareable-preview media route returns 503 `yt-dlp is unavailable` for the
public test video `jNQXAC9IVRw`. Cloudflare starts its real media Container
but the same video returns 502 `Could not download audio`; the image's stock
yt-dlp reports no available formats after its JavaScript challenge solver
was unavailable. No cookies, remote solver, or authorization bypass is used.
A successful hosted WAV/title YouTube import has not been demonstrated, but
this was already an unavailable feature in the old deployed environments.
Do not claim a working YouTube import from the existence of the API route.

The incoming-request signal is enabled in both Workers; local subprocess
disconnect tests pass, but hosted yt-dlp child termination and immediate slot
release after a client disconnect have not been directly observed because the
available public videos fail extraction before a stable long-running transfer.

Successful YouTube imports name the source after the video's title; you can still rename it.

Clicking the YouTube URL field keeps the same unobtrusive border as the menu buttons. Keyboard tabbing shows the accent focus ring on both controls.

## Pitch controls

Each layer has a **Pitch** control from −12 to +12 semitones. Each sequence clip has a matching control whose value is added to the layer's pitch setting; nested sequence clips accumulate their offsets. Pitch changes preserve clip duration, and both settings are saved with the project.

## Sequence generator

**Generate sequences** retains Rows and Columns (two seconds per column). **Density** fills fewer or more column slots: Sparse fills about a quarter, Balanced about five eighths, and Dense fills all; every row gets at least one clip. **Clip duration** controls each clip's span within its slot from Short (0.25–0.75 s) to Long (1.25–1.75 s).
