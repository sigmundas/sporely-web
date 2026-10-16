# Runbook — ingestion and location provenance: G5 staging matrix and production rollout

Plan: `docs/plans/active/2026-10-12-ingestion-location-provenance.md` (Stage 5).
Migration: `supabase/migrations/20261012105630_ingestion_location_provenance.sql`.
Probe: `supabase/ingestion-location-provenance-probe.sql`.
Contract: `docs/supabase-sync-contract.md`, "Private ingestion and location
provenance (not deployed)".

**Status: not executed. No production operation is authorized.** Part 1 is
the manual completion gate G5, run by the user on a disposable target. Part 2
is the separate production procedure. It needs a recorded G5 pass and a fresh,
specific owner authorization, and each client publication needs its own.
Agents do not run either part.

## 0. Exact candidates

### Web and Android (`sporely-web`, branch `feature/photo-provenance`)

| Stage | Accepted commit | Content |
| --- | --- | --- |
| 1 | `49f0e1e487a310e8dd28d6765e12896f5f2cde6a` | migration, SQL test, contract |
| 2 | `22cdcd690155378cf70e2edf3055beb1d11aa166` | `ingest_method` through capture, queue and retries |
| 3 | `102997557f90504a37d24d24006283533361b109` | location pair, `set_observation_location` routing, desktop contract |
| 5 | `<Stage 5 accepted SHA>` (recorded by the engine) | this runbook and the probe |

The client candidate is `1029975`. Stage 5 changes only `docs/` and the probe,
so a build from the Stage 5 SHA has the same client source. Check before
building:

    git diff --exit-code 102997557f90504a37d24d24006283533361b109 <Stage 5 SHA> -- \
      src index.html vite.config.js package.json package-lock.json public \
      android capacitor.config.json

Manual gates passed so far: G1 and G1C (Stage 1), G2 (Stage 2), G3 (Stage 3,
emulator only; physical GNSS and real-camera EXIF were deferred to Android
release readiness by the owner), G4 (Stage 4).

### Desktop (`sporely-py`, read-only pin)

- Pin: `3850b3f9be13f29455bbc593d5fb49ab38244e29`, branch
  `feature/ingestion-location-provenance-stage-4`. On 2026-10-16 the local and
  `origin` refs of that branch both pointed to it.
- G4 passed on tested commit `T = ee6ab4ec840a4f37679210bc4c1895bbb121c94f`.
  The G4 record states that `3850b3f` differs from `T` only in
  `docs/verification/2026-10-sync-key-n1-two-desktop.md`. Confirm before
  building:

      git -C <sporely-py> diff --stat ee6ab4ec840a4f37679210bc4c1895bbb121c94f \
        3850b3f9be13f29455bbc593d5fb49ab38244e29

  Expected: that one file only.
- **Engine acceptance records** (engine `state.json`, each `status`
  `accepted`):
  - This plan's Stage 4 accepted `3fb0cc05139bf76955ce85f3d9bd41af31fee465`
    (sporely-py `.sparring/stages/2026-10-12-ingestion-location-pr-71e21f09-96de0f61-stage-4-…`).
    That candidate failed G4.
  - The Stage 4b correction accepted `ee6f2af86b560630552077ec4f042d9a858758ea`
    (sporely-py `.sparring/stages/2026-10-13-stage-4b-exif-attribution-reachable`).
  - The sync-key plan run `7f95e23f` accepted `3850b3f` in Stage 6, the
    two-desktop regression with the G4 photo-location re-check on `T`, and in
    Stage 7, the independent security review
    (`sporely-worktrees/py-n1/.sparring/stages/2026-10-14-sync-key-identity-ff39f23d-7f95e23f-stage-{6,7}-…`).
    Both declare web `0bb2782` as their sibling.
  - `3fb0cc0` and `ee6f2af` are ancestors of `3850b3f`. `origin
    feature/ingestion-location-provenance-stage-4` was fast-forwarded to
    `3850b3f` with the owner's authorization.
- **Authority for the pin.** The owner-approved sync-key plan ("Outside these
  runs", steps 2–4) directs this plan to continue with the desktop at
  `3850b3f`, citing the Stage 6 G4 evidence on `T`. The owner recorded G4
  against that evidence in this run on 2026-10-16. That decision supersedes
  the Stage 5 brief's wording "exact accepted Stage 4 commit". There is no
  cross-plan re-acceptance command; the accepted records above are the engine
  evidence for `3850b3f`.
- **Release dependency.** `T` is a sync-key desktop. G4 ran it only against a
  target that also had the sync-key server migrations from web `0bb2782`
  (`20261013210000_sync_key_identity`, `20261014120000_sync_client_write_block`,
  `20261015090000_obsolete_desktop_sync_brake`), which are not on this branch.
  It has not been verified against a target with only the provenance
  migration. Desktop publication therefore belongs to the sync-key release
  plan (`2026-10-14-sync-key-identity`), and this runbook does not authorize it.

### Field-set agreement (checked for Stage 5)

- The "Private ingestion and location provenance" section is the same text in
  both contract copies: web lines 939–1104 at `1029975`, desktop lines
  1542–1707 at `3850b3f`. The desktop copy adds a "Desktop implementation"
  subsection after it.
- The enum sets match in the migration CHECKs, web
  `src/location-provenance.js` and `src/observation-shapes.js`, and desktop
  `utils/cloud_sync_impl/reconciliation/location_provenance.py`.
- Both clients call `set_observation_location` with the seven named arguments
  the migration declares (`p_observation_id` … `p_location_status`). The
  desktop always sends NULL altitude and accuracy.

## 1. G5 — stored-metadata matrix on the disposable target

### 1.1 Target

Default target: the local stack `sporely-g3-verify`, already used for G3 and
G4. Project directory
`sporely-worktrees/g3-evidence/supabase-g3`, API `http://127.0.0.1:55421`,
database container `supabase_db_sporely-g3-verify`. Web build environment
template: `sporely-worktrees/g3-evidence/g3-build.env`. Another disposable
target is acceptable if it passes the same checks; record which one was used.

Before each session:

1. The API URL is local or a known staging host, and the checkout you run
   `supabase` from is not linked to `zkpjklzfwzefhjluvhfw`.
2. The probe passes, with `T0` set to the session start in UTC:

       docker exec -i supabase_db_sporely-g3-verify psql -U postgres -X \
         -v ON_ERROR_STOP=1 -v since="$T0" -v expect=applied \
         < supabase/ingestion-location-provenance-probe.sql

   It must print `ilp_probe: READY (applied)` and exit 0. The assertion
   covers Part A (schema, RPC, grants, policies, projections) and Part C
   (non-owner and anonymous reads). It also needs at least one observation and
   one image row on the target, so that Part C cannot pass vacuously. The probe's own pass and
   fail behaviour is tested by
   `supabase/tests/ingestion_location_provenance_probe_test.sh`, which must
   be run on a local database and does not run against this target.
3. For desktop cases, the target also carries the sync-key server objects G4
   used (see `g4-evidence/p1d/target-fingerprint-start.txt`).

### 1.2 Accounts and builds

- **A**: owner test account (for example `owner@g3.test`). **B**: a second
  test account that owns nothing A owns. **Anonymous**: publishable/anon key
  only.
- Web: build or serve the Stage 5 SHA with `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY` pointing at the target. Record the served
  commit.
- Android: a debug build of the Stage 5 SHA against the target. Record the
  APK sha256, and the device or emulator. Use a physical device for the camera
  and GNSS cases G3 deferred, if one is available.
- Desktop: `T` or `3850b3f` against the target.
- Old-client cases use the API requests in 1.4, not released desktops: the
  sync-key brake on the target refuses their writes.

### 1.3 Cases

Record each case: build SHA, platform, the observation and image ids on the
target, expected and observed values, and pass, fail or not reproducible with
the reason. Test-account rows on a disposable target may be recorded. Read
each case's stored values with `p1 <id>` and `p2 <id>` (helpers in 1.4). Use
the id of the observation that case saved: find it in the app (find detail),
or list A's newest rows with
`rest GET "$TA" "observations?select=id,created_at,genus,species&order=created_at.desc&limit=5"`.
Never use the 1.4 API fixture `FIX` for a 1.3 case.

**Ingestion.** Each needs one saved observation, and the stated
`ingest_method` on every live image row.

| Id | Path | Expected `ingest_method` |
| --- | --- | --- |
| I1 | Android, Sporely camera | `sporely_camera` |
| I2 | Android, system camera | `system_camera` |
| I3 | Browser, in-app camera | `web_camera` |
| I4 | Android, native photo picker | `native_picker` |
| I5 | Browser, file input | `web_file_picker` |
| I6 | One batch with at least two methods. Reject or filter one image at an early or interior position, then sort and group. | Each surviving image keeps its own method; the rejected image has no row |
| I7 | Save offline, kill the app, relaunch, reconnect, let the queue drain | One observation; each image row once with its method; probe B3 `duplicate_image_rows` = 0 |
| I8 | Desktop-created image | NULL |

**Location.** These follow the plan's frozen transitions. Run every case
the test devices can reproduce. A case that cannot be reproduced stays
recorded as blocked with its reason. G3 could not produce L6 on an emulator,
and found no UI writer for L7.

| Id | Situation | Expected pair |
| --- | --- | --- |
| L1 | Fresh device fix selected | `device_gps` / `acquired` |
| L2 | Geotagged original photo selected (picker import) | `image_exif` / `acquired` |
| L3 | Manual point (find-detail map picker; desktop details dialog) | `manual` / `acquired` |
| L4 | Permission denied, continue without location | `none` / `denied` |
| L5 | Timeout, continue without location | `none` / `timeout` |
| L6 | Position unavailable, continue without location | `none` / `unavailable` |
| L7 | Location disabled, continue without location | `none` / `disabled` |
| L8 | Skip location with no failure observed (multi-group import, confirm saving without location) | `none` / `skipped` |
| L9 | Timeout, Try again, denied, continue | `none` / `denied` |
| L10 | Denied or timeout, then a fix succeeds and is selected | `device_gps` / `acquired` |
| L11 | A GPS attempt fails while manual coordinates stay selected | `manual` / `acquired`, coordinates unchanged |
| L12 | Deliberate clear through the aware operation (P12; the web has no clear UI) | `none` / `skipped`, all four coordinates NULL |
| L13 | Legacy insert without the fields (P11a) | NULL / NULL |
| L14 | Legacy PATCH that changes a coordinate value (P11c) | NULL / NULL |
| L15 | Unrelated PATCH, or coordinates resent unchanged (P11b) | pair unchanged |
| L16 | Imported photo without GPS (single group) | NULL / NULL |
| L17 | Restored review draft after an outcome (G3 row 17) | the draft's recorded outcome |

**Cross-client** (desktop `T`/`3850b3f` with the Stage 5 web build):

| Id | Case | Expected |
| --- | --- | --- |
| X1 | Web sets `manual`/`acquired`; desktop pulls and makes an unrelated edit; web reads | pair and coordinates preserved; the desktop PATCH carries no location keys |
| X2 | Desktop creates an observation from a geotagged photo | `image_exif` / `acquired`; image `ingest_method` NULL |
| X3 | Desktop Download from Cloud on a fresh profile, then a no-op sync | zero cloud writes |

### 1.4 API requests

Set these in a private shell. Never paste tokens or keys into an agent
session, an issue or a commit.

    API=http://127.0.0.1:55421
    ANON=<publishable/anon key of the target>
    login() { curl -s "$API/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
      -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"; }
    A_JSON=$(login '<A email>' '<A password>'); B_JSON=$(login '<B email>' '<B password>')
    TA=$(jq -r .access_token <<<"$A_JSON"); UA=$(jq -r .user.id <<<"$A_JSON")
    TB=$(jq -r .access_token <<<"$B_JSON")
    # rest METHOD TOKEN PATH [JSON]: prints the body, then "HTTP <status>"
    rest() { curl -s -w '\nHTTP %{http_code}\n' -X "$1" "$API/rest/v1/$3" \
      -H "apikey: $ANON" -H "Authorization: Bearer $2" \
      -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
      ${4:+-d "$4"}; }
    SEL='select=id,updated_at,gps_latitude,gps_longitude,gps_altitude,gps_accuracy,location_source,location_status'
    # p1 ID [TOKEN]: one observation's coordinates and pair (P1; default token A)
    p1() { rest GET "${2:-$TA}" "observations?id=eq.$1&$SEL"; }
    # p2 ID [TOKEN]: that observation's live images and methods (P2)
    p2() { rest GET "${2:-$TA}" "observation_images?observation_id=eq.$1&deleted_at=is.null&select=id,storage_path,sort_order,ingest_method&order=sort_order"; }
    loc() {  # loc ID LAT LON ALT ACC SOURCE STATUS (use null for NULL)
      printf '{"p_observation_id":%s,"p_gps_latitude":%s,"p_gps_longitude":%s,"p_gps_altitude":%s,"p_gps_accuracy":%s,"p_location_source":%s,"p_location_status":%s}' \
        "$1" "$2" "$3" "$4" "$5" "$6" "$7"; }
    # setloc TOKEN ID LAT LON ALT ACC SOURCE STATUS: call set_observation_location
    setloc() { local t="$1"; shift; rest POST "$t" rpc/set_observation_location "$(loc "$@")"; }

**Fixture.** One public, non-draft observation for A with no provenance keys.
This is also P11a. Note the returned `id` as `FIX`:

    rest POST "$TA" observations "{\"user_id\":\"$UA\",\"date\":\"2026-10-16\",\"genus\":\"G5fixture\",\"species\":\"api\",\"visibility\":\"public\",\"is_draft\":false,\"notes\":\"g5 fixture\"}"

If the target refuses this insert (for example because of the sync-key
identity guard), record the error. In that case use a web-created public
observation of A as `FIX`, and mark P11a as not run.

Run the requests in this order. Each one names the observation it reads.
`FIX` is the API fixture above. `OBS` is an app-created observation from 1.3
that has images; for P5 it must be public. P11b and P11c each start from a
baseline that P8 sets explicitly, so neither can pass on a NULL/NULL row.
`setloc` is the helper defined above.

| Id | Request | As | Expected |
| --- | --- | --- | --- |
| P11a | `p1 $FIX` right after the fixture insert | A | `location_source`, `location_status` both null |
| P1 | `p1 $FIX` | A | 200, one row |
| P2 | `p2 $OBS` | A | 200, the methods of that case |
| P3 | `p1 $FIX "$TB"`; `p2 $OBS "$TB"` | B | 200, `[]` |
| P4 | `p1 $FIX "$ANON"`; `p2 $OBS "$ANON"` | Anonymous | an error (401, permission denied for table) or `[]`; never a row |
| P5 | `rest GET "$ANON" "observations_community_view?id=eq.$FIX&select=*"`; `rest GET "$ANON" "observation_images_community_view?observation_id=eq.$OBS&select=*"`; both again with `"$TB"` | Anonymous, then B | rows present; no `ingest_method`, `location_source` or `location_status` key |
| P6 | `rest GET "$ANON" "observations_community_view?select=location_source&limit=1"` | Anonymous | 400, the column does not exist |
| P7 | `rest POST "$ANON" rpc/get_public_observation "{\"p_observation_id\":$FIX}"` | Anonymous | 200; none of the three keys |
| P8 | Baseline: `setloc "$TA" $FIX 63.4 10.4 12 8 '"device_gps"' '"acquired"'`, then `p1 $FIX` | A | 200 and `FIX`; then 63.4/10.4/12/8, `device_gps`/`acquired`. Note `updated_at` |
| P8r | The same P8 call again, then `p1 $FIX` | A | 200; `updated_at` unchanged |
| P8s | `setloc "$TA" $FIX 63.6 10.6 12 8 '"device_gps"' '"acquired"'`, then `p1 $FIX` | A | coordinates 63.6/10.6; pair still `device_gps`/`acquired` |
| P9 | `setloc "$TB" $FIX 61 9 null null '"manual"' '"acquired"'`; the same with `"$ANON"`; then `p1 $FIX` | B; Anonymous | B: 403 (`42501`); anonymous: 401 (permission denied for function); `FIX` still as after P8s |
| P10 | `setloc "$TA" $FIX null null null null '"manual"' '"acquired"'`, then `p1 $FIX` | A | 400 (`23514`); `FIX` unchanged |
| P11b | Re-run P8 (baseline 63.4…, `device_gps`/`acquired`). Then `rest PATCH "$TA" "observations?id=eq.$FIX" '{"notes":"g5 unrelated"}'` and `p1 $FIX`. Then `rest PATCH "$TA" "observations?id=eq.$FIX" '{"gps_latitude":63.4,"gps_longitude":10.4,"gps_altitude":12,"gps_accuracy":8}'` and `p1 $FIX` | A | after each PATCH: `device_gps`/`acquired`, coordinates unchanged |
| P11c | Re-run P8 (baseline). Then `rest PATCH "$TA" "observations?id=eq.$FIX" '{"gps_latitude":63.5}'`, then `p1 $FIX` | A | latitude 63.5; pair null/null |
| P12 | `setloc "$TA" $FIX null null null null '"none"' '"skipped"'`, then `p1 $FIX` (case L12) | A | all four coordinates null; `none`/`skipped` |

Optional cleanup: `rest DELETE "$TA" "observations?id=eq.$FIX"`.

### 1.5 Close the session

Run the probe again with the same `T0`, without `expect`. Compare:

- B1 counts per method with the number of images the cases saved.
- B2 pairs with the location cases.
- B3: `duplicate_image_rows` = 0. `possible_duplicate_obs` = 0, unless a case
  created such a pair on purpose. `mixed_method_observations` ≥ 1 (I6).
  `null_method_images` equals the desktop-created images (I8). The 1.4
  fixture creates no image rows, so it adds nothing here; any other NULL
  image is a mismatch.
- B2 includes the 1.4 fixture once, as the pair its last request left
  (`none`/`skipped` after P12).
- C: `observations_present` = t, `images_present` = t, `non_owner_*_visible` = 0, and
  `*_leaking` = 0 with `*_sampled` > 0.

G5 passes only if every executed case matches, there is no unexplained
mismatch or duplicate retry write, and every minimum G5 case is present: I1–I5,
I6, I7, and the reproducible L and P cases. Record exact SHAs, the target,
platforms and every case outcome in the engine's gate record. A G5 pass
establishes staging readiness only.

## 2. Production procedure (separately authorized; not part of the run)

### 2.0 Before starting

All must be true. Otherwise stop.

1. G5 has a recorded pass for the exact SHAs in section 0.
2. `feature/photo-provenance` has reached `main` through a reviewed merge, and
   the migration is unchanged:

       git fetch origin
       git merge-base --is-ancestor <merged main SHA> origin/main
       git diff --exit-code 49f0e1e487a310e8dd28d6765e12896f5f2cde6a <merged main SHA> -- \
         supabase/migrations/20261012105630_ingestion_location_provenance.sql

3. **Migration order.** `20261012105630` must reach production before any
   later-versioned migration. The sync-key migrations
   (`20261013210000`, `20261014120000`, `20261015090000`) are later. If
   production already has any version later than `20261012105630`, the
   deploy-tree check refuses. Then STOP: do not use `--include-all`, do not
   retime or rename the file, and do not run `migration repair`. Resolve it
   through a separately reviewed amendment (for example a registered order
   exception, as in `docs/deployments/2026-09-25-migration-order-exception.md`)
   with its own authorization.
4. **B0/B1.** Ask the batch-spore-preview measurement owner whether the
   window is open (`supabase/batch-spore-preview-runbook.md`). The probe makes
   no public-RPC calls, but it adds `/* ilp_probe */` statements to
   `pg_stat_statements`. While a window is open, run it on production only
   with that owner's agreement, and record when it ran. Never reset
   statistics.
5. Present to the owner: migration `20261012105630`, target ref
   `zkpjklzfwzefhjluvhfw`, the SHAs, the client artifacts and section 3. The
   owner gives a fresh, specific authorization for the server step.

### 2.1 Server step

1. Verify the target independently right before use: the deploy checkout's
   `supabase/.temp/project-ref` reads `zkpjklzfwzefhjluvhfw`, and the dashboard
   shows the same project.
2. Pre-apply probe (read-only, aggregate-only), as the database owner:

       psql "<production connection string>" -X -v ON_ERROR_STOP=1 \
         -v since="<now UTC>" -v expect=absent \
         -f supabase/ingestion-location-provenance-probe.sql

   It must print `READY (absent, pre-apply)`. Record Part A.
3. Deploy only through the deploy tree, because
   `supabase/deploy-exceptions.json` lists the deferred `20260914090000`:

       node scripts/supabase-deploy-tree.mjs prepare --allow 20261012105630 --ref <merged main SHA>
       node <tree>/scripts/supabase-deploy-tree.mjs check --tree <tree>

   `check` must report that the dry run pushes exactly `20261012105630`.
   Anything else: STOP and report under `AGENTS.md`. Then, inside the tree:

       supabase db push --linked
       node <tree>/scripts/supabase-deploy-tree.mjs post-verify --tree <tree>

   Remove the deploy tree afterwards. `20260914090000` stays local-only.
4. Post-apply probe with `expect=applied` and `since` set to the apply time.
   It must print `READY (applied)`. Part B should show no new provenance yet,
   and Part C zero visibility and zero leaks. Record aggregates only.
5. API readiness on production, with the owner's own test account only:
   `p1 <id>` on one of that account's existing observations, with `API`,
   `ANON` and `TA` set for production (200; NULL/NULL for an old row). Also
   P6 as anonymous (400). No fixture is created on production. Skip P7 on production while a B0/B1 window is open.

The server step must be complete before any provenance-writing client is
published.

### 2.2 Client steps (each needs its own authorization)

1. Web: deploy the build of `<merged main SHA>`. First record the currently
   deployed web build, which is the rollback target.
2. Android: release through the GitHub Actions release builder as a staged
   rollout. First record the current production version code.
3. Desktop: not under this procedure (see the release dependency in
   section 0).

Earlier clients keep working: the fields are nullable, they write NULL, and
the server invalidates their actual coordinate changes. There is no R2
worker change and no aspect-ratio change.

### 2.3 Smoke checks after each activation

With the owner's test account on the activated client: save one new
observation per newly active path. For each saved observation `<id>` (from
the app's find detail), run `p1 <id>` and `p2 <id>` and check its values.
Also check one offline save followed by a reconnect (one row each, with no
duplicate), and P6 plus the community-view reads of P5 for `<id>`
(non-disclosure). Run the probe with `since` set to the activation time:
`duplicate_image_rows` = 0, and C as in 1.5. An unexplained mismatch holds
further activation and starts section 3. Passive observation after these
checks does not extend implementation acceptance.

## 3. Rollback and disable

- **Disable (first choice, non-destructive).** Stop the clients and leave
  the schema in place. Halt the Android staged rollout, and redeploy the
  recorded previous web build. Previous clients store NULL provenance and
  stay compatible. The rows already recorded remain and stay private.
- **Do not disable by revoking `EXECUTE` on `set_observation_location`.**
  Both clients fall back only when the function is missing (`PGRST202`, or
  "could not find the function"). A permission error fails web manual-location
  saves and desktop attributed edits.
- **Do not drop the invalidation trigger on its own.** With the CHECK still in
  place, legacy coordinate changes would then keep stale attribution. A
  legacy clear of an `acquired` row would fail the CHECK and block that
  client's write.
- **Schema removal** drops the RPC, trigger, trigger function, both CHECKs and
  the three columns, which deletes the recorded provenance. It needs a new,
  reviewed compensating migration with its own authorization, applied through
  the deploy tree. No such migration is prepared here. Before relying on it,
  verify the client fallbacks on a disposable target. The web retries the
  INSERT without the pair and the image reservation without `ingest_method`
  when the column is missing, and uses a plain update when the RPC is
  missing. The desktop re-reads without the provenance columns and treats a
  missing RPC as unsupported; its first-upload INSERT behaviour without the
  columns is unverified.

## 4. Out of scope

- Historical provenance (including the 1447/1457 uploads) cannot be
  reconstructed.
- No admin UI, analytics, device identifiers or full EXIF retention.
- No statistics reset, load test or landing switch.
