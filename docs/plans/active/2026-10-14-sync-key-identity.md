# Per-record sync keys — retire the shared `desktop_id` identity

Status: planned 2026-10-14, not started. No stage is authorized to run until the user approves this plan and the prerequisite gates below are recorded. Pushes, merges, production operations and gate results are not authorized by this document.
Date: 2026-10-14
Scope: the remaining permanent fix for the release-blocking multi-desktop `desktop_id` collision: web identity contract, desktop N1 (S3), web/Android key minting (S1b), cutover (S4) and keyless-insert refusal (S4b). Repositories: sporely-web (primary for this plan) and sporely-py.

Purpose: two desktop installations on one account write their own SQLite ids into the shared cloud `desktop_id`, and reverse-link recovery then routes one device's new observation into an overwrite of the other device's cloud row (reproduced ab15, ab17, ab19; present in every released desktop and in `ee6f2af`). The user decided on 2026-10-13 that `desktop_id` is retired as a sync identity and replaced by a random, immutable, per-owner `sync_key` per record, that obsolete desktops get a hard refusal rather than silent discard, and that crash recovery and idempotent retry are release blockers. This plan finishes that work. It does not redesign it.

## Authority, existing work and what this plan does not own

Design authority is this document: the "Frozen identity contract" section and the stage text below. Together they contain every normative identity rule a stage needs. The operator design record kept outside the repositories is provenance only: `sporely-worktrees/g4-evidence/PROPOSAL-desktop-id-identity.md` Revisions 3–5, `identity-design/VERIFY-identity-rules.md`, `identity-design/RELEASE-SEQUENCING.md`, and `SECURITY-REVIEW-desktop-id-identity.md` with its re-check. No stage needs it to execute. If it disagrees with this document, this document wins, and the stage reports the disagreement.

Already done and not redone here. Each finishes in its own existing run:

- S1, server sync-key schema and identity guard: sporely-web `24700c0` on `feature/sync-key-schema-s1`, Codex READY, security review APPROVE, pgTAP 97/97. **Accepted and pushed 2026-10-14**, with GS1-DB recorded as pass. Run `plan-29e3f313-f8d7a4e6` is complete.
- S2, desktop local sync keys: sporely-py `be511bf` on `feature/sync-key-local-s2`, Codex READY, 1265 tests pass. **Accepted and pushed 2026-10-14.** Run `plan-77425a26-9581f511` waits at its completion gate GS2-GUI. Its GUI evidence covered the profile upgrade, restart, new observations and images, copied profiles, sync, no-op sync and Download from Cloud. It did **not** exercise measurement creation, bundle import, portable import or image move in the GUI; those are unit-tested only. Stage 6 below covers them in the GUI.
- Stage 4b, photo-EXIF attribution: sporely-py `ee6f2af` on `feature/ingestion-location-provenance-stage-4`, accepted; run `plan-003da12b-e40b9be2` complete with G4b-EXIF pass.

**Accepted commits only.** Every commit this plan builds on, pins or hands to the ingestion run is an engine-accepted, independently reviewed commit:

- Slice P1 starts from accepted `ee6f2af` and merges accepted `be511bf`. Every later P1 commit therefore contains both.
- Every sibling pin is the exact accepted final candidate of the slice it names.
- G4 and Stage 5 use only the accepted final commit of slice P1. Because Stage 7 is review-only, that commit is the one accepted at Stage 6 and re-accepted at Stage 7.

An unaccepted branch head is never pinned, fast-forwarded to or cited as evidence for a gate.

Not owned by this plan:

- **The production brake** is a separate workstream with its own approvals (sporely-web `fix/obsolete-desktop-sync-brake`, runs `plan-d61b382c-64dac198`, `plan-b280a4c8-46045a1e`, `plan-62201855-dbeb7e60`; sporely-py contract note `f774d9b`). As of 2026-10-14 it is tested on the disposable target and **not deployed to production**. This plan works whether or not it is ever deployed. It relies on only two brake facts: the brake's contract (desktops that send `x-sporely-sync-identity: 2` are not refused) and its removal rule (it is lifted only inside the cutover transaction, with the worker guard removed in the matching worker release, never as a rollback).
- **The ingestion-location plan** (`docs/plans/active/2026-10-12-ingestion-location-provenance.md`). Its run `2026-10-12-ingestion-location-pr-71e21f09-acdfbe32` stays paused with G4 = fail. This plan supplies the corrected desktop candidate and the evidence for G4; the user records G4 and resumes Stage 5 there (see "G4 and Stage 5").
- The temporary desktop fail-safe (S-F) is not built. Its triggers (N1 slipping more than two weeks with no brake, or the brake proving unusable while accounts show multi-desktop use) have not occurred.
- S6 cleanup (dropping the `desktop_id` unique constraints, retiring `portable_cloud_identity_pending`, the backup review at cutover + 80 days, the post-cutover orphan audit) needs production cutover first and is a later revision of this plan.
- The partial Download from Cloud on a fresh profile is tracked separately in sporely-py.

## Frozen identity contract

These rules are settled. A stage that cannot implement one as written stops and reports; it does not choose an alternative.

Server (S1, already built):

- `sync_key uuid NULL` on `observations`, `observation_images`, `spore_measurements`; no backfill, so existing cloud rows keep NULL and no device can claim them.
- Per-owner partial unique indexes `observations_user_sync_key_uidx`, `observation_images_user_sync_key_uidx`, `spore_measurements_user_sync_key_uidx` on `(user_id, sync_key) WHERE sync_key IS NOT NULL`. Uniqueness is per owner, so a key reveals nothing about another tenant.
- Guard function `public._sync_identity_guard()`:
  - LANGUAGE plpgsql, SECURITY INVOKER, pinned `search_path`.
  - Triggers `zzz_sync_identity_guard_{obs,image,measurement}`, BEFORE INSERT OR UPDATE, FOR EACH ROW, named so they sort **last** among BEFORE triggers. pgTAP asserts that order, so a later mutating trigger cannot bypass the guard.
  - Trusted callers are `current_user` in `postgres`, `service_role` and `supabase_admin`.
  - Rule 1, all roles: on UPDATE, `sync_key` may not change in any direction (value→value, value→NULL, NULL→value).
  - Rule 2, non-trusted callers: a row with both `sync_key` and `desktop_id` set is refused, on INSERT and on UPDATE.
  - Both rules refuse with `P0001` and hint `sporely_sync_identity_refused`.
- Error text is fixed. It never contains row values, any auth word (`unauthorized`, `not logged in`, `jwt`, `token`, `session expired`, `authentication failed`, `invalid_grant`, `pgrst301`/`303`, `captcha_failed`) or any transient word (`timeout`, `unavailable`, `schema cache`). Those words would make released desktops treat the refusal as a sign-in or retry case.
- `sync_key` is absent from every non-owner view and from every public RPC result.
- The server never derives storage object keys from `sync_key`.

Desktop N1 (S2 built; S3 in this plan):

- Creation paths. S2 built these; S3 must keep them:
  - Every local creation path mints a uuid4 key in the same transaction as the INSERT.
  - Pull stores the remote key, which may be NULL, and never mints. An explicit sentinel argument keeps "not provided → mint" distinct from "remote NULL → store NULL".
  - Fork paths mint fresh keys: portable import, legacy bundle import and image move. Bundle import also clears `cloud_id` and every sync-state column portable import clears.
  - Full restore keeps keys and `cloud_id`. A copied library file keeps its keys: the same key means the same record, which adoption resolves.
  - The SQLite migration gives keys only to rows with no `cloud_id`.
- Invariant: no POST without a committed local key. A cloud-linked row with a NULL key (every row that existed before S1) is never POSTed. It is PATCHed by verified `cloud_id` only.
- Per-row state machine, all three tables; children wait for their parent's committed `cloud_id`:

| State | Event | Action | Next |
| --- | --- | --- | --- |
| L0 (key, no `cloud_id`) | parent has no `cloud_id` | defer | L0 |
| L0 | POST with `sync_key` → 201 | commit `cloud_id` | L2 |
| L0 | `23505` naming the table's `*_user_sync_key_uidx` | GET by key and owner; parent check; tombstone → existing deletion/restore flow; content equal → link silently; content differs → sync conflict, never PATCH | L2 or conflict |
| L0 | `23505` on any other constraint, `23503`, `42501`, any other 4xx | plain error, row stays dirty | L0 |
| L0 | timeout, network error, crash | nothing; the retry repeats the same POST | L0 |
| L0 or L2 | `P0001` with hint `sporely_upgrade_required` or `sporely_sync_identity_refused`, or a media-worker 426 with `X-Sporely-Error-Code: sporely_upgrade_required` | stop the upload phase for this run, keep rows dirty, keep downloads working, show a persistent banner ("This version of Sporely can no longer upload. Please install the latest version.") and log it as a server/client mismatch: N1 should never receive these | unchanged |
| L2 (`cloud_id`) | edit | verify `cloud_id`; PATCH by id; never send `sync_key` or `desktop_id` | L2 |

- Adoption takes the fetched row as the base snapshot. The parent check is strict: an image's `observation_id` or a measurement's `image_id` must equal the local parent's `cloud_id`, otherwise it is an identity conflict with no re-parenting. An adopted image reuses the adopted row's reserved `storage_path`; object keys are never derived from `sync_key`.
- The client must match the constraint name, not only SQLSTATE `23505`: the legacy `UNIQUE(desktop_id, user_id)` collision is also `23505`.
- Pull matches by cloud `id`, else by a `sync_key` equal to a local key, never by integer. Every `desktop_id` heal and reverse lookup is removed. `conflict_detail` pairs child rows by cloud id, then by key.
- N1 never sends or reads `desktop_id`. Before uploading it probes `select=sync_key&limit=0`; if the column is missing it blocks uploads with "cloud not ready" and keeps pull working.
- N1 sends `x-sporely-sync-identity: 2` on every Data API and media-worker request, so that a deployed brake does not refuse it.
- Integer local ids are never cloud identities.

Web and Android (S1b, in this plan):

- Mint `sync_key` at queue time with `crypto.randomUUID()`, falling back to `crypto.getRandomValues`, and persist it in the queued item; give queued items saved before S1b a key on load.
- Cover `src/sync-queue.js` and every insert in `src/images.js`, including each fallback payload that strips other columns; those payloads must keep `sync_key`.
- Adopt after `23505` on the named index under the same rules as the desktop: link without PATCH, or fail visibly, when the adopted row differs.

Cutover (S4) and keyless refusal (S4b):

Cutover migration (S4), one transaction, in this order:

1. `SET LOCAL lock_timeout = '5s'` and `SET LOCAL statement_timeout = '5min'`.
2. Take the strongest lock the transaction will need, on `observations`, `observation_images` and `spore_measurements`, **before** reading anything. `ADD CONSTRAINT … CHECK` and view replacement need ACCESS EXCLUSIVE, and raising the level mid-transaction can deadlock. The alternative: take SHARE ROW EXCLUSIVE here and move the `CHECK` and view replacement into a separate follow-up migration with its own lock-first rule.
3. If GW3-INPUTS records a backup: insert every row with a non-NULL `desktop_id` into the backup tables (below). If it records no backup, skip this step and create no backup tables.
4. Disable `trg_observations_updated_at`, `trg_05_observation_images_set_updated_at`, `trg_observation_images_touch_observation_updated_at` and `trg_spore_measurements_touch_observation_updated_at`, so that clearing the column changes no `updated_at`. Every other trigger stays enabled, the media guards included.
5. `UPDATE … SET desktop_id = NULL WHERE desktop_id IS NOT NULL` per table, capturing the counts. With a backup, assert backup count = cleared count per table, else `RAISE`, which aborts everything.
6. Re-enable the four triggers.
7. Add guard rule 4 for non-trusted callers: any INSERT or UPDATE with `NEW.desktop_id IS NOT NULL` is refused with `P0001`, hint `sporely_upgrade_required`, message "Sporely Desktop must be updated before it can upload to Sporely Cloud. Install the latest version from sporely.no. Nothing was changed in the cloud." Confirm the download address before release.
8. Add `CHECK (desktop_id IS NULL)` on each table, `NOT VALID` then `VALIDATE`. It holds for trusted roles too.
9. Replace `observations_community_view`, `observations_follow_view` and `observations_friend_view` with `NULL::integer AS desktop_id`. A replaced view cannot drop a column. Keep the column position, every other column and the grants unchanged.
10. If the brake migration (`20261013200000`, trigger `trg_000_sync_brake`, function `private.sync_brake_guard()`) is present, drop it in this same transaction. The matching worker release removes the worker guard.

Behaviour of the migration:

- A deadlock or `lock_timeout` aborts it with no partial state.
- **Retry procedure:** confirm the abort (no backup rows; `desktop_id` unchanged), wait for a quiet window, and re-run the identical migration. After three failures, stop and inspect `pg_locks` / `pg_stat_activity` for long writers. Never weaken the lock order.

Backup tables, only if GW3-INPUTS records one:

- One table per source: `private.desktop_id_backup_observations`, `private.desktop_id_backup_images` and `private.desktop_id_backup_measurements`.
- Each has `row_id bigint PRIMARY KEY REFERENCES <source>(id) ON DELETE CASCADE`, `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`, `desktop_id integer NOT NULL` and `captured_at timestamptz NOT NULL DEFAULT now()`.
- `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`. The `service_role` revoke matters because `private` grants it USAGE.
- RLS is enabled, with no policies. pgTAP asserts that no role but the owner has any privilege.
- The approved retention period goes in `COMMENT ON TABLE`.
- The backup is forensic only. Nothing ever writes its values back into `public`. Platform backups and PITR keep pre-cutover values under the platform's own retention.

Rollback rule: **no rollback ever puts `desktop_id` reverse links back into service.**

- Before cutover: keep S1's columns, indexes and guard. They are inert for clients that send no keys; fix any problem forward.
- After cutover: keep rule 4 and the `CHECK`. If old clients must be served again, relax rule 5 (if enabled) and use the brake. Never restore links.
- The Stage 10 rollback script implements only these steps.

Keyless-insert refusal (S4b), guard rule 5:

- Non-trusted INSERTs with `sync_key IS NULL` are refused with `P0001` / `sporely_upgrade_required`.
- It applies only to tables where every client insert path mints a key.
- PATCH by id of legacy keyless rows keeps working.

Refusals always use `P0001` (HTTP 400), never `42501`/403: v0.8.13 and v0.9.1 treat 403 as a sign-in failure. Where an earlier guard would raise 403 for the same write, that guard's error wins. Released clients' writes pass the earlier guards today, so the only new refusal they meet is this 400.

Contract text. Both copies of `docs/supabase-sync-contract.md` get this identity section, byte-identical. Stage 1 writes the web copy, and Stage 5 copies it to sporely-py. The brake's marked block is left as the brake workstream writes it.

- Definition: "`sync_key` is a random uuid minted locally before the first upload. It is immutable for every role, unique per owner, and recovers only the creating database's own rows. `desktop_id` is retired: clients must not send it. Before cutover the server refuses it on rows that have a key; after cutover it refuses it everywhere."
- Rule 12: "A lost `cloud_id` is reconciled by `sync_key`."
- Rule 20: "`sync_key` is the only recovery identity. Integer local ids are never cloud identities."
- Rule 21, replaced: "No client writes an identity onto an existing cloud row. Pull links by cloud id or `sync_key`."
- Rule 23: "POST only for a row with a key and no `cloud_id`. A 23505 on the table's `*_user_sync_key_uidx` means adopt: parent check, then the fetched row as base, then a conflict on any difference. A tombstone goes to the deletion flow. Any other 409 or 4xx is an error."
- Rule 26: superseded; imports and other forks mint fresh keys.
- New rule: "Children are uploaded only after their parent's `cloud_id` is committed locally. Media object keys are random reserved keys, reused on adoption, never derived from `sync_key`."
- Also the state-machine table above; the two refusal hints and the 426 media answer; the `x-sporely-sync-identity: 2` header; the "cloud not ready" probe; and the rollback rule.

## Verification matrix

Tiers:

- **P**: pgTAP on scratch databases.
- **U**: unit tests with two SQLite databases and a shared fake cloud. The fake cloud enforces the per-owner unique indexes and returns real constraint names; tests wrap the real sync functions in pass-through recorders and never stub the behaviour under test.
- **G**: agent-run GUI/API harness on the disposable target, with two isolated profiles and audit logs.

No behaviour claim rests on U alone. Stages cite rows by number.

| # | Case | Expected | Tier |
| --- | --- | --- | --- |
| 1 | A creates a row; B creates one with the same local id | B inserts; A untouched; no `desktop_id` writes | U+G |
| 2 | Both download; alternating pulls ×3 | no identity writes, no `updated_at` echo | U+G |
| 3 | A edits; B pulls | only B's linked row changes | U+G |
| 4/5 | conflict; keep-device / take-cloud | only the paired rows change | U+G |
| 6 | kill after the server INSERT, before the local `cloud_id` write (observation, image, measurement) | 23505 → adopt; one row each | U (fault injection) + G (fault hook) |
| 7 | timeout after a successful INSERT | adopt, no duplicate | U+G |
| 8 | kill before the request lands | single insert on retry | U+G |
| 9 | kill mid-upload, and after upload before confirmation | reserved key reused, one object | U+G + orphan count |
| 10 | child whose parent is unknown | deferred; parent first | U+G |
| 11 | restart between every step of 6–10 | same as 6–10 | G |
| 12 | portable or bundle import of A's archive into B | fresh keys, new rows, no shared `cloud_id` | U+G |
| 13 | copied database, unchanged content | 23505 → adopt silently | U+G |
| 13b | copied or restored database whose rows were since edited elsewhere | adoption raises a conflict; no PATCH | U+G |
| 13c | adopted row is soft-deleted or purged | deletion/restore flow; no resurrection | U+G |
| 13d | 409 from `23503`, or a `23505` on another constraint | plain error, not adoption | U+P |
| 14 | old clients (v0.8.13, v0.9.1, v0.9.15, v0.9.18, v0.9.25, `0520afd`, `ee6f2af`) against S1, cutover and S4b | refusals as specified; no sign-in prompt; local data and credentials kept; no duplicates except the accepted keyless cases before S4b; orphan objects counted | P+G |
| 14b | old client heals an N1 row after S1 | refused; N1 row keeps a NULL link | P+G |
| 15 | N1 against a server without S1 | uploads blocked "cloud not ready"; pull works | U+G |
| 16 | web/Android create and edit with S1b, against the cutover server | unaffected; keys present | P + web unit + G (web harness) + device gate |
| 16b | S4b: keyless insert from a non-trusted caller | refused; trusted roles allowed | P |
| 17 | cutover then rollback on the disposable target, with a concurrent writer | lock wait or abort with no partial state; counts asserted; no `updated_at` change; rollback restores no links | P + disposable run |
| 18 | `sync_key` immutable for every role; guard `prosecdef = false` | refused for every role | P |
| 19 | another tenant uses the same key | allowed; no cross-tenant 409 | P |
| 20 | `sync_key` absent from every non-owner view and public RPC; `desktop_id` NULL in community, follow and friend views after cutover | holds | P |
| 21 | `CHECK (desktop_id IS NULL)` blocks trusted roles; backup privileges are owner-only | holds | P |

Measured criteria for enabling S4b in production (U4). These are user measurements, using suppressed aggregate queries, outside every run:

1. Desktop N1, web S1b and an Android build containing S1b are released, and every client insert path mints a key.
2. Zero rows created with `sync_key IS NULL` in each table over 14 consecutive days.
3. No Android or web activity on a pre-S1b version in `client_activity_daily` for 14 days, or a user-accepted residual below 1 % of active clients; and no pre-N1 desktop in `reference_client_devices` for 14 days. That desktop figure is a lower bound.
4. Legacy refusal verified on the disposable target (row 14).
5. The upgrade notice has been visible for at least 14 days.

## Dependencies and stage order

The design record lists S1b before S3; the 2026-10-14 status listed S3 first. The real dependencies:

| Work | Needs | Does not need |
| --- | --- | --- |
| Web identity contract | S1 | anything else |
| S3, desktop N1 | S1 server shape; S2 local keys; accepted Stage 4b code (N1 ships both) | S1b: web rows with or without keys are ordinary rows to the desktop |
| S1b, web/Android | S1 server shape | S3 |
| G4 re-verification | S3 accepted | S1b |
| S4 cutover, implementation (Stage 10) | slice P1 accepted; DPO decision and brake state recorded (GW3-INPUTS) | S1b in production; N1 published |
| S4 cutover, production execution | N1 published and its availability criteria met; separate production authorization | S1b (web and Android never send `desktop_id`) |
| S4b | S1b web deployed and Android build published, with the measured U4 criteria | — |

S1b and S3 are independent of each other. The S1b-first order in the design record is a *release* preference: Android store adoption takes time and gates S4b. It is not an implementation dependency. The blocker and G4 need only S1, S2 and S3, so **implementation runs S3 first**. S1b follows without waiting for any production step, and its web deploy and Android publication can then go out early in the release sequence.

## Execution structure

Engine checked 2026-10-14: agent-sparring `ea8e70d`. These engine facts decide the structure:

- Compile intake through `sparring start-plan`.
- One primary repository per run slice, with read-only sibling pins verified at acceptance.
- Gates only at slice boundaries, or as version-2 `gates_before` / `completion_gates`.
- Review-only stages run in mode `independent_review`.
- Acceptance requires the candidate to be pushed, and `--allow-push-for-run` removes per-candidate push stops.
- Scriptable checks, including disposable-target migrations, API checks and GUI-harness runs, are agent verification. Manual gates are reserved for judgment, devices, real-world access and production.

This is a gated, cross-repository plan, so use compile intake, not the plain Markdown direct route. Four run slices, each started from its own repository:

| Slice | Primary repository and branch | Stages | Starts from |
| --- | --- | --- | --- |
| W1 | sporely-web `feature/sync-key-identity-web` | 1 | ingestion web head `1029975` (`feature/photo-provenance`), after S1 is accepted |
| P1 | sporely-py `feature/sync-key-desktop-n1` | 2–7 | `ee6f2af`, with the W1 final candidate as a read-only sibling pin |
| W2 | sporely-web, same branch as W1 | 8–9 | W1 final candidate |
| W3 | sporely-web, same branch | 10–12 | W2 final candidate |

Run order: W1 → P1 → W2 → W3. W2 depends only on W1 and may be started while P1 is still running if the user wants it sooner; nothing else runs in parallel. Each slice's branch is created at the stated commit before approval (`slice-branch --create` or `git worktree add -b`), with no upstream set, so engine pushes go to the same-name remote branch and never to `main`. Each implementation stage has one writer in its primary repository and never edits a sibling. If a desktop stage needs a web contract change, it stops and the change becomes a new web stage.

Verification policy: engine-gated. Each stage passes its own automated checks and independent review, then the engine commits, pushes and accepts it. A manual gate follows the accepted candidate and blocks the next slice or plan completion. Automated acceptance is never a claim that a manual gate passed. A failed check is fixed in a new stage or reverted; agents never edit engine state or record an invented pass.

**Production boundary.** Slice W3 implements, tests on scratch and disposable databases, and independently reviews production migrations: the cutover, its rollback script and the keyless refusal. Accepting W3, or completing this plan, executes nothing in production and authorizes nothing there. Each production-impacting transition is a separate user action outside every run, with its own explicit authorization for exact SHAs and the target project (see "Ordered production procedure"). That covers applying S1, deploying web, publishing Android or desktop, the cutover, enabling S4b, removing the brake, and any backup deletion.

Environment rules for every stage:

- Use the existing disposable environments only:
  - the local Supabase stack `sporely-g3-verify` with its stub media worker and Vite web app;
  - the scratch-database wrappers `sporely-worktrees/identity-impl/db/dbreset.sh` and `dbsql.sh`;
  - the GUI harness `sporely-worktrees/g4-evidence/tools/` (`run.sh`, `g4_launch.py`, `g4_scenarios.py`, `g4_netprobe.py`, `g4_web.mjs`).
- The harness launches only under `run.sh`'s kernel sandbox.
  - It admits a desktop commit only if it is on its fixed list, or is a clean sporely-py commit that contains `ee6f2af` and the accepted S2 commit and is reachable from `feature/sync-key-desktop-n1` or `feature/ingestion-location-provenance-stage-4`.
  - It refuses to launch unless outbound traffic is blocked and the local target and stub worker answer.
  - It records the tested commit, the admission and these pre-launch checks in each run's `manifest.json`.
  - Stages use it as it is and do not edit it. If it refuses a candidate, the stage stops and reports.
- Every desktop GUI session starts with a passing network-isolation probe, uses test accounts and synthetic photos, and keeps the harness's per-run manifest and logs as evidence.
- No hosted Supabase project, production host or production credential is contacted. Disposable-target migrations and writes are agent verification; any hosted-project write is a production operation and outside every stage.
- Use the project interpreters and focused tests only. No `npm test`, builds, Capacitor sync, dependency installation or package upgrade.
- Do not touch the brake branches, the S1/S2 run worktrees, `INBOX.md` in any checkout, or the untracked `tools/metadata_backfill/` work in the primary sporely-py checkout.

## Gates (engine-enforced)

These paragraphs define the gates; their ids, kinds and placement must be represented in compile intake.

### GP-S1 — S1 accepted with GS1-DB recorded

Kind: external. Blocks Stage 1. Run `plan-29e3f313-f8d7a4e6` is complete, with `24700c0` accepted and pushed and GS1-DB recorded as pass. All three were true as of 2026-10-14. Stage 1 integrates exactly that accepted commit.

### GP-S2 — S2 accepted with GS2-GUI recorded

Kind: external. Blocks Stage 2. Run `plan-77425a26-9581f511` is complete, with `be511bf` accepted and pushed (true as of 2026-10-14) and GS2-GUI recorded by the user. Stage 2 integrates exactly that accepted commit. Any record of GS2-GUI must say that measurement creation, bundle import, portable import and image move were unit-tested only; they are verified in the GUI at Stage 6.

### GS1b-ANDROID — S1b on a real Android device

Kind: manual. After Stage 9 (the last stage of slice W2); blocks Stage 10. On an operator-built Android test build of the accepted W2 candidate against the disposable target, the user checks:

- create and queue offline, restart the app, then sync: the stored row has a key;
- an item queued by the pre-S1b build gets a key on load;
- a lost-response retry adopts and does not duplicate.

Record the candidate SHA, device and Android version.

### GW3-INPUTS — decisions before cutover implementation

Kind: authorization. Blocks Stage 10. Before Stage 10 starts, the user records three things:

1. The DPO decision on the restricted `desktop_id` backup: a backup with an approved retention period, or no backup. The DPO note in the design record is the input to this decision.
2. The production brake state: never deployed, or deployed with its merged `main` commit, so that Stage 10 knows whether the cutover lifts it.
3. The go-ahead to prepare the cutover.

## Stages

### Stage 1 — Integrate S1 into the ingestion web line and fix the identity contract (web copy)

Primary repository: sporely-web. Depends on gate GP-S1.

The slice branch `feature/sync-key-identity-web` starts at `1029975`, the accepted ingestion web head. S1b must later edit the provenance-era `src/sync-queue.js` and `src/images.js`. This stage merges the accepted S1 commit `24700c0`. The merge is conflict-free (checked with `git merge-tree` on 2026-10-14). Make no other change in the merge commit.

Then, in a separate commit, add the identity section to `docs/supabase-sync-contract.md` exactly as "Contract text" in the Frozen identity contract specifies: the definition, rules 12, 20, 21 (replaced), 23 and 26 (superseded), the new child-ordering and reserved-media-key rule, the state-machine table, the refusal hints and the 426 media answer, the `x-sporely-sync-identity: 2` header, the "cloud not ready" probe and the rollback rule.

Do not touch the brake's marked block or unrelated drift.

Verify:

- The S1 pgTAP suite (`supabase/tests/sync_key_identity_test.sql`) and the ingestion provenance pgTAP tests pass on a fresh scratch database through the wrappers, with the merged migrations applied in order.
- The focused `node --test` files for `src/sync-queue*.test.js` and `src/images*.test.js` pass unchanged.
- `git diff --check`.

Report the merge commit and the contract commit separately.

### Stage 2 — Integrated desktop baseline (Stage 4b + S2), verified before any S3 code

Primary repository: sporely-py. Depends on gate GP-S2 and accepted Stage 1. Read-only sibling: sporely-web at the exact accepted Stage 1 commit; declare and verify that pin.

The slice branch `feature/sync-key-desktop-n1` starts at accepted `ee6f2af`. This stage merges the accepted S2 commit `be511bf`. `git merge-tree` on 2026-10-14 found exactly two conflicts, both mechanical:

- `database/models.py` `ObservationDB.create_observation`: both sides add a column to the INSERT. Keep the provenance columns and `sync_key`, and make the placeholder count equal the column count.
- `utils/cloud_sync.py` pull-create kwargs: keep both `**_remote_location_provenance_kwargs(remote)` and `sync_key=None`.

Resolve only these. No behaviour change.

Verify, and record exact results in `notes.md`:

- `py_compile` of the touched files.
- Run with the project pytest: `tests/test_sync_key_local.py`, `tests/test_observation_details_location_provenance.py`, `tests/test_cloud_location_provenance_sync.py`, the image-import tests, and the existing focused cloud-sync, schema and `db_share` suites that either side touched.
- A test asserting that `create_observation` writes every provenance field and the key; a mismatched placeholder count must fail it.
- `git diff --check`.

Also prove the baseline is runnable by agents before implementation starts:

- The harness's network-isolation probe passes on this commit, launched by the stage agent itself.
- One fresh-profile run of Download from Cloud, then a no-op sync, makes zero data writes, and no request body contains `sync_key`.

If the stage agent cannot launch the harness, the stage stops: it reports what blocked it and does not substitute unit tests.

### Stage 3 — S3a: identity transport, readiness probe and the observation state machine

Primary repository: sporely-py. Depends on accepted Stage 2. Same read-only web pin.

Implement, for observations:

- the frozen state machine;
- adoption with the base snapshot, and a conflict through the existing keep-device / take-cloud flow;
- tombstone hand-off;
- the named-index `23505` match;
- plain errors for every other refusal;
- the `P0001` hint handling, with a persistent banner;
- the `select=sync_key&limit=0` readiness probe ("cloud not ready" blocks uploads, pull keeps working);
- the `x-sporely-sync-identity: 2` header on every Data API and media-worker request made by the sync client.

Observation payloads stop sending `desktop_id`, and PATCH goes by verified `cloud_id` only.

Add an environment-gated fault-injection hook (for example `SPORELY_SYNC_FAULT=after_insert|before_request|after_upload`). It is inert unless set, it is never read from settings or UI, and it is used by Stage 6.

Unit tests use two SQLite databases and a shared fake cloud. The fake cloud enforces the per-owner unique indexes and returns the real constraint names. Use pass-through recorders around the real sync functions, never stubs of the behaviour under test. Cover design matrix rows 1, 6–8 and 13–13d, plus 15, for observations.

### Stage 4 — S3b: images, measurements and anchors on the state machine

Primary repository: sporely-py. Depends on accepted Stage 3. Same read-only web pin.

Apply the state machine to images, spore measurements and anchors:

- children are deferred until the parent's `cloud_id` is committed;
- the strict parent check on adoption, with no re-parenting;
- an adopted image reuses its reserved `storage_path`, and a retry after upload but before confirmation overwrites the same object;
- the image-move fork keeps its fresh key and becomes a new cloud row;
- the payloads stop sending `desktop_id`.

Unit-test rows 6–11 and 13–13d for images and measurements, and row 12 (portable and bundle import → fresh keys, new rows), with the same fake-cloud rules.

### Stage 5 — S3c: pull and conflict pairing by id or key; remove every `desktop_id` read, write and heal; desktop contract copy

Primary repository: sporely-py. Depends on accepted Stage 4. Same read-only web pin.

Changes:

- Pull matches by cloud id, else by `sync_key`, never by integer.
- Remove every `desktop_id` heal and reverse lookup: in `cloud_sync.py` (including `_find_cloud_observation` reverse-link recovery), `image_identity.py`, `image_pull.py`, `anchors.py`, the measurements and reconciliation modules, `baseline.py`, `conflict_detail.py` and `conflict_plan.py`. `conflict_detail` pairs by cloud id, then by key.
- Rows imported from a portable archive (`portable_cloud_identity_pending`) carry fresh keys and no `cloud_id`. They upload through the L0 state machine like any new row. Their `desktop_id`-based finalisation heal is removed; the flag itself stays until S6.
- Diagnostic tools (`tools/cloud_reconciliation_report.py`, `tools/audit_cloud_media_health.py`, `utils/cloud_media_audit.py`) may still *report* `desktop_id` but must not use it as identity.
- Finish with an `rg` inventory, recorded in `notes.md`, showing that no sync code path reads, writes, compares or sends `desktop_id`. The local schema column stays until S6.

Update the sporely-py `docs/supabase-sync-contract.md` identity section so that it is byte-identical to the pinned web copy (verify by section diff), and remove the superseded rule-21 heal statements. Leave the brake block as the brake workstream writes it.

Unit tests: rows 2–5 (no identity writes, no `updated_at` echo, only paired rows change), row 10, and a regression that fails on `ee6f2af`: two databases with overlapping local ids, where B's new row must insert and A's row must stay untouched.

### Stage 6 — Two-desktop collision regression and G4 delta evidence on the disposable target

Primary repository: sporely-py. Depends on accepted Stage 5. Same read-only web pin. This is agent verification of the accepted Stage 5 code. A defect found here is fixed in this stage and re-verified; the evidence must be from the final candidate.

Prepare the target and run the cases:

- Prepare the disposable target with the Stage 1 web migrations applied, as a recorded snapshot.
- Run two isolated N1 profiles on one test account whose local id sequences deliberately overlap, with the audit triggers recording every cloud write.
- Run each case in both brake states on the disposable target: brake migration and stub-worker guard installed, and not installed.

Required cases:

- Verification matrix rows 1–13d in the G tier, including row 11 (a restart between every step of rows 6–10, using the fault hook).
- Row 14b: an old build heals an N1 row and is refused, and the N1 row keeps a NULL link.
- Row 15: N1 against a target snapshot without S1 is blocked with "cloud not ready", and pull works.
- The exact ab15/ab17/ab19 reproducer, which must now show zero overwrites and zero `desktop_id` writes.
- One N1 profile alongside released `ee6f2af` and `0520afd` on the same account, with the brake off then on.
- GS2-GUI's uncovered cases: measurement creation, bundle import, portable import and image move.
- An orphan-object count from the stub store after the crash cases.

G4 delta, on the same candidate and pinned web candidate. Re-run only the G4 cases whose code path S3 changed:

- Download from Cloud on a fresh profile, then the first write-enabled sync: zero identity writes. This replaces C3a, whose single-device premise is superseded.
- No-op sync.
- New observation from a geotagged photo (`image_exif`/`acquired`).
- Web → desktop → web retention (C9).
- Unrelated edit.
- Attributed edit with a restart before sync.
- Conflict keep-device and take-cloud.
- Restart persistence.
- Edit Images detour (NULL/NULL, no RPC).

The Prepare Images typing cases (r03–r06, r04b, r05b) are carried forward from `ee6f2af` only if `git diff ee6f2af..<candidate>` touches neither `ui/observations_tab.py` `ObservationDetailsDialog` nor the image-import dialog; otherwise re-run them too. State which applied.

Commit a summary record, `docs/verification/2026-10-sync-key-n1-two-desktop.md`, containing:

- the candidate SHA;
- the target snapshot;
- per case: run id, expected result, observed result, and the evidence log path in the operator evidence directory;
- the list of G4 cases carried forward with the reason.

Logs, profiles and credentials stay out of the repository. The reviewer checks the record against the logs.

### Stage 7 — Independent security review of the desktop N1 candidate set

Mode: `independent_review`. Primary repository: sporely-py at the accepted Stage 6 commit; sibling sporely-web at the accepted Stage 1 commit. Depends on accepted Stage 6.

A fresh reviewer with no write access checks:

- that no path sends, reads or heals `desktop_id`;
- that adoption cannot cross owners or parents, or resurrect a tombstone;
- that the refusal handling cannot trigger sign-in prompts, credential clearing or retry storms;
- that the fault hook is inert unless its environment variable is set;
- that the identity header is sent on every write path, including media;
- that the contract copies are byte-identical in the identity section;
- that the Stage 6 evidence matches its logs and covers every listed case in both brake states.

A defect is a defect report that stops the plan; nothing is fixed in this stage.

### Stage 8 — S1b: web and Android key minting and adoption

Primary repository: sporely-web. Depends on accepted Stage 1 (slice W2). Implement the web/Android rules of the Frozen identity contract in `src/sync-queue.js` and every insert in `src/images.js`, including each fallback payload, plus load-time minting for previously queued items.

Verify:

- Focused `node --test` tests: fallback payloads keep `sync_key`; queued items gain a stable key on load; a lost-response retry adopts on the named-index `23505`; a differing adopted row fails visibly without PATCH; any other `23505`, `23503` or 4xx is a plain error; the `getRandomValues` fallback is used when `randomUUID` is absent.
- Agent verification on the disposable target through `g4_web.mjs`: verification matrix row 16, web create and edit with keys present, and a lost-response retry. If the accepted P1 candidate exists, add one coexistence case: web and N1 desktop editing the same observation, which must keep the pairing.
- `git diff --check`.

### Stage 9 — Independent security review of S1b

Mode: `independent_review`. Primary repository: sporely-web at the accepted Stage 8 commit. Depends on accepted Stage 8. The fresh reviewer checks:

- key minting and persistence on every insert path;
- that no key is derived from or exposed by public projections;
- that adoption cannot cross owners or link a differing row silently;
- that legacy queued items gain keys before S4b could ever apply.

Gate GS1b-ANDROID follows this stage.

### Stage 10 — S4: cutover migration and rollback script

Primary repository: sporely-web. Depends on gates GS1b-ANDROID and GW3-INPUTS, and on accepted Stage 7 (slice P1 complete). If GW3-INPUTS records a deployed brake, first merge the `main` commit that contains the brake migration `20261013200000` into this branch, unchanged, as its own commit.

Write the cutover migration exactly as "Cutover migration (S4)" and "Backup tables" in the Frozen identity contract specify:

- lock first;
- the backup only as GW3-INPUTS decided, with source-row foreign keys, owner-only privileges and a retention comment;
- the count assertion;
- clear `desktop_id` with the four `updated_at` triggers disabled and re-enabled;
- guard rule 4;
- `CHECK (desktop_id IS NULL)`;
- the views with `NULL::integer AS desktop_id`;
- lifting the brake in the same transaction when it is present.

Also write a forward-only rollback script that relaxes rule 4 without restoring any link, and the documented retry procedure.

Verify:

- pgTAP on scratch databases for verification matrix rows 17, 20 and 21, plus the existing S1 and brake suites.
- A disposable-target dry run with a concurrent writer: lock wait or `lock_timeout` abort with no partial state, then a successful run with counts asserted.
- A rollback rehearsal.
- Old builds v0.8.13, v0.9.1, v0.9.15, v0.9.18, v0.9.25, `0520afd` and `ee6f2af` through the harness after cutover (row 14): refused with `P0001` / `sporely_upgrade_required`, no sign-in prompt, local data and credentials kept.
- N1 and web unaffected.
- `git diff --check`.

### Stage 11 — S4b: keyless-insert refusal, prepared as a separate migration

Primary repository: sporely-web. Depends on accepted Stage 10. Guard rule 5 as its own migration, ordered after cutover. It refuses keyless inserts from non-trusted callers on the tables where every client insert path mints a key, and leaves PATCH by id of legacy rows working.

Verify:

- pgTAP for verification matrix row 16b.
- A disposable-target run: web and N1 unaffected; the v0.9.18 portable-pending shape refused with local data kept.

The migration is not applied in production until the measured U4 criteria hold; see the production procedure.

### Stage 12 — Independent security review of the cutover and S4b

Mode: `independent_review`. Primary repository: sporely-web at the accepted Stage 11 commit. Depends on accepted Stage 11. The fresh reviewer checks:

- the lock order and that no partial state is possible;
- that no rollback path restores links;
- backup privileges and cascades;
- that `CHECK` holds for trusted roles;
- that the view projections are unchanged except for the nulled column;
- that the brake is lifted only inside the cutover transaction;
- that every refusal uses `P0001` with the correct hint.

## G4 and Stage 5 (ingestion run; user actions, outside this plan's runs)

The ingestion run pins sporely-py by branch, not SHA: its Stage 5 declares sibling `sporely-py` at path `/Users/sigmundas/Documents/Code/sporely/sporely-py`, branch `feature/ingestion-location-provenance-stage-4`, with `candidate_sha` null. Its manifest is immutable, so the corrected desktop must become that branch's head. The order:

1. After slice P1 completes, the operator runs a revised pin preflight. It replaces `stage4b/verify_stage5_pin.sh`, whose hard-coded chain ends at `ee6f2af`. The preflight must confirm all of these:
   - the target commit is the slice's accepted final commit, read from the engine's acceptance records: accepted at Stage 6 and re-accepted unchanged at Stage 7;
   - it descends from accepted `ee6f2af` and accepted `be511bf`;
   - every commit between `ee6f2af` and it is part of an accepted P1 stage candidate;
   - it is on `origin/feature/sync-key-desktop-n1`.

   A branch head that is not that accepted commit is refused.
2. The user authorizes one fast-forward push of `feature/ingestion-location-provenance-stage-4` from `ee6f2af` to that accepted commit. The identity push guard does not allow this branch, so this push needs its own authorization. No accepted candidate is rewritten, and no merge commit is created on that branch.
3. The user records `G4=pass` on run `2026-10-12-ingestion-location-pr-71e21f09-acdfbe32`. The note cites the desktop SHA, the pinned web commit, the Stage 6 record for the re-run cases, and `G4-RESULTS.md` r01–r19 for the carried-forward cases. The earlier G4 fail stays in `notes.md` and `G4-RESULTS.md`.
4. Before resuming Stage 5, prepare both primary checkouts:
   - The primary sporely-py checkout must have `feature/ingestion-location-provenance-stage-4` checked out at that commit and be clean. Today it is on `tools/metadata-backfill` with untracked `tools/metadata_backfill/`; the user moves that work aside without discarding it. The `feature/sync-key-desktop-n1` worktree is removed or detached, so the branch can be checked out there.
   - The primary sporely-web checkout must be on `feature/photo-provenance` and clean. Its uncommitted `INBOX.md` edit is the user's to commit or move.

   Then resume Stage 5.

Stage 5 compares the ingestion fields across both candidates. The identity sections of the two contract copies differ until the W1 web branch reaches `main`; that difference belongs to this plan and is expected, not a Stage 5 defect.

## Ordered production procedure (outside every run)

Each step needs its own explicit authorization, exact SHAs and the deploy-tree and history guards in sporely-web `AGENTS.md`. Nothing here is authorized by plan completion. Old desktops are refused by enforceable server rules (the brake, then cutover rule 4), never by release notes or a waiting period alone.

1. **R0, brake:** separate workstream; its own go/no-go (`sporely-worktrees/identity-impl/GO-NO-GO-brake.md`). If it is deployed, it stays on until R4.
2. **R1:** apply S1 to production. Separately, the ingestion migration must also be in production before N1 is published, because N1 calls `set_observation_location`.
3. **R2:** deploy the S1b web build, and publish an Android build containing S1b.
4. **R3:** publish desktop N1 (the accepted Stage 7 commit, after G4 passes and the ingestion plan's own release steps), with an upgrade notice the user approves.
5. **R4, cutover (Stage 10 migration):** entry criteria: N1 available for at least 14 days, notice sent at least 7 days earlier, dry run and rollback rehearsal on the disposable target, the DPO decision recorded. If the brake is deployed, the worker guard is removed in the matching worker release.
6. **R5, S4b (Stage 11 migration):** only when every measured U4 criterion in the Frozen identity contract holds.
7. **R6:** the paired contract change reaches `main` in both repositories; S6 follows as a revision of this plan.

## Decisions for the user

Approved and done on 2026-10-14:

- **Push mechanics.** A default-deny `pre-push` guard replaced the refuse-all blocks in both repositories (record and rollback: `sporely-worktrees/identity-push-guard/README.md`). It allows fast-forward pushes to `origin` only for `feature/sync-key-schema-s1` and `feature/sync-key-identity-web` (web) and `feature/sync-key-local-s2` and `feature/sync-key-desktop-n1` (py). `main`, deletes, tags and every other branch are refused. Each slice starts with `--allow-push-for-run`.
- **S1** accepted, pushed and GS1-DB recorded; **S2** accepted and pushed.
- **Harness admission** updated as described under Environment rules (record: `g4-evidence/tools/CHANGE-2026-10-14-lineage-admission.md`).

Still open before slice P1: GS2-GUI (gate GP-S2).

Needed later, at their gates: the DPO backup decision, the brake state and the cutover go-ahead (GW3-INPUTS); the Android device check (GS1b-ANDROID); the U4 decision on S4b; the cutover window and notice dates.
