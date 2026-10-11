# Clear (×) button on the find-detail species input

Status: approved 2026-10-11 by the owner. Follow-up to
`docs/plans/active/2026-10-11-taxon-input-clear-button.md`, whose Stage 1 was
accepted at `7123417` but missed this screen. During the owner's manual check,
the owner saw no clear button when editing an existing observation.
Repository: `sporely-web`. Branch: `feature/taxon-input-clear-button`.

## Why

The find-detail screen (editing an existing observation) has its own species
input, separate from capture review and import:

- Markup: `index.html:687` (`#detail-taxon-input`, `#detail-taxon-dropdown`).
- Wiring: `src/screens/find_detail.js:1652-1667`. On `input` it sets
  `selectedTaxon = null`, resets the header via `_setDetailHeader`, and runs a
  debounced `_searchTaxon`.
- Programmatic fills: `:1889` (load), `:3116` (AI prediction click),
  `:3553` (reset to empty), `:4517` (dropdown selection).

## Fixed decisions

- Reuse `src/taxon-clear-button.js` and the `.taxon-field-wrap--clearable`
  styling from the accepted stage. No second implementation.
- Clicking × has exactly the effect of deleting the text by hand (the
  existing `input` handler does the work). The dropdown hides and focus
  returns to the input.
- Button visibility syncs after every programmatic fill listed above.
- No change to capture review, import, search or saving.

## Stage 1 — Clear button on the find-detail species input

Add the button to the `index.html` markup (the `aria-label` must come from
`detail.clearSpecies` through the existing i18n mechanism for static markup,
e.g. the `setPlaceholder`/`setText` pattern in `src/i18n.js`, so it follows
language switches). Wire it in `find_detail.js` and sync it at each
programmatic fill.

Tests: focused tests in the style of the existing find-detail tests. Cover
hidden when empty; shown after load with a taxon and after an AI prediction
click; click clears the value, nulls the selection, hides the dropdown and
focuses the input.

Verification: `node --test` on the touched test files, the full `npm test`
(6 Supabase `*.test.ts` failures pre-exist on `main` and are unrelated),
`VITE_TURNSTILE_SITE_KEY=placeholder npm run build`, eslint on touched files,
`git diff --check`. A phone-width manual check of all three screens is a
deferred human check.
