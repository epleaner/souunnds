# Tunestretch MVP initiative

## Goal
Create a runnable local-file audio tool with a TypeScript CLI and a simple browser UI for Paulstretch-style time stretching, segment looping, layered playback, generative arrangements, and sequencer composition.

## Non-goals
- Cloud uploads, accounts, collaboration, or server-side media storage.
- Studio-grade FFT fidelity or lossless export formats beyond the first supported format.
- DAW integration, MIDI, or automated publishing.

## Acceptance
- A fresh checkout installs and runs with documented package scripts.
- The CLI accepts a local WAV file, applies configured stretch/segment/loop settings, and writes a WAV output through upstream libpaulstretch.
- The web UI imports a local audio file without upload, exposes stretch parameters, previews output through upstream libpaulstretch WASM, and supports segment loops, multiple offset layers, generated arrangements, and sequencer playback.
- Core arrangement logic is deterministic when given a seed and has focused behavioral checks.

## Verification
- TypeScript/build checks for CLI and UI.
- Focused runtime checks for WAV decode/encode, stretching boundaries, arrangement generation, and sequencer scheduling.
- Browser smoke check of import, parameter update, preview, and at least one layer/sequencer interaction.

## Constraints and decisions
- Greenfield React + Vite frontend and Node TypeScript CLI; TypeScript owns arrangement policy while upstream libpaulstretch owns stretch DSP.
- Pin upstream `olilarkin/libpaulstretch` at a tagged release and keep it as a git submodule rather than copying GPL-2.0 source into this repository.
- Native CLI uses the upstream CMake target. Browser preview uses the upstream Emscripten/WASM build; the generated WASM output stays build-generated and is ignored.
- The UI owns transient playback state; shared domain modules own arrangement data and scheduling calculations.

## Progress
- Git and Beads initialized; the project bead is `tunestretch-2k3`.
- Integration bead: `tunestretch-6sj`.
- `olilarkin/libpaulstretch` is pinned as `vendor/libpaulstretch` at the v0.3.0 release commit.
- `src/cli.ts` now crops/loops segments locally, then invokes the upstream native `paulstretch` executable.
- `src/web/paulstretch.ts` loads the generated upstream Emscripten module; arrangement and sequencer policy remains in TypeScript.
- `npm run build:core`, `npm run build:wasm`, upstream CTest, `npm test`, `npm run build`, native CLI smoke, and browser WASM preview/layer/sequence smoke all passed.
- Upstream is GPL-2.0. Generated WASM is ignored and must be produced with `npm run build:wasm` before browser preview.
