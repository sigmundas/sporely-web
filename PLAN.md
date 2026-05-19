# Sporely-web Development Plan

## Purpose

`PLAN.md` is the active working plan for `sporely-web`.

It should contain current tasks, near-term backlog, and long-term roadmap items. It should not contain dated debugging logs, completed implementation notes, long agent prompts, or historical failure analysis. Those belong in `HISTORY.md` or separate docs.

Historical image/upload notes are archived in `HISTORY.md`. Current image-pipeline notes are in `docs/image-pipeline-phase1.md`.

## Current priority: Image pipeline refactor, conservative Phase 2

### Current state

- The app currently works.
- Phase 1 of the image pipeline refactor is complete.
- Phase 1 was documentation/debug-only:
  - `docs/image-pipeline-phase1.md`
  - opt-in debug logging behind `sporely-debug-image-pipeline`
- The next step must be small and low-risk.
- Do not introduce a new `image-intake.js` module yet.

### Next small step

Implement only helper extraction and shape documentation:

- [x] Add a shared `isBlob` / blob-like helper and replace duplicated local checks.
- [x] Add a neutral coordinate helper for shared coordinate validation/coercion.
- [x] Add a default draft / default observation factory used by capture/review/import paths.
- [x] Add simple image shape comments or JSDoc for the existing image objects passed between capture, review, import review, queue, and upload code.

### Explicitly not now

Do not do these in the next pass:

- No `image-intake.js`.
- No rewrite of the full image intake flow.
- No streaming import architecture yet.
- No moving EXIF extraction into `image-worker.js` yet.
- No removal of schema fallbacks too early.
- No broad cleanup of `images.js` or `sync-queue.js` unless required by the helper extraction.
- No behavioral changes to upload, queue, AI crop, or image encoding.

### Regression checks for this step

After helper extraction, manually verify:

- Camera capture still saves and uploads.
- Gallery import still saves and uploads.
- Android HEIC/HEIF native import still produces image + GPS metadata where available.
- JPEG import still treats missing GPS as missing GPS, not `0,0`.
- AI ID still receives the expected crop/image blob.
- Offline queue still persists image bytes and retries after app suspension.
- Existing uploaded observations still show thumbnails.
- No object URL or pending metadata promise resurrects removed import sessions.

## Current priority: Image pipeline refactor

The app currently works. This refactor must stay conservative. Each phase should be small enough to review in one agent chat and one follow-up audit.

### Global guardrails

- Do not rewrite the full image intake flow.
- Do not introduce `image-intake.js` until earlier phases are accepted.
- Do not change upload, queue, AI crop, or image encoding behavior unless the phase explicitly says so.
- Do not remove schema fallbacks early.
- Do not do opportunistic broad cleanup.
- After each phase, run the relevant regression checklist.

### Phase 1 — Documentation and debug visibility

Status: [x] Accepted

Scope:
- Add `docs/image-pipeline-phase1.md`.
- Add opt-in image pipeline debug logging.

Acceptance:
- No behavior changes.
- Debug logging is opt-in.
- Existing capture/import/upload paths still work.

### Phase 2 — Shared helper extraction

Status: [i] Implemented, awaiting review

Scope:
- Add shared blob/blob-like guard.
- Add shared coordinate validation/coercion helper.
- Add default draft / observation payload helpers.
- Add JSDoc for current image object shapes.

Guardrails:
- No `image-intake.js`.
- No upload behavior changes.
- No queue behavior changes.
- No AI crop behavior changes.
- No broad cleanup of `images.js` or `sync-queue.js`.

Review findings to resolve before acceptance:
- [ ] Remove server-managed null placeholders such as `created_at: null` from default insert payloads.
- [ ] Tighten `isBlob()` so blob-like objects must support `arrayBuffer()`.
- [ ] Normalize GPS at final save/enqueue boundaries.
- [ ] Decide whether `observation-shapes.js` may import settings, or split defaults into `observation-defaults.js`.
- [ ] Expand JSDoc so it documents the real capture/review/import/queue/AI shapes.
- [ ] Remove confirmed dead duplicate import/EXIF helper code only after checking references.

Acceptance checks:
- [ ] Camera capture saves and uploads.
- [ ] Gallery import saves and uploads.
- [ ] Android HEIC/HEIF native import preserves image + GPS where available.
- [ ] JPEG without GPS remains missing GPS, not `0,0`.
- [ ] AI ID receives expected crop/image blob.
- [ ] Offline queue persists image bytes and retries after app suspension.
- [ ] Existing uploaded observations show thumbnails.
- [ ] Removed import sessions are not resurrected by object URLs or metadata promises.

### Acceptance blocker: restore stronger EXIF/GPS fallback behavior

Status: [x]  fixed

The import screen now delegates EXIF/GPS handling to `src/screens/import-helpers.js`, but the deleted local helper block had stronger HEIC/HEIF and GPS fallback behavior than the shared helper.

Before accepting this phase:

- [ ] Move the stronger file-first EXIF/GPS fallback logic into `src/screens/import-helpers.js`.
- [ ] Preserve the shared-helper structure; do not reintroduce screen-local duplicate helpers.
- [ ] For HEIC/HEIF, preserve `chunked: false` where needed.
- [ ] Try original-file EXIF/GPS parsing before falling back to limited buffer parsing.
- [ ] Keep raw GPS fallback parsing.
- [ ] Verify JPEG without GPS remains null/missing, never `0,0`.
- [ ] Verify Android HEIC/HEIF with GPS preserves coordinates after import, review, save, and detail reopen.

### Phase 3 — Import/review state boundary audit

Status: [ ] Not started

Scope:
- Map current data shapes between import, review, queue, upload, and AI ID.
- Document which fields are live, legacy, derived, or temporary.
- Do not move code yet.

Output:
- Update `docs/image-pipeline-shapes.md` or equivalent.
- Propose the smallest safe code move for the next phase.

### Phase 4 — Small import memory cleanup

Status: [ ] Not started

Scope:
- Reduce obvious memory pressure without changing architecture.
- Avoid parallel full-resolution blob reads.
- Improve disposal of object URLs and removed sessions.

Guardrails:
- No streaming architecture yet.
- No worker migration yet.
- No new intake module yet.

### Phase 5 — Decide whether `image-intake.js` is justified

Status: [ ] Not started

Scope:
- Only after Phases 2–4 are accepted.
- Propose exact module boundary before implementation.
- List functions to move and functions to leave alone.

Decision:
- [ ] Proceed with small module extraction.
- [ ] Defer because current code is stable enough.

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
