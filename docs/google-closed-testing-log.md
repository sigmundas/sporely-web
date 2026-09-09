# Google Closed Testing Track Log

**Testing Period:** 14 days (Day 5 of 14)  
**Start Date:** September 5, 2026  
**Expected End:** September 18, 2026  
**Status:** In progress

## Google's closed-testing requirement

Google requires at least 12 testers opted in continuously for at least 14
days before a closed testing track can graduate.

**Current status as of 2026-09-09:** 12/12 testers opted in continuously,
day 5 of 14. No eligibility date is projected here; it depends on the
12 testers remaining opted in for the remaining days.

## Summary

Short-form log of changes, issues, and outcomes during the Google closed testing track review period.

## Changes Applied

### Day 5 (September 9, 2026)

**Finds search pagination correction (Stage 1)** — uncommitted at time of writing, see `docs/plans/active/2026-09-09-finds-smooth-pagination.md`
- **Issue 1:** The search-input handler invalidated the render guard/paging state *after* starting the local narrowing render, so that render's async image lookup was discarded once it later checked the (already-invalidated) guard.
- **Fix 1:** Invalidate the render guard and reset paging *before* starting the local narrowing render, so the render captures the fresh sequence.
- **Issue 2:** The input handler always armed the debounced reload timer, even for a normalized-equivalent edit (e.g. trailing whitespace only). Once that timer fired, `_reloadFindsForSearch()` unconditionally reset paging back to page one, so an edit that didn't actually change the search text could still throw away pages the user had already scrolled through.
- **Fix 2:** Only arm/replace the debounce timer when the edit actually changed the normalized query; an equivalent edit leaves any already-pending timer (for a real prior change) untouched and does not arm a new one.
- **Files Changed:** `src/screens/finds.js`, `src/screens/finds.test.js`
- **Tests Added:** Two regressions in `finds.test.js` proving (a) the locally narrowed render commits after an async image lookup resolves post-invalidation, and (b) an equivalent edit neither arms nor disturbs the debounce timer while a real edit still does.

**Auth/Login Preservation Fix** — `a7de5e2`
- **Issue:** `_runSyncQueue()` was calling `getSharedAuthSession({ refresh: true })` unconditionally on every native app resume, even when the local queue was empty. This caused unnecessary Supabase auth touches and potential session thrashing on devices with frequent suspend/resume cycles.
- **Fix:** Reordered the sync queue logic to check the local queue first (pure local read) before performing any auth refresh. Empty queues now return without any network calls to Supabase auth.
- **Secondary Fix:** Stopped hardcoding "(transport)" suffix in session-refresh failure logs; now properly classifies auth rejections vs. transport errors using existing helpers (`isExplicitAuthRejection`, `isTransportSessionError`).
- **Dependency:** Bumped `@supabase/supabase-js` to `2.116.0` (lockless refresh coordination, proactive/reactive distinction to preserve valid sessions across failed proactive refresh).
- **Files Changed:** `src/sync-queue.js`, `src/sync-queue.test.js`, `package.json`, `package-lock.json`
- **Tests Added:** Regression suite in `sync-queue.test.js` verifies the queue-first check and auth-bypass.

## Known Issues / Open Questions

None reported yet (Day 5 of 14).

## Test Coverage

- ✅ Auth session preservation on native resume with empty queue
- ✅ Auth refresh logic re-ordered and tested
- ✅ Error classification for auth vs. transport failures

## Deferred Work

- Any additional auth/login improvements identified during testing
- Performance optimizations based on real-world usage patterns
- Broader testing on Android Play Store internal track (separate from this 14-day review)
