# Tunestretch MVP initiative

## Goal
Create a runnable local-file audio tool with a TypeScript CLI and a simple browser UI for Paulstretch-style time stretching, segment looping, layered playback, generative arrangements, and sequencer composition.

## Non-goals
- Cloud uploads, accounts, collaboration, or server-side media storage.
- Studio-grade FFT fidelity or lossless export formats beyond the first supported format.
- DAW integration, MIDI, or automated publishing.

## Acceptance

- A fresh checkout installs and runs with documented package scripts.
- The CLI accepts local WAV and MP3 (plus ffmpeg-supported audio), applies configured stretch/segment/loop settings, and writes a WAV output through upstream libpaulstretch.
- The web UI imports local MP3/WAV audio without upload, exposes stretch parameters, previews output through upstream libpaulstretch WASM, and supports segment loops, multiple offset layers, generated arrangements, and sequencer playback.
- The UI presents the audio workspace with a Swiss visual system: strict grid, typographic hierarchy, black/red signal palette, and responsive accessible controls.
- Core arrangement logic is deterministic when given a seed and has focused behavioral checks.

## Verification
- TypeScript/build checks for CLI and UI.
- Focused runtime checks for WAV decode/encode, stretching boundaries, arrangement generation, and sequencer scheduling.
- Browser smoke check of import, parameter update, preview, and at least one layer/sequencer interaction.

## Constraints and decisions
- Greenfield React + Vite frontend and Node TypeScript CLI; TypeScript owns arrangement policy while upstream libpaulstretch owns stretch DSP.
- Pin upstream `olilarkin/libpaulstretch` at a tagged release and keep it as a git submodule rather than copying GPL-2.0 source into this repository.
- Native CLI uses the upstream CMake target. Browser preview uses the upstream Emscripten/WASM build; the generated WASM output stays build-generated and is ignored.
- CLI non-WAV input is normalized by a direct `ffmpeg` subprocess into a temporary float WAV; no audio assets are committed.
- The UI owns transient playback state; shared domain modules own arrangement data and scheduling calculations.
- No repository design-system artifact exists yet; the requested Swiss treatment is implemented as the current local visual direction rather than asserted as an existing canonical token set.

## Progress
- Git and Beads initialized; the project bead is `tunestretch-2k3`.
- Integration bead: `tunestretch-6sj`.
- `olilarkin/libpaulstretch` is pinned as `vendor/libpaulstretch` at the v0.3.0 release commit.
- `src/cli.ts` now crops/loops segments locally, then invokes the upstream native `paulstretch` executable.
- `src/web/paulstretch.ts` loads the generated upstream Emscripten module; arrangement and sequencer policy remains in TypeScript.
- `npm run build:core`, `npm run build:wasm`, upstream CTest, `npm test`, `npm run build`, native CLI smoke, and browser WASM preview/layer/sequence smoke all passed.
- Upstream is GPL-2.0. Generated WASM is ignored and must be produced with `npm run build:wasm` before browser preview.
- Current change bead: `tunestretch-di2`.
- CLI now accepts `.mp3` and other non-WAV inputs through temporary ffmpeg normalization before upstream rendering.
- Web source copy and file picker explicitly communicate MP3/WAV local support.
- Web styling now uses a Swiss-inspired paper/ink/red system with grid-led layout, hairline rules, square controls, and responsive compact states.
- Refinement bead: `tunestretch-l3y`.
- UI uses the first Swiss light layout; nonessential hero/source/footer marketing copy remains removed.
- Stop playback is available in the source, layers, and sequence panels and updates the live status.
- Layer, preview, and sequence rendering errors now surface in the live status instead of leaving the UI unresolved.
- Sequence-grid change bead: `tunestretch-6hl`.
- The browser workspace now has two coordinated regions: Layers and Sequence.
- Sequence cells now show a live playback fill, resize from either edge, and support standalone gap cells with their own duration.
- Generated layer placement now samples source energy to avoid selecting silent regions when audio is available.
- Playback uses solid red sequence fills, contiguous edge-to-edge cells, and a global ADSR envelope applied before Web Audio playback.
- Sequence rendering loops a layer's rendered clip when a cell's relative duration exceeds the clip duration.
- Silent playback repair bead: `tunestretch-jow`.
- Generated placement scans deterministic source windows; legacy generated layers are relocated to the best audible window before layer, arrangement, or sequence playback.
