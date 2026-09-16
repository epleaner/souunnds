# Tunestretch MVP initiative

## Goal
Create a runnable local-file audio tool with a TypeScript CLI and a simple browser UI for Paulstretch-style time stretching, segment looping, layered playback, generative arrangements, and sequencer composition.

## Non-goals
- Cloud uploads, accounts, collaboration, or server-side media storage.
- Studio-grade FFT fidelity or lossless export formats beyond the first supported format.
- DAW integration, MIDI, or automated publishing.

## Acceptance
- A fresh checkout installs and runs with documented package scripts.
- The CLI accepts a local WAV file, applies configured stretch/segment/loop settings, and writes a WAV output.
- The web UI imports a local audio file without upload, exposes stretch parameters, previews output in the browser, and supports segment loops, multiple offset layers, generated arrangements, and sequencer playback.
- Core arrangement logic is deterministic when given a seed and has focused behavioral checks.

## Verification
- TypeScript/build checks for CLI and UI.
- Focused runtime checks for WAV decode/encode, stretching boundaries, arrangement generation, and sequencer scheduling.
- Browser smoke check of import, parameter update, preview, and at least one layer/sequencer interaction.

## Constraints and decisions
- Greenfield React + Vite frontend and Node TypeScript CLI; shared pure TypeScript domain/audio modules.
- Keep the first implementation dependency-light and local-only. Browser decoding uses Web Audio; CLI starts with PCM WAV input/output so it remains self-contained.
- Use a Paulstretch-inspired granular overlap/add core that is deterministic with a seed. Keep the algorithm boundary replaceable if FFT phase randomization is added later.
- The UI owns transient playback state; shared domain modules own arrangement data and scheduling calculations.

## Progress
- Git and Beads initialized; the project bead is `tunestretch-2k3`.
- Shared deterministic granular audio engine, WAV codec, arrangement generation, layered rendering, and nested sequencer scheduling live in `src/shared/audio.ts`.
- CLI lives in `src/cli.ts`; browser surface lives in `src/web/App.tsx` and `src/web/styles.css`.
- Verified with `npm test`, `npm run build`, a generated-WAV CLI smoke run, and a browser import/generate/sequence smoke run.
- Follow-up risk: the stretcher is intentionally Paulstretch-inspired granular overlap/add rather than a full FFT phase-randomization implementation; CLI input/output is PCM WAV.
