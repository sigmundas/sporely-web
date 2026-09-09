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

## Changes Applied

### Day 5 (September 9, 2026)

**Finds search pagination correction (Stage 1)** — see `docs/plans/active/2026-09-09-finds-smooth-pagination.md`
- Fixed two search-input defects found by independent code review: the render-guard/paging invalidation ran after the local narrowing render started (discarding that render once its async image lookup resolved), and the debounce timer armed unconditionally even for a normalized-equivalent edit (letting it silently reset paging to page one).
- Files changed: `src/screens/finds.js`, `src/screens/finds.test.js`.
