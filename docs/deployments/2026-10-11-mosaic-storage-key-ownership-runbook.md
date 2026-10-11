# Runbook — spore-mosaic storage-key ownership (production)

Plan: `docs/plans/active/2026-10-11-mosaic-storage-key-ownership.md` (Stage 2).
Migration: `supabase/migrations/20261011100000_enforce_mosaic_storage_key_ownership.sql`.

**Human-executed only.** A person with explicit owner authorization performs
every step below and records the evidence. No agent runs any of it, connects to
production, or sees its output beyond the aggregate counts this runbook marks
as recordable. Nothing here is deployed automatically.

Status: **executed 2026-10-11.** The owner applied `20261011100000` to
production. See "Production deployment — 2026-10-11" at the end of this file.

## What changes in production

- `spore_measurement_mosaics.id` becomes `GENERATED ALWAYS`. The identity
  sequence is advanced to `GREATEST(max(id), last_value)`.
- Three new triggers on `spore_measurement_mosaics`:
  `trg_00_media_guard_server_owned_mosaic`,
  `trg_01_media_guard_key_ownership_mosaic` (BEFORE INSERT/UPDATE) and
  `trg_zz_media_final_state_guard_mosaic` (AFTER INSERT/UPDATE).
- `media_authorize_mosaic_delivery(bigint, uuid)` is replaced with the same
  signature. It adds the deny reason `invalid_storage_namespace`, which is
  checked before the owner branch.
- The migration changes no rows. No Worker deploy is needed: the Worker
  already returns 404 for every denied decision.

## Data-handling rules for whoever runs this

- Production holds personal data. Only **aggregate integers** from steps 2, 3.4
  and 5 may be recorded in this repository or shared with an agent.
- Row-level output (ids, user ids, observation ids, keys, timestamps) belongs
  only in the step 3.1 forensic snapshot, stored under the owner's incident
  procedure. Never paste it into an agent session, a commit, an issue or a
  chat.
- Never put the service-role key or a database password in a prompt or a
  commit.

## 0. Gate before starting

All of the following must be true. Otherwise stop.

- The Stage 1 candidate is accepted, including the `sporely-security-reviewer`
  verdict on its exact SHA.
- The probe's `url_or_leading_slash` question is settled (step 2). Rows in that
  form would be denied once the migration is applied.
- The branch is merged to `main`, and `<merged main SHA>` is pushed. The
  migration file at that SHA is byte-identical to the reviewed candidate:

      git fetch origin
      git merge-base --is-ancestor <merged main SHA> origin/main
      git diff --exit-code <accepted candidate SHA> <merged main SHA> -- \
        supabase/migrations/20261011100000_enforce_mosaic_storage_key_ownership.sql

  Both commands must exit 0. The first proves `<merged main SHA>` is on
  `origin/main`; the second proves the migration file is unchanged.

- No other migration is pending. In particular the paused batch migration
  `20261011120000` is neither on `main` nor applied remotely.
- The owner has explicitly authorized this production deployment in the
  current session.

## 1. Pre-checks (read-only)

From an ordinary checkout of `<merged main SHA>` that is linked to production
(`supabase/.temp/project-ref` must read `zkpjklzfwzefhjluvhfw`):

    supabase migration list

Expected:

- Every version matches between Local and Remote, with two exceptions:
  - `20260914090000` is local-only. This is the documented deferred migration
    (`supabase/deploy-exceptions.json`,
    `docs/deployments/2026-09-25-migration-order-exception.md`). It is not a
    mismatch, and must not be repaired.
  - `20261011100000` is local-only. This is the migration being deployed.
- The latest Remote version is ≤ `20261007123912`.

STOP and report if anything else differs, or if Remote has a version later than
`20261007123912`. Report the mismatched versions, their filenames, `git status`
and the tail of the list. Do not run `supabase migration repair`, do not rename
files, and do not use `--include-all`. A plain `supabase db push` refuses here
because of the deferred migration; that refusal is expected and must not be
worked around.

## 2. Probe (read-only, aggregate-only)

Run this **before** applying the migration, in the SQL editor or `psql` as the
database owner. It returns integers only.

### 2a. Pre-flight probe (verbatim from the plan)

    BEGIN TRANSACTION READ ONLY;
    SELECT
      count(*)                                                        AS total,
      count(*) FILTER (WHERE coalesce(m.storage_key,'') = '')         AS empty_key,
      count(*) FILTER (WHERE starts_with(m.storage_key, m.user_id::text||'/')) AS owner_prefixed,
      count(*) FILTER (WHERE NOT starts_with(coalesce(m.storage_key,''), m.user_id::text||'/')) AS not_owner_prefixed,
      count(*) FILTER (WHERE NOT starts_with(coalesce(m.storage_key,''), m.user_id::text||'/')
                       AND m.storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/') AS foreign_uuid_prefixed,
      count(*) FILTER (WHERE m.storage_key ~* '^(https?://|/)')       AS url_or_leading_slash,
      count(*) FILTER (WHERE m.storage_key ~ '(^|/)\.{1,2}(/|$)' OR m.storage_key ~ '//' OR strpos(m.storage_key, chr(92)) > 0) AS bad_segments,
      count(*) FILTER (WHERE m.user_id IS DISTINCT FROM o.user_id)   AS owner_mismatch,
      count(*) FILTER (WHERE m.id <= 0)                               AS nonpositive_id,
      count(*) FILTER (WHERE m.canonical_bucket = 'private')         AS private_bucket,
      count(*) FILTER (WHERE m.media_version > 1)                    AS version_gt_1,
      count(DISTINCT m.user_id) FILTER (WHERE NOT starts_with(coalesce(m.storage_key,''), m.user_id::text||'/')) AS owners_with_bad_keys,
      (SELECT count(*) FROM (SELECT storage_key FROM public.spore_measurement_mosaics
                             GROUP BY storage_key HAVING count(DISTINCT user_id) > 1) d) AS keys_shared_across_users,
      (SELECT max(id) FROM public.spore_measurement_mosaics)         AS max_id,
      (SELECT last_value FROM public.spore_measurement_mosaics_id_seq) AS seq_last_value
    FROM public.spore_measurement_mosaics m
    JOIN public.observations o ON o.id = m.observation_id;
    ROLLBACK;

### 2b. Neutralization target count (read-only, aggregate-only)

The 2a columns overlap: `not_owner_prefixed` includes empty keys, and
`bad_segments` counts both prefixed and unprefixed rows. Step 3.4 therefore
asserts against this exact count instead. Its predicate is **identical** to the
`invalid_storage_namespace` check in the new `media_authorize_mosaic_delivery`,
applied to every non-empty key.

    BEGIN TRANSACTION READ ONLY;
    WITH target AS (
      SELECT m.id
      FROM public.spore_measurement_mosaics m
      WHERE coalesce(m.storage_key, '') <> ''
        AND (   NOT starts_with(m.storage_key, m.user_id::text || '/')
             OR m.storage_key ~ '(^|/)\.{1,2}(/|$)'
             OR strpos(m.storage_key, '//') > 0
             OR right(m.storage_key, 1) = '/'
             OR strpos(m.storage_key, chr(92)) > 0
             OR m.storage_key ~ '[\x01-\x1f]')
    )
    SELECT
      (SELECT count(*) FROM target)                                   AS namespace_invalid_mosaics,
      (SELECT count(*) FROM public.spore_measurement_mosaic_tiles t
        WHERE t.mosaic_id IN (SELECT id FROM target))                 AS namespace_invalid_tiles,
      (SELECT count(DISTINCT observation_id) FROM public.spore_measurement_mosaics
        WHERE id IN (SELECT id FROM target))                          AS affected_observations;
    ROLLBACK;

Sanity check: `namespace_invalid_mosaics ≥ not_owner_prefixed − empty_key`.
If not, stop and investigate. It is normally also
`≤ not_owner_prefixed − empty_key + bad_segments`. It can exceed that bound only
through owner-prefixed keys that end in `/` or contain control characters,
which 2a does not count. Note it if so.

### Record

Record every 2a and 2b integer with a UTC timestamp. No other output.

### Earlier pre-flight result (2026-10-11, before this runbook)

The owner ran the 2a probe read-only on 2026-10-11, before Stage 1 was
accepted. It returned these aggregate counts:

| Column | Value |
|---|---|
| `total` | 391 |
| `empty_key` | 0 |
| `owner_prefixed` | 391 |
| `not_owner_prefixed` | 0 |
| `foreign_uuid_prefixed` | 0 |
| `url_or_leading_slash` | 0 |
| `bad_segments` | 0 |
| `owner_mismatch` | 0 |
| `nonpositive_id` | 0 |
| `private_bucket` | 0 |
| `version_gt_1` | 44 |
| `owners_with_bad_keys` | 0 |
| `keys_shared_across_users` | 0 |
| `max_id` | 393 |
| `seq_last_value` | 393 |

The owner's assessment, verbatim:

> The read-only inspection of 391 existing mosaic rows found no ownership
> mismatches, foreign storage namespaces, malformed keys, shared cross-user
> keys, or suspicious identity values.
>
> No existing rows require remediation under the proposed security migration.
> The results do not trigger the planned forensic-snapshot or
> row-neutralization procedure.
>
> **Historical exposure cannot be ruled out.** The inspection covers current
> database state only. A previously inserted and subsequently deleted
> malicious row would not be detected. No evidence of such activity has been
> identified by this inspection.
>
> The security fix should proceed regardless. This assessment does not resolve
> the separate legacy public-media-domain exposure.

The earlier run covered 2a only. It did not include 2b, so it does not
establish that there are no namespace-invalid rows. For example, an
owner-prefixed key ending in `/` or containing a control character is counted
only by 2b. The quoted statements about malformed keys and remediation refer to
the 2a columns.

This earlier result does not replace step 2. Re-run 2a and 2b immediately
before applying. Rows can change between the two runs, and the incident branch
(step 3) applies whenever the re-run shows possible exploitation.

### How to read it

| Signal | Meaning | Action |
| --- | --- | --- |
| 2b `namespace_invalid_mosaics > 0`, `not_owner_prefixed − empty_key > 0`, `bad_segments > 0`, `nonpositive_id > 0`, or `max_id > seq_last_value` | **Possible exploitation** | Step 3 (incident branch), then apply |
| `url_or_leading_slash > 0` | Legitimate rows in a non-canonical form would be denied, and step 3.4 would delete them | STOP. The owner decides on normalization before proceeding |
| `private_bucket > 0` | Suspicious while production runs `MEDIA_STORAGE_MODE=legacy` | Include in the step 3 snapshot; the owner decides |
| `empty_key > 0` | Counted inside `not_owner_prefixed`. Denied as `no_key` both before and after; not foreign, and not deleted by step 3.4 | Snapshot in 3.1; the owner decides |
| `keys_shared_across_users > 0` | A key used by more than one owner; at most one can be in-namespace | Treat as possible exploitation |
| All of the above are 0, **including** 2b `namespace_invalid_mosaics` | No existing malformed rows | Skip step 3; go to step 4 |

If a STOP row and the step 3 row both apply, STOP wins: do not enter step 3
or delete anything until the owner has decided (see also the step 0 gate).

2b is decisive on its own. A positive `namespace_invalid_mosaics` enters step 3
even when every 2a signal is 0: an owner-prefixed key that ends in `/` or
contains a control character is counted by 2b but by no 2a column. Never
declare "no malformed rows" unless 2b `namespace_invalid_mosaics` is 0.

`version_gt_1` is normal: replacement uploads and visibility changes bump it.

## 3. Incident branch (only if step 2 shows possible exploitation, or 2b is above 0)

### 3.1 Forensic snapshot (before applying, person only)

A person exports the offending rows to private storage under the data
controller's incident procedure. Run it read-only. **Its output must never enter an agent
context, this repository, or a chat.**

Run it with `psql`, and send the output straight to a private file with
`\o <private file>` before the query (and `\o` afterwards). Do not use the
dashboard SQL editor or terminal scrollback, and do not run it in a terminal an
agent can read.

    BEGIN TRANSACTION READ ONLY;
    SELECT m.id, m.observation_id, m.user_id, o.user_id AS observation_owner,
           m.storage_key, m.canonical_bucket, m.media_version, m.version,
           m.created_at, m.updated_at,
           (SELECT count(*) FROM public.spore_measurement_mosaic_tiles t
             WHERE t.mosaic_id = m.id) AS tile_count
    FROM public.spore_measurement_mosaics m
    JOIN public.observations o ON o.id = m.observation_id
    WHERE (   NOT starts_with(coalesce(m.storage_key, ''), m.user_id::text || '/')
           OR m.storage_key ~ '(^|/)\.{1,2}(/|$)'
           OR strpos(m.storage_key, '//') > 0
           OR right(m.storage_key, 1) = '/'
           OR strpos(m.storage_key, chr(92)) > 0
           OR m.storage_key ~ '[\x01-\x1f]'
           OR m.id <= 0
           OR m.canonical_bucket = 'private'
           OR m.user_id IS DISTINCT FROM o.user_id
           OR m.storage_key IN (SELECT storage_key FROM public.spore_measurement_mosaics
                                GROUP BY storage_key HAVING count(DISTINCT user_id) > 1))
    ORDER BY m.id;
    ROLLBACK;

The snapshot is wider than the neutralization target. It also captures
empty keys, non-positive ids, private-bucket rows, owner mismatches and shared
keys, which
step 3.4 does not delete. The owner decides about those separately.

### 3.2 Breach assessment (owner decision)

A namespace-invalid row lets its author fetch another user's R2 object, which
may contain personal data. The owner decides whether to make a personal-data
breach assessment under the data controller's GDPR personal-data breach
procedure, and records only that the decision was made, not its contents. This runbook does not decide it.

Already-disclosed keys stay readable through the legacy `media.sporely.no`
domain until the Stage 2c cutover (plan, Follow-ups). Neutralization does not
change that. The Worker's `/mm/` route answers `Cache-Control: no-store`, so no
edge cache needs purging for it.

### 3.3 Apply the migration

Do step 4 now. Applying before neutralizing is deliberate:

- the read-time check denies the rows at the Worker as soon as it commits;
- the write guards stop new malformed rows from appearing while step 3.4 runs.

Run step 3.4 promptly afterwards. Until it runs,
`get_public_observation`'s legacy `sporeMosaic.url` still shows
`https://media.sporely.no/<foreign key>` for these rows. That RPC is outside
this plan's scope.

### 3.4 Neutralization (after step 4, owner-approved, single transaction)

1. Re-run step 2b. Expect `namespace_invalid_mosaics` to equal the step 2b
   value. If it is **higher**, rows were added between the probe and the apply:
   the person extends the 3.1 snapshot before continuing. If it is **lower**,
   stop and investigate.
2. Put that number and the matching `namespace_invalid_tiles` into the two
   constants below, then run the whole block in one `psql` session as the
   database owner. Any mismatch raises an exception, and the transaction then
   cannot commit.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Block concurrent writes to BOTH tables for the duration, so the counts
-- taken below equal what is actually deleted; reads continue. The tile lock
-- matters: a tile INSERT/UPDATE/DELETE takes only a compatible lock on the
-- mosaic table, so the mosaic lock alone would not stop it. If either LOCK
-- times out (or a concurrent sync deadlocks against it), the transaction
-- aborts with nothing changed; re-run it.
LOCK TABLE public.spore_measurement_mosaics, public.spore_measurement_mosaic_tiles
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _mosaic_neutralization_result (
  deleted_mosaics bigint, deleted_tiles bigint, remaining_invalid bigint
) ON COMMIT DROP;

DO $$
DECLARE
  expected_mosaics constant bigint := NULL;  -- <- step 3.4.1 namespace_invalid_mosaics
  expected_tiles   constant bigint := NULL;  -- <- step 3.4.1 namespace_invalid_tiles
  target_ids bigint[];
  tiles_before bigint;
  tiles_after bigint;
  deleted bigint;
  remaining bigint;
BEGIN
  IF expected_mosaics IS NULL OR expected_tiles IS NULL THEN
    RAISE EXCEPTION 'fill in expected_mosaics and expected_tiles first';
  END IF;

  SELECT coalesce(array_agg(m.id), '{}') INTO target_ids
  FROM public.spore_measurement_mosaics m
  WHERE coalesce(m.storage_key, '') <> ''
    AND (   NOT starts_with(m.storage_key, m.user_id::text || '/')
         OR m.storage_key ~ '(^|/)\.{1,2}(/|$)'
         OR strpos(m.storage_key, '//') > 0
         OR right(m.storage_key, 1) = '/'
         OR strpos(m.storage_key, chr(92)) > 0
         OR m.storage_key ~ '[\x01-\x1f]');

  IF cardinality(target_ids) <> expected_mosaics THEN
    RAISE EXCEPTION 'target mosaics % <> expected %', cardinality(target_ids), expected_mosaics;
  END IF;

  SELECT count(*) INTO tiles_before
  FROM public.spore_measurement_mosaic_tiles WHERE mosaic_id = ANY (target_ids);
  IF tiles_before <> expected_tiles THEN
    RAISE EXCEPTION 'target tiles % <> expected %', tiles_before, expected_tiles;
  END IF;

  -- Tiles go with their mosaic (ON DELETE CASCADE). No R2 object is touched.
  DELETE FROM public.spore_measurement_mosaics WHERE id = ANY (target_ids);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted <> expected_mosaics THEN
    RAISE EXCEPTION 'deleted % <> expected %', deleted, expected_mosaics;
  END IF;

  SELECT count(*) INTO tiles_after
  FROM public.spore_measurement_mosaic_tiles WHERE mosaic_id = ANY (target_ids);
  IF tiles_after <> 0 THEN
    RAISE EXCEPTION '% tiles survived the cascade', tiles_after;
  END IF;

  SELECT count(*) INTO remaining
  FROM public.spore_measurement_mosaics m
  WHERE coalesce(m.storage_key, '') <> ''
    AND (   NOT starts_with(m.storage_key, m.user_id::text || '/')
         OR m.storage_key ~ '(^|/)\.{1,2}(/|$)'
         OR strpos(m.storage_key, '//') > 0
         OR right(m.storage_key, 1) = '/'
         OR strpos(m.storage_key, chr(92)) > 0
         OR m.storage_key ~ '[\x01-\x1f]');
  IF remaining <> 0 THEN
    RAISE EXCEPTION '% namespace-invalid rows remain', remaining;
  END IF;

  INSERT INTO _mosaic_neutralization_result VALUES (deleted, tiles_before, remaining);
END $$;

SELECT * FROM _mosaic_neutralization_result;   -- counts only; record these
COMMIT;
```

Run it from a file with `psql -v ON_ERROR_STOP=1 -f <file>`, so that `psql`
stops at the first error. If the `DO` block raises, `psql` reports the error and
the transaction is aborted. `psql` then exits and the aborted transaction is
discarded, so nothing is applied; investigate before any retry. (Without
`ON_ERROR_STOP`, the trailing `COMMIT` of an aborted transaction would also only
roll back.) Do not edit the predicate to make
the counts match.

**Do not delete the R2 objects** that these keys point at. They belong to the
users whose namespace they lie in and are legitimate. The deleted rows only
pointed at them.

Expected effects:

- The Worker's `/mm/<id>` returns 404 for the deleted ids. It already did once
  the migration was applied.
- On an affected observation, `get_public_observation` falls back to the
  previous mosaic version if one exists. Otherwise it returns no
  `sporeMosaic`, and the per-spore `cropUrl` fallback applies.
- `delete-account` for the author no longer snapshots a foreign key, so the
  Worker's DELETE prefix refusal stops blocking deletion of that account.

#### Alternative: keep the rows, made inert (owner's choice only)

If the owner prefers to keep the rows, run this transaction **instead of** the
one above. Fill in the constants from step 3.4.1 the same way, and run it with
`psql -v ON_ERROR_STOP=1 -f <file>`. It rewrites each target key to
`<user_id>/<observation_id>/neutralized_mosaic_<id>.webp`, an in-namespace key
that names no object, and asserts that every tile is kept.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Same reasoning as the delete transaction: lock both tables against writes.
LOCK TABLE public.spore_measurement_mosaics, public.spore_measurement_mosaic_tiles
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _mosaic_inert_result (
  rewritten_mosaics bigint, preserved_tiles bigint, remaining_invalid bigint
) ON COMMIT DROP;

DO $$
DECLARE
  expected_mosaics constant bigint := NULL;  -- <- step 3.4.1 namespace_invalid_mosaics
  expected_tiles   constant bigint := NULL;  -- <- step 3.4.1 namespace_invalid_tiles
  target_ids bigint[];
  tiles_before bigint;
  tiles_after bigint;
  rewritten bigint;
  not_inert bigint;
  remaining bigint;
BEGIN
  IF expected_mosaics IS NULL OR expected_tiles IS NULL THEN
    RAISE EXCEPTION 'fill in expected_mosaics and expected_tiles first';
  END IF;

  SELECT coalesce(array_agg(m.id), '{}') INTO target_ids
  FROM public.spore_measurement_mosaics m
  WHERE coalesce(m.storage_key, '') <> ''
    AND (   NOT starts_with(m.storage_key, m.user_id::text || '/')
         OR m.storage_key ~ '(^|/)\.{1,2}(/|$)'
         OR strpos(m.storage_key, '//') > 0
         OR right(m.storage_key, 1) = '/'
         OR strpos(m.storage_key, chr(92)) > 0
         OR m.storage_key ~ '[\x01-\x1f]');

  IF cardinality(target_ids) <> expected_mosaics THEN
    RAISE EXCEPTION 'target mosaics % <> expected %', cardinality(target_ids), expected_mosaics;
  END IF;

  SELECT count(*) INTO tiles_before
  FROM public.spore_measurement_mosaic_tiles WHERE mosaic_id = ANY (target_ids);
  IF tiles_before <> expected_tiles THEN
    RAISE EXCEPTION 'target tiles % <> expected %', tiles_before, expected_tiles;
  END IF;

  -- No R2 object is touched. trg_mosaic_media_version_bump adds +1.
  UPDATE public.spore_measurement_mosaics m
     SET storage_key = m.user_id::text || '/' || m.observation_id::text
                       || '/neutralized_mosaic_' || m.id::text || '.webp'
   WHERE m.id = ANY (target_ids);
  GET DIAGNOSTICS rewritten = ROW_COUNT;
  IF rewritten <> expected_mosaics THEN
    RAISE EXCEPTION 'rewritten % <> expected %', rewritten, expected_mosaics;
  END IF;

  SELECT count(*) INTO not_inert
  FROM public.spore_measurement_mosaics m
  WHERE m.id = ANY (target_ids)
    AND m.storage_key IS DISTINCT FROM
        m.user_id::text || '/' || m.observation_id::text
        || '/neutralized_mosaic_' || m.id::text || '.webp';
  IF not_inert <> 0 THEN
    RAISE EXCEPTION '% target rows do not carry the inert key', not_inert;
  END IF;

  SELECT count(*) INTO tiles_after
  FROM public.spore_measurement_mosaic_tiles WHERE mosaic_id = ANY (target_ids);
  IF tiles_after <> tiles_before THEN
    RAISE EXCEPTION 'tiles changed: % before, % after', tiles_before, tiles_after;
  END IF;

  SELECT count(*) INTO remaining
  FROM public.spore_measurement_mosaics m
  WHERE coalesce(m.storage_key, '') <> ''
    AND (   NOT starts_with(m.storage_key, m.user_id::text || '/')
         OR m.storage_key ~ '(^|/)\.{1,2}(/|$)'
         OR strpos(m.storage_key, '//') > 0
         OR right(m.storage_key, 1) = '/'
         OR strpos(m.storage_key, chr(92)) > 0
         OR m.storage_key ~ '[\x01-\x1f]');
  IF remaining <> 0 THEN
    RAISE EXCEPTION '% namespace-invalid rows remain', remaining;
  END IF;

  INSERT INTO _mosaic_inert_result VALUES (rewritten, tiles_after, remaining);
END $$;

SELECT * FROM _mosaic_inert_result;   -- counts only; record these
COMMIT;
```

As the database owner, `auth.uid()` is NULL and `current_user` is trusted, so
the guards allow it and `trg_mosaic_media_version_bump` adds +1 to
`media_version`. Trade-offs:

- **For:** the database keeps the rows (and their tiles) as evidence alongside
  the off-database snapshot.
- **Against:**
  - The key points at no object. The read-time check now **passes**, so the
    Worker reaches R2, misses and returns 404 rather than being denied
    cleanly.
  - The row is still the observation's latest mosaic, so
    `get_public_observation` advertises a dead
    `https://media.sporely.no/<owner>/…/neutralized_mosaic_….webp` URL. Any
    older legitimate version stays hidden behind it, and the landing site shows
    a broken atlas instead of falling back.
  - Tiles keep referencing an atlas that does not exist.
  - `delete-account` later asks the Worker to delete a missing object under
    the owner's own prefix. This is expected to be harmless, but it is not
    verified.
  - The owner can still overwrite it from sporely-py, which is benign but makes
    the forensic trail harder to follow.

Deleting is preferred. The inert alternative needs an explicit owner choice
recorded with the evidence.

## 4. Apply (deploy tree)

Only after steps 0–2 pass (and step 3.1, when applicable). The helper never
pushes; the person does.

    node scripts/supabase-deploy-tree.mjs prepare --allow 20261011100000 --ref <merged main SHA>

`prepare` creates a temporary worktree of that commit without the deferred
`20260914090000` file, copies the Supabase link, and refuses unless the link
points at `zkpjklzfwzefhjluvhfw`. It prints the tree path, then:

    node <deploy tree>/scripts/supabase-deploy-tree.mjs check --tree <deploy tree>

`check` runs the read-only `supabase migration list` and
`supabase db push --dry-run` in the tree. It refuses unless the pending set and
the dry run are exactly `20261011100000`. Do not continue unless it prints
`All checks passed`.

    cd <deploy tree>
    supabase db push --linked

Answer `y` only if the CLI prompt lists exactly
`20261011100000_enforce_mosaic_storage_key_ownership.sql`. The migration is one
`BEGIN … COMMIT`. If it fails, nothing is applied: stop and report the error.
Do not retry with other flags.

    node <deploy tree>/scripts/supabase-deploy-tree.mjs post-verify --tree <deploy tree>

`post-verify` confirms Remote matches the tree and the deferred migration is
still absent. Run step 5 (and step 3.4 when applicable), then remove the tree
with the exact command `post-verify` prints:

    git -C <main checkout> worktree remove --force <deploy tree>

Never use `--include-all`, `supabase migration up --linked` from an ordinary
checkout, `supabase migration repair`, or direct DDL in the SQL editor.

## 5. Verify (read-only)

Run these as the database owner, inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`.
Record only the results shown as expected.

    -- 5.1 identity is ALWAYS                                   expect: a
    SELECT attidentity FROM pg_attribute
     WHERE attrelid = 'public.spore_measurement_mosaics'::regclass
       AND attname = 'id';

    -- 5.2 sequence is past every claimed id                    expect: t
    SELECT (SELECT last_value FROM public.spore_measurement_mosaics_id_seq)
           >= coalesce((SELECT max(id) FROM public.spore_measurement_mosaics), 0);

    -- 5.3 the three guard triggers, enabled                    expect: 3 rows, tgenabled = O
    SELECT tgname, tgenabled FROM pg_trigger
     WHERE tgrelid = 'public.spore_measurement_mosaics'::regclass
       AND NOT tgisinternal
       AND tgname IN ('trg_00_media_guard_server_owned_mosaic',
                      'trg_01_media_guard_key_ownership_mosaic',
                      'trg_zz_media_final_state_guard_mosaic')
     ORDER BY tgname;

    -- 5.4 new read-time deny reason                            expect: t
    SELECT prosrc LIKE '%invalid_storage_namespace%' FROM pg_proc
     WHERE oid = 'public.media_authorize_mosaic_delivery(bigint, uuid)'::regprocedure;

    -- 5.5 privileges                                           expect: f f f f f f f f t
    SELECT
      has_function_privilege('authenticated', 'public.media_authorize_mosaic_delivery(bigint, uuid)', 'EXECUTE'),
      has_function_privilege('anon',          'public.media_authorize_mosaic_delivery(bigint, uuid)', 'EXECUTE'),
      has_function_privilege('authenticated', 'public._media_guard_server_owned_fields_mosaic()', 'EXECUTE'),
      has_function_privilege('anon',          'public._media_guard_server_owned_fields_mosaic()', 'EXECUTE'),
      has_function_privilege('authenticated', 'public._media_guard_key_ownership_mosaic()', 'EXECUTE'),
      has_function_privilege('anon',          'public._media_guard_key_ownership_mosaic()', 'EXECUTE'),
      has_function_privilege('authenticated', 'public._media_final_state_guard_mosaic()', 'EXECUTE'),
      has_function_privilege('anon',          'public._media_final_state_guard_mosaic()', 'EXECUTE'),
      has_function_privilege('service_role',  'public.media_authorize_mosaic_delivery(bigint, uuid)', 'EXECUTE');

    -- 5.6 no namespace-invalid row is ever allowed             expect: 0
    SELECT count(*) FILTER (WHERE a.allowed)
      FROM public.spore_measurement_mosaics m
      CROSS JOIN LATERAL public.media_authorize_mosaic_delivery(m.id, m.user_id) a
     WHERE NOT starts_with(coalesce(m.storage_key,''), m.user_id::text||'/');

5.6 calls the function as the row's own owner, the most permissive caller. It
must return 0 whether or not step 3.4 has run. After step 3.4 it also returns 0
because no namespace-invalid rows remain. Also re-run step 2b after 3.4: every
column must be 0.

### 5.7 End-to-end (person, test account)

With a **test account** and the current sporely-py release:

1. Sync an observation with a **new** spore mosaic. Expect the sync to succeed
   with no `42501` / `428C9` error. In the app (`app.sporely.no`) and on the
   landing site, the mosaic atlas displays.
2. Change the measurements so sporely-py uploads a **replacement** mosaic and
   sync again. Expect success and the new atlas to display in both places.
3. As the test account owner, change the observation's visibility once and
   back. Expect no error; the mosaic still displays.

If step 1 or 2 fails with a guard error, go to step 6. Do not loosen anything
in production by hand.

### Record

Append a dated "Production deployment" section to this file in a new commit.
Include: operator, UTC times, `<merged main SHA>`, the step 2a/2b integers,
the 3.4 result counts (or "not applicable"), the `check`/`post-verify` outcome,
the 5.1–5.6 results, and the 5.7 pass/fail. Include no identifiers or keys.

## 6. Rollback / compensation

- **Fix forward by default.** A wrong deny reason or an over-strict check gets
  a new, reviewed migration that corrects only that part.
- **If legitimate sync breaks** and cannot wait for a targeted fix, ship a
  **new compensating migration** (a version later than every remote version,
  deployed through this same step 4 deploy-tree path) that:
  - drops `trg_00_media_guard_server_owned_mosaic`,
    `trg_01_media_guard_key_ownership_mosaic` and
    `trg_zz_media_final_state_guard_mosaic`, and their three functions;
  - restores `media_authorize_mosaic_delivery` to the body in
    `20260804120000_media_authorization.sql:850-976`, with its REVOKE, GRANT
    and COMMENT;
  - sets `id` back to `GENERATED BY DEFAULT`.

  This **re-opens the flaw**, so it needs explicit owner approval and its own
  security review. Do the step 3.4 neutralization first: with the old function
  restored, any namespace-invalid row left in place is served again.
- Never use `supabase migration repair`, never edit or rename
  `20261011100000` or any other applied migration, and never run the reverse
  DDL directly in the SQL editor.

## Production deployment — 2026-10-11

Recorded by an agent from the owner's report, after the owner had finished the
deployment. The agent ran no production query or command. Every result below
was reported by the owner. The agent checked only the repository facts marked
"checked locally".

- **Operator:** the owner (manual, human-executed).
- **Target:** Supabase project `zkpjklzfwzefhjluvhfw`.
- **`<merged main SHA>`:** `0af1e32` (`0af1e32233c6bf80aa9f378fffbcd32c700f6ba0`).
  Accepted candidate: `4e58763`.
- **UTC times:** exact times for the probe, the push and the verification were
  **not captured**. Bounds from evidence:
  - Earliest: `2026-10-11T15:35:30Z`, the commit time of `0af1e32`, which the
    deploy tree was built from.
  - Latest: `2026-10-11T17:49:18Z`, when this record was written. The owner
    reported the deployment as complete at that point.

### Step 0 — gate

- Merge ancestry (`0af1e32` on `origin/main`): PASS.
- Migration integrity (`git diff --exit-code 4e58763 0af1e32 -- <migration>`):
  PASS. Also checked locally: the file is byte-identical between the two SHAs.

### Step 1 — pre-checks

`supabase migration list`: only `20260914090000` (documented deferred) and
`20261011100000` (this migration) were local-only. PASS.

### Step 2 — probe (aggregate only)

2a, run before applying:

| Column | Value |
|---|---|
| `total` | 391 |
| `empty_key` | 0 |
| `owner_prefixed` | 391 |
| `not_owner_prefixed` | 0 |
| `foreign_uuid_prefixed` | 0 |
| `url_or_leading_slash` | 0 |
| `bad_segments` | 0 |
| `owner_mismatch` | 0 |
| `nonpositive_id` | 0 |
| `private_bucket` | 0 |
| `version_gt_1` | 44 |
| `owners_with_bad_keys` | 0 |
| `keys_shared_across_users` | 0 |
| `max_id` | 393 |
| `seq_last_value` | 393 |

2b:

| Column | Value |
|---|---|
| `namespace_invalid_mosaics` | 0 |
| `namespace_invalid_tiles` | 0 |
| `affected_observations` | 0 |

Sanity check: `namespace_invalid_mosaics` (0) ≥ `not_owner_prefixed − empty_key`
(0). Holds. Every "How to read it" signal is 0, including 2b, and
`max_id` = `seq_last_value`. Outcome: no existing malformed rows. Step 3 skipped.

### Step 3 — incident branch

Not applicable. No forensic snapshot was taken. 3.4 neutralization was not run:
no rows were deleted or made inert.

The limit stated under "Earlier pre-flight result" still applies. The probe
covers current database state only and cannot rule out historical exposure
through rows that were later deleted.

### Step 4 — apply

- `prepare` / `check` (deploy-tree dry run): PASS. The pending set was exactly
  `20261011100000`.
- `supabase db push --linked` in the deploy tree: applied
  `20261011100000_enforce_mosaic_storage_key_ownership.sql` with no errors.
- `post-verify`: "Remote matches the deploy tree exactly; deferred migrations
  are still absent."
- Deploy tree `sporely-web-deploy-0af1e32233c6`: checked locally at closeout.
  It had already been removed. The directory does not exist and git has no
  worktree entry for it. The agent removed nothing.

### Step 5 — verify

| Check | Expected | Result |
|---|---|---|
| 5.1 `attidentity` | `a` | `a` |
| 5.2 sequence ≥ max id | `t` | `t` |
| 5.3 guard triggers | 3 rows, `O` | 3 rows, all `O` |
| 5.4 `invalid_storage_namespace` in function | `t` | `t` |
| 5.5 privileges | `f f f f f f f f t` | `f f f f f f f f t` (eight denied, `service_role` allowed) |
| 5.6 namespace-invalid rows allowed | 0 | 0 |

The post-3.4 re-run of 2b does not apply, because step 3.4 did not run.

5.7 end-to-end. The owner tested manually. The agent did not run these tests:

| Step | Result |
|---|---|
| 1. New mosaic upload and sync | PASS |
| 2. Replacement mosaic after a measurement change, and sync | PASS |
| 3. Visibility change and restore; mosaic still displays | PASS |
| Mosaic display and app behavior | PASS |

Deviation: the owner ran 5.7 with their normal Sporely account, not a dedicated
test account as 5.7 specifies.

### Outcome

Deployed and verified. No rollback or compensation is needed.

Still open, tracked in the plan and not part of this deployment:

- the paused batch spore-preview RPC branch, which is now unblocked by this
  plan;
- the legacy `media.sporely.no` raw-URL exposure (Stage 2c);
- the remaining items under "Follow-ups" in the plan.
