# Sporely-web Development Plan

## Purpose

`PLAN.md` is the active working plan for `sporely-web`.

It should contain current tasks, near-term backlog, and long-term roadmap items. It should not contain dated debugging logs, completed implementation notes, long agent prompts, or historical failure analysis. Those belong in `HISTORY.md` or separate docs.

Historical image/upload notes are archived in `HISTORY.md`. Current image-pipeline notes are in `docs/image-pipeline-phase1.md`.

# Android release plan

Goal: keep `sporely-web` as the single source repository while supporting three practical distribution targets:

- Web/PWA for iOS users via Cloudflare Pages.
- GitHub Releases Android APK as a signed `.apk`.
- Google Play Android release as a signed `.aab` once the store path is ready.

### Non-negotiable rules

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

### Phase 0 — Audit current release state

Status: not started

Purpose: inspect before changing anything.

Tasks:

- Inspect:
  - `package.json`
  - `package-lock.json`
  - `capacitor.config.*`
  - `android/app/build.gradle` or `android/app/build.gradle.kts`
  - `android/gradle.properties`
  - root `.gitignore`
  - `android/.gitignore`
  - `.github/workflows/`
  - existing metadata/fastlane directories
- Confirm:
  - Android applicationId/package name
  - current `versionName`
  - current `versionCode`
  - current Node requirement
  - current Java/Gradle requirements
  - actual Capacitor `webDir`
  - whether signing config already exists
  - whether product flavors already exist
- Produce a short audit note before implementation.

Test/check commands:

```bash
node --version
npm ci
npm run build
npx cap sync android
cd android && ./gradlew :app:assembleDebug
```

Definition of done:

* Current build path is understood.
* No release files or workflows have been changed yet.
* Risks/conflicts are listed before Phase 1.

---

### Phase 1 — Local release hygiene

Status: not started

Purpose: make local release/version handling predictable before CI signing is added.

Tasks:

* Add `.nvmrc` if missing, matching the repo’s Node requirement.
* Reuse existing version scripts if possible.
* If needed, add `scripts/bump-version.mjs`.
* Version bump logic must keep these aligned:

  * `package.json` version
  * Android `versionName`
  * Android `versionCode`
* Add a short release checklist to README or docs.
* Verify `.gitignore` protects:

  * keystores
  * `*.apk`
  * `*.aab`
  * Android build outputs
  * local signing config

Do not:

* Add signing secrets.
* Add Play deployment.
* Refactor unrelated build files.

Test/check commands:

```
npm ci
npm run build
npx cap sync android
cd android && ./gradlew :app:assembleDebug
git diff --stat
git status
```

Definition of done:

* Local build still works.
* Version bump path is documented.
* No secrets or generated binaries are staged.

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

## Image pipeline refactor, conservative Phase 2

### Current state

- The app currently works.
- Phase 1 of the image pipeline refactor is complete.
- Phase 1 was documentation/debug-only:
  - `docs/image-pipeline-phase1.md`
  - opt-in debug logging behind `sporely-debug-image-pipeline`
- The next step must be small and low-risk.
- Do not introduce a new `image-intake.js` module yet.



## Near-term active tasks

### UI fixes

- [ ] Make a distinct draft/obscured/private banner that is as wide as the screen.
  - Place it just above the thumbnail view in edit-observations.
  - If an observation is obscured, draft, or private, show one tag for each true condition.
  - Remove the smaller Draft/obscured tags currently shown in the upper-left corner.

### Map

- [ ] Add a legend dropdown to the map page.
  - Options: Genus, Month, User.
  - The legend should match the colors used for map dots.

### AI crop workflow

- [ ] Verify cross-platform crop round-trip:
  - web edit → desktop pull
  - desktop edit → cloud/web pull

### Privacy, RLS, and social trails

- [ ] Verify disposable-account RLS paths for:
  - owner
  - accepted friend
  - stranger
  - blocked user
  - banned profile
  - privacy slot limit

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

### Monetization and storage tiers

- [ ] Backfill historical R2 usage into `profiles.total_storage_bytes`, `storage_used_bytes`, and `image_count`.
- [ ] Integrate RevenueCat in the Capacitor wrapper.
- [ ] Configure Pro entitlement and sync it into Supabase profile fields.
- [ ] Implement paywall/account UI comparing:
  - Free: 2 MP images, community access, quota-limited storage.
  - Pro: selectable 2 MP or 12 MP backups, higher quota, high-res research export.
- [ ] Set up entitlement webhook syncing.
- [ ] Add clear UI messaging around free 2 MP uploads, Pro 12 MP uploads, and account storage quota.

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
