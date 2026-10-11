# Clear (×) button on the species input

Status: approved 2026-10-11 by the owner (request: "add an x to clear text
input (from AI ID prefill or previous entries)").
Repository: `sporely-web`. Branch: `feature/taxon-input-clear-button` from
`main` (`c9aeebe`).
Companion plan (separate, not part of this run): sporely-py
`docs/plans/active/2026-10-11-unified-taxon-search.md`.

## Why

The species input is often filled before the user types: an AI-ID result
applies a taxon (`src/screens/review.js` `applyTaxon(0, taxon, {source:'ai'})`,
around `:1858`), or the field keeps an earlier entry. Clearing it now means
selecting and deleting the text by hand, which is awkward on a phone.

## Current behaviour (evidence)

- Review screen input: `src/screens/review.js:1301-1311`
  (`input.taxon-input.detail-taxon-input` + `ul.taxon-dropdown` inside
  `div.taxon-field-wrap`).
- Input handler `review.js:1451-1475`: an empty value calls
  `setSharedTaxon(null, …)` and resets `reviewAiState.selectedTaxonSource`
  to `'manual'`, `selectedService`/`selectedPrediction` to `null`, then
  `_syncReviewRedlistSummary()`; `handleTaxonInput` with empty `q` calls
  `applyTaxon(i, null)` (`:1484-1486`).
- Import review input: `src/screens/import_review.js:2198-2200`, wired in
  `_wireCard` (`:2311-2330`); an empty value sets
  `session.taxon = createManualTaxon('')`, `_clearSessionAiSelection`,
  `_persistSessions`, `_syncImportRedlistSummary`, and hides the dropdown.
- Styles for `.taxon-field-wrap` / `.taxon-dropdown`: `src/style.css`
  around `:4229-4271`.
- No clear button exists anywhere.

## Fixed decisions

- One shared behaviour on both inputs that use `.taxon-input` inside
  `.taxon-field-wrap`: the review screen and each import card.
- The button is visible only when the input has a non-empty value, and its
  visibility updates on every `input` event and after programmatic fills
  (AI apply, `setSharedTaxon` sync, card render with an existing value).
- Clicking it must have **exactly the same effect as the user deleting all
  the text**: reuse the existing empty-value path. Do not add a parallel
  clearing path that could drift (for example by dispatching an `input`
  event after setting `value = ''`, or by calling a shared helper both
  paths use). It must clear any AI selection exactly as manual deletion does.
- After clearing, focus returns to the input and the dropdown is hidden.
- The button must not take focus away in a way that triggers the existing
  200 ms blur-hide race into a stale selection; use `pointerdown`/`mousedown`
  `preventDefault` the same way the dropdown items do.
- Accessibility: a real `<button type="button">` with an `aria-label` from
  the i18n store, and a touch target of at least 32×32 px. Input text must not
  run underneath the button (right padding on the input).
- i18n: add one key (for example `detail.clearSpecies`) to every language
  block in `src/i18n.js` with a real translation (en "Clear species",
  no "Fjern art", sv "Rensa art", de "Art löschen"). No English fallback
  copied into other languages.
- Out of scope: search behaviour, dropdown ranking, Supabase/RPC, and the
  `'Uncertain ID'` literal at `review.js:1308`.

## Stage 1 — Clear button on species inputs

Implement the decisions above in `src/screens/review.js`,
`src/screens/import_review.js`, `src/style.css` and `src/i18n.js`. Prefer one
small helper for the button markup and wiring if it keeps both screens
identical; do not refactor the surrounding taxon code.

Tests: add focused unit tests next to the existing review/import tests
(follow the existing test style and DOM setup) covering:
- button hidden for an empty input, shown after typing and after a
  programmatic AI fill;
- clicking it empties the input, clears the taxon (review: shared taxon
  `null`; import: the session's manual empty taxon) and clears the AI
  selection state the same way manual deletion does;
- focus returns to the input.

Verification: `npm test`, `npm run build`, `npx eslint .` on touched files,
`git diff --check`. A manual check on a phone-width viewport (button
placement, no overlap with long scientific names, works after AI prefill) is a
reasonable deferred human check; it does not block acceptance.
