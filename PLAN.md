# Sporely-web Development Plan

## Purpose

`PLAN.md` is the active working plan for `sporely-web`.

Historical image/upload notes are archived in `HISTORY.md`. Current image-pipeline notes are in `docs/image-pipeline-phase1.md`.

# Plan review status

Last audited against the repository on 2026-08-13 (`0.7.0`, Android
`versionCode 277`). Completed implementation detail belongs in `HISTORY.md`;
this file retains only open work and decisions.

## Android release optimization

Decision needed: is APK/AAB size currently important enough to justify a
dedicated R8 test release? If yes, enable code and resource shrinking in the
next release created for that experiment. Do not tie the work to an old version
number or change a build that is already in Play review.

Scope:

```groovy
buildTypes {
    release {
        minifyEnabled true
        shrinkResources true
        proguardFiles(
            getDefaultProguardFile('proguard-android-optimize.txt'),
            'proguard-rules.pro'
        )
    }
}
```

For AGP 8.13, also evaluate:

```properties
android.r8.optimizedResourceShrinking=true
```

Required verification before publishing:

* clean production web build and Capacitor sync;
* signed release AAB builds successfully;
* compare AAB/APK size before and after optimization;
* cold-start and startup regression check;
* Google sign-in;
* camera capture and gallery import;
* location permissions and coordinate capture;
* biometric login;
* push notifications;
* Artsorakel;
* taxonomy search and taxon persistence;
* image upload and cloud sync;
* offline queue and reconnect retry;
* inspect `mapping.txt`, merged manifest, and R8 warnings;
* add narrowly scoped keep rules only for confirmed reflection-related failures.

Do not enable R8 merely to address taxonomy-search latency. That lookup is primarily a network/database path and should be profiled separately.

## Location and crash-recovery device acceptance

The freeze fix, capture-time location lock, reusable location sheet, and live
review draft recovery were implemented and tested on 2026-07-22. Keep only the
unrecorded on-device acceptance work here; see `HISTORY.md` for implementation
detail.

- [ ] With location slow/off, save from review and confirm the location sheet
      appears immediately above all overlays; all three actions respond.
- [ ] Confirm explicit retry acquires a fix, while continuing without location
      saves null coordinates.
- [ ] Capture a find, walk away for more than 90 seconds, then save; the stored
      coordinates must remain the capture-time position.
- [ ] Force-quit from live review and relaunch; photos and draft fields restore.
      After save or cancel, relaunch must not restore the draft.
- [ ] Confirm the camera viewfinder appears immediately even with location off/slow.
- [ ] Deny OS location; confirm the pill reads "No location · Tap to fix",
      settings opens, and returning with location enabled reacquires a fix.

---

# Android release plan

Goal: keep `sporely-web` as the single source repository while supporting three practical distribution targets:

- Web/PWA for iOS users via Cloudflare Pages.
- GitHub Releases Android APK as a signed `.apk`.
- Google Play Android release as a signed `.aab`.

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

### Cloudflare Pages build isolation

Status: requires Cloudflare dashboard verification; repository state cannot
confirm the current Build watch-path settings.

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

### Store metadata in source control

Status: decision needed; no `android/fastlane/metadata` directory exists.

Purpose: decide whether the existing Play listing should be mirrored in source
control. Android signing, APK/AAB CI, and Play installation are already in use;
this is no longer a prerequisite for opening the store path.

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
  - **Clarify first:** current pins encode ownership and uncertainty, not genus,
    month, or user. Define whether this control recolors pins, how categories
    are bounded, and what “User” means in public/community scope.

### AI crop workflow

- [ ] Verify cross-platform crop round-trip:
  - web edit → desktop pull
  - desktop edit → cloud/web pull


### Database and operations

- [ ] Verify the tracked `delete-account` Edge Function version is deployed and
      run an end-to-end deletion check in the target project.
- [ ] Add focused RLS regression cases when a social/privacy read surface changes.
      The broad “keep validating” item is not independently completable.

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

- [ ] Add direct pure-logic coverage where gaps remain for `image_crop.js`, local
      media signatures, and observation deduplication. Continue with the existing
      `node:test` setup unless there is a concrete Vitest-only need.
- [ ] Expand the existing sync-queue tests to cover mocked IndexedDB/R2 network
      drops and retry loops; the basic queue suite already exists.
- [ ] Add RLS auditing:
  - blocked users
  - banned users
  - private measurements
  - public/friends/private visibility boundaries

## Product backlog

### Web-native analysis and community data

- [ ] Decide ownership before starting: public explorer and aggregate taxon UI
      already live primarily in `sporely-landing`; keep only signed-in/app-specific
      analysis in this repository.
- [ ] If app-native charts remain desired, choose a charting approach for L × W
      scatter plots and Q-value histograms. Adding Plotly.js would be a new
      production dependency and requires confirmation.
- [ ] Add responsive app layouts and fetch the needed measurement projection only
      after the app-specific chart scope is agreed.
- [ ] Audit RLS/RPC exposure for any new aggregate or raw-measurement surface.
- [ ] Add reference-source entry for published min/max/mean/n statistics.
- [ ] Add literature overlays on user plots.
- [ ] Add outlier verification UI linked to R2 thumbnails.



### Cloud media lifecycle

- [ ] Decide whether users need a visible recycle-bin/undo UI. Image tombstones
      already use a 30-day restore window by default in `admin-ops`.
- [ ] Decide whether expired R2 tombstone purge remains an audited admin action or
      becomes scheduled automation; preview, physical deletion, accounting, and
      admin UI already exist.
- [ ] Define observation-tombstone retention separately from image-byte purge.

### Anonymized public spore data (paired with sporely-py Stage L)

Goal: let a user contribute spore measurements to the community
dataset without exposing the observation itself. The schema already
separates `spore_data_visibility` from `visibility`; the missing
piece is a public RPC that surfaces the anonymized subset.

Status: keep, but complete the privacy/product decisions below before schema
work. Existing public RPCs expose spore data only in public-observation
contexts; they do not implement this private-observation anonymization model.

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

Status: keep as a proposal, not an implementation-ready task. Clarify whether
paid drafts expire: the goal says paid has no expiry, while the task below says
12 months. Also define the authoritative “last active” timestamp and confirm
email-notification infrastructure before writing the sweep.

Tasks:

- [ ] Add nullable `observations.expires_at timestamptz`.
- [ ] Edge Function / scheduled job that flags candidate drafts
      (`is_draft = true` AND no edits / no measurements added for D
      months; proposed D = 6 for free tier, with paid-tier behavior still to
      be decided) by setting
      `expires_at = now() + 30 days`. Exempt observations whose
      `spore_data_visibility='public'` — those are contributing
      anonymized data (see above) only if that exemption is confirmed not to
      create an unlimited-draft loophole.
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

- [ ] Verify the `admin-ops` Edge Function and `sporely-admin` moderation actions
      are deployed and exercised in the target environment. The separate admin
      app now owns report review, hide, ban/unban, and tombstone-purge UI; do not
      build a duplicate `/admin` surface in this client.
- [ ] Keep Play listing, screenshots, privacy declarations, and data-safety answers
      current for each release. Keystore-backed signing and APK/AAB CI already exist.

### Documentation / landing page

Removed from this plan: landing-site implementation belongs in
`sporely-landing/PLAN.md`, which already exists. Cross-repository database/RPC
work may still be referenced here when `sporely-web` owns that contract.

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
