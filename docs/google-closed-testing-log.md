# Google Closed Testing Track Log

Short-form log of the Google Play closed-testing track status, and any
issues/fixes discovered specifically during that testing period. This file
is plain human-authored project history — not machine-parsed — kept only so
the Sparring workflow tooling can allowlist edits to it as harmless
same-stage follow-up documentation.

## Google's requirement

Google requires at least 12 testers opted in continuously for at least 14
days before a closed testing track can graduate.

## Status

**As of 2026-09-09:** 12/12 testers opted in continuously, day 5 of 14. No
start or eligibility date is recorded here — none was confirmed — so none is
projected; status is tracked in terms of days elapsed against the 14-day
window instead.

**As of 2026-09-11:** day 7 of 14 by the count above. The Finds smooth-
pagination plan's three stages are all accepted on `feature/sparring-v2-pilot`
and device-verified by the developer; the track is reported as all good. Tester
opt-in count was not re-checked for this entry.

## Changes Applied

### Day 7 (September 11, 2026)

**Finds prefetch and incremental hydration (Stage 3)** — see `docs/plans/completed/2026-09-09-finds-smooth-pagination.md`, sections 3.0–3.8
- The next Finds page is now requested about one viewport ahead through an `IntersectionObserver` on a stable bottom sentinel, instead of 240 px from the bottom, so fast scrolling normally never reaches an unloaded boundary. A viewport-derived scroll fallback covers WebViews without the observer.
- Red-list badges and author profiles no longer block a page from rendering; they arrive in the background and are patched into existing cards. Profile hydration now merges instead of rebuilding, so earlier pages keep their authors.
- The Finds empty state can no longer flash before the first authoritative page has returned (transient observed during Stage 2 device QA).
- If the user does out-run prefetch, a subtle inline "Loading more finds…" line appears in the list footer while waiting. Not a toast or popup.
- Independent review (agent-sparring, codex-cli) sent the first candidate back for stale observer reports bypassing the geometry gate and a latched indicator; both fixed in the second commit. Device QA passed on `8d3276f`.
- Commits: `c149c86`, `8d3276f`. Files changed: `src/screens/finds.js`, `src/screens/finds.test.js`, `src/i18n.js`, `src/style.css`.

**Finds incremental load-more rendering and thumbnail preservation (Stage 2)** — see the same plan, sections 2.1–2.11
- Load-more now appends the new page in place instead of rebuilding the whole list, so existing cards, `<img>` nodes and media bindings survive and thumbnails stop flashing white on pagination. Image-metadata lookup runs only for the newly added ids.
- Returning from an observation's detail view re-renders from the already-loaded pages instead of refetching page 1, so scroll position is restored correctly past page 1.
- Device QA on the first frozen candidate found a double thumbnail flicker per typed search character; the keystroke narrowing render and the debounced authoritative reload now reconcile in place as well, with a survivor-order gate that compares against display order (species grouping) rather than cache order. Device QA passed on `683e843`.
- Commits: `b609404`, `654502f`, `d20aef3`, `d8461fc`, `683e843`. Files changed: `src/screens/finds.js`, `src/screens/finds.test.js`, `src/screens/find_detail.js`.

**Test-anchor hardening** — `4c0caac`, `5786136`: source-contract test anchors now fail loudly on anchor rot instead of passing silently. Tests only, no product change.

### Day 5 (September 9, 2026)

**Finds search pagination correction (Stage 1)** — see `docs/plans/completed/2026-09-09-finds-smooth-pagination.md`
- Fixed two search-input defects found by independent code review: the render-guard/paging invalidation ran after the local narrowing render started (discarding that render once its async image lookup resolved), and the debounce timer armed unconditionally even for a normalized-equivalent edit (letting it silently reset paging to page one).
- Files changed: `src/screens/finds.js`, `src/screens/finds.test.js`.
