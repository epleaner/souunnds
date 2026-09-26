# Themed select control

State: current; Bead `tunestretch-2nl` in progress; clean `ep/sources-section` started at `aa551c3`.

## Goal and scope
Replace both native `<select>` controls in `src/web/App.tsx` with one themed, accessible dropdown: layer audio source and sequence clip layer target. Keep their controlled values, callbacks, disabled/unavailable sources, `src` prefix, selected layer color, and compact sizing. Non-goals: file/number inputs and the existing generate/action popovers.

## Decision and seam
`ThemedSelect` owns the accessible trigger, portal listbox, option focus/typeahead, dismissal, and shared dark-theme styling. Its caller API is `ariaLabel`, `value`, `onValueChange(value)`, `options: readonly {value,label,disabled?,color?}[]`, `variant: "source" | "clip"`, and optional `placeholder`; source shows the bordered `src` prefix and clip shows the selected color. A proposed Radix primitive could not be installed: `npm install @radix-ui/react-select` timed out after 120s, `npm ping` timed out after 12s, and npm cache has no copy. Use a dependency-free accessible React control instead, with a portal to escape `.layer-list` scroll clipping and explicit keyboard/focus/dismissal behavior. In the clip inspector, allow pointer events inside the portaled listbox without closing its parent outside-click handler. Empty value is the `No audio` placeholder; only nonempty source IDs are choices.

## Acceptance oracle
- At both callsites, the entire themed trigger opens a visibly themed option menu; no native select/picker remains. Choice updates layer source or clip target by their existing callbacks; disabled audio rows cannot be selected. Selected clip swatch and `src` prefix remain visible.
- Keyboard opening, arrow navigation, typeahead, Enter/Space selection, Escape dismissal, Tab/focus return, and outside click work. Option labels remain accessible; focus outline remains visible.
- A dropdown in a scrolled layer list and a clip inspector remains visible within the viewport; at 1289px and 320px there is no horizontal overflow. Empty/disabled options and long labels remain legible.
- Real browser import of two sources and layer/clip changes proves model integration; `npm test`, `npm run build`, and focused diff checks pass.

## Current evidence and next action
The source and clip controls both use the single `ThemedSelect` implementation; the old native selectors and markup are gone. No package manifest or lockfile change was needed after the npm registry timed out. The body-zoomed app requires converting trigger viewport coordinates to unzoomed CSS pixels for the portaled popup; its focused positioning code handles this and stays outside the clipped layer list.

## Verification
- In a browser with two imported WAVs, selecting a source changed its layer trigger and selecting Layer 2 in the clip inspector changed the clip label and swatch while leaving the inspector open. No native `<select>` remained in source or rendered DOM; the source retains its `src` prefix.
- The source dropdown opened by pointer and keyboard, ArrowDown/Home/End and typeahead moved the active option, Enter committed, Escape dismissed without changing selection, Tab moved focus, and selection returned focus to the trigger. The disabled empty source could not be chosen by pointer or keyboard; outside click dismissed the menu.
- At 1289px, the source popup fit under its trigger (x801.75–1134.5) and a popup for the last of seven layers remained visible outside a scrolled layer list. At 320px, the popup fit x8–312 and document scroll width stayed 320px. The clip popup remained visible within its inspector at 320px.
- Final `npm run build`, `npm test` (18/18), and `git diff --check` passed; browser console/errors empty. Next action: publish the verified diff and close Bead `tunestretch-2nl`.
