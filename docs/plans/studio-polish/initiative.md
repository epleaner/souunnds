# Studio UI polish

State: complete. Original eight-item polish closed in Bead `tunestretch-6q2` at `a26f626`; slider consistency closed in Bead `tunestretch-txl` at `70fa9a7`; themed dropdowns closed in Bead `tunestretch-2nl`. All were published on `origin/ep/sources-section`.

## Goal and independent acceptance items
1. Source rows: move Choose audio to the right, directly left of each duration timestamp, including compact layout and empty/long filenames.
2. Playback: when header all-layers playback is paused, row play starts only that row's layer; matching target still toggles pause/resume, and header resumes its own aggregate.
3. Layers: last row and section boundary show exactly one bottom divider.
4. Sequence: section height follows content, including empty, populated, and collapsed states; no imposed blank height.
5. ADSR/effects: remove extra gap before Reverb; align the left start of each Reverb/Delay/Compressor slider label and right end of each output to the ADSR slider start/right end. Preserve narrow responsive usability.
6. Sequence timeline: the last sequence grid and its section boundary show one bottom border, while earlier timeline rows retain their borders.
7. Effect labels: Pre-delay and Wet / dry, along with the other effect slider labels, remain on one line without breaking label/output alignment.
8. ADSR/effect spacing: every adjacent slider row, including the ADSR-to-Reverb transition and compact stacked effect sliders, uses the same vertical gap.

## Initial evidence and decision
Before these changes, Choose audio preceded the source row actions, the last layer and section both drew bottom borders, the sequence section reserved extra height, ADSR/effect gaps differed, and inclusive playback matching resumed the aggregate on a row click.

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
- Original polish: `npm run build`, `npm test` (18/18), and staged `git diff --check` passed; browser console/errors empty. Published at `a26f626`; Bead `tunestretch-6q2` closed.

## Slider consistency follow-on
Bead `tunestretch-txl` unifies the shared `RangeField` presentation: label → slider → value in DOM and on screen; one 4 CSS px column gap and zero default range-input margin make every visible slider/value gap 6 rendered px at the 1.5× UI scale. The existing shared track/thumb styles remain identical for layer, ADSR, and effects sliders. ADSR's label track preserves its slider x129/x126 alignment to effect labels at 1289px/320px.

At widths up to 1200px, five layer controls reflow to two columns instead of squeezing the Stretch slider to zero width; below 480px they use one column. Values remain visible at 800px, 1200px, 320px, and 1289px, with no horizontal overflow; the minimum observed Stretch track at 800px measured 65px.

Browser inspection found all 49 rendered controls ordered label/slider/value with the same 6px slider/value gap at both 1289px and 320px. The 480/481px, 720/721px, and 1200/1201px transitions kept outputs visible, tracks nonzero, and page width bounded. Keyboard ArrowRight updated Layer 1 gain from 0.8/-1.94dB to 0.85/-1.41dB and Reverb decay from 2.4s to 2.5s; ArrowLeft restored both. Pointer adjustment at 800px changed Stretch from 8 to 34.5 and Reverb decay from 2.4s to 7.0s; both were restored.

`npm run build`, `npm test` (18/18), and staged `git diff --check` passed; browser errors empty. Published at `70fa9a7`; Bead `tunestretch-txl` closed with no open follow-up.
