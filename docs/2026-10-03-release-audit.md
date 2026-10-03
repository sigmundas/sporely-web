# Release audit — 2026-10-03

Audited clean branch `feature/find-detail-spore-mosaic`, candidate `180a73e`,
against base `d58eecb`. Fixes are local working-tree changes; no release,
production write, migration, commit, or PR was performed.

## Fixes

- Mosaic URLs must match the configured upload Worker origin (default
  `https://upload.sporely.no`) before receiving a bearer token. Reject URL
  credentials, lookalike hosts, protocol downgrades, and invalid versions.
- The optional mosaic RPC no longer holds up the gallery/form. Replacing a
  mosaic explicitly releases its protected binding. Failed fetches remain
  hidden, and a later refresh can retry them.
- Import the missing `buildFullImageFitByteCapAttempts` helper so oversized
  images can retry smaller dimensions on the main-thread canvas path.
- Photo deletion captures the original observation ID, checks all database
  errors, and guards UI updates against navigation. A failed inventory read
  cannot clear the cover. Deletion and cover maintenance remain separate
  requests; a cover failure is reported and can be retried.
- Escape stored AI error/unavailable messages before rendering them as HTML.
- Patch six lockfile dependencies within existing package ranges: xmldom,
  brace-expansion, nanoid, postcss, tar, and Vite. No direct package upgrades.

## Verification

- Node suites: 1,536 passed, 37 skipped, zero failures (split between frontend,
  scripts, Worker, Vite, delete-account, and CSS-loader test files).
- Deno: 70 admin tests and 42 reference-curation tests passed with type checking.
  The initial `npm test` had six Deno-only `jsr:` import failures; Node cannot
  run those test files. They pass when run under Deno with repository configs.
- Python geography backfill: 12 unittest tests passed.
- Production web build, build-time Google client ID / upload URL checks,
  Capacitor doctor, Android sync, and debug APK build passed.
- ESLint: zero errors, 52 warnings (down from 53). Build still reports large
  chunks. Dependency audit after patches: zero vulnerabilities.
- Chromium smoke test at 390×844 with real CSS and public mosaic bytes:
  authenticated loader header, image display, click-to-enlarge, close, and
  removal passed without browser errors. The session and request response
  were stubbed; this was a component smoke test, not a real account login.
- Read-only Supabase checks on linked project `zkpjklzfwzefhjluvhfw` confirmed
  the deployed presentations RPC and delivery authorization definitions.
  Among 113 anonymously visible mosaics sampled through the RPC, none was
  denied by delivery authorization. Owner, draft, visibility, banned-author,
  and blocked-user gates are present in the deployed definitions; authenticated
  combinations were not exercised with actual account sessions.
- Live Worker OPTIONS and public mosaic GET both allow `https://localhost`;
  GET returned image/webp with `Cache-Control: no-store` and `Vary: Origin,
  Authorization`.

## Before release

No physical Android device was connected. Test an owner draft mosaic and a
published mosaic on Android, including enlargement; check a denied viewer,
rapid switching between finds, and photo deletion. The built debug APK is at
`android/app/build/outputs/apk/debug/app-debug.apk`. A fresh top-level release
review and actual-account end-to-end checks are still outstanding.

## Re-audit of Claude update `5c3c597`

This section supersedes the earlier layout and Node-test status above. Claude
moved the mosaic into the gallery, added calibrated scale bars, introduced
thumbnail-first/full-image viewer loading, and changed detail loading order.
The prior compression fix and dependency patches remain uncommitted.

Additional local fixes:

- Retain a mosaic RPC result that arrives before the observation; previously
  the new request order discarded it because `currentObs` was still null.
- Ignore author/social responses belonging to an earlier detail load.
- Keep the preview when full-image resolution fails, instead of assigning a
  protected Worker URL directly to the viewer without its bearer header.
  Synchronously throwing resolvers also fail gracefully.
- Share/save resolves the authorized full image even when the thumbnail is
  still displayed. Failed full-image cache entries release their loader bindings.
- Validate the Worker origin on the full-loader path for protected sources too.
- Refresh scale-bar state after assigning a new photo, avoiding old-photo state
  while its preview/full image loads.

Verification: all Node suites passed (1,544 passed, 37 skipped); regression
coverage includes resolver failure, synchronous errors and late results after
viewer close. Production build, Android sync/debug build, and dependency audit
passed (zero vulnerabilities). Changed production modules have zero lint errors
and two existing warnings. Mobile-width Chromium exercised `openFindDetail`
with a deliberately delayed observation and an immediate mosaic response,
actual HTML/CSS and real mosaic bytes; gallery reveal, viewer click, scale bar
and close passed without page errors. Supabase responses and session were
stubbed in this browser check; physical Android/account end-to-end checks remain
outstanding. No schema/deployment change or production write was performed.
