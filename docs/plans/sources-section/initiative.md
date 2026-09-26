# Sources section

## Goal
Import multiple audio files as independent source rows and assign one source to each layer through a `src` selector. Keep the section and row controls consistent with Layers and Sequence.

## Scope and decisions
- Worktree: `ep/sources-section`. Source rows own filename, duration, choose/replace, play/pause, and stop; `+ Source` adds an empty row. Sources section collapses like other sections.
- Existing saved single-source audio and layers remain usable. Persist source files in IndexedDB and source metadata plus layer assignment in local storage; migrate the legacy single-source key on read. Do not reset the arrangement when adding/replacing audio; existing single-source import behavior (first import creates a layer and sequence) remains.
- Layer `src` selects the PCM used for keyboard trigger, layer preview, layers mix, and sequence playback. Segment bounds follow the selected source. Audio decoding uses one AudioContext sample rate; mixing accommodates mono/stereo. No new dependencies or backend changes.
- Preserve accessible native controls and existing visual vocabulary. Gate/one-shot changes its icon, not its color.

## Acceptance and oracle
- Section header has collapsible SOURCES and + Source; rows contain Choose audio, duration, filename, playback controls. Empty row and saved-but-not-loaded row are actionable.
- Two different sources can be imported; changing a layer `src` changes the audio used by its playback and sequences; source selection persists on refresh.
- Layer play follows keyboard number; gate/one-shot toggles without changing button color.
- Browser inspection at wide and compact widths, pointer/keyboard interaction; focused core tests, typecheck/build, suite.

## Progress
- Initial mapping: `src/web/App.tsx` owns import, persistence, playback, controls; `src/web/styles.css` owns row styles; `src/shared/audio.ts` owns arrangement rendering. Core audio changes delegated to MultiSourceCore; App and CSS integration owned here.

## Verification and handoff
- Browser (Vite at local worktree): imported distinct 220 Hz and 440 Hz WAVs; source rows showed independent names/durations and play/stop controls. Instrumented Web Audio `AudioBufferSourceNode.start`: the two raw sources had distinct buffer fingerprints (`0.05047`, `-0.11159`); changing Layer 1 `src` produced different rendered-layer fingerprints (`0.001989`, `0.003823`). Played the sequence with the second source assigned; reload restored both audio files and the layer assignment.
- Removing the first source left the second playable and reassigned the layer; invalid WAV displayed `Unable to decode audio data` without losing existing rows. On a separate localhost origin, a saved legacy single-source state with the original IndexedDB key, filename key, and layer lacking `sourceId` loaded and played after reload.
- At 1440, 390, and 320 CSS px, screenshots showed the source rows and inline layer `src`; document width matched viewport width. Keyboard Enter on + Source added a row with visible focus. Section collapse/expand and per-source/global transport were exercised. Gate and one-shot both computed to `rgb(133, 139, 137)` when toggled.
- `npm run check`, `npm test` (18 tests), and `npm run build` passed. `git -c diff.ignoreSubmodules=all diff --check` passed; plain Git diff/check cannot traverse this worktree's copied submodule `.git` pointer, so inspection used `diff.ignoreSubmodules=all` without altering the submodule.
- Axe reported one pre-existing `page-has-heading-one` best-practice violation (the studio has no `<h1>`); no new control-specific violations observed. Test-only WAV fixtures in `/tmp` were removed; no build output was staged.

## Delivery correction (reopened)
- Goal: leave the Vite studio served from this worktree, prevent overlapping imports from resetting a newly edited arrangement, and commit/push the verified topic branch. Update repository guidance so verified task-owned changes are committed and pushed by default without requiring repeat approval; preserve explicit no-push and non-force safety boundaries. Mirror the stable rule in AGENTS.md and CLAUDE.md outside the managed Beads blocks.
- Regression oracle: hold import B after its render captured an empty arrangement; complete import A, add/edit a layer, then release B. The added/edited layer and sequencer must remain; B must load as an independent source. A sole initial import must still create the initial layer/sequence.
- State: `ep/sources-section` worktree contains only task-owned changes; main worktree has an unrelated `.beads/interactions.jsonl` modification and must not be staged. Bead `tunestretch-654` reopened. Next action: inspect staged scope, commit, and push the topic branch.
- Regression reproduced before the fix in Chromium: delayed B's `File.arrayBuffer`, imported A, added Layer 2, then released B. Layers dropped from 2 to 1. `importFile` now claims one-time initial arrangement creation synchronously with a ref; no other setters run inside a React state updater.
- Repeated the controlled overlap after the fix: A created Main sequence; added Layer 2 and Sequence 1 while B was held. After B completed, both named layers and both sequencer timelines remained, and the source list showed `A.wav` and `B.wav`. Screenshot of final rendered studio confirmed these controls. Vite remains served from this worktree at `http://127.0.0.1:5177/`.
- Re-ran `npm test` (18 passed), `npm run build` (TypeScript and Vite passed), and `git -c diff.ignoreSubmodules=all diff --check` (passed). Repo-level AGENTS.md and CLAUDE.md now explicitly opt into default verified task-branch commit/push outside managed Beads blocks.
