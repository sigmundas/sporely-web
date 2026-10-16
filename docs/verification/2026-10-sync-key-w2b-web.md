# Stage 8b — disposable verification of web sync keys (W3)

Date: 2026-10-16. Plan: `docs/plans/active/2026-10-14-sync-key-identity.md`,
Stage 8b. Verifies accepted Stage 8 (`46c9297`) on the disposable target only.
No production access, deployment or merge.

## Result (second pass): all three items pass on web `a6abde7`

These runs are the evidence for Stage 8b. Every result below comes from the
`w2b-r2-*` runs; the first pass further down is history only.

**Defect and correction.** Supabase's Postgres runs with
`extra_float_digits = 0` (`w2b/float-columns.txt`), so PostgREST prints
`double precision` with 15 and `real` with 6 significant digits.

- At Stage 8 (`46c9297`), an EXIF latitude of `62.34566944444445` read back
  as `62.3456694444444`. A lost-response retry then refused its own row as
  "different content" (run `w2b-1b-lost-obs`).
- `307ef7f` rounded every number, which was too broad.
- `a6abde7` rounds only the listed `real` and `double precision` columns; those
  lists match the live schema. Every other number, including `numeric` and
  `bigint`, is compared exactly. Regression tests cover both directions.

**Tested commit.** Web code `a6abde7`. The served HEAD is `b174fba`, which
changes only this document; the second-pass runs ran with it, before this
summary was updated. `g4-evidence/w2b/served-tree-check.mjs` (sha256
`c90f4d56…`) ran right after every web run and wrote `provenance-after.json`
into that run's directory. Each one shows:

- a clean tree;
- served-source hashes for `sync-key.js`, `sync-queue.js` and `images.js`,
  fetched both from Node and from inside the app page, equal to the worktree
  files;
- the comparator the page resolves behaving as `a6abde7`. Its probe flags the
  bigint case and accepts the EXIF float case, which tells it apart from both
  earlier commits.

The desktop is `3850b3f` in every desktop run's `manifest.json` (clean tree,
outbound traffic blocked).

**Evidence per run.** `db-audit.txt` lists every audited database write after
the run's start mark, with the columns it changed. `db-final.txt` holds row
counts where they matter. Running notes: `g4-evidence/w2b/notes.md`.

### Item 1 — web create and edit (matrix row 16)

| Case | Run | Evidence |
| --- | --- | --- |
| Plain create | `w2b-r2-1a-create` | Observation 357 and image 346 carry the keys from their insert bodies; `desktop_id` is NULL. Writes: the two INSERTs, the trigger's `updated_at` touch, and the conditional cover fill. |
| Lost observation-insert response, original fixture `g4_geo_r4.jpg` | `w2b-r2-1b-lost-obs` | Both POSTs sent `gps_latitude 62.34566944444445`. The first response was dropped (connection reset); the retry got 409 and adopted row 358 with no PATCH. Then image 201 and the conditional cover fill. `db-final.txt`: one observation for the key, stored exactly as `62.34566944444445`, and one image. |
| Lost image-insert response | `w2b-r2-1c-lost-img` | Dropped response, then 409, then adopted. One image row (348) for its key and no UPDATE on it. |
| Lost observation response, then page reload | `w2b-r2-1d-reload-obs` | Key `9096aa5e…` was sent before and after the reload; 409, then adopted 361. One row. |
| Lost image response, then page reload | `w2b-r2-1d-reload-img` | Key `662aff91…` was sent before and after the reload; 409, then adopted image 351. One image. |
| Web edit of keyed row 357 | `w2b-r2-1e-edit` | Only 357 changed (location fields). `sync_key` is the same in the old and new rows. |

The harness records a 409's status but not its body. That the 409 was a
`23505` on the named key index is inferred from the app adopting, which unit
tests show it does only for that index.

### Item 2 — coexistence with desktop `3850b3f` (profile `w2b-D`, already pulled)

**Direction A: web creates, desktop edits, web reads.**
- `w2b-r2-2a-web-create`: web created observation 366 and image 357.
- `w2b-r2-2a-desktop-pull`: the desktop linked both with the web's keys (local 201) and wrote nothing to the database.
- `w2b-r2-2a-desktop-edit`: the desktop wrote only to 366 and its image 357. Keys were unchanged and `desktop_id` stayed NULL.
- `w2b-r2-2a-web-read`: the web shows the desktop's `open_comment`.

**Direction B: desktop creates, web edits, desktop pulls.**
- `w2b-r2-2b-desktop-create`: the desktop created observation 367 and image 358 with its own keys; `desktop_id` is NULL.
- `w2b-r2-2b-web-edit`: only 367 changed, and its key was unchanged.
- `w2b-r2-2b-desktop-pull`: the desktop wrote no rows. Its local 367 holds the web's manual location.

**Final state (`db-final.txt`).**
- One row per key.
- No keyed observation or image has a `desktop_id`.
- No duplicate keys.
- The owner has 202 observations and 205 images.

**Desktop finding, outside this stage.** The desktop edit again set web-written
image metadata on image 357 to NULL (`source_*`, `stored_*`, `stored_bytes`,
`upload_mode`). It filled desktop defaults (`crop_mode`, `measure_color`,
`objective_name`, `original_filename`) and set the image's `captured_at`. On
observation 366 it changed `habitat_host_genus` and `habitat_host_species` from
NULL to `""`. This stays within the same rows, so it is not an identity
violation, but it is a sporely-py follow-up.

### Item 3 — conditional cover against real PostgREST

| Case | Run | Evidence |
| --- | --- | --- |
| Both keys NULL → fill | r2 runs 1a, 1b, 1c, 1d and 2a | `PATCH ?id=eq.N&image_key=is.null&thumb_key=is.null` caused an audited UPDATE of `image_key,thumb_key` only. |
| Partial cover already present | `w2b-r2-3b-partial-cover` | An owner session (role `authenticated` with the owner's JWT claims) set only `image_key` on 364 inside the retry window (`w2b/r2-3b-partial-cover-writer.txt`). The app's two conditional PATCHes both returned 204, and the audit has no later write. 364 keeps the partial cover. |
| Cover written concurrently | `w2b-r2-3c-concurrent-cover` | The owner session wrote a different full cover on 365 and held the transaction. `pg_stat_activity` showed PostgREST's cover UPDATE blocked by that session (`w2b/r2-3c-concurrent-cover-writer.txt`). After the commit, the PATCH returned 204 with no write. 365 keeps the concurrent cover. |

### Unit checks on `a6abde7`

- Focused `node --test` on Stage 8's six files: 129 tests, 128 pass. The one failure is the baseline assertion `enqueueObservation is IndexedDB-only`.
- `git diff --check` is clean.

### Still in the environment

Blocked queue item 3 (row 345, from the failed run at `46c9297`) stays in
IndexedDB. Blocked items are never retried, and it caused no writes in any run.

## Result (first pass, superseded)

All three items passed on web `307ef7f`, after one correction to Stage 8.

**Defect found and fixed (`307ef7f`).** On this stack, a lost observation-insert
response made the retry adopt its own row and then refuse it as "different
content" (run `w2b-1b-lost-obs`, tested at `46c9297`). Supabase's
`postgresql.conf` sets `extra_float_digits = 0`, so PostgREST returns
`double precision` values with 15 significant digits and `real` values with 6.
The payload sent `gps_latitude 62.34566944444445`, and the row read back as
`62.3456694444444`, although the stored value was exact. The same thing happens
to any coordinate taken from photo EXIF. The item was blocked
(`sync_identity_conflict`) and nothing in the cloud changed. `syncRowDifferences`
now treats two numbers as equal when they print the same at the server's output
precision. Any difference the server can show still counts as a difference. A
regression test uses the observed values.

## Environment

- Disposable stack `sporely-g3-verify` (API `127.0.0.1:55421`). The brake
  (`private.sync_brake_guard`), the write stop (block table empty) and the three
  `*_user_sync_key_uidx` indexes are present.
- Guarded stub media worker on `:55425`.
- Sandboxed Vite on `https://127.0.0.1:55430`.
- Headless Chromium with CDP on `:55431`.
- Account `owner@g3.test`.
- Harness `g4-evidence/tools/g4_web.mjs`: `create_obs` with `lose`/`reload_after_fault`, plus `set_location` and `read_obs`.
- Desktop: `run.sh` with lineage worktree `py-n1`. Every desktop run's `manifest.json` records head `3850b3f9be13f29455bbc593d5fb49ab38244e29` with no tracked modifications, and outbound traffic blocked.
- Evidence of database state comes from the `g4_audit.log` row triggers. Each run has a `db-audit.txt` listing every audited write after the run's starting mark, with the changed columns. Where useful there is also a `db-final.txt`.
- Raw results are in `g4-evidence/runs/w2b-*`. Owner-write helpers are in `g4-evidence/w2b/`.

**Which commit a run tested.** `g4_web.mjs` does not record the web HEAD.

- Runs that started before 07:57:48 UTC tested `46c9297`.
- Every later run tested `307ef7f`, a clean tree with nothing changed after the commit.
- The served tree was not hash-checked. Running `w2b/served-tree-check.mjs` needed approval that this session could not get.
- Instead, it was established by proxy:
  - `web-identity` is the only web checkout on `feature/sync-key-identity-web`;
  - every insert body the served app sent carries a `sync_key`;
  - the comparator change took effect on the served app between `w2b-1b-lost-obs` and `w2b-1b-lost-obs-2`.

## Item 1 — web create and edit with keys, retries and adoption (matrix row 16)

| Case | Run | Commit | Evidence |
| --- | --- | --- | --- |
| Plain create | `w2b-1a-create-2` | `46c9297` | Observation 344 and image 333 carry the keys from their insert bodies, and `desktop_id` is NULL. Writes: INSERT obs, INSERT img, the trigger touching `updated_at`, and the conditional cover fill (`image_key,thumb_key`). The fix cannot affect this run: the comparator is not called on a fresh insert. |
| Lost obs-insert response | `w2b-1b-lost-obs` | `46c9297` | **Failed (the defect above).** 201 lost, the retry got 409, and the item was blocked. One row (345), with no further writes. |
| Lost obs-insert response | `w2b-1b-lost-obs-2` | `307ef7f` | 201 lost, the retry got 409 on the key index, and the row was adopted with no PATCH. Then image 201 and the conditional cover fill. `db-final.txt`: one observation (347) for its key and one image (334). |
| Lost image-insert response | `w2b-1c-lost-img` | `307ef7f` | Image 201 lost, the retry got 409, and the image was adopted. One image row (335) for its key, and no UPDATE on the image. |
| Lost obs response, then page reload | `w2b-1d-reload-obs` | `307ef7f` | The insert body before the reload and the retry after it carry the same key `00c77a7e…`. 409, then adopted. One row (350). |
| Lost image response, then page reload | `w2b-1d-reload-img` | `307ef7f` | The same image key `3875d7ee…` before and after the reload. 409, then adopted. One image (338). |
| Web edit of a keyed observation | `w2b-1e-edit` | `307ef7f` | Location picker on 344. Only row 344 changed (`gps_*`, `location_*`), and `sync_key` was identical in the old and new rows. The other two audit rows are the app's start-up activity bookkeeping. |

## Item 2 — coexistence with desktop `3850b3f` (fresh profile `w2b-D`)

**Preparation.** The profile was brought to a quiescent state first:
`w2b-2-desktop-initial-sync` through `-4`, `w2b-2a-desktop-pull` and `w2b-2-desktop-settle-1`.

During those pulls the desktop made writes unrelated to the web case:
- it re-sent identical `deleted_at` values on already-tombstoned images;
- it recomputed `spore_statistics` and spore mosaics for measured observations 294–313;
- it replaced `observation_spore_summaries` rows.

Those runs record these writes. They involve no identity column and none of the rows below. `w2b-2-desktop-settle-1` wrote no observation or image rows.

**Direction A: web creates, desktop edits, web reads.**
- `w2b-2a-web-create`: web created observation 355 with key `d268fbb6…` and image 344 with key `0ef450fb…`.
- The desktop pulled both and stored the web's keys locally (local 192 and 185 in `w2b-2-desktop-settle-1/local-after.json`). It wrote nothing to them.
- `w2b-2a-desktop-edit`: the desktop wrote only to observation 355 and its image 344. Keys were unchanged, `desktop_id` stayed NULL, and no other row was written.
- `w2b-2a-web-read`: the web detail page for 355 shows the desktop's `open_comment`.

**Direction B: desktop creates, web edits, desktop pulls.**
- `w2b-2b-desktop-create`: the desktop created observation 356 with key `3b8e4cc6…` and image 345 with key `ae204600…`. `desktop_id` is NULL.
- `w2b-2b-web-edit`: the web location edit changed only row 356, and its key was unchanged.
- `w2b-2b-desktop-pull`: the desktop sync wrote no observation or image rows. Its local row 193 now has the web's manual location (`snapshots/w2b-2-final.json`).

**Final state (`w2b-2b-desktop-pull/db-final.txt`).**
- Each key has exactly one row.
- Each observation has one image.
- The owner has 193 observations and 196 images, which is the earlier count plus 2 and plus 2: no duplicates.
- No keyed row has a `desktop_id`.

**Desktop finding, outside this stage.** The edit PATCH in `w2b-2a-desktop-edit` changed web-written image metadata on image 344 (`db-field-changes.txt`):
- `source_*`, `stored_*`, `stored_bytes` and `upload_mode` were set to NULL;
- `crop_mode`, `measure_color`, `objective_name` and `original_filename` were set to desktop defaults;
- on observation 355, `habitat_host_genus` and `habitat_host_species` went from NULL to `""`.

This is the same row, so it is not an identity or ownership violation. It is field loss in sporely-py, which this stage does not edit, and it needs its own tracking.

## Item 3 — conditional cover updates against real PostgREST

| Case | Run | Commit | Evidence |
| --- | --- | --- | --- |
| Both keys NULL → fill | 1a, 1b-2, 1c, 1d, 2a | both | In each run, `PATCH ?id=eq.N&image_key=is.null&thumb_key=is.null` caused an audited UPDATE of `image_key,thumb_key` only. |
| Partial cover already present | `w2b-3b-partial-cover` | `307ef7f` | In the retry window, an owner session (role `authenticated` with the owner's JWT claims; `w2b/3b-partial-cover-writer.txt`) set only `image_key` on 353. The app's conditional PATCH ran twice and both returned 204, but the audit has no later write. The row keeps `image_key` set and `thumb_key` NULL. |
| Cover written concurrently | `w2b-3c-concurrent-cover` | `307ef7f` | The owner session wrote a different full cover on 354 and held the row lock. The app read NULL and sent its PATCH. `pg_stat_activity` shows that PostgREST UPDATE waiting on the owner session (`w2b/3c-concurrent-cover-writer.txt`); the owner then committed. PostgREST re-checked `image_key IS NULL`, matched nothing and returned 204, and the audit has no app write. The concurrent cover stays. |

The owner writes in item 3 used psql, not PostgREST, so the brake and the write-stop header checks did not apply to them. That is expected for a stand-in for the owner's other client.

## Unit tests and checks on `307ef7f`

- Focused `node --test` on Stage 8's files (`connectivity-loss`, `ingest-method-provenance`, `sync-key-adoption`, `sync-key`, `sync-queue-recovery`, `sync-queue`): 128 tests, 127 pass. The one failure is the baseline assertion `enqueueObservation is IndexedDB-only` already recorded for Stage 8.
- `images.test.js` together with the sync files: 122 of 122 pass.
- `git diff --check` is clean.

## Left in the environment

The browser's IndexedDB still holds blocked queue item 3 from the failed run at `46c9297` (row 345). Blocked items are never retried automatically, and it caused no writes during later runs.
