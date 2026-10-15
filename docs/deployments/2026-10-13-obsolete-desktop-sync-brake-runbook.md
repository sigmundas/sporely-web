# Runbook — obsolete-desktop sync brake (production)

Stage: `2026-10-13-obsolete-desktop-sync-brake`; re-issued by Stage 1b of
`docs/plans/active/2026-10-14-sync-key-identity.md`.
Migration: `supabase/migrations/20261015090000_obsolete_desktop_sync_brake.sql`
(the reviewed `20261013200000`, never applied in production, re-versioned to
apply after the sync-key migrations; function body, triggers, grants and
refusal text unchanged).
Worker: `cloudflare/r2-upload-worker/src/obsolete-desktop-guard.js`, wired into
`handleRequest` in `cloudflare/r2-upload-worker/src/index.js`.

Status: **prepared, not executed.** Deploying the worker and applying the
migration to production are the **user's** actions. No agent deploys the
worker, pushes the migration, connects to production, or sees production
output beyond the aggregate values this runbook marks as recordable.

## Release context

The brake ships in the integrated sync-key release, not on its own. That
plan's "Release" section is the authority for the order; this runbook is
its procedure for these steps:

| Plan "Release" step | This runbook |
|---|---|
| 2. merge photo-location web, the web identity branch and the integrated desktop to `main` (not `fix/obsolete-desktop-sync-brake`) | gate 0 |
| 3. prepare the desktop release artefacts and the upgrade notice | gate 0 |
| 4. deploy the media worker with the guard, `/healthz` flag, 426 probe and the real-worker smoke test | steps 2, 2a, 2b |
| 5. apply the migrations in version order: `20261012105630`, `20261013210000`, `20261014120000`, `20261015090000` | step 3 (one deploy-tree push of exactly these four) |
| — | steps 4, 4c and, when required, 5 |
| 6. publish the integrated desktop and the upgrade notice | only after 4c passed and any required step 5 is done |

Step 3 applies all four migrations, so no keyed row can exist before the
brake: no released client mints sync keys, and the desktop, web and Android
builds that do are published only after step 3.

## Why

Every shipped Sporely desktop (v0.8.13 up to the current release and
`ee6f2af`) finds "its" cloud observation through the shared `desktop_id`
reverse link. Two installations on one account (two computers, a reinstall or
a copied database) number their local rows independently. A new local row can
therefore be PATCHed over another device's cloud observation without any
warning. The overwriting client even reports "Cloud sync complete … 1 patched".
This was demonstrated on the disposable target (`g4-evidence/brake/RESULTS.md`,
run bk10). Until a desktop that uses per-record sync keys ships, the server
refuses these clients' writes.

## What changes in production

- **Worker:** `PUT`, `DELETE` and every other non-read method on `/upload/*`
  from an obsolete desktop gets HTTP **426** with body
  `{"error":"sporely_upgrade_required","message":"Sporely Desktop must be updated before it can upload to Sporely Cloud. Install the latest version from sporely.no. Nothing was changed in the cloud."}`,
  header `X-Sporely-Error-Code: sporely_upgrade_required` and the usual CORS
  headers. The refusal happens before authentication, R2 access or quota
  accounting. `GET`/`HEAD /upload/*`, `/m/*`, `/mm/*`, `/artsorakel`,
  `/artsorakel/media`, `/reverse-location`, `/healthz` and `OPTIONS` are
  unchanged.
- **Database:** function `private.sync_brake_guard()` (SECURITY INVOKER,
  `search_path=''`, not executable by client roles), plus trigger
  `trg_000_sync_brake` (BEFORE INSERT OR UPDATE OR DELETE, FOR EACH ROW) on
  `observations`, `observation_images`, `spore_measurements`,
  `spore_measurement_mosaics`, `spore_measurement_mosaic_tiles`,
  `observation_spore_summaries` and `observation_reference_uses`. A refused
  write raises `P0001` with HINT `sporely_upgrade_required`, which PostgREST
  returns as HTTP 400 with the same message. The migration changes no rows.

### Who is blocked

A request is refused when **all** of these hold:

- its lower-cased `User-Agent` starts with `python-requests/`;
- it has no `x-sporely-sync-identity: 2` header;
- in the database only: it came through the Data API with an `authenticated`
  or `anon` JWT. Worker `/upload/` routes accept only `authenticated` JWTs.

That covers every desktop build released so far and `ee6f2af`. They all send
the python-requests default for cloud traffic (verified in each tag).

Also blocked: any other Python script that uses an **end-user** JWT with the
default User-Agent, for example a maintainer script. Such a script can send
its own User-Agent instead.

**Not blocked:** web and Android (browser and WebView User-Agents),
`service_role` and other server roles (including the worker's own database
calls), migrations, cron and direct SQL sessions, and a future desktop that
sends `x-sporely-sync-identity: 2`. Reads are not affected: old desktops can
still sign in, download from the cloud and pull.

The User-Agent test holds back **honest** old clients. It is **not** an
authorization boundary: any caller can choose its User-Agent and headers. RLS
and the existing guards remain the authorization layer.

### No unsynced local data is lost

On the disposable target, every tested build (v0.8.13, v0.9.1, v0.9.15,
v0.9.18, v0.9.25, `0520afd`, `ee6f2af`; `RESULTS.md` bk20, bk32/33, bk40/41,
bk61–63) behaved the same under the brake:

- new rows stay `local` and edits stay `dirty`;
- photos stay on disk;
- credentials stay stored, with no sign-out, no token refresh and no retry
  loop;
- no local row gains another device's cloud id.

That is the final state, with both halves applied. In the worker-first gap a
v0.8.13 or v0.9.1 desktop does create a new observation's cloud row; the local
row then stays `dirty` with that cloud id, and its photo stays local and
pending (`brake-426/RESULTS.md`, G-NEW). See "What users see".

Pending work uploads once a desktop that is not braked syncs. An observation
deleted in an old desktop disappears locally only. Its cloud row and media are
kept, and the next pull brings it back.

## Order: worker first, then the database immediately after

1. **Worker first.** The database alone is unsafe. When an old desktop deletes
   an observation, it removes the media through the worker before it attempts
   the row delete. With only the database brake, the row delete is refused but
   the media is already gone: bk31 lost 4 media objects this way.
2. **Database immediately after.** The worker alone does not stop the
   overwrite. Row writes (`PATCH observations`, `set_observation_location`, the
   `desktop_id` heal) go straight to PostgREST, never through the worker (bk10).
   Between the two steps:
   - overwrites are still possible;
   - an old desktop can create an observation row whose media upload is then
     refused. v0.8.13 and v0.9.1 then insert no `observation_images` row, so
     the cloud observation has no image row and no media until a desktop that
     is not braked syncs the still-pending local photo
     (`brake-426/RESULTS.md`, G-NEW);
   - v0.8.13 and v0.9.1 desktops that delete an observation leave its media
     orphaned in the public legacy bucket. See the next section.

   The gap is bounded: at most 15 minutes, or the worker is rolled back, with
   one documented limit when a push's outcome cannot be settled. See "Gap
   timing, bound and abort".

The reverse order (database first) is not used: it causes the half-deletes
found in the delete tests (bk31).

### Controlled window

Running steps 2 and 3 in one sitting shortens the worker/database mismatch
window but does not remove it. An old desktop that syncs inside it can
create an image-less row or orphan an observation's media
(`identity-impl/brake-426/RESULTS.md`). The deployment is therefore
controlled:

- **Before step 2,** every desktop installation that syncs to the account is
  quit, and stays closed until the integrated desktop is installed on it. The
  account owner is the only desktop cloud-sync user; other users use Android,
  which neither half of the brake affects. Tick before step 2:

  - [ ] Every desktop installation that syncs to Sporely Cloud is quit and
        will stay closed until the integrated desktop is installed.
        Name: ____________ Date (UTC): ____________

- **The window's UTC start and end are recorded:** T0 and T2 (or the
  rollback time) in the timing record.
- **Step 3 starts only after step 2's checks (2a and 2b) pass.** If step 3
  fails, "Abort" and procedure Q apply; the window is not left open.
- **After step 3,** the read-only API log check 4c must show no row writes
  with a `python-requests` User-Agent in the window. Any found are reconciled
  with step 5 before the integrated desktop is published.

### The worker-first gap orphans media (accepted residual)

Between the worker deploy and the database migration, the worker refuses an
old desktop's media delete with 426, but the database still accepts its row
deletes. The v0.8.13 and v0.9.1 desktops ignore a failed media delete:
`delete_cloud_observation` (sporely-py v0.8.13 `utils/cloud_sync.py`
lines 8366-8372, v0.9.1 lines 9182-9188) catches the error, prints a warning,
and then deletes the `observation_images` rows and the `observations` row
anyway. v0.9.15 and later stop at the failed media delete instead, so they
are not affected. The client stops trying media after the first refused
`DELETE`, so the worker sees **one** refused `DELETE` per deleted observation,
not one per object (`brake-426/RESULTS.md`, G-DEL).

The result for each observation deleted this way in the gap:

- its media objects stay in the legacy bucket `sporely-media` with no row
  pointing at them;
- production runs `MEDIA_STORAGE_MODE = "legacy"`, and that bucket is served
  publicly at `media.sporely.no`, so media the user deleted stays reachable
  by anyone who has its old URL;
- the user's storage quota accounting for those objects is not released.

The gap's other residual is the G-NEW case above: an observation row created
by a v0.8.13 or v0.9.1 desktop in the gap, with no image row and no media.
Nothing is lost (the photo stays on the user's computer, pending), but the
cloud copy is incomplete until a desktop that is not braked syncs it.

Worker-first is still the right order. The database-first order loses media
outright: an old desktop's media delete succeeds before the database refuses
the row delete (bk31 lost 4 media objects this way). Orphaned objects in a
short window are the smaller, recoverable harm: no user data is lost, and the
objects can be found afterwards (step 5a) and removed under a separately
approved step 5b.

Requirements:

- Keep the gap within the bound in "Gap timing, bound and abort": at most 15
  minutes, target under 10. Everything that can run before the gap does (step
  P), so the gap holds only `wrangler deploy`, the 2a and 2b checks and the
  push.
- Fill in the timing record (T0–T3). Step 5 uses the window from T0 to T2, or
  to the rollback time after an abort.
- Capture the worker's requests during the gap (step 2, `wrangler tail`).
  Step 5a uses the capture.
- The owner accepts this residual explicitly before the deploy. This line must
  be ticked, with a name and a date, before step 2:

  - [ ] Owner accepts that, during the worker-first gap, v0.8.13/v0.9.1
        observation deletes can leave publicly reachable orphaned media, and
        v0.8.13/v0.9.1 uploads can leave cloud observation rows without image
        rows or media. Orphaned media stays until it is removed, if ever,
        under a separately approved step 5b. Name: ____________
        Date (UTC): ____________

## Gap timing, bound and abort

### Timing record

Fill in UTC values as the procedure runs (`date -u +%FT%TZ`). Keep this
record with the deploy notes; every field is recordable.

| Field | Meaning | UTC |
|---|---|---|
| T0 | `wrangler deploy` in step 2 finished: **gap start** | |
| Push cutoff | T0 + 10 min | |
| Abort at | T0 + 15 min | |
| Tail start | `wrangler tail` capture running (step 2) | |
| T1 | all 2a and 2b checks passed | |
| Push started | `supabase db push --linked` started in step 3 | |
| T2 | the push committed the brake migration: **gap end** | |
| T3 | 4a passed | |
| Settled | only if the push started and T2 is not confirmed: procedure Q's outcome and time | |
| Rollback | only after an abort: worker rollback verified (replaces T2 as gap end) | |

### Bound

- The gap, T2 − T0, must not exceed **15 minutes**. The target is under 10.
- **Push cutoff, T0 + 10 min.** Do not start the first push after it; abort
  instead. The only later push is Q step 4's forward retry, which closes a
  gap that is already open. The 5 minutes up to "abort at" are reserved for settling a push
  that failed (procedure Q) and for the worker rollback.
- **Abort at, T0 + 15 min.** By then either T2 has happened, or the worker
  rollback is verified.
- An aborted deploy may be retried later, only from step 0, with a fresh
  timing record. The earlier gap still gets its own step 5.
- **Limit of the bound: a push with an unsettled outcome.** Once the push
  has started, the worker may be rolled back only if procedure Q proves the
  migration did not commit and cannot commit. When Q cannot prove that, the
  bound gives way, never the safety rule: the worker is **not** rolled back,
  and the gap outlives the bound. That state is the documented gap state,
  not bk31. A worker rollback while the outcome is unknown could recreate
  bk31.

### Procedure Q: settle the outcome of a push that did not report success

The brake migration is one transaction (`BEGIN;` at line 107, `COMMIT;` at
line 174 of the migration file), so it is applied fully or not at all. A push
that does not report success does not show which.

The push applies four files in version order, and the brake is the last.
This runbook does not rely on how the CLI groups them: each of the three
earlier files (`20261012105630`, `20261013210000`, `20261014120000`) may have
committed while the brake did not. Q decides on the brake alone (query 3a).
Record which of the four are still pending afterwards (`check` from step P,
read-only). The earlier three are not rolled back either; with no brake, no
key-minting client published and an empty write-block table, they change
nothing for the clients in use. The database session that
ran it is not identified: this runbook has no verified way to identify it,
because the CLI's connection path and any pooling were not verified. So Q
neither lists nor terminates sessions. It settles the outcome only from facts
that do not depend on which session ran the push.

Use Q whenever the push started and did not report success: it errored, it
was refused, its prompt was answered `n`, or it is still running at the
push cutoff.

1. **Still running at the push cutoff.** Do not interrupt it: interrupting
   only makes the outcome harder to settle, and a push that finishes and
   commits ends the gap the right way. The outcome is unsettled; go to 4.
2. **Committed.** Run query 3a from step 1 (read-only). If it returns 7 and
   a non-NULL procedure, the push committed: record T2 as the time observed,
   run `post-verify` from step 3, and follow "After T2". No rollback.
3. **Proven not committed, and unable to commit.** The worker rollback is
   allowed only when **all** of the following hold:
   - the CLI process has exited;
   - query 3a returns 0 and NULL;
   - and one of these:
     - the prompt was answered `n`, and the CLI printed nothing that shows
       it applied a statement. This case rests on the CLI asking before it
       applies anything, which is the prompt's purpose but was not verified
       for this runbook. If the output leaves any doubt, the outcome is
       unsettled;
     - the output shows a **PostgreSQL error with an SQLSTATE**, raised by
       one of the migration's statements. PostgreSQL aborts the whole
       transaction on such an error and turns any later `COMMIT` into a
       rollback, so that transaction can never commit.

   Record the case, the SQLSTATE if there is one, the 3a result and the time
   as "settled".
4. **Unsettled.** This is every other case: a lost connection, a timeout, an
   interrupted or still-running CLI, an error without an SQLSTATE, or output
   that does not show which statement failed.
   - Do **not** roll the worker back. Keep the worker guard and the tail
     running.
   - Record the overrun and report it to the owner. The integrated desktop is
     not published while the brake is unconfirmed.
   - Repeat query 3a every few minutes, read-only. When it shows the brake,
     record T2 as the time observed and continue with "After T2".
   - The only other way out is forward. With the owner's agreement, run
     `check` from step P again in the deploy tree. If `20261015090000` is no
     longer pending, the first push committed it: run query 3a and continue at
     T2. Otherwise push again. If some of the earlier three are no longer
     pending, `check` refuses, because the pending set no longer equals the
     allowlist; then `prepare` a new deploy tree with `--allow` set to exactly
     the versions still pending, run its `check`, and push from it. The
     brake migration is idempotent (`CREATE OR REPLACE FUNCTION`, and
     `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER`), so a second run
     leaves the same brake whether or not the first transaction commits after
     all. If the first transaction is still open, the second waits behind its
     locks; it is then a running push again, handled by step 1.
   - Do not terminate database sessions to force an outcome. This runbook
     has no verified way to identify the push's session, and terminating
     anything else would abort unrelated work.

Never roll the worker back unless step 3 holds.

### Abort

The worker rollback before T2 is the **only** rollback this runbook allows.

| Point | Trigger | Operator action | Verify | Record |
|---|---|---|---|---|
| Before step 2 | Any gate, pre-check or step P fails | Stop. Nothing has changed in production. | — | Which check failed. |
| Step 2 fails | `wrangler deploy` exits with an error | Run `curl -s https://upload.sporely.no/healthz`. | If it still shows the step 1 `workerVersion` and no `obsoleteDesktopBrake`, nothing changed: stop. If it shows `sporely-r2-upload-worker@obsolete-desktop-brake-1`, the new worker is live: set T0 now and continue with the next row. | The error, which `workerVersion` `/healthz` showed. |
| Before the push starts | Any 2a or 2b result differs, or the push cutoff passes before the push was started | Roll the worker back (see "Rollback" below). | Rollback check below. | Trigger, rollback UTC time (the gap end), healthz result. Step 5 applies to [T0, rollback]. |
| After the push started, T2 not confirmed | The push errors or is refused; its prompt lists anything other than exactly the four files of step 3 (answer `n`); or the push cutoff passes | Run procedure Q. Roll the worker back only if Q's step 3 holds. If 3a shows the brake, continue "After T2". If the outcome is unsettled, do not roll back (Q step 4, "Limit of the bound"). | Q's result, then the rollback check. | Trigger, Q's case (and SQLSTATE), the 3a result, the "settled" time, and either the rollback time (gap end), T2, or the overrun. Step 5 applies to the window that ended. |
| After T2 | Anything | **No rollback of either half, ever.** See below. | — | — |

**Rollback:** roll the worker back to the deployment version id recorded in
step 1, with `wrangler rollback <version id>` or the Cloudflare dashboard's
deployment rollback for `sporely-r2-upload`. Verify that
`curl -s https://upload.sporely.no/healthz` reports the step 1
`workerVersion` and has **no** `obsoleteDesktopBrake` field. Then stop the
tail.

What the pre-T2 rollback restores: exactly the production behaviour before
the deploy. Old desktops upload and delete media as before, and the
multi-device overwrite hazard remains as before. No database brake was
applied (when a push had started, Q's step 3 proved it), so nothing the
database was refusing is re-enabled.

After T2 the database brake has committed:

- 4a or 4b fails: stop and report. Any fix is a forward change.
- Web or Android are refused: narrow forward at once ("Emergency procedure",
  step 3).
- The worker misbehaves: deploy a fixed tree that **contains the guard**.
  Never deploy an older worker: with the database brake active, that recreates
  the bk31 media loss.
- "Removal rule" and "Emergency procedure" apply unchanged.

## Data-handling rules for whoever runs this

- Production holds personal data. Only the **aggregate values** and pass/fail
  results named in the "Record" sections may be recorded in this repository
  or shared with an agent.
- Never paste row-level output, tokens, the service-role key or a database
  password into an agent session, a commit, an issue or a chat.
- Use a test account you own for the end-to-end checks.

## 0. Gate before starting

All of the following must be true. Otherwise stop.

- The candidate is accepted, including a `sporely-security-reviewer` verdict
  on its exact SHA. `<accepted candidate SHA>` is the final accepted
  candidate of the web identity branch `feature/sync-key-identity-web`.
- The old-client case of the sync-key plan (verification matrix row 14:
  released desktop builds against the key schema with the brake, database and
  media worker) has passed on the disposable target, in Stage 6.
- Plan "Release" step 2 is done: photo-location web, the web identity branch
  and the integrated desktop are merged to `main`, and `<merged main SHA>` is
  pushed. `fix/obsolete-desktop-sync-brake` is not merged. The four
  migrations and the worker at that SHA are byte-identical to the accepted
  candidate, and the old brake version `20261013200000` is not in the tree:

      git fetch origin
      git merge-base --is-ancestor <merged main SHA> origin/main
      git diff --exit-code <accepted candidate SHA> <merged main SHA> -- \
        supabase/migrations/20261012105630_ingestion_location_provenance.sql \
        supabase/migrations/20261013210000_sync_key_identity.sql \
        supabase/migrations/20261014120000_sync_client_write_block.sql \
        supabase/migrations/20261015090000_obsolete_desktop_sync_brake.sql \
        cloudflare/r2-upload-worker/src
      git ls-tree --name-only <merged main SHA> supabase/migrations/ | grep -c 20261013200000

  The first two commands must exit 0, and the count must be 0.
- Plan "Release" step 3 is done: the integrated desktop release artefacts
  and the owner-approved upgrade notice are ready, but not published.
- **Before merging:** in the Cloudflare dashboard, confirm that the
  `sporely-r2-upload` worker has no Git-connected automatic build. If it had
  one, the merge to `main` would itself deploy the worker and start an
  unrecorded, unbounded gap. This repository has no CI that deploys the worker
  or applies migrations: `.github/workflows/` holds only the Android release
  build and a read-only Supabase heartbeat.
- No other migration is pending except the documented deferred
  `20260914090000` (see `supabase/deploy-exceptions.json`) and the four of
  step 3.
- The owner has explicitly authorized this production deployment in writing.
- The owner-acceptance line in "The worker-first gap orphans media" is
  ticked, with a name and a date.
- The "Controlled window" line is ticked: every syncing desktop installation
  is quit.
- Users have been told, or the owner has accepted deploying first: release
  notes and a web/support message carrying the upgrade text. The desktop shows
  only a count of issues, so most users will not see the refusal text.

## 1. Pre-checks (read-only)

1. Worker health, from any machine:

       curl -s https://upload.sporely.no/healthz

   Expect `"ok": true`. Record the `workerVersion` and `mediaStorageMode`.
   Before this deploy, `obsoleteDesktopBrake` is absent.
2. Migration history, from a checkout of `<merged main SHA>`:

       supabase migration list

   Only the deferred `20260914090000` may show as local-only, plus the four
   new `20261012105630`, `20261013210000`, `20261014120000` and
   `20261015090000`. `20261013200000` must not appear in either column. Any
   other disagreement: STOP and report. A successful
   listing also proves that the Supabase CLI is authenticated and linked to
   the production project.
3. Database, as the database owner, inside
   `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`:

       -- 3a. Brake not installed yet (expect 0 and NULL).
       SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_000_sync_brake';
       SELECT to_regprocedure('private.sync_brake_guard()');

       -- 3b. The seven tables and the private schema exist (expect 7, then 1).
       SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname IN ('observations', 'observation_images', 'spore_measurements',
                            'spore_measurement_mosaics', 'spore_measurement_mosaic_tiles',
                            'observation_spore_summaries', 'observation_reference_uses');
       SELECT count(*) FROM pg_namespace WHERE nspname = 'private';

       -- 3c. BEFORE row triggers that will fire before the brake. Before step 3
       -- (the write stop is not applied yet), expect exactly these three on
       -- observations:
       --   enforce_non_public_observation_limit_trigger,
       --   guard_selected_sporely_taxon_id_v2_trg,
       --   observation_taxon_shared_reference_rate_row_trg.
       -- After step 3 (4a), expect those three plus
       -- aaa_sync_client_write_block, from 20261014120000, on each of the
       -- seven tables: 10 rows.
       -- Each can only raise or skip the row. Anything else: STOP and report.
       SELECT c.relname, t.tgname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND (t.tgtype & 3) = 3
          AND (t.tgname COLLATE "C") < 'trg_000_sync_brake'
          AND c.relname IN ('observations', 'observation_images', 'spore_measurements',
                            'spore_measurement_mosaics', 'spore_measurement_mosaic_tiles',
                            'observation_spore_summaries', 'observation_reference_uses')
        ORDER BY 1, 2;
4. The current worker deployment, from `cloudflare/r2-upload-worker`:

       wrangler deployments list

   Record the version id of the deployment currently serving 100% of
   traffic. It is the rollback target for "Abort". Without it, do not start
   step 2.

### Record

`workerVersion`, `mediaStorageMode`, the 3a–3c values, whether
`migration list` showed only the expected rows, and the current worker
deployment's version id.

## P. Prepare the gap (no production change)

Run this in the same sitting, directly before step 2. Everything here is
read-only or local, so the gap itself holds only `wrangler deploy`, the 2a
probes, `supabase db push --linked` and its confirmation.

1. Build and check the deploy tree. The deferred-migration gap is in force,
   so step 3 uses it. The helper never pushes; the person does.

       node scripts/supabase-deploy-tree.mjs prepare --allow 20261012105630,20261013210000,20261014120000,20261015090000 --ref <merged main SHA>
       node <deploy tree>/scripts/supabase-deploy-tree.mjs check --tree <deploy tree>

   Do not continue unless `check` prints `All checks passed` and the pending
   set is exactly these four versions. If anything delays step 2 noticeably,
   run `check` again before starting it.
2. The Supabase CLI is authenticated and linked to the production project.
   Step 1's `supabase migration list` already proved this, `prepare` verifies
   the deploy tree's production link, and `check` runs `migration list` and
   `db push --dry-run` inside the tree. Nothing further is needed.
3. Wrangler, from `cloudflare/r2-upload-worker`. The Wrangler commands and
   flags in this runbook (`wrangler deployments list`,
   `wrangler tail <worker> --format json`, `wrangler rollback <version id>`)
   have **not** been checked against Wrangler's own documentation while this
   runbook was written: it was prepared offline, and no Wrangler install or
   copy of its command reference was available. The missing input is
   Wrangler's command reference for `tail`, `deployments` and `rollback`
   (developers.cloudflare.com, Wrangler "Commands"), or the `--help` output of
   the Wrangler version the operator uses. Check them now, before the gap:
   - `wrangler whoami` shows the Cloudflare account that owns
     `sporely-r2-upload`;
   - `wrangler tail` accepts a worker name and `--format json`, according to
     the command reference or `wrangler tail --help`. **This is a gate.** The
     capture must be a local JSON file; the dashboard's live logs are not a
     substitute. If the installed Wrangler cannot do this, stop: abort
     before step 2;
   - `wrangler rollback` accepts a version id. If not, the dashboard's
     Deployments → Rollback for `sporely-r2-upload` is the rollback path
     (it needs no capture), and you note that.
4. Database session for query 3a. Open a SQL session as the database owner
   (the same access as step 1's queries) and keep it open through T3, so
   procedure Q can run query 3a at once. In it, read-only, check that no
   long transaction would block the migration, which makes an unsettled push
   less likely:

       -- Expect t. Without it, other roles' xact_start reads as NULL and the
       -- next count is not reliable: stop, abort before step 2.
       SELECT pg_has_role('pg_read_all_stats', 'MEMBER') AS can_read_activity;

       -- Expect 0: no transaction older than a minute holds a lock on the
       -- seven tables. Such a transaction would block the migration's
       -- CREATE TRIGGER. Otherwise wait and repeat; do not start step 2.
       SELECT count(*) FROM pg_stat_activity a
        WHERE a.pid <> pg_backend_pid()
          AND a.xact_start < now() - interval '1 minute'
          AND EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
                       WHERE l.pid = a.pid
                         AND c.relname IN ('observations', 'observation_images',
                               'spore_measurements', 'spore_measurement_mosaics',
                               'spore_measurement_mosaic_tiles',
                               'observation_spore_summaries',
                               'observation_reference_uses'));

   The deploy never terminates database sessions (see procedure Q).
5. Have four terminals ready:
   - in `cloudflare/r2-upload-worker`, the step 2 deploy, then the tail
     command from step 2, with an output file **outside any repository**;
   - in `<deploy tree>`, `supabase db push --linked` typed but not run;
   - the abort command `wrangler rollback <version id from step 1>` typed but
     not run;
   - the database session from item 4, with query 3a ready.
6. Optional baseline for step 5a: the `media_health` counts (see 5a, part B).
7. Prepare the 2b smoke test so that it runs as one command inside the gap:
   the requests of `identity-impl/real-worker/test.sh` (run on the Stage 1b
   candidate under local `wrangler dev`), pointed at
   `https://upload.sporely.no`, with a fresh access token of a test account
   you own and keys under that account's `brake-smoke/` prefix only. Keep the
   token out of every file and log.
8. Prepare the 4c log query and confirm, from the Supabase Logs Explorer
   documentation or a read-only test query outside the window, which fields
   carry the request method, path, `User-Agent` and status. This runbook has
   not verified that schema. If the API request logs do not show the
   `User-Agent`, stop: abort before step 2.

### Record

That `check` passed, the role check, the lock count, that the tail
command was confirmed (and from which source), whether rollback is by CLI
or dashboard, and that the 2b script and the 4c query are ready.

## 2. Deploy the worker

From a clean checkout of `<merged main SHA>`, following
`cloudflare/r2-upload-worker/README.md` ("Deploy"):

    cd cloudflare/r2-upload-worker
    wrangler deploy

No secret, binding or `wrangler.toml` change is part of this stage.

When `wrangler deploy` finishes, record **T0** in UTC and set "abort at" to
T0 + 15 min. This is the start of the worker-first gap. If `wrangler deploy`
errors, follow "Abort", row "Step 2 fails".

Immediately start the capture, and record "tail start":

    wrangler tail sporely-r2-upload --format json >> <capture file outside any repository>

- Use only the worker name and `--format json`, as confirmed in step P. Use
  no filter flags: none were verified. Filter the saved file afterwards by request method
  (`DELETE`, `PUT`) and response status (`426`); step 5a says how.
- If the tail disconnects, restart the same command at once (it appends) and
  note the uncovered interval. If Wrangler reports that it is sampling
  events, note that too: the capture is then incomplete.
- Stop it after T2 (or after a verified abort rollback).
- The file contains user ids in request paths and may contain request
  headers. It stays on the operator's machine. Only counts derived from it
  are recorded. Delete it once step 5 (and any 5b decision) is done.

### 2a. Verify the worker (no media is touched)

These are the same two checks that the worker README ("Deploy") makes
mandatory after every worker deploy until the sync-key cutover: the
`/healthz` flag and the 426 probe.

The refusal comes before authentication, so these probes need no token and
cannot change anything:

    # Expect 426, X-Sporely-Error-Code: sporely_upgrade_required, the JSON body above.
    curl -si -X DELETE -A 'python-requests/2.32.3' \
      https://upload.sporely.no/upload/00000000-0000-4000-8000-000000000000/brake-probe.webp
    curl -si -X PUT -A 'python-requests/2.32.3' --data-binary 'x' \
      https://upload.sporely.no/upload/00000000-0000-4000-8000-000000000000/brake-probe.webp

    # Expect 401 (missing token), NOT 426: browsers and the sync-key header pass the brake.
    curl -si -X DELETE -A 'Mozilla/5.0' \
      https://upload.sporely.no/upload/00000000-0000-4000-8000-000000000000/brake-probe.webp
    curl -si -X DELETE -A 'python-requests/2.32.3' -H 'x-sporely-sync-identity: 2' \
      https://upload.sporely.no/upload/00000000-0000-4000-8000-000000000000/brake-probe.webp

    # Expect 200, the same health as step 1, "obsoleteDesktopBrake": true and
    # "workerVersion": "sporely-r2-upload-worker@obsolete-desktop-brake-1".
    curl -s https://upload.sporely.no/healthz

The README's probe uses a throwaway key under your own test account instead
of the zero-UUID path. Both work, because the refusal comes before
authentication.

The 2a probes are refused requests too, so they appear in the capture. Step
5a excludes them by their paths.

If all results match, continue to 2b at once.

### 2b. Real-worker smoke test (test account, plan "Release" step 4)

Run the script prepared in step P item 7. It repeats Stage 1b's real-worker
test against the deployed worker, with the test account's token, under its
`brake-smoke/` prefix only:

- a released-desktop PUT and DELETE (`User-Agent: python-requests/2.32.3`, no
  `x-sporely-sync-identity`) get **426** with
  `X-Sporely-Error-Code: sporely_upgrade_required`, and a GET afterwards shows
  the store unchanged;
- a new-desktop PUT and DELETE (`x-sporely-sync-identity: 2` and an
  `x-sporely-client-version`) and an Android-WebView PUT and DELETE succeed;
- GETs are unaffected.

The smoke test leaves no object behind: each successful PUT is followed by
its DELETE.

If all results match, record **T1** and continue to step 3 **immediately**.
If any 2a or 2b result differs, do not attempt a fix inside the gap: abort
("Abort", row "Before the push starts"), which rolls the worker back to the
step 1 version id. Rolling back is allowed here, and only before T2, because
the database brake is not applied yet.

## 3. Apply the migrations (deploy tree)

The deploy tree was built and checked in step P. Start the push only before
the push cutoff (T0 + 10 min), and record "push started". In
`<deploy tree>`:

    supabase db push --linked

Answer `y` only if the prompt lists exactly these four files, in this order:

    20261012105630_ingestion_location_provenance.sql
    20261013210000_sync_key_identity.sql
    20261014120000_sync_client_write_block.sql
    20261015090000_obsolete_desktop_sync_brake.sql

Otherwise answer `n` and abort. The brake migration is one
`BEGIN … COMMIT`, so it is applied fully or not at all, but a push that
reports an error does not prove that nothing committed, and the earlier
files may have committed without it (procedure Q). If the push errors, is refused, or has not finished by the push
cutoff, abort ("Abort", row "After the push started"). Procedure Q settles
whether it committed, and the worker may be rolled back only if Q proves it
did not and cannot. Otherwise the gap stays open past the bound, with the
worker guard kept, and is closed forward. Do not just stop and report:
that would leave the gap open.

When the push reports success for all four files, record **T2** in UTC. This
is the end of the worker-first gap. Then stop the tail.

    node <deploy tree>/scripts/supabase-deploy-tree.mjs post-verify --tree <deploy tree>

Then remove the tree with the exact command `post-verify` prints. Never use
`--include-all`, `supabase migration up --linked` from an ordinary checkout,
`supabase migration repair`, or direct DDL in the SQL editor.

## 4. Verify (read-only, then one end-to-end check)

### 4a. Catalog, inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`

    -- Expect 7 rows, all tgtype 31 (row, BEFORE, INSERT, DELETE, UPDATE), tgenabled 'O'.
    SELECT c.relname, t.tgtype, t.tgenabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'trg_000_sync_brake'
       AND t.tgfoid = 'private.sync_brake_guard()'::regprocedure
     ORDER BY 1;

    -- Expect f, {search_path=""}, f, f.
    SELECT p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE'),
           has_function_privilege('authenticated', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = 'private.sync_brake_guard()'::regprocedure;

    -- Repeat 3c: exactly the three known triggers on observations plus
    -- aaa_sync_client_write_block on each of the seven tables (10 rows).

    -- Expect 0: the write stop's block table was created empty and nothing
    -- is blocked.
    SELECT count(*) FROM private.sync_client_write_block;

When 4a passes, record **T3**. If it fails, stop and report: the database
brake has committed, so there is no rollback, and any fix is forward ("Abort",
"After T2").

### 4b. End-to-end with a test account you own

Use an existing observation of the test account, and a field you can set back.
Send the requests with that account's access token and the project's anon key.

1. As an old desktop: `PATCH /rest/v1/observations?id=eq.<test obs id>` with
   `User-Agent: python-requests/2.32.3` and body `{"notes": "brake probe"}`.
   Expect HTTP **400** and body
   `{"code":"P0001", …, "hint":"sporely_upgrade_required", "message":"Sporely Desktop must be updated …"}`.
   The row must be unchanged.
2. The same request with a browser User-Agent: expect 204, and the field
   changed. Set it back the same way.
3. A `GET` of the same row with the python User-Agent: expect 200.
4. Web app (`app.sporely.no`) and the Android app, signed in as the test
   account: edit and save an observation, add a photo, delete the photo.
   All must work as before.
5. Optional, only if available: a released desktop signed in to the test
   account. Expect `Cloud sync finished with N issue(s)`, no sign-in prompt,
   and the new local observation still `local`.

### 4c. API log check for the window (read-only)

With the query prepared in step P item 8, count the Data API requests in the
window [T0, T2] (or [T0, rollback] after an abort) that:

- have a `User-Agent` starting with `python-requests/` (case-insensitive);
- are row writes: `POST`, `PATCH`, `PUT` or `DELETE` under `/rest/v1/`,
  including `/rest/v1/rpc/` calls.

Expect **0**: every syncing desktop was quit ("Controlled window"). Record
only the count, never request paths, ids or headers. If the count is not 0,
step 5 is **required** and must be completed before the integrated desktop
is published (plan "Release" step 6). Do the same if the step 2 capture
shows any refused `PUT` or `DELETE` outside the 2a/2b probes.

### Record

The 4a results (counts and booleans), the pass/fail of each 4b item, the 4c
count, and the completed timing record (T0, abort at, tail start, T1, T2,
T3, and whether T2 − T0 stayed within 15 minutes). No ids, tokens or row
contents.

## 5. Reconcile the gap (orphaned media, rows without media)

This step is required when 4c, or the capture, shows old-desktop activity in
the window; otherwise it is optional. It is separate from the deploy, and
when required it is finished before the integrated desktop is published. It
covers the window from T0 to T2, or to the rollback time after an abort, and
finds both gap residuals (see "The worker-first gap orphans media"):

- legacy-bucket objects left behind by v0.8.13/v0.9.1 observation deletes
  (part A);
- cloud observation rows that v0.8.13/v0.9.1 created without an image row,
  because the media upload was refused (part B).

The method was dry-run on the disposable target
(`brake-426/RESULTS.md`, "Orphan detection", `orphan-detect.sh`): it found
exactly the 4 objects of the two G-DEL observations, and 0 orphans before
them.

### 5a. Identify (read-only)

**Reading the capture.** Every request URL to the worker's upload route has
the form `/upload/<key>`, and the key is
`<user_id>/<observation_id>/<file name>`. From the capture file, keep only
events whose request URL path starts with `/upload/` and whose response
status is `426`. Check one saved event first to see where Wrangler puts the
method, URL and status. Then drop:

- the 2a probes, which use the zero user id
  `00000000-0000-4000-8000-000000000000`;
- any README-style probe under your own test account's `brake-probe/` path;
- the 2b smoke test's requests under your test account's `brake-smoke/`
  path.

Split the rest by method: `DELETE` events feed part A, `PUT` events feed part
B. If the capture is incomplete (a late start after T0, a disconnect, or
sampling), it is a lower bound; use the full-bucket reconciliation in A5 as
well.

**Part A: orphaned media.**

1. Candidate prefixes. Each refused `DELETE` names one object, but the client
   stops after the first refused media delete, so one refused `DELETE` stands
   for the whole observation. Expand each one to its observation prefix
   `<user_id>/<observation_id>/`. Deduplicate.
2. List the bucket, read-only. Use an R2 API token with **Object Read**
   permission only, scoped to the bucket `sporely-media`, and the
   S3-compatible `ListObjectsV2` call against
   `https://<account id>.r2.cloudflarestorage.com` (any S3 client), with each
   candidate prefix as `prefix`. This runbook does not rely on
   `wrangler r2 object` for listing: that it can list keys has not been
   verified. For A5, list the whole bucket the same way, without a prefix.
   `ListObjectsV2` returns at most one page of keys per call. Follow every
   page: while a response has `IsTruncated` true, call again with its
   `NextContinuationToken` as `continuation-token`. The listing is complete
   only when the last response has `IsTruncated` false. Record the number of
   pages and keys, so a listing that stopped early is visible.
3. Collect every referenced key, inside a read-only transaction. Thumbnails
   live in the same directory as their image, with the file name prefixed
   `thumb_`, `thumb_small_` or `thumb_medium_` (`media_variant_key`, sporely-py
   `utils/r2_storage.py`); old desktops uploaded only `thumb_`. Deriving the
   prefixes from every key, as below, can only mark more objects as
   referenced, which is the safe direction.

       BEGIN TRANSACTION READ ONLY;
       WITH refs(k) AS (
         SELECT storage_path FROM public.observation_images       -- includes tombstoned rows
         UNION ALL SELECT original_storage_path FROM public.observation_images
         UNION ALL SELECT image_key FROM public.observations
         UNION ALL SELECT thumb_key FROM public.observations
         UNION ALL SELECT image_key FROM public.spore_measurements
         UNION ALL SELECT thumb_key FROM public.spore_measurements
         UNION ALL SELECT storage_key FROM public.spore_measurement_mosaics
       ), keys AS (SELECT ltrim(k, '/') AS k FROM refs WHERE k IS NOT NULL AND k <> '')
       SELECT k FROM keys
       UNION
       SELECT regexp_replace(k, '([^/]+)$', v || '\1')
         FROM keys, unnest(ARRAY['thumb_', 'thumb_small_', 'thumb_medium_']) AS v;
       ROLLBACK;

4. The gap orphans are the keys listed under the candidate prefixes (A2) that
   are missing from A3. With a complete capture this set is exact.
5. Full-bucket reconciliation, when the capture is incomplete or missing: the
   orphans are all bucket keys missing from A3. The bucket cannot show when
   rows were deleted, so this set also contains any orphans older than the
   gap; only objects uploaded before the gap's end can be gap orphans, and
   beyond that they cannot be told apart. Treat that set as one
   reconciliation.

**Part B: observation rows without media.**

1. From the refused `PUT` events, take the distinct
   (`<user_id>`, `<observation_id>`) pairs. The worker refuses before
   authentication, so a path can name anything: a pair is only a claim until
   B2 matches it to a real row of that user.
2. Inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`, with the pairs from B1
   in the `VALUES` list and the window from the timing record:

       WITH captured(user_id, id) AS (
         VALUES ('<user_id>'::uuid, <observation_id>::bigint) -- one row per pair
       ), imageless AS (
         SELECT o.id, o.created_at FROM public.observations o
          WHERE NOT EXISTS (SELECT 1 FROM public.observation_images i
                             WHERE i.observation_id = o.id)
       )
       SELECT
         -- B2a, the result: captured pairs that match a row of that user,
         -- created in the gap, with no image row.
         (SELECT count(*) FROM captured c
            JOIN public.observations o ON o.id = c.id AND o.user_id = c.user_id
            JOIN imageless m ON m.id = o.id
           WHERE m.created_at >= '<T0>' AND m.created_at < '<T2 or rollback>') AS b2a_in_gap,
         -- B2b: the same match, but created outside the window: an older
         -- pending upload, or a client-supplied created_at. Report, do not add.
         (SELECT count(*) FROM captured c
            JOIN public.observations o ON o.id = c.id AND o.user_id = c.user_id
            JOIN imageless m ON m.id = o.id
           WHERE NOT (m.created_at >= '<T0>' AND m.created_at < '<T2 or rollback>')) AS b2b_outside_gap,
         -- B2c, approximate fallback only: every image-less row created in the
         -- window, captured or not. An upper bound: an observation without
         -- photos is legitimate, and created_at is only a column default.
         (SELECT count(*) FROM imageless m
           WHERE m.created_at >= '<T0>' AND m.created_at < '<T2 or rollback>') AS b2c_window;

   B2a counts **candidates**: rows consistent with a refused gap upload. It
   does not prove that the refusal caused them. Captured pairs that match no
   row of that user are dropped. If the capture is incomplete, B2a is a lower
   bound and B2c the only (approximate) cover for the uncovered interval.

3. The existing media-health audit (`admin-ops` edge function called
   without an `action`, the read-only overview whose `media_health` block is
   built in `supabase/functions/admin-ops/index.ts`) is a before/after sanity
   check, taken in step P and again now. It counts image rows with missing
   media (`rows_missing_storage_path`, `rows_missing_thumb_path`) and media
   issues. It **cannot** count the G-NEW rows: they have no image row at all
   (`brake-426/RESULTS.md`). Its counts should not move because of the gap;
   if they do, report it.

These rows heal when a desktop that is not braked syncs the still-pending
local photo. No server-side change to them is part of this runbook.

**Data handling.** Keep the capture, listings and query output on the
operator's machine. Object keys and observation ids belong to users and are
personal data: record only counts and total size in this repository or in an
agent session.

### 5b. Remove (separately approved)

Deleting objects, and correcting the affected users' storage accounting (for
example through the admin storage reconciliation,
`reconcile_profile_storage_usage`), are production writes. They are **not**
part of this runbook. Each needs its own written approval from the owner,
based on the 5a count.

### Record

Whether 5a was run; whether the capture was complete (and any uncovered
intervals); the number of candidate prefixes; the listing's page and key
counts; the orphan count and total size (A4, and A5 if run); the number of
captured pairs and the B2a, B2b and B2c counts; the `media_health` before/after
counts; and whether 5b was approved. No keys, ids or user ids.

## What users see

- **Old desktop (every released build):**
  - The sync banner shows only a count, for example
    `Cloud sync finished with 2 issue(s).` or, on v0.8.13,
    `Sporely Cloud synced: 1 imported. 2 other issue(s).`
  - The upgrade text appears only in the per-row sync error details.
  - There is no dialog and no sign-in prompt.
  - Download and pull keep working.
  - Deleting an observation shows `Observation deleted with 1 cleanup issue(s).`
    The media `DELETE` gets 426 and the image-row `DELETE` gets 400 `P0001`,
    so the observation `DELETE` is never sent and the cloud is unchanged. The
    cloud copy and its media stay, and the next pull re-imports the
    observation (`brake-426/RESULTS.md`, F-DEL).
  - Credentials are kept, and a restart comes up signed in with no prompt, in
    both the gap and the final state (`brake-426`, restart runs).
- **Old desktop v0.8.13 and v0.9.1, during the worker-first gap only:**
  - A new observation's row is created in the cloud (201), its media upload
    is refused (426), and no image row is inserted. The UI reports success
    with 0 errors (`Sporely Cloud synced: 1 uploaded.` on v0.8.13,
    `Cloud sync complete. … 1 patched.` on v0.9.1); the refusal appears only on
    stdout. The local observation stays linked to the new cloud row and
    `dirty`, and its photo stays local and unlinked. It is retried once per
    sync, with no loop.
  - Deleting a synced observation shows only `Observation deleted.`, with no
    cleanup issue. The rows are deleted and the media stays as orphans.
  - Credentials stay stored and restarts come up signed in.
  - Known gap-only inaccuracy: the 426 refusal text says `Nothing was changed
    in the cloud.` That is false in the gap, because rows were created or
    deleted. It is accurate in the final state. The worker is not changed for
    this; users see the text at most in per-row details or on stdout.
- **Web and Android:** no change.
- **Support text:** "If Sporely Desktop says it must be updated before it can
  upload, nothing was lost: your observations are still on your computer and
  will upload after you install the latest version."

## Removal rule

The brake is removed **only** by the future sync-key cutover migration, in the
**same transaction** that installs the permanent identity gate. The worker
guard is removed in the matching worker release, after that migration is
applied.

It is **never** removed as a rollback. Dropping the triggers, or reverting the
worker to a version without the guard while the database brake is active,
reactivates unsafe desktop synchronization. That means silent overwrites, or
media deletion ahead of a refused row delete (bk31). There is deliberately no
down migration.

The worker rollback before T2 in "Gap timing, bound and abort" is the only
rollback this runbook allows; at that point the database brake has not been
applied.

### Every later worker deploy, until the cutover

The database brake is protected by its pgTAP test; the worker guard is not.
A `wrangler deploy` from any tree without the guard (a branch cut before this
merge, an emergency hotfix) **silently removes the brake**. That is forbidden
until the cutover.

After **every** worker deploy until the cutover, both checks from 2a are
**mandatory** (they are also step 8 of "Deploy" in
`cloudflare/r2-upload-worker/README.md`):

1. `curl -s https://upload.sporely.no/healthz` reports
   `"obsoleteDesktopBrake": true`.
2. The 426 probe: a PUT with `User-Agent: python-requests/2.32.3` and no
   token, to a throwaway key under your own test account
   (`/upload/<your test account user_id>/brake-probe/brake-probe.webp`),
   returns **426** with `X-Sporely-Error-Code: sporely_upgrade_required`.

If either fails, deploy a tree that contains the guard at once.

## Emergency procedure: narrow, never remove

If the brake refuses a client that must keep working:

1. **Identify the client** from the refusal: User-Agent, headers, role.
   Expected false positives are scripts that use an end-user JWT with the
   python-requests default User-Agent.
2. **Prefer fixing the client.** A legitimate script sets its own
   User-Agent, for example `sporely-maintenance/1.0`. No server change is
   needed.
3. **Otherwise narrow the rule with a forward migration.** Write a new
   migration that replaces `private.sync_brake_guard()` with a narrower
   identification rule, for example an exact exemption that cannot match a
   shipped desktop. Make the same change in `obsolete-desktop-guard.js` and
   deploy the worker. The worker is order-insensitive here: either half
   narrowing first only lets the affected client through earlier.
4. **Before deploying a narrowing,** re-run the old-desktop matrix on the
   disposable target (`g4-evidence/brake/tools/collide.sh`). Every shipped build
   must still be refused.
5. Never `DROP TRIGGER`, `ALTER TABLE … DISABLE TRIGGER`, or redeploy an
   older worker as the fix.

If web or Android were refused (not expected: neither sends a python-requests
User-Agent), apply step 3 at once.
