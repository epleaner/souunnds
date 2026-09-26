# Studio UI polish

State: current; Bead `tunestretch-6q2` in progress, `ep/sources-section` started clean at `aa551c3`. Concurrent dropdown change is tracked by `tunestretch-2nl` and `docs/plans/themed-select/initiative.md`; select component owns only new files while this work touches existing App/CSS.

## Goal and independent acceptance items
1. Source rows: move Choose audio to the right, directly left of each duration timestamp, including compact layout and empty/long filenames.
2. Playback: when header all-layers playback is paused, row play starts only that row's layer; matching target still toggles pause/resume, and header resumes its own aggregate.
3. Layers: last row and section boundary show exactly one bottom divider.
4. Sequence: section height follows content, including empty, populated, and collapsed states; no imposed blank height.
5. ADSR/effects: remove extra gap before Reverb; align the left start of each Reverb/Delay/Compressor slider label and right end of each output to the ADSR slider start/right end. Preserve narrow responsive usability.
6. Sequence timeline: the last sequence grid and its section boundary show one bottom border, while earlier timeline rows retain their borders.
7. Effect labels: Pre-delay and Wet / dry, along with the other effect slider labels, remain on one line without breaking label/output alignment.
8. ADSR/effect spacing: every adjacent slider row, including the ADSR-to-Reverb transition and compact stacked effect sliders, uses the same vertical gap.

## Evidence and plan
The source row markup currently renders Choose audio before `.source-row-actions`, which contains duration. `.source-row` uses a five-track grid at `styles.css:122-156` with a compact override near `:1190`. `.layer-row` has a bottom border at `:320-324`; section also has a bottom border. `.sequence-section` reserves `min-height:228.5px` at `:538-545`. `.adsr-controls` has `gap:8px`, ADSR sliders use `64px + 10px` left track and `48px` right track; effects rows currently use 48px/64px title tracks and a separate grid with `auto/38px` subtracks around effects sliders (`:910-998`). Playback's `playbackTargetIncludes` treats every unmuted layer as included in the all-layers target; `toggleTargetPlayback` resumes a paused included target (`App.tsx:1710-1726`).

Decision and implementation: move Choose audio into the row action group immediately before duration; treat only exact targets as the same playback target for toggling and button state, so a row never inherits the aggregate's pause/resume state; remove the last layer row's border and sequence minimum height/flex growth; align effect labels and outputs to the ADSR tracks with matching grid gaps. For added feedback, remove only the last sequence grid's bottom border (retaining the section boundary) and keep effect labels on one line with enough slider track room to preserve the right output edge. Both native select callsites were migrated by the concurrent themed-select work.

## Verification
- With real imported WAVs, aggregate Play all → Pause all → row Play Layer 1 changed the header to Play all, row 1 to Pause Layer 1, row 2 to Play Layer 2, and the live playback status to Playing Layer 1. Pausing then resuming the aggregate via the header also worked.
- At 1289px, Choose audio ended at x1082 and duration began at x1089.5; at 320px they were adjacent on the compact second row (x161 to x164), with no document horizontal overflow, including a long filename.
- Last layer row computed bottom border was 0; section boundary retained its single border. Seven layers were exercised with a scrolled list.
- Sequence section measured 149.5px populated (36px header + 112.5px content + border), 37px collapsed, and 37px with zero sequences on a fresh origin (36px header + border; content height 0).
- ADSR-to-Reverb spacing now matches every other adjacent slider row at 4 CSS px (6 rendered px); no extra gap remains. Reverb, Delay, and Compressor labels began at the ADSR slider x129 and outputs ended at ADSR output x908 at 1289px; at 320px both edges matched x126 and x308.
- First sequence grid retained its 0.6667px bottom border; last grid computed 0px and the section retained its single 0.6667px boundary at 1289px and 320px. Browser screenshot showed a single bottom line under the final timeline.
- Pre-delay and both Wet / dry labels rendered on one 15.6px line at 1289px and 320px with no slider/label overlap; their Reverb/Delay output right edges still matched the ADSR output (x908 and x308), and scroll width matched each viewport.
- All measured gaps between slider rows were 6 rendered px at both 1289px and 320px, including ADSR rows, the transition into Reverb, individual compact effect controls, and transitions between effects. The formerly 8px/10px responsive effects gaps were removed.
- Final `npm run build`, `npm test` (18/18), and `git diff --check` passed; browser console/errors empty. Next action: publish the verified diff and close Bead `tunestretch-6q2`.
