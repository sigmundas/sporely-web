# Runbook — obsolete-desktop sync brake (production)

Stage: `2026-10-13-obsolete-desktop-sync-brake`.
Migration: `supabase/migrations/20261013200000_obsolete_desktop_sync_brake.sql`.
Worker: `cloudflare/r2-upload-worker/src/obsolete-desktop-guard.js`, wired into
`handleRequest` in `cloudflare/r2-upload-worker/src/index.js`.

Status: **prepared, not executed.** Deploying the worker and applying the
migration to production are the **user's** actions. No agent deploys the
worker, pushes the migration, connects to production, or sees production
output beyond the aggregate values this runbook marks as recordable.

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
   - an old desktop can create observation and image rows whose media upload is
     then refused. Those rows have no media until a desktop that is not braked
     syncs them again;
   - v0.8.13 and v0.9.1 desktops that delete an observation leave its media
     orphaned in the public legacy bucket. See the next section.

   Keep the gap to minutes.

### The worker-first gap orphans media (accepted residual)

Between the worker deploy and the database migration, the worker refuses an
old desktop's media delete with 426, but the database still accepts its row
deletes. The v0.8.13 and v0.9.1 desktops ignore a failed media delete:
`delete_cloud_observation` (sporely-py v0.8.13 `utils/cloud_sync.py`,
about lines 8354-8371) catches the error, prints a warning, and then deletes
the `observation_images` rows and the `observations` row anyway. v0.9.15 and
later stop at the failed media delete instead, so they are not affected.

The result for each observation deleted this way in the gap:

- its media objects stay in the legacy bucket `sporely-media` with no row
  pointing at them;
- production runs `MEDIA_STORAGE_MODE = "legacy"`, and that bucket is served
  publicly at `media.sporely.no`, so media the user deleted stays reachable
  by anyone who has its old URL;
- the user's storage quota accounting for those objects is not released.

Worker-first is still the right order. The database-first order loses media
outright: an old desktop's media delete succeeds before the database refuses
the row delete (bk31 lost 4 media objects this way). Orphaned objects in a
short window are the smaller, recoverable harm: no user data is lost, and the
objects can be found and removed afterwards (step 5).

Requirements:

- Keep the gap as short as possible. Run step 3 immediately after the 2a
  checks pass, in the same sitting, with step 3's commands prepared in
  advance.
- Record the gap's **UTC start** (the time `wrangler deploy` in step 2
  finished) and its **UTC end** (the time `supabase db push --linked` in
  step 3 committed). Step 5 uses this window.
- The owner accepts this residual explicitly before the deploy. This line must
  be ticked, with a name and a date, before step 2:

  - [ ] Owner accepts that v0.8.13/v0.9.1 observation deletes during the
        worker-first gap can leave publicly reachable orphaned media until
        step 5 removes it. Name: ____________ Date (UTC): ____________

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
  on its exact SHA.
- Completion gate **GB-GUI** has passed: real old desktop builds against the
  candidate on the disposable target.
- The branch is merged to `main`, and `<merged main SHA>` is pushed. The
  migration and the worker at that SHA are byte-identical to the accepted
  candidate:

      git fetch origin
      git merge-base --is-ancestor <merged main SHA> origin/main
      git diff --exit-code <accepted candidate SHA> <merged main SHA> -- \
        supabase/migrations/20261013200000_obsolete_desktop_sync_brake.sql \
        cloudflare/r2-upload-worker/src

  Both commands must exit 0.
- No other migration is pending except the documented deferred
  `20260914090000` (see `supabase/deploy-exceptions.json`).
- The owner has explicitly authorized this production deployment in writing.
- The owner-acceptance line in "The worker-first gap orphans media" is
  ticked, with a name and a date.
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

   Only the deferred `20260914090000` may show as local-only, plus the new
   `20261013200000`. Any other disagreement: STOP and report.
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

       -- 3c. BEFORE row triggers that will fire before the brake. Expect exactly
       -- these three on observations:
       --   enforce_non_public_observation_limit_trigger,
       --   guard_selected_sporely_taxon_id_v2_trg,
       --   observation_taxon_shared_reference_rate_row_trg.
       -- Each can only raise or skip the row. Anything else: STOP and report.
       SELECT c.relname, t.tgname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND (t.tgtype & 3) = 3
          AND (t.tgname COLLATE "C") < 'trg_000_sync_brake'
          AND c.relname IN ('observations', 'observation_images', 'spore_measurements',
                            'spore_measurement_mosaics', 'spore_measurement_mosaic_tiles',
                            'observation_spore_summaries', 'observation_reference_uses')
        ORDER BY 1, 2;

### Record

`workerVersion`, `mediaStorageMode`, the 3a–3c values, and whether
`migration list` showed only the expected rows.

## 2. Deploy the worker

From a clean checkout of `<merged main SHA>`, following
`cloudflare/r2-upload-worker/README.md` ("Deploy"):

    cd cloudflare/r2-upload-worker
    wrangler deploy

No secret, binding or `wrangler.toml` change is part of this stage.

When `wrangler deploy` finishes, record the time in UTC. This is the start
of the worker-first gap.

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

If any result differs, roll the worker forward with a fix, or roll it back to
the version recorded in step 1. Rolling back is allowed here, and only here,
because the database brake is not applied yet. Then stop.

Continue to step 3 **immediately**.

## 3. Apply the migration (deploy tree)

The deferred-migration gap is in force, so use the deploy tree. The helper
never pushes; the person does.

    node scripts/supabase-deploy-tree.mjs prepare --allow 20261013200000 --ref <merged main SHA>
    node <deploy tree>/scripts/supabase-deploy-tree.mjs check --tree <deploy tree>

Do not continue unless `check` prints `All checks passed` and the pending set
is exactly `20261013200000`.

    cd <deploy tree>
    supabase db push --linked

Answer `y` only if the prompt lists exactly
`20261013200000_obsolete_desktop_sync_brake.sql`. The migration is one
`BEGIN … COMMIT`. If it fails, nothing is applied: stop and report the error.

When the push has committed, record the time in UTC. This is the end of the
worker-first gap.

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

    -- Repeat 3c: still exactly the three known triggers.

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

### Record

The 4a results (counts and booleans), the pass/fail of each 4b item, and the
worker-first gap's UTC start and end (steps 2 and 3). No ids, tokens or row
contents.

## 5. Optional: reconcile media orphaned in the gap

This step is optional and separate from the deploy. It finds the legacy-bucket
objects left behind by v0.8.13/v0.9.1 observation deletes during the recorded
gap (see "The worker-first gap orphans media").

The repository has no tool that lists bucket objects without a row. The
existing media-health audit (`admin-ops` edge function, `media_health` in
`supabase/functions/admin-ops/index.ts`) works from the rows: rows missing
media, unpurged tombstones and media issues. It cannot see an object whose rows
were deleted, so it does not find these orphans. Its output is still a useful
before/after sanity check.

### 5a. Identify (read-only)

1. List the object keys in the legacy bucket `sporely-media` with a read-only
   R2 credential. Keys have the form `<user_id>/…`.
2. Inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`, collect every media key
   that a row still references: `observation_images` (including tombstoned
   rows), the thumbnail keys derived from them, and
   `spore_measurement_mosaics.storage_key`.
3. The orphans are the bucket keys from 1 that are missing from 2. The
   bucket cannot show when the rows were deleted, so this set also contains
   any orphans older than the gap. Only objects uploaded before the gap's end
   can be gap orphans; beyond that, gap orphans cannot be told apart from
   older ones. Treat the set as one reconciliation. If the operator captured
   the worker's refused `DELETE` requests during the gap (for example with
   `wrangler tail` running between steps 2 and 3), those paths are the exact
   candidates, and each must also be missing from 2.
4. Keep the list on the operator's machine. Object keys contain user ids and
   are personal data: record only the **count** and total size in this
   repository or in an agent session.

### 5b. Remove (separately approved)

Deleting objects, and correcting the affected users' storage accounting (for
example through the admin storage reconciliation,
`reconcile_profile_storage_usage`), are production writes. They are **not**
part of this runbook. Each needs its own written approval from the owner,
based on the 5a count.

### Record

Whether 5a was run, the orphan count and total size, and whether 5b was
approved. No keys or user ids.

## What users see

- **Old desktop (every released build):**
  - The sync banner shows only a count, for example
    `Cloud sync finished with 2 issue(s).` or, on v0.8.13,
    `Sporely Cloud synced: 1 imported. 2 other issue(s).`
  - The upgrade text appears only in the per-row sync error details.
  - There is no dialog and no sign-in prompt.
  - Download and pull keep working.
  - Deleting an observation shows `Observation deleted with 1 cleanup issue(s).`
    The cloud copy and its media stay, and come back on the next pull.
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
