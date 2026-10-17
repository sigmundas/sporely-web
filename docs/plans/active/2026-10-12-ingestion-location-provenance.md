# Camera and photo imports — record upload method and GPS outcomes

Status: five-stage scope approved in principle; execution wording revised after refused intake. Existing Stage 1 files are uncommitted preparation evidence, not an accepted candidate. Only Stage 1 preparation is currently authorized. Starting a managed run, proceeding to Stage 2, and production operations each require the applicable user action described below.
Date: 2026-10-12
Scope: sporely-web ingestion, durable state, Supabase metadata; a separate sporely-py preservation stage.

Purpose: record how each photo entered Sporely and where observation coordinates came from, including why GPS was missing. Image dimensions are already stored. This plan leaves camera aspect ratios unchanged; use the new metadata to decide later whether 4:3 capture, a warning, or cropping is needed. It does not preserve all EXIF or reconstruct missing metadata for historical uploads.

## Execution ownership and candidate strategy

This is a gated, cross-repository plan: use compile intake, not the plain Markdown direct-run route. The five numbered stages below are intentional. Intake must preserve their repository ownership, explicit manual gates and completion gate in its manifests. A refused intake is not authorization to start work. Preparing this revision does not start any stage.

The plan is kept at docs/plans/active/2026-10-12-ingestion-location-provenance.md in the normal sporely-web repository. For managed runs the input plan is immutable: agents write only their current stage's notes.md; the engine owns handoffs, acceptance, gates and run state. There is no requirement to edit another checkout's plan during a run. Ordinary documentation updates outside a managed run use this canonical path on the selected web branch and reach main through normal reviewed Git integration.

Repository inventory for read-only intake:

- sporely-web: /Users/sigmundas/Documents/Code/sporely/sporely-web, currently feature/photo-provenance at 65dff7f before this revision. Stages 1, 2, 3 and 5 have this primary repository. Continue these web slices on the same selected feature branch; do not hard-code the abandoned Stage 1 branch as a runtime requirement.
- sporely-py: /Users/sigmundas/Documents/Code/sporely/sporely-py. Stage 4 has this primary repository. Supply it with --context-repository sporely-py=/Users/sigmundas/Documents/Code/sporely/sporely-py during preparation. Intake snapshots its actual branch and commit. A dedicated desktop feature branch must be selected through the engine's branch workflow before its implementation slice is approved. Preserve existing untracked taxonomy scripts and other unrelated work; do not auto-stash, include, or discard it to meet run prechecks.

The existing preparation checkout /Users/sigmundas/Documents/Code/sporely/sporely-worktrees/sporely-web-provenance-stage1, branch feature/ingestion-location-provenance-stage1 at a427a6f, is read-only source material for Stage 1. Its candidate files are supabase/migrations/20261012105630_ingestion_location_provenance.sql, supabase/tests/ingestion_location_provenance_test.sql and the private-provenance section added to docs/supabase-sync-contract.md. Stage 1 imports only those reviewed changes into its selected web candidate, rechecks them against that candidate's base and reruns verification. Do not copy the whole old worktree, edit it concurrently, switch its branch, or treat its old verification as current acceptance. If the candidate timestamp conflicts with newly applied history, stop under AGENTS.md rather than rename or repair history. Importing the existing candidate is Stage 1 implementation and is not performed by this planning task.

Each implementation stage has one writer in its primary repository. Stage 1 defines the web/server contract, and Stage 3 finalizes the web copy's desktop-preservation requirements before Stage 4 begins. Stage 4 updates only the Python contract and implementation, while declaring the accepted Stage 3 web commit as a read-only sibling candidate pin. Both contracts must agree at that pin. If desktop work requires changing the web contract, stop and request an explicit web amendment; do not edit the sibling or fabricate a paired candidate. Stage 5 uses the accepted Stage 4 Python commit as a read-only sibling pin. The engine must verify all declared pins are clean and pushed. It does not commit, push or merge a sibling repository on behalf of the primary stage.

## Candidate commits and human verification

For an approved managed run, select the engine-gated verification policy explicitly: each stage first passes its automated checks and independent review, then the engine finalizes its separate commit, push and acceptance. A stage's manual gate follows that accepted candidate and blocks the next stage, or plan completion. Automated acceptance is not a claim that the manual check passed. Failed or blocked checks keep continuation stopped; fix through the engine's repair/review workflow or revert, never edit engine state or record an invented pass.

This policy is supported by sporely-py's AGENTS.md and .sparring/PROJECT.md. For the web stages, approving the prepared run must explicitly include this commit-before-manual-gate choice and normal candidate push authorization. It supersedes this plan's former contradictory instructions to apply a committed candidate but wait for the same API checks before committing. Outside an approved engine-gated run, the preparation remains uncommitted under the existing human-verification policy. A Start run action scoped to Stage 1 does not grant the separate Stage 2 go-ahead or any production operation.

All checks in the manual gates use a disposable local/staging target with test accounts and the exact accepted commits. The operator supplies and verifies that target; a missing target or device keeps the gate blocked. Agents do not execute human/device checks. Candidate automation may use the existing local database transactionally. No production schema/data writes, stats resets, B0/B1 traffic changes, app publication or production activation are included in implementation acceptance. No npm test, builds, Capacitor sync, dependency installation or package upgrade is authorized for agents by this plan; use focused tests and the repository's existing environments. Operator device builds for manual checks are a separate action.

## Findings and evidence

- The earlier read-only live audit found none of ingest_method, location_source, location_status; recheck target schema before implementation rather than treat this historical fact as current. Existing image dimensions suffice. Owner-only base-table SELECT policies and explicitly projected community image view support keeping diagnostics private; audit all public observation views/RPCs before migration.
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

Provenance-aware coordinate changes need a dedicated owner-authorized, transactional server operation that explicitly supplies the complete coordinate/provenance bundle. It must allow changing coordinates while legitimately retaining the same enum pair, e.g. device_gps/acquired to a new device_gps/acquired fix. An ordinary row trigger cannot distinguish omitted provenance fields from explicitly supplied fields whose values equal OLD; comparing enums alone is insufficient evidence. Stage 1 must design and verify the explicit operation plus the invalidation guard as part of the candidate migration. Prefer an invoker/RLS-enforced RPC using existing owner checks; no client-controlled bypass flag or new SECURITY DEFINER shortcut. One possible implementation clears attribution with the coordinate write and sets the validated pair within the same transaction; assess existing update triggers before choosing it.

Provenance-only updates to unchanged coordinates must validate the complete pair and its compatibility with the resulting coordinate state. Old-client inserts remain nullable. Stage 3 routes aware location changes through the server operation; Stage 4 uses the same contract. This supersedes the earlier blanket statement that old desktop clients must never clear cloud provenance: they preserve it on unrelated edits, and the server invalidates it on actual coordinate changes.

## Stages

### Stage 1 — Prepare database fields for photo method and GPS outcomes

Primary repository: sporely-web. Implementation candidate: import and verify the existing preparation files in the selected web feature branch.

Inventory public observation/image views and RPCs plus alternate image insertion paths. Implement the frozen transition/legacy contract at the server boundary, including a validated explicit location operation and conservative ordinary-update invalidation. Create a new tracked Supabase migration through repository workflow; no historical backfill. Include nullable fields and validation; preserve old-client inserts. Avoid changes to R2 object keys, media delivery or worker unless an actual overwrite path requires them. Test migration on an available local database, enum rejection, old payloads, owner/non-owner access and public projections. Cover each changed coordinate-bundle component, NULL transitions, unchanged resends, unrelated edits, partial/omitted provenance, aware updates retaining identical enums and failure rollback. Production application is a separate explicitly authorized guarded deployment; respect deploy-exceptions.json and deploy-tree tooling. Preparation stops before migration creation if history disagrees beyond the registered exception.

### Stage 2 — Record each photo's camera or picker method through upload and retries

Primary repository: sporely-web. Depends on accepted Stage 1 and manual gate G1 plus the distinct manual go-ahead G1C.

Extend observation-shapes.js and existing photo/imageMeta structures. Assign enums in capture.js, native camera branches in import_review.js/review.js, native picker branches and browser file-input handlers. Update import-store.js, review-draft-store.js, both payload builders, queue normalize/serialize, reservation payload and any direct-add-image paths in images.js. Preserve through prepared-byte replacement and recovered reservations; do not add unconditional metadata PATCH retries. Test all five ingestion methods, mixed-source batches, grouping/reorder/remove, legacy queue entries, restart before save, queue restart, upload retry and lost-reservation-response recovery. Verify with focused node --test files; no npm test, builds or dependency installation. Actual camera/picker and restart/retry checks belong to manual gate G2 after the accepted candidate.

Required regression: create uniquely identifiable mixed-source images A, B, C and D; reject/filter B, then sort the survivors into a different order and group them into observations. Assert each surviving image's blob identity and ingest_method remain paired through payload construction, persisted-session recovery and queue serialization. Place rejected images at both an early and an interior position; the test must catch indexing metadata against the original array after filtering. Group/sort by the existing supported criteria, not a test-only algorithm.

### Stage 3 — Record GPS, EXIF and manual locations, including failure reasons

Primary repository: sporely-web. Depends on accepted Stage 2 and manual gate G2.

Extend existing capture-session/import-session state and persisted drafts. Map geo error kinds and preflight decisions at the action boundary using the frozen transitions. Route aware coordinate changes through the Stage 1 explicit server operation. Carry the selected fix source through EXIF hydration and canonical save location. Cover manual assignment/clearing and adding photos to existing observations without silently replacing location provenance. Test acquired GPS, denied, disabled, timeout, unavailable, skipped, usable/missing EXIF, manual overwrite/clear, late fixes, session reset and mixed photo GPS selection. Explicitly test that continue-without-location preserves denied/timeout/unavailable/disabled. Finalize docs/supabase-sync-contract.md with the desktop field/merge/preservation requirements so Stage 4 can implement against a fixed web contract. Real permission/settings flows, GPS availability and restored drafts belong to manual gate G3.

### Stage 4 — Preserve photo and location metadata through desktop sync

Primary repository: sporely-py. Depends on accepted Stage 3 and manual gate G3. Read-only sibling candidate: sporely-web at the exact accepted Stage 3 commit; declare and verify that pin.

In sporely-py update local schema/model fields, cloud observation/image payloads, snapshots and pull/push preservation. Reuse existing field-list conventions and passive snapshot preservation where suitable; location fields participate in merge as part of the coordinate bundle. Follow the legacy invalidation contract and use the aware operation for newly attributed coordinate changes. Cover cloud→desktop→cloud, metadata-only edits, legacy coordinate changes, old snapshots, anchor promotion, download-only zero writes and no-op sync behavior. Update the Python sync contract to match the already accepted, pinned web contract; both copies are required, with web changes owned by Stages 1 and 3. If matching requires a web change, stop for a separately owned amendment. Use project Python/pytest paths; no dependency changes.

### Stage 5 — Prepare diagnostic checks and a staging-first rollout runbook

Primary repository: sporely-web. Depends on accepted Stage 4 and manual gate G4. Read-only sibling candidate: sporely-py at the exact accepted Stage 4 commit; declare and verify that pin. Use the web contract already finalized by Stage 3; do not modify the desktop sibling.

This is a bounded implementation/documentation stage, not a production operation. Extend existing diagnostic SQL or add a focused owner-authorized provenance probe under supabase/; document a repeatable test-account matrix and guarded rollout procedure. Keep probes bounded and read-only, and do not add analytics, admin UI, device identifiers or full EXIF retention. Automated acceptance requires local query/projection checks, matching field/contract review against both accepted candidates, focused regression evidence from the earlier stages, and git diff --check. New test failures or changed code require the relevant rerun; unchanged earlier results are not rerun merely for count.

The runbook must name exact accepted commit SHAs, the provenance migration version, schema/RPC readiness checks, the disposable target, the Android/web and desktop candidate builds, the owner/non-owner/anonymous API matrix, rollback/disable steps and the ordered production checklist below. This stage commits/pushes those reviewable artifacts on automated evidence. The user executes the matrix in manual completion gate G5. No production operation occurs inside Stage 5.

## Manual gates (engine-enforced)

These paragraphs define the gates; their ids, kinds and placement must be represented in compile intake. Candidate acceptance never satisfies a gate. Each pass must be recorded by the user for the exact accepted candidate and verified target.

### G1 — API and access checks

Kind: manual. After Stage 1; blocks Stage 2. The operator applies the accepted, committed migration in the disposable local/staging target and verifies the actual API: owner reads and atomic same-enum coordinate updates, unrelated/value-identical legacy PATCH preservation, actual changed-coordinate legacy PATCH invalidation, failure rollback, non-owner/anonymous denial, and public observation/image responses omitting the private fields. SQL tests and effective ACL inspection alone do not satisfy this manual gate. Record target, candidate SHA, request results and pass/fail.

### G1C — Permission to continue with image ingestion

Kind: manual. After Stage 1; blocks Stage 2. The user explicitly gives the Stage 2 go-ahead after G1 passes. Starting Stage 1 or accepting its candidate does not satisfy this separate manual authorization gate.

### G2 — Camera, picker and offline retry checks

Kind: manual. After Stage 2; blocks Stage 3. On test-account candidate builds, the user exercises all five actual entry paths (Sporely camera, system camera, web camera, native picker, web file picker), one mixed-source batch with rejection/filtering followed by sorting/grouping, restart before save, queued restart, upload retry and lost-reservation-response recovery. Verify the correct ingest_method remains attached to each surviving image in the stored rows. Record candidate SHA, platform and observed values for every case.

### G3 — Location acquisition and restored drafts

Kind: manual. After Stage 3; blocks Stage 4. The user checks real device permission/settings flows, usable/missing image EXIF, manual coordinate assignment/clearing, late fixes, session reset and restored drafts. Continuing after denied/timeout/unavailable/disabled must preserve that meaningful outcome; a selected successful fix uses acquired and its actual source. A failed attempt must preserve existing selected coordinates. Record candidate SHA and the expected/observed pair for each reproducible case; unavailable device conditions keep the missing case blocked.

### G4 — Desktop restart and cross-client retention

Kind: manual. After Stage 4; blocks Stage 5. The user verifies restart persistence, web→desktop→web preservation, unrelated desktop edits, legacy coordinate changes, no-op sync, and Download-from-Cloud making zero cloud writes, using the accepted desktop candidate and its pinned web candidate in the disposable target. Record both SHAs, target and actual stored metadata. This explicit manual gate is required even when all desktop unit tests pass.

### G5 — Stored-metadata matrix and staging readiness

Kind: manual. After Stage 5; blocks plan completion. The user runs the Stage 5 matrix on the disposable target using the accepted web and desktop candidates. Minimum evidence: one successful saved observation for each of the five ingestion paths, at least one mixed batch with two different methods and a rejected/filtered image before sorting/grouping, and at least one restored queued retry; exercise each frozen location transition reproducible on the test devices. Inspect private stored values and public non-disclosure using owner, non-owner and anonymous API requests. Every executed case must match the expected image identity/method and coordinate/source/status bundle, with no unexplained mismatch or duplicate retry write. Missing required cases keep the manual gate blocked; do not invent a sample-duration threshold. Record exact SHAs, target, platforms and case outcomes. Passing this gate establishes staging readiness only.

## Ordered production procedure (outside the implementation run)

The following operation is a separate, explicitly authorized procedure. It is not an engine candidate stage and is not satisfied by plan completion. Its prerequisite is the recorded pass of G5 and a concrete operator checklist from Stage 5. No production work is currently authorized.

1. Present the exact migration version, target project/ref, candidate SHAs, client artifacts and rollback/disable procedure for a fresh, specific authorization of the production operation. Verify the target independently immediately before execution and run all AGENTS.md history and deploy-tree guards. The registered deferred 20260914090000 must remain excluded; any unregistered mismatch stops the procedure without repair or renaming.
2. Apply only the authorized committed provenance migration through the approved deploy-tree path, then post-verify migration history and API/schema readiness. This server step must complete before publishing or activating provenance-writing clients.
3. With separate explicit authorization for each client publication, publish/activate the tested Android/web candidate and desktop candidate. Keep prior clients compatible with nullable fields and conservative coordinate invalidation. No R2 worker or aspect-ratio change is included.
4. The operator checks one new saved observation per newly activated client/path, private provenance values, retry behavior and public non-disclosure. An unexplained mismatch holds further activation and invokes the reviewed disable/revert procedure. Passive observation beyond these smoke checks does not extend implementation acceptance.

Any admin diagnostic UI, aspect-ratio change or broader observation experiment requires its own bounded scope and authorization. No reconstruction of historical 1447/1457 provenance is possible from this metadata change. The ongoing batch-spore-preview B0→B1 measurement window remains untouched: no statistics reset, load test or landing switch is authorized here.

## Historical preparation evidence (not current acceptance)

The records below describe the earlier manual preparation at base a427a6f. They are retained for audit and must not override the execution/candidate policy or gate definitions above. The former remote-only history mismatch was superseded by the authentic committed migration; Stage 1 must establish fresh evidence. No local SQL, live schema/history or candidate behavior was reverified during this intake repair.

Audit and plan refinement only: source inspection and read-only live schema/policy/history queries; no application tests run because no implementation changed. No production migrations, builds, dependency installation or commits. Unrelated untracked work in both repositories preserved.

Stage 1 preparation precheck, 2026-10-12:

- `supabase migration list` completed. The registered local-only 20260914090000 is expected. An additional remote-only 20261012100000 is not registered and blocks migration preparation under AGENTS.md.
- Read-only remote history confirms 20261012100000 is named add_public_observation_spore_previews, already applied remotely. Expected filename by version/name: 20261012100000_add_public_observation_spore_previews.sql; no corresponding file exists in this checkout. No history repair or file reconstruction attempted.
- Tail: 20261011100000 local/remote; 20261011190000 local/remote (20261011190000_correct_admin_database_health.sql); 20261012100000 remote only.
- Status: untracked INBOX.md, unrelated 2026-10-04-cache-first-connectivity plan, this provenance plan, and supabase/verification/. Existing verification files were not edited.
- An existing local Supabase database is running; it was not reset or migrated. This does not establish schema compatibility or migration verification.
- No candidate migration, server code or tests created; no commit or push. Stage 1 remains incomplete pending a checkout with consistent migration history (apart from the registered exception). Stage 2 and production deployment remain unauthorized.

### Stage 1 preparation resumed

- Updated origin/main now contains the authentic applied 20261012100000 migration. The preparation was isolated in the permanent worktree /Users/sigmundas/Documents/Code/sporely/sporely-worktrees/sporely-web-provenance-stage1 on feature/ingestion-location-provenance-stage1, based on a427a6f. Moved from /tmp using git worktree move on 2026-10-12 so the uncommitted candidate is no longer in temporary storage. Original worktree/branch and unrelated files preserved; no history reconstructed or repaired. The read-only migration-list precheck passed with only registered deferred 20260914090000.
- Prepared 20261012105630_ingestion_location_provenance.sql: three nullable fields, enum/pair consistency checks, ordinary coordinate-change invalidation, owner/RLS-enforced SECURITY INVOKER set_observation_location RPC. No production application, public projection edit, historical backfill or R2 worker change. Alternate insertObservationImage and its fallback payloads also need Stage 2 propagation, beyond reservation.
- Existing public views and public RPC definitions use explicit projections; local checks inspect all public view columns and public RPC source/result declarations and exercise community observation/image views plus get_public_observation as a non-owner. Base owner RLS remains unchanged.
- RPC makes two conditional updates under one row lock and transaction; existing observation triggers were inspected. Location-only writes do not bump image/media versions. Identical retries do not create a new row tuple. Injected second-write failure rolls back coordinate changes. No client-controlled bypass.
- Verification: candidate migration plus supabase/tests/ingestion_location_provenance_test.sql passed on the existing local PostgreSQL 17.6 database inside BEGIN/ROLLBACK. Covers old inserts, all ingestion enums and failure statuses, acquired sources, each changed coordinate component and NULL transition, identical resends, omitted/partial provenance, aware same-enum updates, invalid pairs/ranges, rollback, no-op retry, media cursors, owner/non-owner RPC/base-table access, and public non-disclosure. Session transitions and filtering/sorting regression remain Stage 2/3 tests, not claimed by SQL coverage.
- Initial negative-ID fixture needed OVERRIDING SYSTEM VALUE. Anonymous denied-function calls inside DO caused a local PostgreSQL signal-11 backend crash; server recovered and candidate schema rolled back. Anonymous denial now uses has_function_privilege effective ACL; actual authenticated owner/non-owner and claimless calls remain exercised. No grants weakened. Validate real anonymous HTTP denial in the human gate.
- No full database reset, build, dependency installation, production writes, commit or push. Local schema/history unchanged after rollback. web sync contract documented the server candidate; desktop changes were left for Stage 4. Stage 1 remains a preparation candidate, not deployed/accepted.

## Intake repair record — 2026-10-12

- Refused intake: 2026-10-12-ingestion-location-pr-71e21f09-20261012T124111Z-compile-5a05. Its engine artifacts remain unchanged.
- Replaced two-checkout plan edits with immutable managed input and engine-owned stage notes. Existing prepared code is read-only source material, not a second active candidate branch.
- Made commit-before-manual-gate policy explicit for approved runs; kept a separate Stage 2 go-ahead and staging-only API/device gates.
- Assigned one primary repository per stage; Stage 4 uses a supplied Python context and pinned web contract, Stage 5 a pinned desktop candidate. No simultaneous sibling writes.
- Defined Stage 5 artifacts, measurable staging matrix and ordered, separately authorized schema-before-client production procedure.
- This repair edits documentation only. It does not import candidate implementation, commit an implementation stage, start a run, execute a manual gate, migrate any target, reset statistics or change B0/B1 work.
