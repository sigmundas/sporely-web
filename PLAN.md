# Sporely-web Development Plan

## Purpose

`PLAN.md` is the active working plan for `sporely-web`.

Historical image/upload notes are archived in `HISTORY.md`. Current image-pipeline notes are in `docs/image-pipeline-phase1.md`.

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
