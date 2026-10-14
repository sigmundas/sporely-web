# Per-record sync keys — retire the shared `desktop_id` identity

Status: revised 2026-10-14 after the user's scope decisions; not started. Approving this plan authorizes the three implementation slices below and their candidate pushes to the designated branches. It authorizes no merge to `main`, no production operation and no gate result in any other run.
Date: 2026-10-14
Scope: the permanent fix for the multi-desktop `desktop_id` collision, implemented and tested together with the photo-location feature as one integrated desktop release. In scope: the web identity contract and a write stop for faulty desktop builds; the desktop sync change; web/Android key creation. Deferred: the database cutover and the refusal of keyless inserts. Repositories: sporely-web and sporely-py.

Purpose: two desktop installations on one account write their own SQLite ids into the shared cloud `desktop_id`. Reverse-link recovery then routes one device's new observation into an overwrite of the other device's cloud row (reproduced ab15, ab17, ab19; present in every released desktop and in `ee6f2af`). The user decided on 2026-10-13:
- `desktop_id` is retired as a sync identity, replaced by a random, immutable, per-owner `sync_key` per record;
- obsolete desktops get a hard refusal rather than silent discard;
- crash recovery and idempotent retry are release blockers.

This plan finishes that work and does not redesign it.

## Authority, accepted work and what this plan does not own

This document is the design authority. The "Identity rules" section and the stage text contain every normative rule a stage needs. The operator design record outside the repositories is provenance only:
- `sporely-worktrees/g4-evidence/PROPOSAL-desktop-id-identity.md` Revisions 3–5;
- `identity-design/VERIFY-identity-rules.md`;
- `identity-design/RELEASE-SEQUENCING.md`;
- the security review and its re-check.

Where those disagree with this document, this document wins, and the stage reports the disagreement.

Accepted work, built on and not redone:

- **Database sync keys and identity guard:** sporely-web `24700c0` on `feature/sync-key-schema-s1`. Accepted and pushed 2026-10-14; security review approved; 97/97 database tests.
  - Its disposable-target dry run is recorded as passed, with one stated limitation: of the desktop builds, only `ee6f2af` was run against it. Older released builds are covered by this plan's old-client cases.
  - Not merged; not in production.
- **Desktop local sync keys:** sporely-py `be511bf` on `feature/sync-key-local-s2`. Accepted and pushed 2026-10-14; 1265 tests pass.
  - Its GUI check covered profile upgrade, restart, new observations and images, copied profiles, sync, no-op sync and Download from Cloud.
  - It did **not** cover measurement creation, bundle import, portable import or image move; those were unit-tested only. That incomplete result is preserved as it stands and is not recorded as passed.
  - By the user's decision of 2026-10-14, those four scenarios are performed against the integrated desktop build in Stage 6 instead.
  - Not merged; not released.
- **Photo-EXIF attribution:** sporely-py `ee6f2af` on `feature/ingestion-location-provenance-stage-4`, accepted.

**Accepted commits only.**
- Slice P1 starts from accepted `ee6f2af` and merges accepted `be511bf`, so every later P1 commit contains both.
- Every sibling pin is the exact accepted final candidate of the slice it names.
- The photo-location run receives only the accepted final commit of slice P1.
- An unaccepted branch head is never pinned, fast-forwarded to or cited as gate evidence.

Not owned by this plan:

- **The temporary production brake** (sporely-web `fix/obsolete-desktop-sync-brake` at `48dc63e`, runbook, and sporely-py contract note `f774d9b`).
  - By the user's decision of 2026-10-14 it is **not deployed** and is kept only as a contingency: the admin center shows no microscopy cloud uploads from any account but the user's.
  - Its branches are not merged to `main`. See "Database migration order" for how it stays inactive.
- **The photo-location plan** (`docs/plans/active/2026-10-12-ingestion-location-provenance.md`). Its run stays paused with the desktop check (G4) failed. This plan supplies the accepted integrated desktop commit and the re-test evidence.
- **Later work, planned closer to release** when actual adoption is known (see "Deferred"):
  - the database cutover and the refusal of keyless inserts;
  - cleanup: dropping the `desktop_id` unique constraints, retiring `portable_cloud_identity_pending`, the orphan-media audit.
- The temporary desktop fail-safe is not built.
- The partial Download from Cloud on a fresh profile is tracked separately in sporely-py.

## Identity rules

These rules are settled. A stage that cannot implement one as written stops and reports.

### Server (accepted at `24700c0`)

- `sync_key uuid NULL` on `observations`, `observation_images` and `spore_measurements`, with no backfill.
- Per-owner partial unique indexes `observations_user_sync_key_uidx`, `observation_images_user_sync_key_uidx` and `spore_measurements_user_sync_key_uidx` on `(user_id, sync_key) WHERE sync_key IS NOT NULL`.
- Guard `public._sync_identity_guard()`:
  - SECURITY INVOKER, pinned `search_path`;
  - triggers `zzz_sync_identity_guard_{obs,image,measurement}`, BEFORE INSERT OR UPDATE, which sort last among BEFORE triggers (asserted by tests);
  - trusted callers are `postgres`, `service_role` and `supabase_admin`.
  - Rule 1, all roles: `sync_key` never changes on UPDATE, in any direction.
  - Rule 2, non-trusted callers: a row carrying both `sync_key` and `desktop_id` is refused on INSERT and UPDATE.
  - Both refuse with `P0001`, hint `sporely_sync_identity_refused`.
- Error text is fixed. It never contains row values, any auth word (`unauthorized`, `not logged in`, `jwt`, `token`, `session expired`, `authentication failed`, `invalid_grant`, `pgrst301`/`303`, `captcha_failed`) or any transient word (`timeout`, `unavailable`, `schema cache`).
- `sync_key` never appears in non-owner views or public RPC results, and storage keys are never derived from it.
- Refusals always use `P0001` (HTTP 400), never `42501`/403: v0.8.13 and v0.9.1 treat 403 as a sign-in failure.

### Desktop write stop (new; built in Stage 1)

A practical way to stop writes from a faulty newly released desktop build, without a deploy and without touching other clients:

- The new desktop sends two headers on every Data API and media-worker request:
  - `x-sporely-sync-identity: 2`;
  - `x-sporely-client-version: <app version>`.
- A new migration, versioned after `20261013210000`, adds:
  - a table `private.sync_client_write_block(client_version text PRIMARY KEY, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`, owner-only: privileges revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`, RLS on with no policies;
  - a trigger function `private.sync_client_write_block_guard()`, run as BEFORE INSERT/UPDATE/DELETE row triggers on `observations`, `observation_images`, `spore_measurements`, `spore_measurement_mosaics`, `spore_measurement_mosaic_tiles`, `observation_spore_summaries` and `observation_reference_uses`.
- Privileges:
  - The trigger function is SECURITY DEFINER, owned by the migration owner, with `search_path` pinned to `''` and fully qualified names.
  - EXECUTE is revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`. Trigger firing does not need EXECUTE, so clients can neither call the function nor read the table.
  - The function reads only the block table and `request.headers`. It never uses `current_user`, writes nothing, and returns `NEW` (or `OLD` on DELETE) unchanged when not refusing.
  - pgTAP asserts `prosecdef = true`, the pinned `search_path`, the revoked EXECUTE, and that `authenticated` cannot `SELECT` the table.
- The check reads PostgREST's `request.headers`. When `x-sporely-sync-identity` is present and `x-sporely-client-version` is listed in the table, it refuses with `P0001`, hint `sporely_upgrade_required`, and the fixed message "This version of Sporely Desktop is blocked from uploading. Install the latest version from sporely.no. Nothing was changed in the cloud."
- The check keys only on the request headers, never on the database role. Requests without the identity header are never affected: web, Android, released desktops, Edge Functions, migrations and plain SQL sessions.
- RPC writes are covered even when the function runs as its owner, because the request's headers stay visible inside it.
- Activation is one authorized production `INSERT` of the faulty version, and removal is one `DELETE`.
- The new desktop treats the refusal like any `sporely_upgrade_required` answer: it stops uploading, keeps rows dirty and shows the banner.
- Limit: media-worker requests are not blocked. A blocked build can still upload or delete media bytes, but it cannot write the rows that reference them. Rows are written first, so this costs orphan bytes at worst.

### Desktop (local keys accepted at `be511bf`; sync change in this plan)

**Creation paths, already built:**
- Every local creation path mints a uuid4 key in the INSERT's transaction.
- Pull stores the remote key, which may be NULL, and never mints. An explicit sentinel separates "not provided" from "remote NULL".
- Portable import, legacy bundle import and image move mint fresh keys. Bundle import also clears `cloud_id` and the sync state that portable import clears.
- Full restore and copied library files keep keys.
- The SQLite migration keys only rows without `cloud_id`.

**Invariant:** no POST without a committed local key. A cloud-linked row with a NULL key is never POSTed, only PATCHed by verified `cloud_id`.

**Per-row state machine** (observations, images, measurements; a child waits for its parent's committed `cloud_id`):

| State | Event | Action | Next |
| --- | --- | --- | --- |
| L0 (key, no `cloud_id`) | parent has no `cloud_id` | defer | L0 |
| L0 | POST with `sync_key` → 201 | commit `cloud_id` | L2 |
| L0 | `23505` naming the table's `*_user_sync_key_uidx` | GET by key and owner; parent check; tombstone → existing deletion/restore flow; content equal → link silently; content differs → sync conflict, never PATCH | L2 or conflict |
| L0 | `23505` on any other constraint, `23503`, `42501`, any other 4xx | plain error; row stays dirty | L0 |
| L0 | timeout, network error, crash | nothing; the retry repeats the same POST | L0 |
| L0 or L2 | `P0001` with hint `sporely_upgrade_required` or `sporely_sync_identity_refused`, or a media 426 with `X-Sporely-Error-Code: sporely_upgrade_required` | stop the upload phase for this run; keep rows dirty and downloads working; persistent banner "This version of Sporely can no longer upload. Please install the latest version."; log it as a server/client mismatch | unchanged |
| L2 (`cloud_id`) | edit | verify `cloud_id`; PATCH by id; never send `sync_key` or `desktop_id` | L2 |

**Adoption and ownership:**
- Adoption takes the fetched row as the base snapshot.
- Parent check: an image's `observation_id` must equal its local parent observation's `cloud_id`, and a measurement's `image_id` its local parent image's `cloud_id`. Otherwise it is an identity conflict: no re-parenting, the row stays dirty.
- An adopted image reuses the adopted row's reserved `storage_path`. If its bytes were never confirmed, the retry uploads to that same key.
- The client matches the constraint name, not only SQLSTATE `23505`: the legacy `UNIQUE(desktop_id, user_id)` collision is also `23505`.
- An image moved to another observation is a new cloud row with a fresh key. The old cloud image is tombstoned, because cloud `observation_id` is immutable.

**Pull** matches by cloud `id`, else by a `sync_key` equal to a local key, never by integer. Every `desktop_id` heal and reverse lookup is removed. `conflict_detail` pairs child rows by cloud id, then by key.

**Before uploading**, the desktop probes `select=sync_key&limit=0`. If the column is missing, it blocks uploads with "cloud not ready" and pull keeps working.

**Lost cloud id from an older version (one-time legacy recovery).** An older desktop may have created a cloud row and crashed before storing its `cloud_id`. The upgrade then gives that local row a key, and a plain POST would create a duplicate. The rule:

- When the new desktop's migration adds its marker column `legacy_recovery_pending`, it sets the marker on every observation, image and measurement row that has no `cloud_id` at that moment, and never sets it again afterwards. On a real user's first launch of the new desktop, the local-key and marker migrations run together, so the marker means exactly "existed before the upgrade, never confirmed in the cloud".
- Before a marked row's first POST, the desktop makes one read-only lookup for rows of the same owner with `sync_key IS NULL` and `desktop_id = <local id>`. For images and measurements, the lookup is also restricted to the already-linked parent.
- **Exactly one match whose uploaded content equals the local row:** link it locally (store `cloud_id`, clear the marker). There is no cloud write: the key cannot be added to an existing row, and `desktop_id` is never written.
- **Any other outcome** (no match, several matches, or different content, which may be another device's colliding row): clear the marker and POST as a new keyed row. Report "possible duplicate of an earlier upload" in the sync summary.
- A row found this way is never PATCHed and never deleted. The worst case is a visible duplicate, never an overwrite.
- After the eventual cutover clears `desktop_id`, the lookup finds nothing and the rule becomes a no-op.

### Web and Android (key creation in this plan)

- Mint `sync_key` at queue time with `crypto.randomUUID()`, falling back to `crypto.getRandomValues`, and persist it in the queued item. Queued items saved before the change get a key on load.
- Cover `src/sync-queue.js` and every insert in `src/images.js`, including each fallback payload. Those payloads keep `sync_key` when they strip other columns.
- Adopt after `23505` on the named index under the desktop's rules: link without PATCH, or fail visibly, when the adopted row differs.
- Web and Android never send `desktop_id`, and never send the desktop identity or version headers.

### Contract text

Both copies of `docs/supabase-sync-contract.md` get this identity section, byte-identical. Stage 1 writes the web copy, and Stage 5 copies it to sporely-py. The brake's marked block is not added.

- Definition: "`sync_key` is a random uuid minted locally before the first upload. It is immutable for every role, unique per owner, and recovers only the creating database's own rows. `desktop_id` is retired as an identity: clients must not send it, and the server refuses it on rows that have a key."
- Rule 12: "A lost `cloud_id` is reconciled by `sync_key`; rows that predate keys use the one-time legacy recovery, which never writes to the matched row."
- Rule 20: "`sync_key` is the only recovery identity. Integer local ids are never cloud identities."
- Rule 21, replaced: "No client writes an identity onto an existing cloud row. Pull links by cloud id or `sync_key`."
- Rule 23: "POST only for a row with a key and no `cloud_id`. A 23505 on the table's `*_user_sync_key_uidx` means adopt: parent check, then the fetched row as base, then a conflict on any difference. A tombstone goes to the deletion flow. Any other 409 or 4xx is an error."
- Rule 26: superseded; imports and other forks mint fresh keys.
- New rule: "Children are uploaded only after their parent's `cloud_id` is committed locally. Media object keys are random reserved keys, reused on adoption, never derived from `sync_key`."
- New rule: "The desktop sends `x-sporely-sync-identity: 2` and `x-sporely-client-version`. A version listed in the server's write-block table is refused with `sporely_upgrade_required`."
- Also the state-machine table, the refusal hints and the 426 media answer, the "cloud not ready" probe, and the rule that no rollback restores `desktop_id` links.

## Verification matrix

Tiers:
- **P**: pgTAP on scratch databases.
- **U**: unit tests with two SQLite databases and a shared fake cloud that enforces the per-owner unique indexes and returns real constraint names. Tests wrap the real sync functions in pass-through recorders and never stub the behaviour under test.
- **G**: agent-run GUI/API harness on the disposable target with two isolated profiles and audit logs.

No behaviour claim rests on U alone.

| # | Case | Expected | Tier |
| --- | --- | --- | --- |
| 1 | A creates a row; B creates one with the same local id | B inserts; A untouched; no `desktop_id` writes | U+G |
| 2 | both download; alternating pulls ×3 | no identity writes, no `updated_at` echo | U+G |
| 3 | A edits; B pulls | only B's linked row changes | U+G |
| 4/5 | conflict; keep-device / take-cloud | only the paired rows change | U+G |
| 6 | kill after the server INSERT, before the local `cloud_id` write (observation, image, measurement) | 23505 → adopt; one row each | U + G (fault hook) |
| 7 | timeout after a successful INSERT | adopt, no duplicate | U+G |
| 8 | kill before the request lands | single insert on retry | U+G |
| 9 | kill mid-upload, and after upload before confirmation | reserved key reused, one object | U+G + orphan count |
| 10 | child whose parent is unknown | deferred; parent first | U+G |
| 11 | restart between every step of 6–10 | same as 6–10 | G |
| 12 | portable or bundle import of A's archive into B | fresh keys, new rows, no shared `cloud_id` | U+G |
| 13 | copied database, unchanged content | 23505 → adopt silently | U+G |
| 13b | copied or restored database whose rows were since edited elsewhere | adoption raises a conflict; no PATCH | U+G |
| 13c | adopted row soft-deleted or purged | deletion/restore flow; no resurrection | U+G |
| 13d | 409 from `23503`, or `23505` on another constraint | plain error, not adoption | U+P |
| 14 | old clients (v0.8.13, v0.9.1, v0.9.15, v0.9.18, v0.9.25, `0520afd`, `ee6f2af`) against the key schema | unchanged except refused link repairs onto keyed rows; no sign-in prompt; local data and credentials kept | G |
| 14b | an old client repairs a link onto a new-desktop row | refused; the row keeps a NULL link | P+G |
| 15 | new desktop against a server without the key schema | uploads blocked "cloud not ready"; pull works | U+G |
| 16 | web create and edit with keys, retries and adoption | keys present, no duplicates | P + web unit + G |
| 18 | `sync_key` immutable for every role; guard `prosecdef = false` | refused for every role | P (accepted) |
| 19 | another tenant uses the same key | allowed; no cross-tenant 409 | P (accepted) |
| 20a | `sync_key` absent from every non-owner view and public RPC | absent | P (accepted) |
| 22 | an old desktop crashed after creating cloud rows, before storing `cloud_id`; the new desktop upgrades the profile | equal content → linked, no cloud write, no duplicate; different content or another device's colliding row → new row plus a "possible duplicate" report; nothing PATCHed | U+G |
| 23 | the write stop: block the candidate's version, sync, then unblock | while blocked: every row write refused, banner shown, local data kept, other clients unaffected; after unblock: pending work uploads | P+G |
| 24 | ownership after two-desktop activity: images and measurements of both computers | every image under its own observation and every measurement under its own image; storage paths stay in the owner's prefix; no child re-parented | U+G |

Rows 17, 20b, 21 and 16b belong to the deferred cutover and keyless refusal.

## Dependencies and order

| Work | Needs | Does not need |
| --- | --- | --- |
| Web contract and write stop (Stage 1) | accepted database keys | anything else |
| Desktop fix (Stages 2–7) | accepted database keys, local keys and photo-EXIF desktop code; the Stage 1 contract | web/Android key creation |
| Web/Android key creation (Stage 8) | accepted database keys | the desktop fix |
| Photo-location desktop re-check (G4) | the accepted desktop fix | web/Android key creation |

The design record listed web key creation before the desktop. That is a release preference, because Android adoption takes time. It is not an implementation dependency. The blocker and the photo-location re-check need only the desktop fix, so it runs first.

## Database migration order

The production order is fixed by migration version:
1. photo-location `20261012105630`;
2. database sync keys `20261013210000`;
3. the write stop, newer than both.

They reach `main` together with the integrated release and are applied through the repository's deploy-tree procedure, with its history checks.

The brake stays inactive by construction:
- Its migration `20261013200000` and its worker change exist only on `fix/obsolete-desktop-sync-brake`, which is not merged to `main`. `supabase db push` and the deploy tree therefore never see it.
- The sporely-py brake contract note `f774d9b` is not merged either.
- If the brake is ever needed, it is re-issued as a new migration with a version newer than everything applied, which is allowed because it was never applied anywhere in production. It is reviewed again at that point. The new desktop already sends the identity header the brake exempts.

## Execution structure

Engine checked 2026-10-14: agent-sparring `ea8e70d`.
- Compile intake; one primary repository per slice; read-only sibling pins verified at acceptance.
- Review-only stages run in mode `independent_review`.
- Acceptance requires a pushed candidate; each slice starts with `--allow-push-for-run`.

| Slice | Primary repository and branch | Stages | Starts from |
| --- | --- | --- | --- |
| W1 | sporely-web `feature/sync-key-identity-web` | 1 | `1029975` (photo-location web head) |
| P1 | sporely-py `feature/sync-key-desktop-n1` | 2–7 | accepted `ee6f2af`; sibling pin: W1 final candidate |
| W2 | sporely-web, same branch as W1 | 8 | W1 final candidate |

**Run order:** W1, then P1, then W2. W2 depends only on W1.
- Each implementation stage has one writer in its primary repository and never edits a sibling.
- If a desktop stage needs a web contract change, it stops and reports.
- The slices contain no manual or authorization gates; every check inside them is agent verification. The user's actions are listed in "Outside these runs".

**Verification policy:**
- Each stage passes its own checks and an independent review, then the engine commits, pushes and accepts it.
- A failed check is fixed in a new stage or reverted.
- Agents never edit engine state or record a result in another run.

**Environment rules for every stage:**
- **Disposable environments only:**
  - the local Supabase stack `sporely-g3-verify`, its stub media worker and the Vite web app;
  - the scratch-database wrappers `sporely-worktrees/identity-impl/db/dbreset.sh` and `dbsql.sh`;
  - the harness in `sporely-worktrees/g4-evidence/tools/` (`run.sh`, `g4_launch.py`, `g4_scenarios.py`, `g4_netprobe.py`, `g4_web.mjs`).
- **The harness** launches only under its kernel sandbox. It admits a desktop commit only if it is on its fixed list, or is a clean sporely-py commit that contains `ee6f2af` and `be511bf` and is reachable from `feature/sync-key-desktop-n1` or `feature/ingestion-location-provenance-stage-4`. It refuses to start unless outbound traffic is blocked and the local target answers. It records the tested commit and those checks in each run's `manifest.json`. No stage edits anything under `sporely-worktrees/g4-evidence/tools/`. New desktop GUI scenarios belong to the sporely-py candidate in `tools/sync_harness/scenarios.py`:
  - they are tracked, reviewed with the stage, contain no credentials or network code, and use the harness's driver helpers;
  - the harness runs them as `--scenario repo:<function>` and records the file's sha256 in `scenario_source.json`.

  If the harness refuses a candidate, the stage stops.
- **No hosted access:** no stage contacts a hosted Supabase project, production host or production credential. Stage 1 creates one migration. Before creating it, the stage compares the branch's migration files with `origin/main`. Exactly two additions are expected and allowed: the accepted photo-location migration `20261012105630_ingestion_location_provenance.sql` and the accepted sync-key migration `20261013210000_sync_key_identity.sql`. Any other difference stops the stage: a missing, changed or extra file, or a version registered in `supabase/deploy-exceptions.json` behaving differently than its registry entry says. The new migration's version must be newer than every migration on the branch and on `origin/main`. The production history check (`supabase migration list`) belongs to the release procedure.
- **Tools:** project interpreters and focused tests only. No `npm test`, builds, Capacitor sync, dependency installation or package upgrade.
- **Hands off:** the brake branches, the earlier S1/S2 run worktrees, `INBOX.md` in any checkout, and the untracked `tools/metadata_backfill/` work in the primary sporely-py checkout.

## Stages

### Stage 1 — Merge the database keys into the photo-location web line; add the desktop write stop; write the identity contract (web copy)

Primary repository: sporely-web. Starts at `1029975`.

Make three separate commits, in this order:

1. Merge the accepted database-key commit `24700c0`. The merge was conflict-free when checked with `git merge-tree` on 2026-10-14. No other change goes in this commit.
2. Add the write-stop migration and its pgTAP tests exactly as "Desktop write stop" specifies. Tests:
   - a listed version is refused on INSERT, UPDATE and DELETE of every covered table, including a write made inside `set_observation_location`;
   - an unlisted version, a request without the identity header, and a SQL session with no request headers are allowed;
   - the table's privileges are owner-only;
   - the refusal is `P0001` with hint `sporely_upgrade_required`, and the message contains no auth or transient word.
3. Add the identity section to `docs/supabase-sync-contract.md` exactly as "Contract text" specifies.

Verify:
- The accepted database-key tests, the photo-location provenance tests and the new write-stop tests pass on a fresh scratch database through the wrappers, with all migrations applied in version order.
- The focused `node --test` files for `src/sync-queue*.test.js` and `src/images*.test.js` pass unchanged.
- `git diff --check`.

### Stage 2 — Integrated desktop baseline, verified before any sync change

Primary repository: sporely-py. Read-only sibling: sporely-web at the exact accepted Stage 1 commit.

The slice branch starts at accepted `ee6f2af`. Merge accepted `be511bf`. On 2026-10-14 `git merge-tree` found two mechanical conflicts:
- `database/models.py` `ObservationDB.create_observation`: keep the provenance columns and `sync_key`, and make the placeholder count equal the column count.
- `utils/cloud_sync.py` pull-create kwargs: keep both `**_remote_location_provenance_kwargs(remote)` and `sync_key=None`.

Resolve only these. No behaviour change.

Verify:
- `py_compile` of the touched files.
- Project pytest on `tests/test_sync_key_local.py`, `tests/test_observation_details_location_provenance.py`, `tests/test_cloud_location_provenance_sync.py`, the image-import tests, and the focused cloud-sync, schema and `db_share` suites that either side touched.
- A test that `create_observation` stores every provenance field and the key.
- `git diff --check`.

The stage agent then launches the harness itself:
- the isolation probe passes on this commit;
- a fresh-profile Download from Cloud followed by a no-op sync makes zero data writes, and no request body contains `sync_key`.

If the harness cannot be launched, the stage stops and reports what blocked it.

### Stage 3 — Observation identity: state machine, legacy recovery, readiness probe, headers

Primary repository: sporely-py. Same web pin.

Implement, for observations:
- the state machine, adoption and conflict hand-off, the tombstone hand-off, and the named-index `23505` match;
- plain errors for every other refusal;
- refusal handling with the persistent banner;
- the "cloud not ready" probe;
- both desktop headers on every Data API and media-worker request;
- the marker migration and the one-time legacy recovery.

Observation payloads stop sending `desktop_id`, and PATCH goes by verified `cloud_id` only.

Add an environment-gated fault hook (`SPORELY_SYNC_FAULT=after_insert|before_request|after_upload`). It is inert unless set, and never read from settings or the UI.

Unit tests (U tier, observations): matrix rows 1, 6–8, 13–13d, 15 and 22, and the write-stop refusal.

### Stage 4 — Images, measurements and anchors on the state machine

Primary repository: sporely-py. Same web pin.

- Children are deferred until the parent's `cloud_id` is committed.
- Strict parent check on adoption; no re-parenting.
- Reserved `storage_path` reuse, and the confirming upload on retry.
- Image move becomes a new cloud row with a fresh key.
- Legacy recovery for marked images and measurements, restricted to the linked parent.
- Payloads stop sending `desktop_id`.

Unit tests: matrix rows 6–11, 12, 13–13d, 22 and 24 for images and measurements.

### Stage 5 — Pull and conflict pairing by id or key; remove every `desktop_id` read, write and repair; desktop contract copy

Primary repository: sporely-py. Same web pin.

- Pull matches by cloud id, else by `sync_key`, never by integer.
- Remove every `desktop_id` link repair and reverse lookup in `cloud_sync.py` (including `_find_cloud_observation`), `image_identity.py`, `image_pull.py`, `anchors.py`, the measurements and reconciliation modules, `baseline.py`, `conflict_detail.py` and `conflict_plan.py`. The only exception is the read-only legacy-recovery lookup from Stage 3.
- `conflict_detail` pairs by cloud id, then by key.
- Portable-pending rows upload through the state machine. Their `desktop_id`-based finalisation repair is removed; the flag stays until cleanup.
- Diagnostic tools (`tools/cloud_reconciliation_report.py`, `tools/audit_cloud_media_health.py`, `utils/cloud_media_audit.py`) may report `desktop_id` but never use it as identity.
- Record an `rg` inventory in `notes.md` showing that no sync path writes, compares or sends `desktop_id`, and that the only read is the legacy-recovery lookup.

Copy the identity section into sporely-py's contract, byte-identical to the pinned web copy (verify by section diff).

Unit tests: rows 2–5 and 10, plus a regression that fails on `ee6f2af`: two databases with overlapping local ids, where B's new row inserts and A's row is untouched.

### Stage 6 — Two-desktop collision regression, ownership, recovery and the outstanding GUI scenarios on the integrated build

Primary repository: sporely-py. Same web pin. This is agent verification of the accepted Stage 5 code. A defect found here is fixed in this stage and re-verified, so the evidence comes from the final code.

Set-up:
- The disposable target has the Stage 1 web migrations applied, as a recorded snapshot.
- Two isolated new-desktop profiles on one test account, with deliberately overlapping local id sequences.
- Audit triggers record every cloud write.

Required cases:
- Matrix rows 1–13d in the G tier, including row 11 with the fault hook.
- Rows 14, 14b, 15, 22, 23 and 24.
- The exact ab15/ab17/ab19 reproducer: zero overwrites and zero `desktop_id` writes.
- One new-desktop profile alongside released `ee6f2af` and `0520afd` on the same account.
- **The outstanding desktop GUI scenarios** from the local-key check, on this integrated build: measurement creation, bundle import, portable import and image move. Scenarios the harness lacks are added in this stage to `tools/sync_harness/scenarios.py`.
- An orphan-object count from the stub store after the crash cases.

Photo-location desktop re-check (G4), on the same build and web pin. Re-run only the cases whose code path the sync change touched:
- Download from Cloud on a fresh profile, then the first write-enabled sync: zero identity writes;
- no-op sync;
- a new observation from a geotagged photo (`image_exif`/`acquired`);
- web → desktop → web retention;
- an unrelated edit;
- an attributed edit with a restart before sync;
- conflict keep-device and take-cloud;
- restart persistence;
- the Edit Images detour (NULL/NULL, no RPC).

The Prepare Images typing cases (r03–r06, r04b, r05b) are carried forward from `ee6f2af` only if `git diff ee6f2af..<tested commit>` touches neither `ObservationDetailsDialog` in `ui/observations_tab.py` nor the image-import dialog; otherwise re-run them. State which applied.

Evidence convention:
- Every harness run is made on one clean tested commit `T`, the last code commit of this stage. The launcher records `T` in each `manifest.json`.
- The summary `docs/verification/2026-10-sync-key-n1-two-desktop.md` is the stage's final commit, on top of `T`, and changes only that file.
- It lists `T`, the target snapshot and, per case, the run id, expected result, observed result and evidence log path, plus the carried-forward cases with their reason.
- Logs, profiles and credentials stay outside the repository.
- The reviewer checks that only the summary changed between `T` and the candidate, that every cited manifest records `T`, and that the summary matches its logs.

### Stage 7 — Independent security review of the desktop fix

Mode: `independent_review`. Primary repository: sporely-py at the accepted Stage 6 commit; sibling sporely-web at the accepted Stage 1 commit.

A fresh reviewer with no write access checks:
- that no path sends, writes or repairs `desktop_id`, and that the legacy lookup is read-only, exact-content only and never followed by a write to the matched row;
- that adoption cannot cross owners or parents, or resurrect a tombstone;
- that refusal handling cannot trigger sign-in prompts, credential clearing or retry storms;
- that the write stop affects only listed desktop versions;
- that the fault hook is inert unless its environment variable is set;
- that both headers are sent on every write path;
- that the contract copies are byte-identical in the identity section;
- that the Stage 6 evidence follows its convention and covers every listed case.

A defect stops the plan; nothing is fixed in this stage.

### Stage 8 — Web and Android key creation and adoption

Primary repository: sporely-web, starting at the W1 final candidate. Implement "Web and Android" from the identity rules.

The engine's review of this stage includes a security checklist:
- every insert path mints and keeps a key;
- no key appears in a public projection;
- adoption never crosses owners and never links a differing row silently;
- items queued before the change gain keys on load.

Verify:
- Focused `node --test` tests:
  - fallback payloads keep `sync_key`;
  - stable keys for previously queued items;
  - lost-response retry adopts on the named-index `23505`;
  - a differing adopted row fails visibly without PATCH;
  - other `23505`, `23503` and 4xx answers are plain errors;
  - the `getRandomValues` fallback.
- On the disposable target, matrix row 16 through `g4_web.mjs`, plus one coexistence case if the accepted P1 commit exists: web and the new desktop editing the same observation.
- `git diff --check`.

## Outside these runs (user actions; none is a gate or stage of this plan)

**Photo-location re-check and resume:**
1. After slice P1 completes, the coordinating agent runs these read-only commands outside every run and reports their output:
   - `git -C sporely-py merge-base --is-ancestor ee6f2af <P1>`
   - `git -C sporely-py merge-base --is-ancestor be511bf <P1>`
   - `git -C sporely-py ls-remote origin refs/heads/feature/sync-key-desktop-n1` (must equal `<P1>`)
   - a check that `<P1>` equals the candidate recorded as accepted in the P1 run's final stage state.
2. With the user's separate authorization, the user or the coordinating agent fast-forwards `feature/ingestion-location-provenance-stage-4` from `ee6f2af` to `<P1>`. That branch is outside the push guard's allow-list.
3. The user records the photo-location desktop check in its own run, citing `<P1>`, the web pin, the Stage 6 summary and the earlier `ee6f2af` evidence for carried-forward cases. The earlier failure stays in its history.
4. The user prepares the two primary checkouts, then resumes the photo-location plan:
   - sporely-py on `feature/ingestion-location-provenance-stage-4` at `<P1>`, clean, with the untracked `tools/metadata_backfill/` moved aside, not discarded;
   - sporely-web on `feature/photo-provenance`, clean, with `INBOX.md` committed or moved.

   The identity sections of the two contract copies differ until the web identity branch reaches `main`. That difference is expected.

**Release**, one integrated release with the photo-location feature. Each step needs explicit authorization, exact SHAs and sporely-web `AGENTS.md`'s deploy-tree and history checks:
1. Optional, read-only and quick: confirm limited exposure with one aggregate query over production metadata. Count accounts with desktop cloud writes in the last 90 days, and accounts with more than one desktop device in `reference_client_devices`, with small counts suppressed. No per-account rows go into Claude.
2. Merge the integrated branches to `main`: photo-location web, the web identity branch, and the integrated desktop. Do not merge the brake branches.
3. Apply the migrations in version order: `20261012105630`, `20261013210000`, then the write stop.
4. Deploy the web build. Build an Android test build and check it on a real device:
   - an offline queue survives a restart;
   - an item queued before the change gains a key;
   - a lost-response retry adopts.

   Publish Android.
5. Publish the integrated desktop, with an upgrade notice the user approves. If it misbehaves, list its version in the write-block table.

## Deferred: cutover and keyless refusal (to be planned closer to release)

Planned in a later revision of this plan, once desktop adoption after the release is known. These safety requirements carry over unchanged:

- **Cutover.** One transaction that:
  - takes the strongest lock it needs on the three identity tables before reading anything (or moves the `CHECK` and view replacement into a follow-up migration);
  - backs up `desktop_id` only if the DPO decides so, owner-only and forensic, with an approved retention period;
  - clears `desktop_id` with the four `updated_at` triggers disabled, so no `updated_at` changes;
  - asserts backup count = cleared count when there is a backup;
  - adds a guard rule refusing any non-trusted write carrying `desktop_id`, with `P0001` / `sporely_upgrade_required`;
  - adds `CHECK (desktop_id IS NULL)`;
  - keeps the community, follow and friend views' column as `NULL::integer`.

  A lock timeout aborts it with no partial state. Retry the identical migration in a quiet window, at most three times.
- **No rollback ever restores `desktop_id` links.** Rollback keeps the refusal rule and the `CHECK`.
- **Keyless refusal.** Optional. It applies only when every client insert path mints keys and the measured adoption criteria hold:
  - zero keyless inserts for 14 days;
  - no pre-change web, Android or desktop versions active for 14 days, or an accepted residual below 1 %;
  - the upgrade notice visible for 14 days.

  Old Android builds' behaviour under refusal must be tested on a device first.
- **Cleanup:** drop the `desktop_id` unique constraints; retire `portable_cloud_identity_pending` and the legacy-recovery marker; run the orphan-media audit; review any backup before its retention ends.
- Matrix rows 16b, 17, 20b and 21 move to that revision.

## Decisions recorded 2026-10-14

- The brake is not deployed and is kept as a contingency.
- The desktop fix ships with the photo-location feature in one integrated release.
- The local-key GUI check is amended: its four unperformed scenarios run on the integrated build in Stage 6. Its incomplete result is preserved, not recorded as passed.
- The cutover and keyless refusal are deferred out of this run.
- The database dry-run result stands, with its limitation.
- Push guard (`sporely-worktrees/identity-push-guard/README.md`): fast-forward pushes to `origin` only, for `feature/sync-key-identity-web` (web) and `feature/sync-key-desktop-n1` (py), plus the two already-accepted branches. Harness admission: `g4-evidence/tools/CHANGE-2026-10-14-lineage-admission.md`.
