# Sporely-web Development Plan

## Purpose

`PLAN.md` is the active working plan for `sporely-web`.

Historical image/upload notes are archived in `HISTORY.md`. Current image-pipeline notes are in `docs/image-pipeline-phase1.md`.

# Review-screen location: freeze fix + capture-time location lock

Status: all three stages implemented and tested (2026-07-22), awaiting
on-device verification. See the 2026-07-22 entry in `HISTORY.md` for the
condensed summary.

## Incident and background

A user captured photos with the native camera, reached the review screen
("Gjennomgang"), tapped save, and the app froze showing the
"Preparing observation..." progress modal with the "Location is not ready"
sheet visible underneath but unresponsive. Force-quit was the only way out,
and the photos were lost (review photos are memory-only).

Audit found four root causes. All were verified against the code
(confirmed independently by a second review):

1. **Progress overlay deadlocks the location sheet (critical).**
   `saveObservationBatch()` (`src/screens/review.js`, ~line 2141) shows the
   `#import-progress` overlay, then awaits `_resolveReviewSaveLocation()`,
   which can await the save-location sheet indefinitely. The overlay is only
   hidden in the `finally`, which cannot run until the sheet resolves.
   Stacking makes the sheet untappable: `#review-save-location-overlay`
   (z-index 300, `style.css` `.sheet-overlay`) lives *inside*
   `#screen-review`, and `.screen.active` is `position:absolute; z-index:1`
   — a stacking context that caps the sheet at layer 1. `#import-progress`
   (z-index 180) is a sibling of the screens under `#app`, so it paints
   above the entire review screen and its full-screen backdrop swallows
   every tap. The sheet's promise can never resolve → save stays in flight
   forever.

2. **Save-time GPS retry never runs — token type mismatch (critical).**
   `_requestReviewSaveLocation()` and `_requestReviewLocationRetry()`
   (`src/screens/review.js` ~779 and ~891) pass
   `captureSessionRequestToken: 'live:<ms>'` (a string from
   `_currentReviewSessionKey()`). `geo.js` `_captureSessionRequestIsCurrent`
   compares with `token === liveCaptureSession.requestToken`, a *numeric*
   counter — always false → `_isInternalOverrideAllowed` rejects →
   `requestFreshLocation` returns blocked without ever calling the OS.
   So the first save attempt goes straight to "Location is not ready" and
   the sheet's "Try again" is a silent no-op. Existing tests miss this
   because `requestFreshLocation` is dependency-injected and stubbed
   (`__setReviewTestHooks`). Do NOT relax geo.js to accept arbitrary
   strings — the guard exists to stop stale requests from updating a later
   session. Expose the real token instead (a test-only accessor
   `__getCaptureLocationSessionRequestTokenForTests` already exists at the
   bottom of geo.js as a model).

3. **Live review photos are memory-only (verified: no persistence path).**
   `state.capturedPhotos` is touched only by `capture.js`,
   `import_review.js`, and `review.js` — nothing persists or restores it.
   The *import* flow already persists pending sessions to IndexedDB via
   `src/import-store.js`; the live camera → review flow has no equivalent.
   Force-quit before `enqueueObservation()` loses the photos.

4. **Location is resolved at save time, not capture time (design flaw).**
   For live reviews the canonical GPS is `state.captureSessionLocation.fix`
   read at save (`_canonicalReviewSaveGps`). The watch keeps running through
   review and `_isBetterSessionFix` (geo.js ~128) replaces the fix whenever
   a more *accurate* one arrives, with no capture-window restriction — if
   the user walks away while reviewing (or AI ID takes long), a later fix
   from the wrong spot can win. Also, per-photo EXIF/native GPS stored on
   `photo.gps` by `_addFilesToReview` is never consulted for live saves.
   Related smell: `saveObservationBatch` ignores `locationResult.gps`
   returned by `_resolveReviewSaveLocation` and re-reads
   `_canonicalReviewSaveGps()` (~line 2169), leaving a race window.

Desired model (product intent): lock the observation location as soon as
the images are in and a good fix exists — do not silently substitute the
device's current position minutes later. Distinguish:
- *location acquisition* — the watch may keep gathering candidates;
- *capture location* — an immutable fix selected for the photo batch;
- *current device location* — for maps / explicit "use current location"
  only, never silently substituted.

## Stage 1 — Unbrick save (P0, ship alone)

Status: DONE (2026-07-22). All items implemented; 315/316 tests pass —
the single failure is pre-existing and unrelated (`src/screens/map.test.js`
imports leaflet, whose `leaflet.css` import breaks under `node --test`;
fails identically on the unmodified tree). Not yet verified on a device.

- [x] 1.1 `_resolveReviewSaveLocation` now calls `_hideProgress()` before
      awaiting `_showReviewSaveLocationSheet()`, and sets the label to
      "Finding location…" while the save-time GPS request runs. Progress
      re-appears naturally ("Encoding images…" / "Finding location…") after
      a proceed/retry decision.
- [x] 1.2 `#review-save-location-overlay` moved from `#screen-review` to
      the `#app` root in `index.html`, next to `#import-progress`, with a
      comment explaining the stacking trap. No JS changes were needed
      (all lookups are by ID).
- [x] 1.3 `getCaptureSessionRequestToken()` exported from `src/geo.js`
      (returns null when no live session). Passed in
      `_requestReviewSaveLocation` and in BOTH geo calls of
      `_requestReviewLocationRetry` — the `startLocationWatch` call there
      had the same bug (internalOverride with no token = always blocked).
- [x] 1.4 `saveObservationBatch` uses `locationResult.gps ?? null` as
      `finalGps`.
- [x] 1.5 Tests added: review.test.js — "save-time location request
      reaches the real geolocation API with a valid session token"
      (real `requestFreshLocation`, fake `navigator.geolocation`, real
      timers — this is the test the DI stubs could never provide);
      "the progress overlay is hidden whenever the save location sheet
      awaits a decision"; "save location sheet is mounted at the app
      root..." (index.html structural assertion); "save flow hides
      progress before the sheet..." (source assertions, incl. forbidding
      `captureSessionRequestToken: sessionToken`). geo.test.js —
      "getCaptureSessionRequestToken returns the live token and is the
      only accepted override token" (asserts the `'live:<ms>'` string
      shape stays rejected). Sheet-button coverage already existed via
      DI tests (try-again / manual / save-without).

- [x] 1.6 (added after review) GPS pill silenced during save: the
      `review-gps-status` host (id added in `index.html`) is hidden while
      `reviewSaveInFlight`, `_syncReviewLocationWarning` makes no changes
      mid-save, and the pill is restored + resynced in the save `finally`
      only when the user is still on the review screen. After Save is
      pressed, the progress text and the fallback sheet are the only
      location feedback.

Manual QA checklist for the device (not yet done):
- Reproduce the incident setup: camera capture with location slow/off,
  tap save → the sheet must appear WITHOUT the progress modal on top,
  and all three buttons must respond.
- "Try again" with location now available must actually acquire a fix
  (previously silently impossible) and save with coordinates.
- While saving, the GPS pill must disappear (no warning flicker mid-save).

## Stage 2 — Capture-time location lock (P1, own PR, behavior change)

Status: DONE (2026-07-22). Implemented as a **capture window** rather than
a separate `lockedFix` field — smaller diff, same guarantees. Mechanism:

- `state.captureSessionLocation.captureWindowEndAt` (nullable ms epoch) =
  last photo timestamp + `CAPTURE_LOCK_GRACE_MS` (90 s). Set/refreshed by
  `_refreshCaptureLockWindow()` in `buildReviewGrid` for live reviews
  (covers review entry AND `_addFilesToReview`, which calls it). Cleared
  by `beginCaptureLocationSession` / `endCaptureLocationSession` and for
  imported reviews.
- geo.js `_captureSessionAcceptsFixTimestamp` rejects fixes whose
  timestamp is past the window, so the session fix (the observation's
  location source) can never absorb a walking-away position — even a
  more accurate one. The global `state.location.fix` still updates freely
  (map / other consumers). GOTCHA: the field is nullable — it must be
  null-checked BEFORE `_finiteNumber()`, because `Number(null) === 0`
  (finite!) and "no window" silently becomes "window ended at epoch 0".
- Canonical live GPS (`_liveReviewCanonicalGps`, used by both display and
  save): the more accurate of the window-restricted session fix and the
  lead photo's own `photo.gps` (EXIF for picker/native imports; capture.js
  stores the at-shutter fix object per photo). Tie-break: session fix.
  If photos' coordinates spread beyond ~200 m a one-per-session toast
  warns and the first photo's position is used.
- `_canAcquireReviewSaveLocation` returns false once the window is closed
  — no silent save-time acquisition. The sheet's explicit "Try again" and
  the warning banner's "Try again" call `_overrideCaptureWindowForSession()`
  (user consent to current position): sets a session-keyed override flag
  and nulls `captureWindowEndAt`; `_refreshCaptureLockWindow` respects the
  override so it does not re-close.
- The location watch is stopped (`_stopWatchIfCaptureWindowClosed`) from
  the review location listener and `buildReviewGrid` once the window is
  closed; guarded on `watchId != null` to avoid emit-recursion with
  `stopLocationWatch`.
- Pill shows "Location locked · ±x m" when a fix exists and the window is
  closed ("Location ready" while still open).

- [x] 2.1–2.4 as above.
- [x] 2.5 Tests: closed-window blocks silent acquisition + explicit retry
      overrides (review.test.js); per-photo GPS fallback; accuracy
      preference between session fix and photo gps; capture-window
      enforcement in geo.test.js ("session fix ignores fixes taken after
      the capture window closes"). `_seedReviewState` now defaults to a
      recent sessionStart so live tests run with an open window — pass an
      old `sessionStart` to test closed-window behavior. HISTORY.md
      2026-07-22 entry records the behavior change.

Manual QA for Stage 2 (not yet done):
- Capture a find, wait >90 s walking away, save: coordinates must be the
  capture-time position (or the sheet if none), never the current one.
- Pill flips to "Location locked" ~90 s after the last photo.
- Sheet "Try again" after the window still works and uses the current
  position (explicit consent).

## Stage 3 — Crash recovery for live reviews (P2, independent of Stage 2)

Status: DONE (2026-07-22). Implementation notes for handover:

- New module `src/review-draft-store.js`. It uses its OWN IndexedDB
  database (`sporely-review-drafts`, v1, store `review_draft`, single
  record id `'current'`, `schemaVersion: 1`) — `import-store.js` owns the
  `'sporely'` DB at version 1, and adding a store there would force a
  coordinated version bump across both modules. Blobs are stored as
  ArrayBuffers; photos with a pending `blobPromise` (capture.js pushes
  `blob: null` + promise) are resolved before the IDB transaction opens.
  Every operation is try/catch-warn — quota or missing-indexedDB failures
  never throw and never block saving the observation.
- Checkpointing in `src/screens/review.js`: `_checkpointReviewDraft()`
  runs from `buildReviewGrid` (covers review entry via router and
  `_addFilesToReview`), deduplicated by a key of session key + photo
  count/timestamps/custom-crop rects so the blob serialization only reruns
  when photos actually change. Field edits (habitat, notes, uncertain,
  visibility, draft toggle, precision, obscured) call
  `_scheduleReviewDraftFieldSync()` — a 600 ms debounce into
  `updateReviewDraftFields`, which merges fields into the stored record
  without rewriting blobs. Imported reviews are skipped entirely
  (import-store already covers them).
- Cleanup: `_discardReviewDraft()` on successful enqueue and on
  cancelReview. Unknown `schemaVersion` on load discards the draft.
- Restore: `restoreReviewDraft(draft)` exported from review.js; called at
  boot in `main.js` inside the existing `pending-import-restore` boot step
  — a pending import wins if both exist (the review draft stays stored for
  the next launch). Restore rebuilds `state.capturedPhotos`, captureDraft,
  session start/fix and `captureWindowEndAt`, sets the location-name
  input, navigates to review, and toasts "Restored unsaved find". The
  restored capture window is normally closed already, so Stage 2
  semantics prevent the post-crash position from being silently attached.

- [x] 3.1 (blobs + draft fields + capture-window state; AI results are
      NOT persisted — they re-run from the photos; noted as acceptable)
- [x] 3.2 delete on enqueue/cancel; schemaVersion; graceful quota failure
- [x] 3.3 restore on launch (silent restore + toast, matching the
      existing pending-import restore convention rather than a prompt)
- [x] 3.4 Tests: `src/review-draft-store.test.js` (round-trip incl.
      pending blobPromise, put-replaces semantics, field merge, clear,
      schema discard, no-photo guard, failure path) and
      review.test.js `restoreReviewDraft rebuilds the live session...`.

Manual QA for Stage 3 (not yet done):
- Capture photos, reach review, force-quit → relaunch: review reopens
  with the photos and a "Restored unsaved find" toast; saving attaches
  the capture-time location or offers the sheet.
- Save or cancel → relaunch: no restore.

Possible follow-ups (not scheduled): persist AI identification results in
the draft; restore-prompt UI instead of silent restore; i18n for the new
hardcoded strings (toast + sheet copy are English-only, matching the
existing sheet).

## Stage 4 — Actionable disabled-location GPS pill (capture + review)

Status: DONE (2026-07-22), then **largely superseded by Stage 5** the same
day — the off/unavailable pill split, `isLocationKnownOff`, and the
"Location is off · Tap to enable" wording were replaced by the single
"No location · Tap to fix" state + shared sheet. The settings-opening
helper (`openLocationSettingsOrExplain`) and the whole-pill tap target
survive. Kept for history:

- New shared module `src/location-settings.js`:
  `isLocationKnownOff(locationState)` (permission denied OR
  position-unavailable/system location off — deliberately NOT timeout),
  `supportsOpenAppSettings()` / `openLocationSettingsOrExplain()` (native
  Capacitor `App.openSettings`, otherwise a concise instructions toast).
  review.js's `_supportsOpenLocationSettings` / `_openReviewLocationSettings`
  now delegate to it (the warning banner keeps its behavior).
- Pill states on BOTH screens (capture `_normalizeCaptureLocationState`,
  review `_syncReviewGpsStatus`):
  - valid fix → "Location captured · ±x m" (renamed from "Location
    ready"; review keeps "Location locked" once the capture window closes)
    — never overwritten by warnings; the fix branch is checked first.
  - known off → "Location is off · Tap to enable",
    `data-gps-state="off"` (styled like unavailable), action
    `enable-settings`.
  - timeout / generic error → "Location unavailable · Try again", action
    `retry` (wording changed from "Couldn’t determine location").
  - preference 'disabled' → "Location not included" (reserved wording per
    the HISTORY gotcha), action `enable`. The capture screen's small
    Enable button remains, but the whole pill is now the tap target on
    both screens (`data-gps-action` + `cursor: pointer`; review pill got
    `id="review-gps-pill"`, `role="button"`).
- Tap dispatch: `enable` → opt in + retry acquisition; `retry` →
  re-acquire; `enable-settings` → opt preference in, re-check
  capability/permission (no doomed 10 s GPS wait when still denied), then
  either acquire immediately (permission actually available) or open app
  settings / show instructions. On review the tap also calls
  `_overrideCaptureWindowForSession()` so the fix acquired after returning
  from settings is not rejected by a closed capture window.
- Resume: geo.js's existing visibility-resume path
  (`resumeCaptureLocationSession`) re-checks capability/permission and
  retries acquisition; it activates because the tap set preference to
  'enabled' before the app was backgrounded by the settings screen.
- Stage 2 gap fixed while here: `startCamera` now nulls
  `captureWindowEndAt` — returning to the camera to add photos reopens
  the capture window (review recomputes it from the extended batch).
- Tests: capture.test.js "known-off location renders …" (off state + tap
  opens settings + no GPS request while denied) and "timeout keeps its own
  wording …" (timeout vs off distinction; captured fix never overwritten);
  review.test.js mirrors both. Existing wording assertions updated
  ("Location ready" → "Location captured", "Couldn’t determine location" →
  "Location unavailable").

## Stage 5 — One pill + one reusable sheet; camera never waits for GPS

Status: DONE (2026-07-22). Simplification pass over Stages 1/4 UX.

- **Camera-first capture.** `startCamera` no longer awaits the location
  preflight. `_startCaptureLocationFlow(token)` (capture.js) runs
  fire-and-forget AFTER the stream attaches — so the OS camera and
  geolocation prompts are never stacked (HISTORY iOS gotchas hold: only
  OS permission `granted` silently upgrades an 'ask' preference; 'prompt'
  still goes through the consent sheet, now shown over the live
  viewfinder). Denied/unsupported show NO prompt — the pill + sheet own
  failure UX. `prepareNewFindLocation`/`startNewFindLocationAcquisition`
  remain only for import_review.js.
- **One pill, three states** (both screens): "Location captured · ±x m"
  (valid fix always wins; the review "Location locked" label was dropped),
  "Finding location…", "No location · Tap to fix"
  (`data-gps-state="none"`). `position-unavailable` is NOT treated as
  proof the system location is off; only permission-denied is known
  blocked (and geo.js already short-circuits it — no 10 s waits).
- **One reusable sheet** `#location-fix-overlay` at the `#app` root
  (`src/location-fix-sheet.js`): Open location settings / Try again /
  Continue without location. Opened by the pill tap on either screen and
  by Save without a locked location. "Enter place manually" was removed
  (the Location text field handles place names); "Don't use location for
  future finds" was removed (persistent preference belongs in Settings).
- **Save shows the sheet immediately** — `_resolveReviewSaveLocation` has
  no automatic GPS wait. "Try again" = one short 8 s explicit request
  (`_requestReviewSaveLocation`), which opts the preference in and
  reopens the capture window (explicit consent). "Continue without
  location" suppresses the sheet for the session. "Open location
  settings" aborts the save (button re-enabled) and opens settings.
- **Removed:** the orange inline review warning
  (`#review-location-warning`, `_syncReviewLocationWarning`,
  `_reviewLocationWarningState` + all its buttons), the capture pill's
  small Enable button, `isLocationKnownOff`, the off/unavailable pill
  split, and the associated CSS.
- Capture-time locking, EXIF fallback, draft persistence, and the
  save-in-flight pill hiding are unchanged.
- Tests: both screen suites rewritten to the new model — save opens the
  sheet immediately (no auto request); failed retry re-opens the sheet
  until one succeeds; pill tap → sheet → settings (Capacitor stub);
  camera-first ordering (getUserMedia before the consent sheet); leaked
  fire-and-forget flows are cancelled in capture.test.js `afterEach` via
  `stopCamera()` (preflight token bump).

Manual QA for Stage 5 (not yet done):
- Camera viewfinder appears immediately even with location off/slow.
- Deny OS location → pill reads "No location · Tap to fix" with no
  delay; tap → sheet; "Open location settings" opens app settings
  (native) or shows instructions (web); returning with location enabled
  re-acquires via the resume path.
- Save with no fix → sheet appears instantly (no 10 s hang); Try again
  acquires; Continue without location saves with null coordinates.

---

# Android release plan

Goal: keep `sporely-web` as the single source repository while supporting three practical distribution targets:

- Web/PWA for iOS users via Cloudflare Pages.
- GitHub Releases Android APK as a signed `.apk`.
- Google Play Android release as a signed `.aab` once the store path is ready.

- Cloudflare owns the web/PWA deployment. Do not add GitHub Actions workflows that deploy the web app.
- The Android CI must run the Capacitor sequence in the correct order:
  - `npm ci`
  - `npm run build`
  - `npx cap sync android`
  - Gradle APK/AAB build
- Do not assume the Vite output directory. Verify `webDir` in `capacitor.config.*`.
- Use the repository’s Node requirement. Current repo expects Node `>=22`.
- Keystores, passwords, generated APKs/AABs, and local signing files must never be committed.

---

### Phase 3 — Cloudflare Pages build isolation

Status: not started

Purpose: avoid unnecessary web builds for Android-only changes.

Tasks:

* Do not add a web deployment workflow.
* Document Cloudflare Pages Build watch paths.
* Recommended starting point:

  * Include paths: `*`
  * Exclude paths: `android/*`
* Consider excluding release-only paths after testing:

  * `.github/*`
  * docs-only files
* Make sure mixed commits still behave correctly:

  * `android/*` only: web build should be skipped
  * `src/*` only: web build should run
  * `android/*` + `src/*`: web build should run

Definition of done:

* Cloudflare deployment remains dashboard/Git integration owned.
* Android-only commits no longer waste Cloudflare builds.
* Web-relevant commits still trigger Cloudflare builds.

---

### Phase 4 — Store metadata scaffold

Status: not started

Purpose: keep store listing text in source control without automating publication yet.

Tasks:

* Add Google Play / Fastlane-style metadata:

```text
android/fastlane/metadata/android/en-US/title.txt
android/fastlane/metadata/android/en-US/short_description.txt
android/fastlane/metadata/android/en-US/full_description.txt
```

* Use factual placeholder text if final text is not ready.
* Keep screenshots and graphics out of this phase unless already prepared.

Do not:

* Add Fastlane Play deployment.
* Add service account JSON.
* Claim unsupported features.

Definition of done:

* Metadata paths exist.
* Files contain editable text only.
* No binary store assets are added accidentally.

---


## Near-term active tasks

### Map

- [ ] Add a legend dropdown to the map page.
  - Options: Genus, Month, User.
  - The legend should match the colors used for map dots.

### AI crop workflow

- [ ] Verify cross-platform crop round-trip:
  - web edit → desktop pull
  - desktop edit → cloud/web pull


### Database and operations

- [ ] Ensure `delete-account` Edge Function is deployed and functional.
- [ ] Verify unique constraints on observations are applied if still pending.
- [ ] Keep validating RLS policies as new social/privacy features are added.

## Refactor and audit backlog

### Small safe refactors

- [ ] Optional server-side change summary:
  - Consider a future Supabase RPC/view that returns one per-observation “meaningful cloud change” summary.
  - Goal: remove most remaining client-side deep comparison work.
- [ ] Profile/account parity QA:
  - Verify web Profile and desktop Profile & Cloud read/write the same Supabase `profiles` fields:
    - `username`
    - `display_name`
    - `bio`
    - `avatar_url`
  - Confirm desktop `profile_email` follows the Supabase auth email and is not treated as an independent account identifier while signed in.
- [ ] Desktop account migration UX:
  - Design a safer path for users who want a new Sporely Cloud account without duplicating synced observations or losing spore data.
  - Keep the desktop account lock until this exists.

### Later image/import architecture

These are real issues, but they are not the next image-pipeline step.

- [ ] Import flow memory architecture:
  - Stream each processed blob directly to IndexedDB in `_processFile`.
  - Release full-resolution blobs from RAM as early as possible.
  - Keep only lightweight metadata and downscaled preview/AI blobs in active memory.
  - Avoid `Promise.all(files.map(f => f.arrayBuffer()))` memory spikes.
- [ ] Import/review state cleanup:
  - Move import session state into a predictable shared state boundary.
  - Audit blob URL disposal on delete/navigation.
  - Prevent pending metadata promises from resurrecting removed sessions.
- [ ] Worker metadata extraction:
  - Later, consider moving initial metadata extraction and preview generation into `image-worker.js`.
  - Do not do this until the small helper extraction has landed and been tested.

### Automated tests and static analysis

- [ ] Introduce ESLint to catch dead code, missing variables, and unused imports.
- [ ] Introduce Vitest for pure-logic modules:
  - `image_crop.js`
  - local media signature generation
  - observation deduplication logic
- [ ] Add sync queue tests:
  - mock IndexedDB
  - mock Cloudflare R2 worker uploads
  - simulate network drops and retry loops
- [ ] Add RLS auditing:
  - blocked users
  - banned users
  - private measurements
  - public/friends/private visibility boundaries

## Product backlog

### Web-native analysis and community data

- [ ] Integrate Plotly.js for L × W scatter plots and Q-value histograms.
- [ ] Use responsive layouts for mobile field/gallery views and desktop analysis views.
- [ ] Fetch raw measurement data from Supabase for charts.
- [ ] Build a public dataset explorer using existing Supabase RPCs.
- [ ] Display aggregate taxon statistics from public-facing data.
- [ ] Audit RLS policies for aggregate/public measurement visibility.
- [ ] Add reference-source entry for published min/max/mean/n statistics.
- [ ] Add literature overlays on user plots.
- [ ] Add outlier verification UI linked to R2 thumbnails.



### Cloud media lifecycle

- [ ] Recycle bin / undo window: 48h or 7 days.
- [ ] R2 media physical deletion: after the recycle window expires.
- [ ] Sync tombstone metadata: retain for 30–90 days.

### Anonymized public spore data (paired with sporely-py Stage L)

Goal: let a user contribute spore measurements to the community
dataset without exposing the observation itself. The schema already
separates `spore_data_visibility` from `visibility`; the missing
piece is a public RPC that surfaces the anonymized subset.

Tasks:

- [ ] New public RPC (working name
      `search_public_anonymous_spore_points`) reading observations
      where `spore_data_visibility = 'public'` regardless of
      `observations.visibility`. Projection strips observation id,
      observer, GPS, and exact date. Keeps: `genus`, `species`,
      `length_um`, `width_um`, `q`, `country_code`, optionally
      `year_month` when the (species, country, month) cohort has at
      least N points (starting suggestion N = 5), else year only.
- [ ] Companion mosaic-tile RPC (or extension of an existing one)
      that returns the tile URL + tile rect + polygon overlay
      *without* the `observationId`, so anonymized points can still
      render their thumbnail on the public site but the tile cannot
      be linked back to the underlying observation page.
- [ ] Direct table reads on `observations`,
      `observation_images`, `spore_measurements`,
      `spore_measurement_mosaics`, `spore_measurement_mosaic_tiles`
      must continue to reject anonymous / stranger access when the
      observation is not `visibility='public'`. New visibility only
      goes through the RPCs.
- [ ] Landing must skip the observation-detail deep link for
      anonymized points; clicks land on the species aggregate view
      instead.
- [ ] Extend `supabase/tests/public_observation_rpc_validation.sql`
      with:
      - private observation + `spore_data_visibility='public'` → RPC
        returns anonymized point.
      - same observation is NOT returned by
        `search_public_observations` /
        `get_public_observation`.
      - rare-taxa cohort under N returns year only, not month.

Open questions:

- Whether to expose the anonymized point count in
  `search_public_species` (probably yes as a separate
  `anonymousSporePointCount` field so operators can see uptake
  without conflating it with public observations).
- Retention semantics if a user later flips
  `spore_data_visibility='private'`: their anonymized points must
  disappear from the RPC on the next call (RLS + RPC filter should
  handle this automatically, but verify).

### Draft observation expiry policy (paired with sporely-py Stage M)

Goal: keep the free tier honest without hard-deleting anyone's work.
Free tier gets 20 private slots plus draft slots that expire if
they're never picked up again; paid tier has no expiry cap.

Tasks:

- [ ] Add nullable `observations.expires_at timestamptz`.
- [ ] Edge Function / scheduled job that flags candidate drafts
      (`is_draft = true` AND no edits / no measurements added for D
      months; D = 6 for free tier, D = 12 for paid) by setting
      `expires_at = now() + 30 days`. Exempt observations whose
      `spore_data_visibility='public'` — those are contributing
      anonymized data (see above) and must survive the sweep.
- [ ] On `expires_at` reaching now, set the existing observation
      tombstone (`deleted_at`) — do NOT hard delete. Media garbage
      collection (already tracked in `Cloud media lifecycle`) does
      the eventual R2 purge.
- [ ] User-facing notification: one email + in-app banner during the
      grace window. "Keep this draft" one-click action clears
      `expires_at`.
- [ ] Landing/desktop-side surfaces for the banner + keep action.
- [ ] RLS: owners must still be able to read / update / undelete
      their expiring drafts.
- [ ] Ship the sweep in dry-run first (log candidates, do not set
      `expires_at`) and audit for at least one full sweep cycle
      before enabling live expiry.

Non-goals:

- No hard delete at expiry — always route through the existing
  tombstone + recycle bin flow.
- No expiry for `is_draft = false` observations.
- No expiry for drafts with public spore data opted in.

### UGC moderation and Play Store compliance

- [ ] Moderation dashboard V1:
  - Use Supabase Studio to review reports, delete offending observations/comments, and ban users.
- [ ] Moderation dashboard V2:
  - Build in-app `/admin` view gated by `is_admin = true`.
- [ ] Prepare Google Play Store release:
  - Android keystore
  - release signing
  - `.aab` build
  - store listing
  - screenshots
  - privacy policy

### Documentation / landing page

This may belong in the `sporely-landing` plan instead of `sporely-web`.

- [ ] Decide whether this section should stay here or move to a separate landing-page plan.
- [ ] Initialize VitePress in `sporely-landing`.
- [ ] Recreate current `index.html` highlights on the VitePress homepage.
- [ ] Configure VitePress to source Markdown files from `../sporely-py/docs/`.
- [ ] Update build and deployment scripts for `sporely.no`.

## Long-term ideas

- [ ] In-browser measurement:
  - Replicate manual spore clicking and calibration using HTML5 Canvas.
- [ ] Cross-platform math consistency:
  - Investigate Pyodide/WebAssembly for shared Python/Numpy logic in-browser.

## References

- `HISTORY.md` — debugging history, completed fixes, gotchas, and old implementation notes.
- `docs/image-pipeline-phase1.md` — current image pipeline notes and Phase 1 findings.
- Suggested future docs:
  - `docs/project-status.md`
  - `docs/manual-qa.md`
  - `docs/agent-audit-checklist.md`
