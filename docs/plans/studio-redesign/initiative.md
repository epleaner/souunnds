# Studio redesign

## Goal
Rework the souunnds web studio into a minimal, compact, Swiss-inspired dark DAW surface with muted colors and no redundant copy.

## Scope
- Preserve the existing React audio workflow and behavior in `src/web/App.tsx`.
- Redesign `src/web/styles.css` and make only necessary metadata/semantic changes.
- Verify the rendered surface at wide and compact viewports.

## Acceptance
- Dark muted visual system with compact hierarchy and clear DAW controls.
- Import, playback, layers, and sequence controls remain usable.
- Responsive layout remains usable at compact widths.
- Typecheck and production build pass.

## Decisions
- Keep the established React/Vite stack and state ownership.
- Use CSS-first redesign; avoid new dependencies and avoid redesigning audio behavior.
- Keep visible labels needed for operation and accessibility; remove decorative marketing copy.

## Verification
- Browser render verified at 1440×1000, 390×844, and 320×800; no horizontal overflow at 320px.
- 200% root text resize verified at 320px with no horizontal overflow.
- Keyboard interaction verified by focusing the sequence tab; accessible roles/states remain exposed.
- `npm run check` passed.
- `npm run build` passed.
- `npm test` passed (17 tests).

## Figma Make exploration
- User job: import an audio file, shape stretch parameters, arrange generated layers, and play or export an evolving sequence.
- Scope: one populated desktop DAW workspace with a compact responsive variant; Make is visual/behavioral evidence, not production source.
- Platform/viewports: desktop web at 1440×1000; compact web at 390×844; preserve meaning at 320 CSS px.
- Exact visible copy: `souunnds`, `SOURCE`, `CHOOSE AUDIO`, `STOP`, `ADSR`, `ATTACK`, `DECAY`, `SUSTAIN`, `RELEASE`, `LAYERS`, `SEQUENCE`, `PLAY SEQUENCE`, `PLAY ALL`, `+ SEQUENCE`, `RANDOMIZE`, `RANDOMIZE 1×4`, `LOOP LAYERS`, `LOOP SEQUENCE`, `REMOVE`.
- Visual direction: dark graphite surfaces, muted gray text, near-white type, one restrained amber signal accent, 8px rhythm, thin separators, square corners, grotesk sans, monospaced values, no gradients, no shadows, no hero copy.
- Reference translation: Swiss grid → strict columns, asymmetric hierarchy, communication-first typography; norns → tactile sparse controls, monochrome instrument surface, parameter values as primary signal, minimal copy.
- Required states: populated default with selected sequence cell, playing/transport feedback, disabled stop before playback, and empty source before audio import.
- Non-goals: no backend or audio behavior changes, no marketing copy, no decorative illustrations, no bespoke generated assets, no publication or sharing.
- Research sources: Poster House, `https://swissgrid.posterhouse.org/`; monome docs, `https://monome.org/docs/norns/` and `https://monome.org/docs/grid/`.

## Accepted Make packet
- Route: Browser Make through Orca embedded browser; source of truth is the Make file plus accepted revision, not production code.
- Make file: `https://www.figma.com/make/7bszfukzWllwnR3dWBWrIG/Responsive-Audio-DAW-Screen?t=0PYEisCnm25A2Kv1-0`
- Revision lineage: Version 1 workspace; Version 2 compact source strip; Version 3 stacked compact layout; Version 4 overflow containment.
- Accepted regions: source/transport bar, waveform/timeline, four generated layer rows, sequence cells, ADSR rail, LAYERS controls, SEQUENCE actions, bottom status strip.
- Accepted tokens: `#101112` graphite background, `#17191b` surface, `#2b2e31` separators, `#c9cbc8` primary text, `#858b89` muted text, `#d89a4a` amber signal; square geometry, 1px rules, 8px rhythm, grotesk sans, monospaced values.
- Accepted states: stopped (`STOP` disabled, `▶` enabled), playing (`STOP` enabled, `▶` disabled, elapsed time advances), selected sequence cell (amber outline plus numbered cell), source populated, compact stacked layout.
- Browser evidence: direct Make preview exposed native `textbox`, `button`, `checkbox`, and `slider` roles; clicking `▶` produced `00:06`, enabled `STOP`, and disabled `▶`; clicking `STOP` restored `STOP` disabled and `▶` enabled.
- Responsive evidence: browser screenshots reviewed at 1440-ish desktop, 390×844, and 320×800; final 320 metrics were `innerWidth=320`, `scrollWidth=320`, `bodyScrollWidth=320`, with stacked ADSR/LAYERS/SEQUENCE sections and no root horizontal overflow.
- Known prototype boundary: Make preview is exploratory and its generated code is not production authority; production implementation must map the accepted regions to `src/web/App.tsx` and `src/web/styles.css`.

## Disclosure iteration
- Make Version 7: secondary actions/settings are collapsed behind `GENERATE LAYERS`, per-layer `LAYER SETTINGS`, `SEQUENCE SETTINGS`, and `CELL SETTINGS`; primary transport, timeline, layer rows, sequence cells, ADSR, and play actions remain visible.
- Accessibility: native disclosure summaries expose `DisclosureTriangle` roles; keyboard focus verification reports `:focus-visible` with a 2px solid amber outline and 2px offset.
- Responsive verification: 320×800, 390×844, and 1440×1000 all have no root horizontal overflow; all four disclosures are collapsed by default. Expanding all four at 320px remains `scrollWidth=320`.
- No Figma Make publish/share/apply action was taken. Production source remains unchanged by this design iteration.
## Popover and section iteration
- Make Version 8: Generate, layer, sequence, and cell settings are compact popover-style controls; settings triggers expose `aria-expanded` state and preserve the Swiss visual language.
- Main sections are independently collapsible: `SOURCE / TRANSPORT`, `WAVEFORM / TIMELINE`, `LAYERS`, `SEQUENCE`, `ADSR`, and `STATUS`; headers remain reachable when collapsed and default expanded state preserves the current first view.
- Browser evidence: direct preview opened generator, layer, sequence, and cell settings controls; collapsing all six main sections left their labels exposed with `expanded=false`.
- Responsive evidence: screenshots reviewed at 320×800 and 1440×1000; preview metrics stayed at viewport width with no root horizontal overflow. Mobile settings interactions preserved `scrollWidth=320`.
## Collapsed flow correction
- Make Version 9 removes the reserved blank region under collapsed `SEQUENCE`; all six sections now share one normal vertical flow.
- Geometry evidence at 1048px: collapsed `SEQUENCE` ends at `y=139`, `ADSR` begins at `y=140` (1px separator); expanding `SEQUENCE` moves `ADSR` to `y=244.5`, and collapsing restores `y=140`.
- Responsive evidence: 320px and 390px previews remain within viewport width (`scrollWidth` equals `innerWidth`).
## Grid and control refinement
- Make Version 10: ADSR envelope stroke reduced to `0.75`; `GENERATE LAYERS` moved into the `LAYERS` header row; `PLAY SEQUENCE` and `PLAY ALL` now hug their labels.
- Make Version 11: sequence changed from a single row to a 4×8 accessible cell matrix with uniform square cells and restrained active states.
- Make Version 12: sequence matrix tightened to 30px square cells at desktop and mobile, left-aligned as a compact monome-like instrument grid rather than a full-width panel.
- Browser evidence: Version 12 preview exposes 32 cell buttons with four rows of eight equal 30×30px cells; root and body widths equal the viewport at 1048px, 320px, and 390px. ADSR SVG path reports `stroke-width="0.75"`. Text action buttons remain content-sized.
## Grid cleanup and enlargement
- Make Version 13 removes stray underscore-like glyphs, row-number remnants, text-decoration, and pseudo-element bars from the sequence matrix.
- Desktop evidence: 32 accessible cells render as four rows of eight equal 36×36px squares in a compact left-aligned block; no repeated underscore characters appear in the preview text.
- Responsive evidence: 320px cells measure 34×34px and 390px cells 36×36px; both viewports remain overflow-free.
## Chrome simplification
- Make Version 16 removes `WAVEFORM / TIMELINE` and its reserved content entirely.
- `STATUS` is no longer a collapsible section; `STOPPED`, `00:00`, and `42%` now live in a fixed anchored footer with a 1px top border.
- Visible `SETTINGS` labels are replaced by compact gear buttons with `aria-label="Settings"` and `title="Settings"`; gear activation still opens the layer settings popover.
- Browser evidence: preview text contains neither `WAVEFORM / TIMELINE` nor `STATUS`; four Settings gear buttons remain; at 390px the footer is fixed at `top=816`, `bottom=844`, `height=28`. Root/body widths remain equal to viewport at 1048px, 320px, and 390px.
## Gear icon correction
- Make Version 17 replaces the prior brightness-like Settings glyph with a filled outline SVG cogwheel: eight distinct teeth and a punched circular center hole.
- All four controls remain icon-only buttons with `aria-label="Settings"` and `title="Settings"`; activation still opens the per-layer settings popover.
- Browser evidence: Version 17 preview screenshot visibly shows toothed gears; DOM inspection confirms four Settings buttons share the SVG gear path and 14×14 viewBox. Desktop root/body widths are 1048px; at 390px they remain 390px with a fixed 28px footer (`top=816`, `bottom=844`) and no horizontal overflow.
## Production implementation handoff
- User job: import a source, generate and tune layers, arrange sequence cells, and play the result without losing the compact instrument-surface hierarchy.
- Production boundary: preserve React/Vite and existing audio state in `src/web/App.tsx`; implement the approved visual system in `src/web/styles.css`; keep DSP/WASM behavior in `src/shared/audio.ts` and `src/web/paulstretch.ts`.
- Accepted Make mapping: source/transport → import and playback shell; LAYERS → generated layer list and settings; SEQUENCE → sequence controls and cells; ADSR → playback envelope controls; fixed footer → processing/status feedback.
- Non-goals: no backend rewrite, no new UI framework or dependency, no generated-asset handoff, no Figma Make publish/share/apply operation.
- Execution evidence required: wide, 390px, and 320px rendered checks; keyboard/focus checks; source import and playback/stop smoke; layer generation/settings smoke; sequence edit/playback smoke; empty/error states; `npm run check`, `npm run build`, and `npm test`.
## Production execution evidence
- `src/web/App.tsx` now maps the approved one-surface layout to source/transport, LAYERS, SEQUENCE, and ADSR sections with collapsible headers, accessible gear settings, sequence/cell popovers, fixed playback/status footer, and elapsed-time feedback.
- `src/web/styles.css` now uses the approved graphite palette (`#101112`, `#17191b`, `#2b2e31`, `#c9cbc8`, `#858b89`, `#d89a4a`), full-width section rules, 36px sequence cells, compact waveform rows, and responsive 320/390px layouts.
- Browser smoke: imported a temporary valid WAV, generated four layers and four sequences with 32 cells, opened layer Settings and the SEQ/CELL controls, changed a selected cell, played/stopped source audio, and played/stopped a generated sequence.
- Browser evidence: desktop `1440px` and compact `390px`/`320px` renders kept root/body scroll widths equal to viewport; fixed footer measured `28px` high and anchored to the viewport. Keyboard Tab focus exposed the amber 2px outline on Generate Layers. Invalid audio surfaced `Unable to decode audio data` without breaking the surface.
- Static evidence: `npm run check`, `npm run build`, and `npm test` passed; Vitest reported 17 passing tests. Production build remains the source of truth; Make remains reference-only.

## Pixel parity correction
- Re-measured the accepted Make preview at `1440×1000` and matched production section geometry exactly: source `0–65`, layers `65–218`, sequence `218–446.5`, ADSR `446.5–931.328`; sequence controls/cells, four layer gears, ADSR rails, and envelope SVG share the reference coordinates.
- Matched source control boxes to Make: filename `(174.4375,35,149,18)`, choose audio `(335.4375,33,98.265625,22)`, clock `(1276.03125,35,36,18)`, stop `(1324.03125,33,53.640625,22)`, play `(1389.671875,33,34.328125,22)`.
- Matched ADSR rails `(x=72,w=1308)` at `y=487.75,512.25,536.75,561.25`; envelope SVG `(12,578.5,1416,339.828125)`; switched slider thumbs to square reference styling and aligned the five-point envelope to Make’s `0 0 200 48` geometry.
- Matched layer waveform palette and default ADSR values to the accepted populated state (`1.00s`, `0.80s`, `0.72`, `0.40s`); idle footer retains the reference `42%` display while live processing/playing values remain dynamic.
- Final verification: browser upload/generation produced four layers; Settings opened; sequence selection changed; desktop screenshot reviewed against Make; compact `390px` viewport had `scrollWidth=390`; `npm run check`, `npm run build`, and `npm test` passed (17 tests).

## Interactive ADSR graph
- Replaced the static envelope SVG with a state-derived editor: attack, decay, sustain, and release slider updates redraw the graph; dragging the attack/decay/release nodes updates the corresponding values, with decay/release vertical movement updating sustain.
- Interactive nodes remain SVG circles, expose slider semantics and value text, and support keyboard arrows; pointer coordinates clamp to the existing slider ranges.
- Browser evidence: slider `ArrowRight` moved attack `1.00 → 1.01` and graph x `64 → 64.6`; dragging attack moved the slider to `1.17`; dragging decay vertically moved sustain to `0.82`; graph-node `ArrowUp` moved sustain to `0.83`.

## Inline ADSR layout
- Desktop ADSR uses a two-column row: sliders occupy the left column and the graph is right-justified beside them. The graph stretches to the slider grid height instead of setting the section height.
- Browser evidence: desktop slider grid and graph both measured `h=68.15625` at `1440px`; graph `x=1146`, `w=284`; compact graph stacked below the sliders at `x=8`, `w=374`, `h=220`; body `scrollWidth` remained `390`.

## Studio control refinements
- Enlarged all visible ADSR anchors while preserving rendered circles; the attack anchor now maps vertical movement to the Sustain slider as well as horizontal movement to Attack time.
- Section collapse markers are positioned to the left of section names. Empty sequence messaging is centered in its 36px row. User-facing Cell terminology is now Clip.
- Choose audio uses horizontal padding and centered flex content; Play uses grid centering. Generator, layer, sequence, and clip settings menus are absolute overlays and no longer change section flow.
- Browser evidence: attack-node vertical drag changed Sustain `0.72 → 0.52`; desktop generator/sequence popovers remained absolute with unchanged section heights; compact body remained `390px` wide.

## Compact control dropdown refinement
- Layer generation is now split into a compact `▶` preview action, `+ Layers` generator trigger, and adjacent gear settings menu; `Linked` lives in the gear menu.
- The generator menu keeps `+ Layer` on its own row and places Count, Seed, and Generate on one inline form row. Sequence uses the same compact `▶`, Play all, SEQ, and CLIP toolbar treatment.
- Layer, generator, sequence, and clip menus share the dark bordered overlay language. Layer settings now use the reference panel hierarchy: uppercase heading, labeled horizontal sliders, values, Preview layer, and Remove.
- Browser evidence: desktop generator overlay measured `440px` wide, settings overlay `142px`, layer settings overlay `400px`; sequence and clip menus opened without changing section height. Compact viewport measured `scrollWidth=390` and generator overlay stayed within `x=20..390`.
- Static evidence: `npm run check`, `npm run build`, and `npm test` passed (17 tests).

## Make dropdown parity pass
- Reviewed the live Make preview at the accepted file URL and inspected all four dropdown states: Generate Layers, Layer Settings, SEQ, and CELL.
- Make's SEQ menu is a compact 400px overlay with a heading, full-width `RANDOMIZE`, `RANDOMIZE 1×4`, and `CLEAR` actions, then separated `LOOP LAYERS` and `LOOP SEQUENCE` checkboxes.
- Make's CELL menu uses `CELL SETTINGS`, the selected layer/step subtitle, a length slider with multiplier output, repeats input, and full-width `REMOVE CELL`.
- Production now uses `CELL` terminology, mirrors the SEQ/CELL content and hierarchy, maps sequence actions to existing handlers, and formats layer settings as Make-style percent, multiplier, milliseconds, and decibel values.
- Browser evidence: production opened generator, layer, SEQ, and CELL overlays; production SEQ measured `400px` wide and exposed the three Make actions plus both loop controls; CELL exposed the selected layer/step, length, repeats, and Remove Cell.

## Sequence dropdown scale correction
- The SEQ overlay retained the Make action hierarchy but was oversized relative to the surrounding production controls. Reduced action button and loop-label typography, dimensions, and checkbox spacing to the shared compact control scale.
- Browser evidence: desktop SEQ action button height `23.5px`, label height `20px`; compact overlay measured `374px` within a `390px` viewport with `scrollWidth=390`.

## Shared theme and footer correction
- Removed SEQ-specific oversized typography and control dimensions; the action stack now reuses shared `make-button`, `label-caps`, `inline-control`, border, spacing, and token behavior.
- Narrowed the SEQ overlay to `320px` while retaining responsive viewport clamping.
- Anchored the processing/status footer with `position: fixed` so it stays at the viewport bottom.
- Browser evidence: at `390×844`, SEQ measured `320px` wide with `20px` action buttons and `19px` loop rows; root/body `scrollWidth=390`; footer measured `top=816`, `bottom=844`, `height=28px`, `position=fixed`.

## Title removal and content-fit SEQ width
- Removed decorative titles from generator, layer, sequence, and cell dropdowns; controls now open directly into their shared content surfaces.
- SEQ now uses intrinsic content width rather than a fixed panel width. Browser evidence at `390px`: overlay `139.8125px` wide, `scrollWidth=390`, and zero remaining dropdown title nodes.

## Shared dropdown component
- Added a reusable `DropdownPanel` React wrapper for generator settings, generator, layer, sequence, and cell overlays.
- Moved shared overlay padding into `.control-popover`; all dropdown variants now inherit `12px` padding instead of per-panel padding values.
- Browser evidence: production SEQ and generator overlays both computed `padding: 12px`; compact SEQ remained within the viewport and the footer stayed fixed at `top=816`.

## Shared dropdown trigger spacing
- Applied one shared `4px` dropdown margin in the `control-popover` base instead of per-menu margin overrides.
- Tuned the variant anchor offsets to the same rendered `7px` gap from each trigger CTA for generator, layer, and SEQ overlays.
- Browser evidence at `390px`: generator, layer, and SEQ trigger gaps each measured `7px`; SEQ remained content-width and overflow-free.

## Layers and sequence control refinement
- Goal: keep LAYERS, SEQUENCE, and fixed STATUS visible in one viewport while exposing high-frequency actions inline.
- Acceptance: scrollable constrained layer list; equal-height buttons; inline layer config plus play/remove controls; source-derived waveform; section-level sequence play-all/randomize actions; per-sequence play/randomize/clear actions; loop settings in SEQ; cell editing popover anchored above the selected cell; no standalone CELL dropdown.
- Non-goals: DSP/WASM changes, backend changes, new dependencies, or replacing the existing React/Vite boundary.

## Layers and sequence control verification
- `src/web/App.tsx` now keeps `+ Layer` and `Generate layers` in the LAYERS header, exposes all layer range/enable controls inline, uses source-sample-derived waveform bars, and provides per-layer play/remove icon actions.
- The layer list is constrained to `160px` with vertical scrolling; sequence and ADSR remain visible at `1440×1000` and `390×844`. Sequence header actions are `Play all`, `Randomize sequences`, and `SEQ`; each sequence row has play, randomize, and clear actions.
- `SEQ` contains only `Loop layers` and `Loop sequence`. The standalone CELL trigger is gone; clicking a cell renders its editor popover above that cell. Rendered browser geometry confirmed the popover at `x=9`, `y=106.8` for the first cell on a `390×844` viewport.
- Browser smoke imported a temporary valid WAV; the populated layer row showed non-placeholder waveform bars and inline controls. Non-cell action buttons measured `22px` high; document scroll height equaled the `844px` viewport.
- Static verification: `npm run check`, `npm run build`, `npm test` (17 passing), and `git diff --check`.

## Sequence icon refinement
- Replaced the SEQ text trigger with a compact accessible settings gear.
- Empty sequence rows no longer render play/randomize/clear CTAs. Populated rows use the shared 20px play-icon button and SVG play glyph; source, layer, and sequence play controls use the same component.
- Browser verification at `390px`: empty rows had zero `.sequence-row-actions`; populated rows had one action group; all shared play buttons measured `20×20px` and contained the shared SVG icon. Horizontal scroll width remained `390px`.

## Layer control compression
- Removed layer waveform rendering entirely.
- Kept all five layer sliders in one horizontal control row; browser measurement at `390px` found all five range inputs sharing one `y` coordinate.
- Replaced the On checkbox with an accessible headphone mute toggle. The icon is amber when active and gray when muted, with `aria-pressed` and Mute/Unmute labels.

## Source filename persistence
- Persisted the editable source filename/path field under `souunnds.source-file-name` in `localStorage` and restore it during App initialization.
- Browser verification set `/Users/test/audio.wav`, refreshed the app, and observed the same value restored with `scrollWidth=390px`.
- Browser security still prevents recovering the actual selected file bytes or absolute filesystem path from a file input; only the displayed filename/path text persists.

## Arrangement persistence
- Persisted validated layer, sequence, ADSR, duration, active-sequence, and selected-cell state under `souunnds.studio-state`.
- Browser verification restored a layer named `Persisted layer`, five layer values, muted state, one sequence cell, and ADSR values `2`, `1.5`, `0.4`, `2.5` after reload.
- Persistence is JSON-only; decoded audio remains session-local and must still be imported for playback.

## Compact generator controls
- Reduced the Generate layers popover to `8px` padding and tighter field gaps, kept Count, Seed, Linked, and Generate on one non-wrapping line, and retained viewport clamping.
- Browser verification at `390px`: panel measured `374×41px`, form measured `356×23px`, all four controls shared the same row, and document `scrollWidth` remained `390px`.

## Generator link control
- Kept Generate layers on the shared `DropdownPanel`/`control-popover` boundary.
- Made Count and Seed inputs subtle borderless numeric controls with only a low-contrast bottom rule.
- Replaced the Linked checkbox with an accessible chain-link icon toggle. Browser verification confirmed amber linked state, gray unlinked state, `aria-pressed`, and Link/Unlink labels.

## Icon tooltips
- Added native `title` tooltips to sequence cell resize/edit controls; shared icon buttons already propagate their accessible label into `title`.
- Browser verification found every rendered icon button and sequence cell control had matching accessible label and tooltip text at `390px`; no horizontal overflow.

## Source file auto-restore
- Added best-effort File System Access API persistence: handles selected through the native picker are stored in IndexedDB and reopened automatically on refresh when read permission is already granted.
- Unsupported browsers, unavailable IndexedDB, denied permissions, and normal file-input selections retain the existing Choose audio fallback.
- Browser integration verification seeded a real OPFS `FileSystemFileHandle`, reloaded the app, and observed `restore-test.wav ready`, enabled source playback, and `390px` horizontal containment.

## Audio picker interaction
- Replaced the nested file-input label with a dedicated button that invokes the File System Access picker directly; the hidden file input remains the compatibility fallback.
- Browser verification clicked the replacement control twice and observed two picker invocations with no layout overflow.

## Source replacement race
- Guarded asynchronous auto-restore and manual imports with a monotonically increasing source-load ID; selecting a new file invalidates an older restore before it can overwrite the new source.
- Browser verification selected a replacement WAV through the picker path and observed the new filename, ready status, enabled source playback, and `390px` containment.

## Picker compatibility recovery
- Bound `showOpenFilePicker` to `window`, reset the native input before fallback selection, and fall back to the native picker on denied or unavailable File System Access permission.
- Browser verification confirmed the fallback input path activates on `NotAllowedError` and remains contained at `390px`.

## Explicit file loading
- Removed File System Access, IndexedDB handle storage, permission restoration, and auto-restore logic.
- Replaced the picker path with a plain native file input behind a `Load file` button; repeated native selections remain supported.
- Browser verification loaded two WAV files sequentially, observed each filename and ready status, and confirmed `390px` containment.

## Explicit restored-file loading
- Persisted the selected audio bytes and metadata in IndexedDB (the browser's durable local storage for binary data), while retaining the filename in localStorage.
- Added a conditional inline restore action; refresh restores saved-file availability but does not auto-load or replace the current source.
- Browser verification loaded a WAV, refreshed with playback disabled, then explicitly loaded the saved file and observed ready playback state at `390px`.

## Restore CTA visibility
- Rendered small `restore <filename>` text only when a persisted local file is available, positioned immediately after `Load file`.
- Browser verification showed only `Load file` with no saved file, then the inline restore action after persistence, with no horizontal overflow.

## Layer slider alignment
- Changed layer slider labels, values, and controls to share one inline row; browser measurement confirmed matching control alignment without horizontal overflow at `390px`.

## Shared shuffle controls
- Added a per-layer `Randomize` icon button and replaced the sequence randomize glyph with the same shared shuffle SVG.
- Browser verification confirmed both controls expose matching `aria-label`/`title` text and the layer action reports `Randomized Layer 1.`.

## Section header consistency
- Compacted empty layer and sequence content to one `24px` row, while preserving the populated sequence height.
- Unified layer header controls at `22px`, replaced sequence `Play all` text with the shared play icon, and moved source playback into the right-aligned section header action group.
- Browser verification at `688×825`, `390px`, and `320px` confirmed right-aligned playback controls, inline restore placement, equal header-control heights, separated compact transport controls, and no horizontal overflow.

## Section border cleanup
- Removed borders from every button inside source, layer, and sequence headers, including hover states.
- Collapsed sections now use only the section divider; their header-row divider is removed, and collapsed populated sequences no longer retain the expanded minimum height.
- Browser verification at `688×825` confirmed `0px` header-button borders, one `1px` divider per collapsed section, compact collapsed heights, and no horizontal overflow.

## Unified transport and slider controls
- Replaced header button outlines with full-height vertical separators and grouped source duration, play/pause, and stop controls in the source header.
- Added real Web Audio pause/resume behavior. Browser verification confirmed the transport icon and accessible label swap between play, pause, and resume; the clock remains fixed while paused, advances after resume, and resets on stop.
- Kept muted layer rows at full opacity while dimming only the headphones icon, and compacted every layer label, slider, value, and action onto one row.
- Reused the same `RangeField` component and range-track/thumb styles for layers and ADSR. Browser verification at `688px`, `390px`, and `320px` confirmed aligned one-row controls and no document overflow.

## Single-row source header
- Removed the Source / Transport body and its expand/collapse state; source selection, current filename, restore action, duration, play/pause, and stop now share the section header.
- The empty state presents `CHOOSE AUDIO` instead of `No file selected`, while loaded filenames reuse the `SOURCE` label typography.
- Browser verification at `688px`, `390px`, and `320px` confirmed the section stays `25px` tall with no body or horizontal overflow; narrow layouts abbreviate the restored filename while retaining the restore action.

## Borderless controls and playback effects
- Removed borders, including hover and expanded-state borders, from every button inside the Layers and Sequence sections; source controls retain their vertical separators.
- Added persisted Reverb, Delay, Time, and Feedback sliders to the renamed `ADSR / EFFECTS` section. The controls reuse `RangeField`, remain keyboard-operable, and update active playback.
- Rejected adding Tone.js: the repository has no audio framework dependency, while Tone's reverb and delay APIs wrap the same native Web Audio primitives needed here. The implementation uses one cached convolution impulse plus native `ConvolverNode`, `DelayNode`, and bounded feedback/gain nodes.
- Browser verification created one convolver with a `2.4s` impulse, one delay at `420ms`, wet gains of `40%` and `25%`, and `50%` feedback across nine graph connections; changing reverb during playback updated its live gain to `60%`.
- Browser verification at `688px` and `320px` confirmed all layer/sequence buttons remain borderless at rest and on hover, effects persist after reload, range keyboard input works, and the page has no horizontal overflow.

## 150% interface scale
- Applied a single `1.5` UI zoom to the document so text, controls, spacing, sections, and the fixed transport footer scale together like browser zoom at 150%.
- Compensated the viewport-based minimum height and minimum width, and scaled responsive breakpoints to preserve the same effective layout decisions after zoom.
- Added compact visible labels for source, layer-generation, and sequence-generation actions below `480px`; full accessible names and desktop labels remain unchanged.
- Browser verification at `1440px`, `688px`, `390px`, and `320px` confirmed section/control dimensions scale by 1.5, headers do not overlap, controls remain interactive, and document width matches the viewport.

## Active control-polish pass
- **Goal:** Make playback state legible and controllable at each layer/sequence row, move sequence-owned settings to those rows, compact the cell editor, and align the remaining typography/effects/source details.
- **Non-goals:** No new audio rendering engine, sequence data migration, or change to the existing 150% interface scale.
- **Acceptance:** Centered destructive icons; disabled generators without source audio; uniformly gray restore copy hidden for the loaded file; ADSR-sized layer labels/values; pause/resume toggles for each playback target; borderless inline effects rows with per-effect dry/wet mixing; per-sequence loop settings; and a compact, shared-slider cell editor without repeats that dismisses on outside click.
- **Design:** Keep `App` as the playback owner. Add one explicit playback-target identity so every play button can derive play/pause/resume state from the existing AudioContext lifecycle. Keep sequence settings in each sequence row and reuse `RangeField` for every slider.
- **Verification:** Exercise empty and loaded source states, individual and aggregate playback pause/resume, effect parameter layout/live graph values, per-row settings independence, cell-popover dismissal, keyboard controls, and responsive layouts in the real browser; then run typecheck, build, tests, and diff checks.
- **Escalation:** Only an unavailable browser audio or pointer-event boundary blocks completion; otherwise recover locally and continue.

## Control-polish verification
- Replaced text multiplication signs with centered SVG close icons; browser geometry matched icon and button centers exactly for layer and sequence controls.
- Generator actions were disabled with no source and enabled after loading audio. Restore copy used one muted color and disappeared after loading the stored file, even if the editable display filename changes.
- Layer range labels/values now compute to the same `9px`/`10px` sizes as ADSR. Narrow layer rows retain usable tracks through section-local horizontal scrolling without document overflow.
- Added explicit playback targets for source, each layer, the layer mix, each sequence, and the all-sequences mix. Browser playback confirmed play → pause icon/label → resume for individual and aggregate layer/sequence controls.
- Reworked the effect chain into constant-power per-effect wet/dry stages. Browser graph inspection at `25%` reverb and `75%` delay confirmed dry/wet gains of `0.9239/0.3827` and `0.3827/0.9239`, one convolver, one delay, and twelve graph connections. Reverb is one inline row; delay wet/dry, time, and feedback share one row with no divider.
- Moved loop controls into each sequence row. A two-sequence browser scenario confirmed independent persisted settings, a `3px` rendered trigger gap at 150% scale, and click-away dismissal.
- Compacted the cell editor to `180px` CSS width on wide layouts and `87px` on the narrowest layout, reused `RangeField` for length, removed the repeats field, and confirmed outside-click dismissal with no viewport overflow.
- Verification passed at `1440px`, `688px`, `390px`, and `320px`; `npm run check`, `npm run build`, all `17` tests, and `git diff --check` passed.

## Reverb parameter extension
- **Goal:** Extend the current native Web Audio reverb with persisted decay, pre-delay, and damping controls while preserving the existing constant-power wet/dry stage.
- **Non-goals:** No Tone.js dependency, algorithmic room-size or diffusion model, new audio renderer, or changes to delay behavior.
- **Design:** Regenerate and replace the convolver impulse after an `80ms` settled decay change, put a bounded pre-delay before the convolver, and apply a low-pass damping filter only to the wet path. Keep one last-value impulse cached per audio context to avoid retaining every slider position.
- **Acceptance:** Decay `0.2–8s`, pre-delay `0–250ms`, and damping `500Hz–18kHz` are accessible, persisted, backward-compatible with old saved state, inline with reverb wet/dry, and live during playback.
- **Verification:** Inspect the live Web Audio graph and parameter updates in the browser, confirm persistence and responsive containment, then run typecheck, production build, tests, and diff checks before restarting the served application.

## Reverb parameter verification
- Added persisted `Decay`, `Pre-delay`, and `Damping` ranges beside reverb `Wet / dry`, with legacy saved effects receiving `2.4s`, `20ms`, and `8kHz` defaults.
- The native wet path is now source → pre-delay → convolver → low-pass damping → wet gain. A browser-instrumented playback confirmed a `6.3s` regenerated stereo impulse, `205ms` pre-delay, `10.1kHz` low-pass cutoff, and fourteen graph connections while playback remained active.
- Keyboard input and reload persistence were exercised for every new control. Wide rendering keeps all four reverb controls on one row; narrow rendering preserves them through effects-local horizontal scrolling.
- `npm run check`, `npm run build`, all `17` tests, and `git diff --check` passed. The rebuilt production surface was loaded from `http://localhost:4173` and exposed all four reverb controls.

## Compact control follow-up
- **Goal:** Left-align empty Layers/Sequence copy, add a direct `+ Sequence` action beside sequence generation, and make wet/dry the final field in both effects rows.
- **Design:** Reuse the existing empty-state class and CTA styles. A new sequence receives four default clips targeting the first layer, becomes active immediately, and uses the existing persisted sequencer shape.
- **Acceptance:** Both empty messages align to their section's left edge; `+ Sequence` mirrors `+ Layer` responsive labeling and disabled state; effect behavior is unchanged while reverb orders Decay, Pre-delay, Damping, Wet/dry and delay orders Time, Feedback, Wet/dry.
- Empty sequences render only their left-aligned empty-state copy; their per-row play, shuffle, settings, and clear controls remain hidden until clips exist.
- **Verification:** Exercise empty and loaded states, add and reload a sequence, inspect effect field order at wide and narrow widths, then run typecheck, build, tests, and diff checks before restarting the production server.

## Compact control verification
- Empty Layers and Sequence copy computed to `text-align: left`; an empty sequence exposed zero per-row controls while a populated sibling retained play, shuffle, settings, and clear.
- `+ Sequence` remained disabled without usable source/layer input. With audio loaded, it added `Sequence 2`, made four clips targeting the first layer, rendered the standard four row controls, persisted both sequences, and restored them after reload.
- Browser geometry confirmed the effect field order as Reverb: Decay, Pre-delay, Damping, Wet/dry and Delay: Time, Feedback, Wet/dry. At `320px`, the sequence action used its compact `+` label and remained within the header.
- `npm run build`, all `17` tests, and `git diff --check` passed. The rebuilt `http://localhost:4173` surface exposed the add action, both final effect orders, left-aligned empty copy, and no controls for its empty sequence.

## Empty-copy inset correction
- Layers and Sequence wrap their empty copy differently, so a shared internal padding produced mismatched visible insets. The layer empty state now matches the Sequence container's `10px` desktop and `8px` responsive inset, while the Sequence empty state adds no second inset.

## Three-band compressor
- **Goal:** Add one Compressor row with independent Low, Mid, and High amount sliders.
- **Design:** Split the final reverb/delay mix at `250Hz` and `4kHz`, run each band through a native `DynamicsCompressorNode`, and recombine them. Amount maps `0–100%` to a `0dB` through `-60dB` threshold with fixed `6:1` ratio, `30dB` knee, `3ms` attack, and `250ms` release.
- **Bypass:** When all three amounts are zero, the unfiltered final mix goes directly to output and the multiband sum is muted. Parameter changes crossfade to the multiband path and update thresholds during playback.
- **Acceptance:** Low, Mid, and High share one persisted, keyboard-operable row; old saved states default each amount to zero; live playback updates the three thresholds without rebuilding the graph.

## Three-band compressor verification
- Browser instrumentation created three `DynamicsCompressorNode`s and `250Hz`/`4kHz` crossover filters. At `25%`, `50%`, and `75%`, thresholds were `-15dB`, `-30dB`, and `-45dB`; all nodes used the fixed `6:1` ratio, `30dB` knee, `3ms` attack, and `250ms` release.
- During active playback, one-step slider changes updated thresholds to `-15.6dB`, `-30.6dB`, and `-45.6dB` without creating new compressor nodes. Returning all bands to zero switched the output gains to dry `1` / multiband `0`.
- Keyboard input, reload persistence, legacy zero defaults, wide one-row alignment, and narrow effects-local scrolling were exercised in the browser. The rebuilt `http://localhost:4173` surface exposed Low, Mid, and High on one row.
- The empty-copy inset correction measured an exact `0px` Layers/Sequence difference at both `1440px` and `320px`, including the rebuilt production surface.
- `npm run build`, all `17` tests, and `git diff --check` passed.

## Compressor NaN repair
- Preserved pre-compressor React state can lack the newly added band fields during development hot refresh, producing `NaN%` before a full reload. Band amounts are now normalized at every UI, persistence, and AudioParam boundary; missing or non-finite values become zero immediately.
- Browser verification supplied `"NaN"`, `null`, an object, and a missing band value. Both development and rebuilt production surfaces rendered `0%`, set each range to `0`, and rewrote all three persisted amounts as finite zeroes. `npm run build`, all `17` tests, and `git diff --check` passed.

## Header action spacing
- Layers and Sequence now share one action-group spacing rule: equal `8px` desktop, `5px` compact, `2px` narrow, and `4px` icon-label horizontal padding, with zero inter-button gaps and the same `24px` play-control width.
- Browser geometry at `1440px`, `688px`, `590px`, and `470px` confirmed matching Layers/Sequence play widths, horizontal paddings, zero inter-button gaps, and right-edge alignment. The rebuilt production surface matched at `470px`; `npm run build` and `git diff --check` passed.

## Aggregate playback, action icons, and sequence generation
- **Aggregate transport:** The Layers header is explicitly labeled Play/Pause/Resume all layers and remains wired to the full arrangement render; the Sequence header remains wired to the simultaneous all-sequence render. Muted layers stay intentionally excluded.
- **Shared icons:** Play, shuffle, headphones, settings, link, and destructive actions now use the shared `IconButton`; shared stroke icons use one `12px` viewBox/stroke treatment and block SVG layout. Headphones geometry is optically centered, and sequence settings uses a lighter sliders icon instead of the dense filled gear.
- **Sequence deletion:** The row X removes the complete sequencer, selects the next available row, closes row popovers, and stops aggregate or matching sequence playback before removal.
- **Sequence generator:** Generate Sequences now opens a Layers-style dropdown with `Rows` (`1–12`) and `Columns` (`1–32`) inputs plus an explicit Generate action. Generation replaces the grid with the requested randomized dimensions and closes the panel.
- Generator panels are capped to their section width; below `480px`, the shared form row wraps instead of extending beyond the viewport.

## Aggregate playback, icon, deletion, and generator verification
- With two layers loaded, the Layers header transitioned `Play all layers` → `Pause all layers` → `Resume all layers` while the footer transitioned PLAYING → PAUSED → PLAYING. With two populated sequences, the Sequence header produced the same aggregate transition.
- Headphones, shuffle, and settings SVGs all rendered as shared `action-icon` instances. Browser geometry measured exact `0px` horizontal and vertical center deltas for headphones and settings; the lighter settings-sliders glyph visually matched the shared stroke family.
- A generated `2 × 3` grid produced two persisted sequence rows with three clips each. Removing one row reduced the persisted and rendered count without leaving an empty row; removing the last sequence during aggregate playback stopped playback and left zero rows.
- At `320px`, the Sequence generator exposed Rows and Columns, wrapped its shared form, stayed exactly within `0–320px`, and caused no document overflow. The rebuilt production surface repeated the header labels, icon centering, contained dropdown, and complete-row deletion checks.
- `npm run build`, all `17` tests, and `git diff --check` passed.

## Keyboard layer triggers
- **Mapping:** Layers `1–12` use the visible physical-key bindings `1–9`, `0`, `−`, and `=`. Keyboard shortcuts are ignored while an input, select, textarea, button, or editable element has focus.
- **Modes:** Each layer persists `One-shot` by default or `Gate`. One-shot plays through after key release and restarts from the beginning on a new physical press; Gate starts on keydown and follows the shared ADSR attack, decay, and sustain envelope, then uses the configured ADSR release time on keyup or window blur.
- **Playback design:** Keyboard layers use independent polyphonic source/gain voices feeding one shared keyboard effects bus and AudioContext. This avoids rebuilding the reverb/delay/compressor graph per voice and prevents transport pause from accidentally suspending keyboard voices.
- **Safety:** Key auto-repeat is ignored, mute suppresses triggers, removed layers cancel pending/active voices, the global Stop action stops keyboard voices, and async Gate rendering cannot start after its key has been released.
- **Verification:** Instrumented production playback showed Gate creating one source on keydown and stopping it on keyup; One-shot survived key release, stopped/restarted the prior source on a second press, and stopped through the global Stop control. Holding Gate while starting One-shot kept both sources active, repeated keydown created no second source, and typing a mapped key in the layer-name input created no source.
- **Persistence and layout:** Reload preserved `gate` / `one-shot` values and visible `1` / `2` bindings. At `320px`, the document had zero horizontal overflow; the layer list scrolled locally and exposed the complete trigger controls.
- **Gates:** The final production build repeated Gate keyup, One-shot release, and global Stop behavior. `npm run build`, all `17` tests, and `git diff --check` passed.

## ADSR gate release and sequence invariants
- Gate note-off uses the ADSR release setting captured when the voice starts; retrigger and global Stop retain only a short anti-click stop rather than changing the musical release behavior.
- A sequence must contain at least one clip. Constructors require a layer target, persisted empty sequences are discarded, deleting a layer removes its clips and any sequence left empty, and deleting a sequence's final clip removes that sequence.
- **Correction verification:** With ADSR Release set to `1.25s`, instrumented production playback scheduled Gate note-off exactly `1.25s` after keyup and kept Stop enabled until the release completed. Removing clips through the final clip removed the sequence row; removing the only layer removed its four dependent clips and sequence row; six injected persisted empty sequences normalized to zero rows and were removed from persisted state.

## Row icon controls
- Layer and sequence row CTAs share the same `IconButton` component and `row-icon-actions` layout. Both groups use the same button dimensions, alignment, and gap; the layer trigger controls are spaced separately from the icon group. Layer controls are ordered Play, Headphones, Shuffle, Remove.
- Headphones/mute uses shared `aria-pressed` state styling and sequence settings uses shared `aria-expanded` styling. Active toggles keep the accent foreground without a persistent background fill. Their bespoke hover overrides were removed, so play, randomize, headphones, and settings receive the same hover treatment; destructive actions retain only their semantic red hover color.
- **Verification:** On the rebuilt production surface, layer and sequence row icons rendered at `20px × 20px` with identical adjacent spacing. Layer Play, sequence Play, randomize, headphones, and settings all computed the same hover background `rgb(32, 36, 39)`, foreground `rgb(201, 203, 200)`, and border treatment. Playing Play, pressed headphones, and expanded settings each computed a transparent resting background with the same accent foreground.
- Layer and sequence rows share the same inset rule: `6px` inline at desktop widths and `3px` at the existing responsive breakpoint. Sequence content no longer adds a second `10px` horizontal inset or `4px` / `8px` vertical wrapper padding.
- **Padding verification:** Production computed identical left/right row padding for layers and sequences, zero wrapper padding around sequence rows, and zero top inset for both row lists. At `320px`, both computed `3px` inline padding with zero document overflow.

## Sequence mute and aggregate row state
- Every sequence row persists a `muted` state and exposes the shared Headphones `IconButton` in the order Play, Headphones, Shuffle, Remove. Existing persisted sequences migrate to unmuted.
- Aggregate sequence playback excludes muted sequences and disables its header Play control when all sequences are muted; direct row preview remains available. Aggregate layer playback likewise excludes muted layers and disables its header Play control when none are audible.
- Layer and sequence header playback now drives the participating row Play icons through Play, Pause, and Resume. Clicking a participating row's Pause or Resume control toggles the same aggregate transport; muted rows remain in the Play state.
- **Verification:** With two sequences and the second muted, production aggregate playback reported `Playing 1 sequences`; the header and first row changed to Pause then Resume together while the muted row stayed Play. Layer header playback produced the same synchronized row state. Reload preserved Main as Mute and Sequence 1 as Unmute, and the sequence CTA order was Play, Headphones, Shuffle, Remove.

## Pastel layer identities
- Editable layer names are removed. Layers retain generated `Layer N` labels only for accessible names and status text; each row's sole visible identity is a 3px pastel circle centered vertically in its left gutter.
- `src/shared/layer-colors.ts` provides the Chroma-equivalent color pipeline without a runtime dependency: a 24-color HSL pastel palette, WCAG luminance contrast against `#101112`, Oklab perceptual distance, and maximin selection so each new layer is both readable and distinct from existing layers.
- Layer colors persist, generated arrangements receive seeded colors without perturbing audio generation randomness, and legacy saved layers migrate from custom names/missing colors to `Layer N` plus unique palette colors.
- Sequence clips use their target layer's exact color, replacing unrelated per-sequence tone classes. Accessible clip labels still identify the target as `Layer N`.
- **Verification:** Twelve allocated colors were unique with minimum WCAG contrast `6.41:1` against the app background and minimum pairwise Oklab distance `6.31`. Production showed no visible layer names; each marker computed to exactly `3px × 3px` with `50%` border radius and a vertically centered position; sequence CTA centers matched their row centers; and clip fills matched their target layer colors. Colors remained stable across reload and legacy custom-name/color migration succeeded. At `320px`, sequence clips scroll locally and the document has zero horizontal overflow.

## Unconditional sequence looping
- Sequence playback always loops. Individual sequence playback, aggregate sequence playback, and aggregate duration fitting no longer branch on saved preferences.
- Layers scheduled inside sequence cells always loop to fill their cell duration.
- The obsolete `loopSequence` and `loopLayers` schema fields, defaults, persistence output, controls, settings popover, and settings icon are removed. Legacy saved values are discarded while the remaining sequencer fields migrate normally.
- **Verification:** Production playback created looping Web Audio buffer sources for both an individual sequence and the aggregate sequence control (`loop === true` in both cases). No loop labels or settings buttons remained, and persisted sequencers omitted both obsolete fields. The always-fill layer scheduling contract passed with the full 17-test suite.

## Narrow viewport reflow
- At `720px` and below, each layer and sequence row collapses its controls into an ellipsis dropdown aligned inline at the far right of the row content. Layer menus stack the keyboard number, trigger-mode icon, play, mute, randomize, and remove on six distinct lines; sequence menus stack their four actions. CTA activation keeps the menu open for repeated adjustments; outside click, Escape, or the ellipsis trigger dismisses it. Wide clip sets scroll inside the remaining clip space. Desktop continues to show every action directly in a horizontal row.
- At `480px` and below, each layer parameter receives its own full-width row and restores its value output. Reverb, delay, and compressor controls also use one control per line; from `481–720px`, effect groups use two control columns. The layer color marker moves to the top-left and doubles from `3px` to `6px`; an `18px` content gutter keeps it clear of Start. Sequence cells scale from a `36px` base to `24px`, including proportional widths for longer clips, and their gap narrows from `3px` to `2px`.
- **Verification:** At `390px`, the layer menu exposed six controls on six distinct lines. Switching trigger mode and toggling layer mute both left the menu expanded; sequence mute did the same for its menu. Opening another menu still closed the prior one. The five layer sliders remained on distinct lines, the marker remained `6px × 6px`, and sequence cells remained `24px × 24px`. At `900px`, ellipsis triggers were hidden and both action groups retained horizontal direction. The document reported zero horizontal overflow at both widths.

## Square markers and trigger-mode icons
- Layer color markers are square at every viewport: `3px × 3px` on desktop and `6px × 6px` on mobile.
- Ableton's Launch Modes define Trigger as key-down starts/key-up ignored—the same behavior as this app's One-shot—and Gate as key-down starts/key-up stops. Ableton's chooser remains textual, but its Clip Launch control uses a triangular launch glyph. The compact local toggle therefore uses a triangle aimed at an end bar for One-shot and a square-pulse waveform for Gate rather than copying a nonexistent Ableton per-mode icon pair.
- The former text select is a single icon button. Clicking it atomically switches the stored mode and glyph; its changing accessible label announces the current mode and destination mode. The existing keyboard-trigger behavior is unchanged.
- **Verification:** Production desktop showed a `3px` square marker, no trigger-mode select or visible `One-shot`/`Gate` text, and a button labeled `Layer 1 trigger mode: One-shot. Switch to Gate`. Activating it changed the label to Gate, set `aria-pressed="true"`, and replaced the two-path One-shot glyph with the gate waveform. At `390px`, the marker was a `6px` square and the icon toggle remained visible inside the vertically stacked layer menu with zero document overflow.

## Stacked mobile generators
- At `720px` and below, both generator popovers use a fixed `160px` viewport-bounded width and stack every form child vertically. Labels keep their number inputs aligned opposite the label, while link and Generate actions align at the lower right. Desktop generator controls remain horizontal.
- The mobile layer square now starts at `top: 9px`, exactly centering its `6px` height against the Start parameter row while retaining the dedicated left gutter.
- **Verification:** At `390px`, the layer generator reported column direction with four controls on four distinct lines; the sequence generator reported three controls on three distinct lines. Both panels computed to `160px` and stayed within the viewport. The square and Start row center coordinates matched exactly. At `900px`, the open sequence generator returned to row direction and intrinsic width. The document retained zero horizontal overflow.

## Shared section headers and ADSR spacing
- Layers, Sequence, and ADSR/Effects now render through the same `SectionHeader` component. It owns the shared `section-action-row`, toggle semantics, marker, `aria-controls`, and optional right-side actions, preventing ADSR from silently losing the standard header border again.
- ADSR/Effects uses `6px` top padding instead of the previous fractional `13.40625px`, matching the minimal border-to-first-control spacing of the other expanded workspace sections while preserving existing inline and bottom padding.
- **Verification:** At `390px`, all three sections had exactly one direct shared header row with the same `24px` height and identical solid bottom-border width/color. The ADSR header-to-Attack and Layers header-to-Start gaps both measured `9px` after browser scaling. Collapsing ADSR removed its content and internal header border while retaining the section's outer border, matching the shared collapsed-section behavior. Zero document overflow.

## Sequence timeline revamp
- **Goal:** Give every sequence an editable duration and place non-overlapping clip triggers at arbitrary absolute times, with empty gaps as first-class timeline space.
- **Non-goals:** No new UI dependency, backend change, unrelated layer/effect redesign, or change to unconditional sequence looping.
- **Model:** `Sequencer.durationSeconds` bounds stable-id clips. Each clip owns `startSeconds`, `durationSeconds`, and `repeatFill`; playback scheduling and the UI use those absolute seconds directly.
- **Interaction:** Drag the sequence end anchor or right-click it to type duration in seconds. Drag either clip edge; crossing an adjacent clip shortens that neighbor rather than creating overlap. Click an empty gap to insert a default-length clip and immediately open its source/repeat-fill popover.
- **Acceptance:** Duration controls, gap insertion, source selection, repeat-fill, collision behavior, persistence migration, playback gaps, and responsive rendering work in the real surface.
- **Verification:** Focused scheduling tests, typecheck/build/test, and browser pointer/context-menu/keyboard/responsive playback smoke.
- **Tracking:** Bead `tunestretch-e88`.
- **Implementation:** The shared model now stores sequence and clip timing in absolute seconds. The production timeline renders gaps, stable clips, a draggable/right-clickable end anchor, clip source/repeat-fill controls, and a moving sequence playhead.
- **Browser verification:** At `1440px`, typing duration changed `8.00s → 10.00s`; dragging the end anchor changed `10.00s → 11.00s`. A gap click inserted a `1.00s` clip and opened its editor. Source changed from Layer 1 to Layer 2 and Repeat fill persisted off.
- **Collision verification:** Dragging clip 1's right edge through clip 2 shortened clip 2 to `0.50s`; dragging clip 2's left edge back through clip 1 shortened clip 1. Both cases persisted with exactly zero overlap.
- **Playback and migration:** Individual sequence playback exposed a moving playhead plus pause/resume states. A legacy base-length/gap sequence migrated to a `4.00s` timeline with clips at `0–1s` and `2–4s`.
- **Responsive verification:** At `320×800`, the clip editor and duration popover remained within the viewport, both resize handles remained present per clip, and document `scrollWidth` stayed `320`.
- **Static verification:** `npm run check`, `npm test` (`15` passing), `npm run build`, and `git diff --check` passed.
- **Keyboard verification:** Activating the empty timeline surface with Enter inserted the clip in the first available gap, opened the same editor, and moved focus to `Clip layer source`.
