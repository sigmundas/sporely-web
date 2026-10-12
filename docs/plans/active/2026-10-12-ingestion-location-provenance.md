# Camera and photo imports — record upload method and GPS outcomes

Status: five-stage plan approved in principle; Stage 1 candidate prepared and locally verified, uncommitted pending human verification. Stage 2 and production deployment are not authorized.
Date: 2026-10-12
Scope: sporely-web ingestion, durable state, Supabase metadata; a separate sporely-py preservation stage.

Purpose: record how each photo entered Sporely and where observation coordinates came from, including why GPS was missing. Image dimensions are already stored. This plan leaves camera aspect ratios unchanged; use the new metadata to decide later whether 4:3 capture, a warning, or cropping is needed. It does not preserve all EXIF or reconstruct missing metadata for historical uploads.

## Plan and implementation locations

The canonical plan is tracked on main at docs/plans/active/2026-10-12-ingestion-location-provenance.md in the normal sporely-web checkout. It was moved here on 2026-10-12 for discoverability; the five stages, contracts, verification evidence and deployment restrictions are unchanged.

The unfinished Stage 1 implementation remains in /Users/sigmundas/Documents/Code/sporely/sporely-worktrees/sporely-web-provenance-stage1 on feature/ingestion-location-provenance-stage1: the candidate migration, SQL tests and sync-contract edits are uncommitted pending the human gate. Use that checkout for candidate verification, and update this canonical plan in the normal sporely-web checkout for handoffs. The source audit below refers to the inspected candidate base a427a6f; line numbers may differ on current main. Publishing this plan does not accept Stage 1, authorize Stage 2, or authorize production deployment.

## Findings and evidence

- Live Supabase has none of ingest_method, location_source, location_status. Existing image dimensions suffice. Owner-only base-table SELECT policies and explicitly projected community image view support keeping diagnostics private; audit all public observation views/RPCs before migration.
- review.js:2227 and import_review.js:597 construct image entries with blob/crop fields only.
- sync-queue.js:416 and :465 normalize and serialize explicit image fields. Prepared-byte caching, reservation recovery and retries reuse these shapes (:1190–1272).
- import-store.js:66 serializes imageMeta with crop fields only. Review drafts also project photo metadata (review-draft-store.js:93). Both must preserve provenance before queueing.
- camera-actions.js:46 routes Android to the registered native opener. import_review.js:1616 chooses openSystemCamera versus capturePhotos, then merges both through _handleNativePhotoResultAsLive. Pass an enum from the chosen branch; do not inspect the setting later.
- review.js:2415 defaults captureSource to 'Sporely native camera' in the common import helper. This debug label cannot be authoritative provenance. Other camera/picker branches also supply debug labels.
- capture.js:568 returns ImageCapture versus canvas captureMethod; subsequent diagnostic logging uses it. Persist backend explicitly if included, rather than parsing debug strings.
- geo.js:252–349 already classifies permission denial, disabled preference, timeout and unavailable position/API. review.js:886 returns only action/gps at save, collapsing why coordinates are absent. Persist session-specific results, not unrelated global geo state.
- images.js:1484 reserves observation_images with an explicit insert payload. This is the primary image-metadata write boundary; the R2 worker is not automatically a required provenance writer. Audit alternate direct-upload insertion paths before implementation.
- image-worker.js encodes pixels through OffscreenCanvas.convertToBlob. Stored WebP EXIF absence does not establish source EXIF absence.
- Desktop image_payloads.py, image_pull.py, reconciliation/values.py, snapshots and anchors use explicit field sets. gps_source designates the contributing image; it is separate from ingestion provenance.

## Contract decisions

1. Nullable image ingest_method: sporely_camera, system_camera, web_camera, native_picker, web_file_picker, unknown. NULL means historical/unsupported client. unknown means a new operation could not classify its actual entry point. Desktop-created images remain NULL in the initial release; document broader enum support separately.
2. Preserve per-image identity through mixed batches, grouping, reorder, removal and restart. Do not derive method from screen, MIME, dimensions, EXIF, filenames, current settings or debug labels. Ingestion is into Sporely, not proof of the original photographing device.
3. Nullable observation location_source: device_gps, image_exif, manual, none, unknown; it describes current coordinates. Existing data remains NULL even when coordinates exist.
4. Nullable location_status: acquired, disabled, denied, timeout, skipped, unavailable, unknown. For valid coordinates use acquired (including EXIF/manual assignment). For absent coordinates preserve the latest meaningful session acquisition outcome at save. Continuing without coordinates is a save decision, not a replacement acquisition result: skipped applies only when no meaningful failure or disabled outcome was observed. This is not a history of every GPS attempt. A failed GPS attempt must not erase valid existing coordinates or their source. Define deliberate coordinate clearing by a provenance-aware client as none/skipped. Do not infer status for imports whose location acquisition was never observed.
5. Persist source/status atomically with coordinates. Identify EXIF versus device fixes before they merge; native Sporely-written GPS EXIF must not be mistaken for independent image-origin GPS. Late metadata hydration must update provenance only if its coordinates win canonical selection.
6. Optional capture_backend for web_camera only: image_capture, canvas. Defer initially unless implementation shows it adds little scope. Synthetic demo captures must not be classified as real camera captures.
7. Keep fields outside public API/view projections. Client-reported diagnostics are not authorization claims. Reuse owner policies; no device identifiers or full EXIF retention.

### Frozen location transitions

These examples describe the saved observation. Session state must not borrow an error from a previous session. When several attempts complete, the latest meaningful outcome of the current accepted attempt wins; ignore stale asynchronous responses. A successful selected fix takes precedence over earlier failures.

| Situation | location_source | location_status |
| --- | --- | --- |
| Fresh device fix selected | device_gps | acquired |
| Usable original-image EXIF selected | image_exif | acquired |
| User assigns coordinates manually | manual | acquired |
| GPS denied, then user continues without coordinates | none | denied |
| GPS times out, then user continues without coordinates | none | timeout |
| GPS unavailable, then user continues without coordinates | none | unavailable |
| Location disabled, then user continues without coordinates | none | disabled |
| User skips location with no observed failure or disabled outcome | none | skipped |
| Timeout, explicit retry, permission denied, then continue | none | denied |
| Denied or timeout, then a selected device fix succeeds | device_gps | acquired |
| GPS attempt fails but existing manual coordinates remain selected | manual | acquired |
| User deliberately clears coordinates through the aware location operation | none | skipped |
| Historical record or legacy insert with no provenance | NULL | NULL |
| Legacy client actually changes any coordinate-bundle value | NULL | NULL |
| Unrelated edit, or coordinate values resent unchanged | Preserve | Preserve |

### Legacy coordinate-update contract

The coordinate bundle is gps_latitude, gps_longitude, gps_altitude and gps_accuracy. Compare actual stored values with NULL-safe equality; merely including coordinate fields in a request is not a change. A changed latitude, longitude, altitude or accuracy can invalidate attribution. Preserve both provenance fields on unrelated edits and value-identical coordinate updates.

On ordinary coordinate-changing UPDATEs, invalidate both location_source and location_status to NULL. Do not retain stale acquired/device_gps attribution, infer manual attribution, or convert missing coordinates to a guessed skipped outcome. This conservative rule also covers explicit NULLs, clearing one coordinate, partial provenance payloads and legacy clients resending an old record.

Provenance-aware coordinate changes need a dedicated owner-authorized, transactional server operation that explicitly supplies the complete coordinate/provenance bundle. It must allow changing coordinates while legitimately retaining the same enum pair, e.g. device_gps/acquired to a new device_gps/acquired fix. An ordinary row trigger cannot distinguish omitted provenance fields from explicitly supplied fields whose values equal OLD; comparing enums alone is insufficient evidence. Stage 1 must design and verify the explicit operation plus the invalidation guard before creating the migration. Prefer an invoker/RLS-enforced RPC using existing owner checks; no client-controlled bypass flag or new SECURITY DEFINER shortcut. One possible implementation clears attribution with the coordinate write and sets the validated pair within the same transaction; assess existing update triggers before choosing it.

Provenance-only updates to unchanged coordinates must validate the complete pair and its compatibility with the resulting coordinate state. Old-client inserts remain nullable. Stage 3 routes aware location changes through the server operation; Stage 4 uses the same contract. This supersedes the earlier blanket statement that old desktop clients must never clear cloud provenance: they preserve it on unrelated edits, and the server invalidates it on actual coordinate changes.

## Stages

### 1. Prepare database fields for photo method and GPS outcomes

Inventory public observation/image views and RPCs plus alternate image insertion paths. Implement the frozen transition/legacy contract at the server boundary, including a validated explicit location operation and conservative ordinary-update invalidation. Create a new tracked Supabase migration through repository workflow; no historical backfill. Include nullable fields and validation; preserve old-client inserts. Avoid changes to R2 object keys, media delivery or worker unless an actual overwrite path requires them. Test migration on an available local database, enum rejection, old payloads, owner/non-owner access and public projections. Cover each changed coordinate-bundle component, NULL transitions, unchanged resends, unrelated edits, partial/omitted provenance, aware updates retaining identical enums and failure rollback. Production application is a separate explicitly authorized guarded deployment; respect deploy-exceptions.json and deploy-tree tooling. Preparation stops before migration creation if history disagrees beyond the registered exception.

### 2. Record each photo's camera or picker method through upload and retries

Extend observation-shapes.js and existing photo/imageMeta structures. Assign enums in capture.js, native camera branches in import_review.js/review.js, native picker branches and browser file-input handlers. Update import-store.js, review-draft-store.js, both payload builders, queue normalize/serialize, reservation payload and any direct-add-image paths in images.js. Preserve through prepared-byte replacement and recovered reservations; do not add unconditional metadata PATCH retries. Test all five ingestion methods, mixed-source batches, grouping/reorder/remove, legacy queue entries, restart before save, queue restart, upload retry and lost-reservation-response recovery. Verify with focused node --test files; no npm test, builds or dependency installation. Human gate: actual camera/picker and restart/retry checks; leave implementation uncommitted until confirmed unless an approved engine gate applies.

Required regression: create uniquely identifiable mixed-source images A, B, C and D; reject/filter B, then sort the survivors into a different order and group them into observations. Assert each surviving image's blob identity and ingest_method remain paired through payload construction, persisted-session recovery and queue serialization. Place rejected images at both an early and an interior position; the test must catch indexing metadata against the original array after filtering. Group/sort by the existing supported criteria, not a test-only algorithm.

### 3. Record GPS, EXIF and manual locations, including failure reasons

Extend existing capture-session/import-session state and persisted drafts. Map geo error kinds and preflight decisions at the action boundary using the frozen transitions. Route aware coordinate changes through the Stage 1 explicit server operation. Carry the selected fix source through EXIF hydration and canonical save location. Cover manual assignment/clearing and adding photos to existing observations without silently replacing location provenance. Test acquired GPS, denied, disabled, timeout, unavailable, skipped, usable/missing EXIF, manual overwrite/clear, late fixes, session reset and mixed photo GPS selection. Explicitly test that continue-without-location preserves denied/timeout/unavailable/disabled. Human gate: real permission/settings flows, GPS availability and restored drafts.

### 4. Preserve photo and location metadata through desktop sync

In sporely-py update local schema/model fields, cloud observation/image payloads, snapshots and pull/push preservation. Reuse existing field-list conventions and passive snapshot preservation where suitable; location fields participate in merge as part of the coordinate bundle. Follow the legacy invalidation contract and use the aware operation for newly attributed coordinate changes. Cover cloud→desktop→cloud, metadata-only edits, legacy coordinate changes, old snapshots, anchor promotion, download-only zero writes and no-op sync behavior. Update both repositories' sync contracts. Human gate: restart and cross-client retention. Use project Python/pytest paths; no dependency changes.

### 5. Verify stored metadata and deploy after approval

Initially use owner-authorized diagnostic queries; add admin UI only as a separately bounded need. No new analytics system. Execute a user-run matrix across five paths, a mixed batch, offline restart/retry and location outcomes; inspect stored values and public API non-disclosure. Deploy only after explicit authorization and repository guards. Observe new records before proposing aspect-ratio changes. No reconstruction of 1447/1457 provenance.

## Validation and progress

Audit and plan refinement only: source inspection and read-only live schema/policy/history queries; no application tests run because no implementation changed. No production migrations, builds, dependency installation or commits. Unrelated untracked work in both repositories preserved.

Stage 1 preparation precheck, 2026-10-12:

- `supabase migration list` completed. The registered local-only 20260914090000 is expected. An additional remote-only 20261012100000 is not registered and blocks migration preparation under AGENTS.md.
- Read-only remote history confirms 20261012100000 is named add_public_observation_spore_previews, already applied remotely. Expected filename by version/name: 20261012100000_add_public_observation_spore_previews.sql; no corresponding file exists in this checkout. No history repair or file reconstruction attempted.
- Tail: 20261011100000 local/remote; 20261011190000 local/remote (20261011190000_correct_admin_database_health.sql); 20261012100000 remote only.
- Status: untracked INBOX.md, unrelated 2026-10-04-cache-first-connectivity plan, this provenance plan, and supabase/verification/. Existing verification files were not edited.
- An existing local Supabase database is running; it was not reset or migrated. This does not establish schema compatibility or migration verification.
- No candidate migration, server code or tests created; no commit or push. Stage 1 remains incomplete pending a checkout with consistent migration history (apart from the registered exception). Stage 2 and production deployment remain unauthorized.

### Stage 1 preparation resumed

- Updated origin/main now contains the authentic applied 20261012100000 migration. Work continues in the permanent worktree /Users/sigmundas/Documents/Code/sporely/sporely-worktrees/sporely-web-provenance-stage1 on feature/ingestion-location-provenance-stage1, based on a427a6f. Moved from /tmp using git worktree move on 2026-10-12 so the uncommitted candidate is no longer in temporary storage. Original worktree/branch and unrelated files preserved; no history reconstructed or repaired. The read-only migration-list precheck passed with only registered deferred 20260914090000.
- Prepared 20261012105630_ingestion_location_provenance.sql: three nullable fields, enum/pair consistency checks, ordinary coordinate-change invalidation, owner/RLS-enforced SECURITY INVOKER set_observation_location RPC. No production application, public projection edit, historical backfill or R2 worker change. Alternate insertObservationImage and its fallback payloads also need Stage 2 propagation, beyond reservation.
- Existing public views and public RPC definitions use explicit projections; local checks inspect all public view columns and public RPC source/result declarations and exercise community observation/image views plus get_public_observation as a non-owner. Base owner RLS remains unchanged.
- RPC makes two conditional updates under one row lock and transaction; existing observation triggers were inspected. Location-only writes do not bump image/media versions. Identical retries do not create a new row tuple. Injected second-write failure rolls back coordinate changes. No client-controlled bypass.
- Verification: candidate migration plus supabase/tests/ingestion_location_provenance_test.sql passed on the existing local PostgreSQL 17.6 database inside BEGIN/ROLLBACK. Covers old inserts, all ingestion enums and failure statuses, acquired sources, each changed coordinate component and NULL transition, identical resends, omitted/partial provenance, aware same-enum updates, invalid pairs/ranges, rollback, no-op retry, media cursors, owner/non-owner RPC/base-table access, and public non-disclosure. Session transitions and filtering/sorting regression remain Stage 2/3 tests, not claimed by SQL coverage.
- Initial negative-ID fixture needed OVERRIDING SYSTEM VALUE. Anonymous denied-function calls inside DO caused a local PostgreSQL signal-11 backend crash; server recovered and candidate schema rolled back. Anonymous denial now uses has_function_privilege effective ACL; actual authenticated owner/non-owner and claimless calls remain exercised. No grants weakened. Validate real anonymous HTTP denial in the human gate.
- No full database reset, build, dependency installation, production writes, commit or push. Local schema/history unchanged after rollback. web sync contract documents the candidate; desktop changes and its matching contract update deferred to Stage 4. Stage 1 remains a preparation candidate, not deployed/accepted.

Human verification / later authorized deployment gate (not performed by agent):

1. In a disposable local/staging environment, apply the committed candidate through the owning migration workflow and verify owner PostgREST reads/writes, an unrelated legacy PATCH, and a changed-coordinate legacy PATCH that clears both provenance fields. Production application requires separate explicit authorization and deploy-tree guards.
2. Call set_observation_location via the actual API as owner and non-owner; confirm owner same-enum coordinate updates succeed atomically, non-owner and anonymous requests fail, and public observation/image responses omit provenance.
3. Confirm these API checks and the candidate for commit in the next task. Stop at Stage 1; Stage 2 remains unauthorized.
