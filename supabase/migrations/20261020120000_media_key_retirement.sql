-- Media-key retirement registry, guard, release RPC and purge claim (Stage 0a).
--
-- Plan: docs/plans/active/2026-10-20-media-key-retirement-and-cloud-copy-delete.md
-- (revision 7), section "Stage 0a", with §K (key root and family) and §L
-- (canonical lock order). Deploying this migration needs explicit user
-- approval, and the existing tombstone purge must be disabled first (Step 0,
-- admin-ops ADMIN_TOMBSTONE_PURGE_ENABLED, with drain evidence).
--
-- What this adds
-- --------------
-- 1. §K helpers: private.media_key_normalize / _strip_variant_prefixes /
--    media_key_root / media_key_family (IMMUTABLE, back the expression
--    indexes) and private.lock_media_key_roots (§L.5).
-- 2. Registry: private.media_key_retirements (one immutable record per
--    release or purge claim, with its exact delete_keys) and
--    private.retired_media_key_roots (indexed roots). Never deleted.
--    REVOKE ALL from PUBLIC, anon, authenticated, service_role; SELECT to
--    service_role only. Writes happen only inside the SECURITY DEFINER
--    functions below.
-- 3. observation_images.purge_claimed_at / purge_retirement_id: server-owned
--    and immutable once set. Set together, once, by the purge claim.
-- 4. Guard private.media_key_retirement_guard: an unconditional BEFORE
--    INSERT OR UPDATE FOR EACH ROW trigger (zzy_media_key_retirement_guard,
--    sorting after every other BEFORE row trigger except zzz_sync_identity_guard_*,
--    which must stay last and only raises; so it sees the final key values)
--    on observation_images, spore_measurements, observations,
--    spore_measurement_mosaics and calibrations. No role exemption. It
--    refuses attaching any key whose root is retired (HINT
--    sporely_media_key_released), restoring a row whose roots are retired or
--    that is purge-claimed (sporely_purge_claimed / sporely_media_key_released),
--    and any client or service-role change of the claim columns that is not
--    linked to a 'purge' retirement for that image and owner.
-- 5. Release RPC public.release_observation_image_bytes (authenticated):
--    one transaction, §L order, replay by operation UUID.
-- 6. Purge claim public.claim_tombstoned_image_purge (service_role) and a
--    replaced public.finalize_observation_image_purge that requires the claim.
-- 7. Sweep support public.claim_retired_key_sweep /
--    public.record_retired_key_sweep (service_role), and
--    public.media_key_is_retired (service_role, for the Worker in Stage 0b).
-- 8. Expression indexes on private.media_key_root(<key column>).
-- 9. Obsolete-desktop brake (20261015090000): accept sync identity '2' or '3'.
-- 10. admin_database_health classifies the two registry tables (body of
--     20261020100100 verbatim plus one rule).
--
-- Isolation: the guard (when it has work) and every new function refuse to
-- run outside READ COMMITTED (HINT sporely_requires_read_committed): the
-- post-lock registry read is only fresh under READ COMMITTED.
--
-- Rollback: before the first retirement only, drop the wrappers, guard and
-- functions. After any release or purge claim, never drop the registry, the
-- guard or media_key_root; forward fixes only.

BEGIN;

-- =============================================================
-- 1. §K key root and family.
-- =============================================================

-- Trim whitespace, then strip leading and trailing '/'. Empty -> NULL.
CREATE FUNCTION private.media_key_normalize(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.btrim(pg_catalog.btrim(p_key), '/'), '')
$$;

-- Fixed point of "strip ONE leading thumb_|small_|medium_|cards_|preview_":
-- repeat while the name starts with a prefix AND is longer than it. A name
-- made only of prefixes therefore keeps its last prefix (the base is never
-- empty), which keeps root(root(k)) = root(k) and root(member) = root(k) for
-- every family member. The prefixes are prefix-free, so the greedy repetition
-- with a "something follows" lookahead equals the repeated single strip.
CREATE FUNCTION private.media_key_strip_variant_prefixes(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT pg_catalog.regexp_replace(p_name, '^(?:thumb_|small_|medium_|cards_|preview_)+(?=.)', '')
$$;

-- Self-contained (pg_catalog only): it backs the expression indexes, which
-- evaluate it as the writing role; calling other private helpers would need
-- USAGE on schema private for those roles. Same rules as
-- media_key_normalize + media_key_strip_variant_prefixes (the fixture test
-- checks they agree).
CREATE FUNCTION private.media_key_root(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN s.n IS NULL THEN NULL
    WHEN 'originals' = ANY (pg_catalog.string_to_array(s.n, '/')) THEN s.n
    WHEN pg_catalog.strpos(s.n, '/') = 0
      THEN pg_catalog.regexp_replace(s.n, '^(?:thumb_|small_|medium_|cards_|preview_)+(?=.)', '')
    ELSE pg_catalog.regexp_replace(s.n, '/[^/]*$', '') || '/'
         || pg_catalog.regexp_replace(pg_catalog.regexp_replace(s.n, '^.*/', ''),
                                      '^(?:thumb_|small_|medium_|cards_|preview_)+(?=.)', '')
  END
  FROM (SELECT NULLIF(pg_catalog.btrim(pg_catalog.btrim(p_key), '/'), '') AS n) s
$$;

-- Family = {stored key} ∪ {root} ∪ V(base) ∪ V(stored filename)
--          ∪ {Worker deriveThumbKey(stored key)}, each under the key's dir.
-- Originals: {the key}. Sorted (C collation), distinct.
CREATE FUNCTION private.media_key_family(p_key text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  n text := private.media_key_normalize(p_key);
  v_dir text;
  v_file text;
  v_base text;
  v_names text[];
  v_name text;
  v_prefix text;
  v_worker text;
BEGIN
  IF n IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;
  IF 'originals' = ANY (pg_catalog.string_to_array(n, '/')) THEN
    RETURN ARRAY[n];
  END IF;

  IF pg_catalog.strpos(n, '/') = 0 THEN
    v_dir := NULL;
    v_file := n;
  ELSE
    v_dir := pg_catalog.regexp_replace(n, '/[^/]*$', '');
    v_file := pg_catalog.regexp_replace(n, '^.*/', '');
  END IF;
  v_base := private.media_key_strip_variant_prefixes(v_file);

  v_names := ARRAY[v_file, v_base];
  FOREACH v_name IN ARRAY ARRAY[v_base, v_file] LOOP
    FOREACH v_prefix IN ARRAY ARRAY[
      'thumb_', 'thumb_small_', 'thumb_medium_', 'thumb_cards_', 'thumb_preview_',
      'small_', 'medium_', 'cards_', 'preview_'
    ] LOOP
      v_names := v_names || (v_prefix || v_name);
    END LOOP;
  END LOOP;

  -- cloudflare/r2-upload-worker/src/index.js deriveThumbKey.
  IF v_dir IS NULL THEN
    v_worker := CASE WHEN pg_catalog.left(v_file, 6) = 'thumb_' THEN v_file ELSE 'thumb_' || v_file END;
  ELSE
    v_worker := 'thumb_' || pg_catalog.regexp_replace(v_file, '^(thumb_|small_|medium_|cards_|preview_)', '');
  END IF;
  v_names := v_names || v_worker;

  RETURN ARRAY(
    SELECT DISTINCT (CASE WHEN v_dir IS NULL THEN x ELSE v_dir || '/' || x END) COLLATE "C" AS k
      FROM pg_catalog.unnest(v_names) AS x
     ORDER BY 1
  );
END
$$;

-- §L.5: DISTINCT roots, ordered by (hashtextextended(root, 7311), root).
CREATE FUNCTION private.lock_media_key_roots(p_roots text[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT pg_catalog.hashtextextended(x, 7311) AS h, x COLLATE "C" AS root
      FROM pg_catalog.unnest(p_roots) AS x
     WHERE x IS NOT NULL
     ORDER BY 1, 2
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(r.h);
  END LOOP;
END
$$;

CREATE FUNCTION private.media_key_require_read_committed()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Media-key retirement checks require READ COMMITTED isolation (got %). Nothing was changed in the cloud.',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = 'P0001', HINT = 'sporely_requires_read_committed';
  END IF;
END
$$;

-- §K key syntax: refuse '.' / '..' segments, ANY '%' (every percent
-- encoding, e.g. %2F, %5C, %2e) and a literal backslash. The Worker must apply the
-- same rule (Stage 0b).
CREATE FUNCTION private.media_key_is_valid(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT s.n IS NULL OR NOT (
       '.' = ANY (pg_catalog.string_to_array(s.n, '/'))
    OR '..' = ANY (pg_catalog.string_to_array(s.n, '/'))
    OR pg_catalog.strpos(s.n, '%') > 0
    OR pg_catalog.strpos(s.n, E'\\') > 0
  )
  FROM (SELECT NULLIF(pg_catalog.btrim(pg_catalog.btrim(p_key), '/'), '') AS n) s
$$;

-- =============================================================
-- 2. Registry.
-- =============================================================

CREATE TABLE private.media_key_retirements (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  image_id bigint NOT NULL,
  reason text NOT NULL CHECK (reason IN ('release', 'purge')),
  operation_id uuid NOT NULL UNIQUE,
  delete_keys text[] NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  last_swept_at timestamptz,
  last_attempted_at timestamptz
);

COMMENT ON TABLE private.media_key_retirements IS
  'Media-key retirement records (20261020120000). One immutable row per release or purge claim with its exact delete_keys. Never deleted; only last_swept_at and last_attempted_at change.';

-- Sweep order: never-attempted first, then least recently attempted, so
-- records that keep failing rotate to the back and cannot starve the queue.
CREATE INDEX media_key_retirements_sweep_order_idx
  ON private.media_key_retirements (last_attempted_at NULLS FIRST, id);
CREATE INDEX media_key_retirements_image_id_idx
  ON private.media_key_retirements (image_id);

CREATE TABLE private.retired_media_key_roots (
  user_id uuid NOT NULL,
  key_root text NOT NULL,
  retirement_id bigint NOT NULL REFERENCES private.media_key_retirements (id),
  PRIMARY KEY (user_id, key_root)
);

COMMENT ON TABLE private.retired_media_key_roots IS
  'Retired §K key roots (20261020120000). A retired root is never reusable; rows are never deleted.';

-- The guard's read is global (any user, any row), so it needs key_root alone.
CREATE INDEX retired_media_key_roots_key_root_idx
  ON private.retired_media_key_roots (key_root);
CREATE INDEX retired_media_key_roots_retirement_id_idx
  ON private.retired_media_key_roots (retirement_id);

ALTER TABLE private.media_key_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.retired_media_key_roots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.media_key_retirements, private.retired_media_key_roots
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE private.media_key_retirements_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE private.media_key_retirements, private.retired_media_key_roots
  TO service_role;

-- Account erasure (GDPR storage limitation / erasure): the ONLY way registry
-- rows may be deleted. A user's rows are erasable only when BOTH hold:
--   * the server-owned account-deletion marker private.reference_account_deletions
--     exists for the user. It is written only by the service-role-only
--     delete_reference_library_for_account RPC, the account-deletion stage,
--     and disappears with the auth user (ON DELETE CASCADE);
--   * no row of the user remains in observations, observation_images,
--     spore_measurements, spore_measurement_mosaics or calibrations.
-- This is a data condition checked inside the trigger, not a session flag:
-- no GUC or caller-supplied value can make another user's rows erasable.
-- Why erasing is safe: no surviving row can carry the deleted uid (the five
-- tables reference profiles/auth.users), and the guard refuses any new or
-- changed key outside the writing row owner's prefix for every role, so no
-- row can ever attach a key under the erased '<uid>/' prefix again; the
-- retired roots of that prefix are therefore never needed afterwards.
CREATE FUNCTION private.media_key_registry_erasable(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = p_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.observations x WHERE x.user_id = p_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.observation_images x WHERE x.user_id = p_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.spore_measurements x WHERE x.user_id = p_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.spore_measurement_mosaics x WHERE x.user_id = p_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.calibrations x WHERE x.user_id = p_user_id)
$$;

CREATE FUNCTION private.media_key_registry_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND private.media_key_registry_erasable(OLD.user_id) THEN
    RETURN OLD;  -- account erasure only (see media_key_registry_erasable)
  END IF;
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'media_key_retirements'
     AND (pg_catalog.to_jsonb(NEW) - 'last_swept_at' - 'last_attempted_at')
       = (pg_catalog.to_jsonb(OLD) - 'last_swept_at' - 'last_attempted_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'private.% is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001', HINT = 'sporely_media_key_registry_immutable';
END
$$;

CREATE TRIGGER media_key_retirements_immutable
  BEFORE UPDATE OR DELETE ON private.media_key_retirements
  FOR EACH ROW EXECUTE FUNCTION private.media_key_registry_immutable();
CREATE TRIGGER media_key_retirements_no_truncate
  BEFORE TRUNCATE ON private.media_key_retirements
  FOR EACH STATEMENT EXECUTE FUNCTION private.media_key_registry_immutable();
CREATE TRIGGER retired_media_key_roots_immutable
  BEFORE UPDATE OR DELETE ON private.retired_media_key_roots
  FOR EACH ROW EXECUTE FUNCTION private.media_key_registry_immutable();
CREATE TRIGGER retired_media_key_roots_no_truncate
  BEFORE TRUNCATE ON private.retired_media_key_roots
  FOR EACH STATEMENT EXECUTE FUNCTION private.media_key_registry_immutable();

ALTER TABLE private.media_key_retirements ENABLE ALWAYS TRIGGER media_key_retirements_immutable;
ALTER TABLE private.media_key_retirements ENABLE ALWAYS TRIGGER media_key_retirements_no_truncate;
ALTER TABLE private.retired_media_key_roots ENABLE ALWAYS TRIGGER retired_media_key_roots_immutable;
ALTER TABLE private.retired_media_key_roots ENABLE ALWAYS TRIGGER retired_media_key_roots_no_truncate;

-- =============================================================
-- 3. Server-owned purge-claim columns.
-- =============================================================

ALTER TABLE public.observation_images
  ADD COLUMN purge_claimed_at timestamptz,
  ADD COLUMN purge_retirement_id bigint REFERENCES private.media_key_retirements (id);

COMMENT ON COLUMN public.observation_images.purge_claimed_at IS
  'Server-owned (20261020120000). Set once by private.claim_tombstoned_image_purge_core together with purge_retirement_id; the row can then never be restored.';
COMMENT ON COLUMN public.observation_images.purge_retirement_id IS
  'Server-owned (20261020120000). The private.media_key_retirements ''purge'' record of this image and owner; immutable once set.';

-- =============================================================
-- 4. Reference lookup (through the expression indexes below).
-- =============================================================

CREATE FUNCTION private.media_key_references(p_roots text[])
RETURNS TABLE (
  tbl text,
  row_id bigint,
  col text,
  key text,
  owner_id uuid,
  parent_image_id bigint,
  is_deleted boolean,
  is_purge_claimed boolean
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 'observation_images', i.id, 'storage_path', i.storage_path, i.user_id, i.id,
         i.deleted_at IS NOT NULL, i.purge_claimed_at IS NOT NULL
    FROM public.observation_images i
   WHERE i.storage_path IS NOT NULL
     AND private.media_key_root(i.storage_path) = ANY (p_roots)
  UNION ALL
  SELECT 'observation_images', i.id, 'original_storage_path', i.original_storage_path, i.user_id, i.id,
         i.deleted_at IS NOT NULL, i.purge_claimed_at IS NOT NULL
    FROM public.observation_images i
   WHERE i.original_storage_path IS NOT NULL
     AND private.media_key_root(i.original_storage_path) = ANY (p_roots)
  UNION ALL
  SELECT 'spore_measurements', m.id, 'image_key', m.image_key, m.user_id, m.image_id, false, false
    FROM public.spore_measurements m
   WHERE m.image_key IS NOT NULL
     AND private.media_key_root(m.image_key) = ANY (p_roots)
  UNION ALL
  SELECT 'spore_measurements', m.id, 'thumb_key', m.thumb_key, m.user_id, m.image_id, false, false
    FROM public.spore_measurements m
   WHERE m.thumb_key IS NOT NULL
     AND private.media_key_root(m.thumb_key) = ANY (p_roots)
  UNION ALL
  SELECT 'observations', o.id, 'image_key', o.image_key, o.user_id, NULL::bigint, false, false
    FROM public.observations o
   WHERE o.image_key IS NOT NULL
     AND private.media_key_root(o.image_key) = ANY (p_roots)
  UNION ALL
  SELECT 'observations', o.id, 'thumb_key', o.thumb_key, o.user_id, NULL::bigint, false, false
    FROM public.observations o
   WHERE o.thumb_key IS NOT NULL
     AND private.media_key_root(o.thumb_key) = ANY (p_roots)
  UNION ALL
  SELECT 'spore_measurement_mosaics', s.id, 'storage_key', s.storage_key, s.user_id, NULL::bigint, false, false
    FROM public.spore_measurement_mosaics s
   WHERE s.storage_key IS NOT NULL
     AND private.media_key_root(s.storage_key) = ANY (p_roots)
  UNION ALL
  SELECT 'calibrations', c.id, 'image_storage_path', c.image_storage_path, c.user_id, NULL::bigint, false, false
    FROM public.calibrations c
   WHERE c.image_storage_path IS NOT NULL
     AND private.media_key_root(c.image_storage_path) = ANY (p_roots)
$$;

-- References that can block p_owner's release, claim or sweep: EVERY row of
-- p_owner, whatever the key's prefix (a legacy key outside '<uid>/' still
-- counts), and any other owner's legacy row whose key is outside its own
-- prefix. Other owners' rows with keys under their own prefix are ignored: release and claim retire only
-- keys under the owner's own prefix (key_foreign otherwise), which no other
-- owner may legitimately reference, and the guard refuses new ones.
CREATE FUNCTION private.media_key_owner_references(p_roots text[], p_owner uuid)
RETURNS TABLE (
  tbl text,
  row_id bigint,
  col text,
  owner_id uuid,
  parent_image_id bigint,
  is_deleted boolean,
  is_purge_claimed boolean
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT r.tbl, r.row_id, r.col, r.owner_id, r.parent_image_id, r.is_deleted, r.is_purge_claimed
    FROM private.media_key_references(p_roots) r
   WHERE r.owner_id = p_owner
      -- A legacy row of another owner whose key is not under that row's own
      -- prefix (pre-guard data; the guard refuses new ones) also blocks:
      -- such bytes are refused, never deleted.
      OR NOT pg_catalog.starts_with(private.media_key_normalize(r.key), r.owner_id::text || '/')
$$;

-- =============================================================
-- 5. Guard.
-- =============================================================

CREATE FUNCTION private.media_key_retirement_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new jsonb := pg_catalog.to_jsonb(NEW);
  v_old jsonb;
  v_cols text[];
  v_col text;
  v_val text;
  v_keys text[] := ARRAY[]::text[];
  v_changed text[] := ARRAY[]::text[];
  v_roots text[];
  v_restore boolean := false;
  v_claim_change boolean := false;
  v_hit text;
  v_fenced boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := pg_catalog.to_jsonb(OLD);
  END IF;

  -- Account-deletion write fence: once delete-account has written the
  -- server-owned marker (begin_account_deletion, first stage after the global
  -- sign-out), no top-level INSERT or UPDATE of the owner's rows (NEW or OLD
  -- owner) is accepted from any role, so erasure is not raced by new content.
  -- Nested writes of other triggers (pg_trigger_depth() > 1, e.g. the
  -- child-touch UPDATE of observations.updated_at while delete-account deletes
  -- images) pass only when key-neutral; see the second check below.
  v_fenced := EXISTS (SELECT 1 FROM private.reference_account_deletions d
                       WHERE d.user_id = (v_new ->> 'user_id')::uuid
                          OR d.user_id = (v_old ->> 'user_id')::uuid);
  IF v_fenced AND pg_catalog.pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'This account is being deleted. Nothing was changed in the cloud.'
      USING ERRCODE = 'P0001', HINT = 'sporely_account_deleting';
  END IF;

  v_cols := CASE TG_TABLE_NAME
    WHEN 'observation_images' THEN ARRAY['storage_path', 'original_storage_path']
    WHEN 'spore_measurements' THEN ARRAY['image_key', 'thumb_key']
    WHEN 'observations' THEN ARRAY['image_key', 'thumb_key']
    WHEN 'spore_measurement_mosaics' THEN ARRAY['storage_key']
    WHEN 'calibrations' THEN ARRAY['image_storage_path']
  END;
  IF v_cols IS NULL OR TG_TABLE_SCHEMA <> 'public' THEN
    RAISE EXCEPTION 'media_key_retirement_guard is not defined for %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'observation_images' THEN
    v_restore := TG_OP = 'UPDATE'
      AND (v_old ->> 'deleted_at') IS NOT NULL
      AND (v_new ->> 'deleted_at') IS NULL;
    IF TG_OP = 'INSERT' THEN
      v_claim_change := (v_new ->> 'purge_claimed_at') IS NOT NULL
                     OR (v_new ->> 'purge_retirement_id') IS NOT NULL;
    ELSE
      v_claim_change := (v_new -> 'purge_claimed_at') IS DISTINCT FROM (v_old -> 'purge_claimed_at')
                     OR (v_new -> 'purge_retirement_id') IS DISTINCT FROM (v_old -> 'purge_retirement_id');
    END IF;
  END IF;

  -- Keys this write attaches: new or changed non-NULL keys; on a restore,
  -- every key the row carries.
  FOREACH v_col IN ARRAY v_cols LOOP
    v_val := private.media_key_normalize(v_new ->> v_col);
    IF v_val IS NOT NULL
       AND (TG_OP = 'INSERT' OR v_restore OR (v_new -> v_col) IS DISTINCT FROM (v_old -> v_col)) THEN
      v_keys := v_keys || v_val;
    END IF;
    IF v_val IS NOT NULL
       AND (TG_OP = 'INSERT' OR (v_new -> v_col) IS DISTINCT FROM (v_old -> v_col)) THEN
      v_changed := v_changed || v_val;
    END IF;
  END LOOP;

  IF v_fenced AND (TG_OP = 'INSERT' OR pg_catalog.cardinality(v_changed) > 0 OR v_restore OR v_claim_change) THEN
    RAISE EXCEPTION 'This account is being deleted. Nothing was changed in the cloud.'
      USING ERRCODE = 'P0001', HINT = 'sporely_account_deleting';
  END IF;

  IF pg_catalog.cardinality(v_keys) = 0 AND NOT v_restore AND NOT v_claim_change THEN
    RETURN NEW;
  END IF;

  PERFORM private.media_key_require_read_committed();

  -- Every new or changed key must be well-formed and live under the row
  -- owner's prefix, for EVERY role (service_role and migrations included; no
  -- exemption mechanism exists). Keys a write leaves unchanged are not
  -- re-validated. Both checks run before any key lock or registry read, so a
  -- foreign key neither waits on nor reveals another owner's retirement
  -- state: it always gets this one refusal. Release, claim and sweep also
  -- ignore any legacy reference whose owner does not own the key's prefix.
  FOREACH v_val IN ARRAY v_changed LOOP
    IF NOT private.media_key_is_valid(v_val) THEN
      RAISE EXCEPTION 'This media key is not a valid Sporely storage key. Nothing was changed in the cloud.'
        USING ERRCODE = 'P0001', HINT = 'sporely_media_key_invalid';
    END IF;
    IF (v_new ->> 'user_id') IS NULL OR NOT pg_catalog.starts_with(v_val, (v_new ->> 'user_id') || '/') THEN
      RAISE EXCEPTION 'A media key must live under the row owner''s storage prefix. Nothing was changed in the cloud.'
        USING ERRCODE = '42501', HINT = 'sporely_media_key_foreign';
    END IF;
  END LOOP;

  IF v_claim_change THEN
    -- Only NULL -> non-NULL of both columns together, on a tombstoned row,
    -- linked to a 'purge' retirement of this image and owner. A session GUC
    -- (sporely.purge_claim) is never consulted: it is not authorization.
    IF TG_OP = 'INSERT'
       OR (v_old ->> 'purge_claimed_at') IS NOT NULL
       OR (v_old ->> 'purge_retirement_id') IS NOT NULL
       OR (v_new ->> 'purge_claimed_at') IS NULL
       OR (v_new ->> 'purge_retirement_id') IS NULL
       OR (v_new ->> 'deleted_at') IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM private.media_key_retirements r
          WHERE r.id = (v_new ->> 'purge_retirement_id')::bigint
            AND r.reason = 'purge'
            AND r.image_id = (v_new ->> 'id')::bigint
            AND r.user_id = (v_new ->> 'user_id')::uuid
       ) THEN
      RAISE EXCEPTION 'The purge claim of this image is server-owned and cannot be changed. Nothing was changed in the cloud.'
        USING ERRCODE = 'P0001', HINT = 'sporely_purge_claimed';
    END IF;
  END IF;

  IF v_restore AND ((v_old ->> 'purge_claimed_at') IS NOT NULL OR (v_new ->> 'purge_claimed_at') IS NOT NULL) THEN
    RAISE EXCEPTION 'This image was permanently removed and cannot be restored. Nothing was changed in the cloud.'
      USING ERRCODE = 'P0001', HINT = 'sporely_purge_claimed';
  END IF;

  IF pg_catalog.cardinality(v_keys) > 0 THEN
    v_roots := ARRAY(SELECT DISTINCT private.media_key_root(k) FROM pg_catalog.unnest(v_keys) AS k);
    PERFORM private.lock_media_key_roots(v_roots);
    -- Fresh read: a separate statement after the key locks (READ COMMITTED),
    -- global across users and rows.
    SELECT r.key_root INTO v_hit
      FROM private.retired_media_key_roots r
     WHERE r.key_root = ANY (v_roots)
     LIMIT 1;
    IF v_hit IS NOT NULL THEN
      RAISE EXCEPTION 'This media file was removed from Sporely Cloud and cannot be attached again. Nothing was changed in the cloud.'
        USING ERRCODE = 'P0001', HINT = 'sporely_media_key_released';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER zzy_media_key_retirement_guard
  BEFORE INSERT OR UPDATE ON public.observation_images
  FOR EACH ROW EXECUTE FUNCTION private.media_key_retirement_guard();
CREATE TRIGGER zzy_media_key_retirement_guard
  BEFORE INSERT OR UPDATE ON public.spore_measurements
  FOR EACH ROW EXECUTE FUNCTION private.media_key_retirement_guard();
CREATE TRIGGER zzy_media_key_retirement_guard
  BEFORE INSERT OR UPDATE ON public.observations
  FOR EACH ROW EXECUTE FUNCTION private.media_key_retirement_guard();
CREATE TRIGGER zzy_media_key_retirement_guard
  BEFORE INSERT OR UPDATE ON public.spore_measurement_mosaics
  FOR EACH ROW EXECUTE FUNCTION private.media_key_retirement_guard();
CREATE TRIGGER zzy_media_key_retirement_guard
  BEFORE INSERT OR UPDATE ON public.calibrations
  FOR EACH ROW EXECUTE FUNCTION private.media_key_retirement_guard();

-- ALWAYS: session_replication_role = replica must not bypass the guard.
ALTER TABLE public.observation_images ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;
ALTER TABLE public.spore_measurements ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;
ALTER TABLE public.observations ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;
ALTER TABLE public.spore_measurement_mosaics ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;
ALTER TABLE public.calibrations ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;

-- =============================================================
-- 6. Release and purge claim.
-- =============================================================

-- Replay by operation UUID: the stored record wins, whatever the row looks
-- like now. NULL when the UUID is unknown.
CREATE FUNCTION private.media_key_retirement_replay(
  p_operation_id uuid,
  p_user_id uuid,
  p_image_id bigint,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_rec private.media_key_retirements%ROWTYPE;
BEGIN
  SELECT * INTO v_rec FROM private.media_key_retirements r WHERE r.operation_id = p_operation_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_rec.image_id IS DISTINCT FROM p_image_id
     OR v_rec.reason IS DISTINCT FROM p_reason
     OR (p_user_id IS NOT NULL AND v_rec.user_id IS DISTINCT FROM p_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict', 'image_id', p_image_id);
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', CASE p_reason WHEN 'release' THEN 'released' ELSE 'claimed' END,
    'image_id', v_rec.image_id,
    'retirement_id', v_rec.id,
    'delete_keys', pg_catalog.to_jsonb(v_rec.delete_keys),
    'purpose', (SELECT i.metadata_purpose FROM public.observation_images i WHERE i.id = v_rec.image_id),
    'replayed', true
  );
END
$$;

CREATE FUNCTION private.release_observation_image_bytes_core(
  p_release_id uuid,
  p_image_id bigint,
  p_expected_storage_path text,
  p_expected_original text,
  p_metadata_purpose text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_resp jsonb;
  v_obs_id bigint;
  v_owner uuid;
  v_obs_owner uuid;
  v_img public.observation_images%ROWTYPE;
  v_roots text[];
  v_keys text[];
  v_ret_id bigint;
BEGIN
  PERFORM private.media_key_require_read_committed();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'release_observation_image_bytes requires an authenticated caller'
      USING ERRCODE = '42501';
  END IF;
  IF p_release_id IS NULL OR p_image_id IS NULL THEN
    RAISE EXCEPTION 'p_release_id and p_image_id are required' USING ERRCODE = '22023';
  END IF;

  v_resp := private.media_key_retirement_replay(p_release_id, v_uid, p_image_id, 'release');
  IF v_resp IS NOT NULL THEN
    RETURN v_resp;
  END IF;

  -- Unlocked pre-read; re-verified after the locks.
  SELECT i.observation_id, i.user_id INTO v_obs_id, v_owner
    FROM public.observation_images i WHERE i.id = p_image_id;
  IF NOT FOUND OR v_owner IS DISTINCT FROM v_uid THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'image_id', p_image_id);
  END IF;

  -- §L.1 observation row.
  SELECT o.user_id INTO v_obs_owner FROM public.observations o WHERE o.id = v_obs_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_obs_owner IS DISTINCT FROM v_uid THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'image_id', p_image_id);
  END IF;
  -- §L.2 per-user cascade lock (as _media_bump_child_images_on_obs).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_obs_owner::text, 42));
  -- §L.3 image row.
  SELECT * INTO v_img FROM public.observation_images i WHERE i.id = p_image_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_img.user_id IS DISTINCT FROM v_uid OR v_img.observation_id IS DISTINCT FROM v_obs_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'image_id', p_image_id);
  END IF;
  -- §L.4 the owner's measurement rows of this image, by id.
  PERFORM 1 FROM public.spore_measurements m
    WHERE m.image_id = p_image_id AND m.user_id = v_img.user_id
    ORDER BY m.id FOR NO KEY UPDATE;
  -- §L.5 key roots of the stored keys.
  v_roots := ARRAY(
    SELECT DISTINCT private.media_key_root(k)
      FROM pg_catalog.unnest(ARRAY[v_img.storage_path, v_img.original_storage_path]) AS k
     WHERE private.media_key_root(k) IS NOT NULL
  );
  PERFORM private.lock_media_key_roots(v_roots);

  -- A concurrent call with the same UUID may have committed while we waited.
  v_resp := private.media_key_retirement_replay(p_release_id, v_uid, p_image_id, 'release');
  IF v_resp IS NOT NULL THEN
    RETURN v_resp;
  END IF;

  IF v_img.deleted_at IS NOT NULL OR v_img.purged_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'deleted', 'image_id', p_image_id);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[v_img.storage_path, v_img.original_storage_path]) AS k
              WHERE k IS NOT NULL AND NOT private.media_key_is_valid(k)) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'key_invalid', 'image_id', p_image_id);
  END IF;
  -- Only keys under the image owner's own prefix are ever retired; a legacy
  -- key elsewhere keeps its bytes (and is listed by deploy precheck 2).
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[v_img.storage_path, v_img.original_storage_path]) AS k
              WHERE k IS NOT NULL
                AND NOT pg_catalog.starts_with(private.media_key_normalize(k), v_img.user_id::text || '/')) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'key_foreign', 'image_id', p_image_id);
  END IF;
  IF v_img.image_type IS DISTINCT FROM 'microscope' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_microscope', 'image_id', p_image_id);
  END IF;
  IF v_img.storage_path IS DISTINCT FROM p_expected_storage_path
     OR v_img.original_storage_path IS DISTINCT FROM p_expected_original
     OR pg_catalog.cardinality(v_roots) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'row_changed', 'image_id', p_image_id);
  END IF;
  IF p_metadata_purpose IS NULL OR p_metadata_purpose NOT IN ('owner_sync', 'public_microscopy') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'purpose_invalid', 'image_id', p_image_id);
  END IF;

  -- Any other reference to a family root refuses. Exempt only the rows this
  -- transaction clears: the image itself, the owner's measurements of this
  -- image, and the owning observation's cover.
  IF EXISTS (
    SELECT 1 FROM private.media_key_owner_references(v_roots, v_img.user_id) ref
     WHERE NOT (ref.tbl = 'observation_images' AND ref.row_id = p_image_id)
       AND NOT (ref.tbl = 'spore_measurements' AND ref.parent_image_id = p_image_id AND ref.owner_id = v_img.user_id)
       AND NOT (ref.tbl = 'observations' AND ref.row_id = v_obs_id)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'media_key_shared', 'image_id', p_image_id);
  END IF;

  v_keys := ARRAY(
    SELECT DISTINCT f COLLATE "C"
      FROM pg_catalog.unnest(
             private.media_key_family(v_img.storage_path)
             || private.media_key_family(v_img.original_storage_path)) AS f
     ORDER BY 1
  );

  INSERT INTO private.media_key_retirements (user_id, image_id, reason, operation_id, delete_keys)
  VALUES (v_img.user_id, p_image_id, 'release', p_release_id, v_keys)
  RETURNING id INTO v_ret_id;
  INSERT INTO private.retired_media_key_roots (user_id, key_root, retirement_id)
  SELECT v_img.user_id, r, v_ret_id FROM pg_catalog.unnest(v_roots) AS r
  ON CONFLICT DO NOTHING;

  UPDATE public.observation_images i
     SET storage_path = NULL,
         original_storage_path = NULL,
         upload_mode = NULL,
         source_width = NULL,
         source_height = NULL,
         stored_width = NULL,
         stored_height = NULL,
         stored_bytes = NULL,
         metadata_purpose = p_metadata_purpose
   WHERE i.id = p_image_id;

  UPDATE public.spore_measurements m
     SET image_key = CASE WHEN private.media_key_root(m.image_key) = ANY (v_roots) THEN NULL ELSE m.image_key END,
         thumb_key = CASE WHEN private.media_key_root(m.thumb_key) = ANY (v_roots) THEN NULL ELSE m.thumb_key END
   WHERE m.image_id = p_image_id
     AND m.user_id = v_img.user_id
     AND (private.media_key_root(m.image_key) = ANY (v_roots)
          OR private.media_key_root(m.thumb_key) = ANY (v_roots));

  UPDATE public.observations o
     SET image_key = CASE WHEN private.media_key_root(o.image_key) = ANY (v_roots) THEN NULL ELSE o.image_key END,
         thumb_key = CASE WHEN private.media_key_root(o.thumb_key) = ANY (v_roots) THEN NULL ELSE o.thumb_key END
   WHERE o.id = v_obs_id
     AND (private.media_key_root(o.image_key) = ANY (v_roots)
          OR private.media_key_root(o.thumb_key) = ANY (v_roots));

  RETURN pg_catalog.jsonb_build_object(
    'status', 'released',
    'image_id', p_image_id,
    'retirement_id', v_ret_id,
    'delete_keys', pg_catalog.to_jsonb(v_keys),
    'purpose', p_metadata_purpose,
    'replayed', false
  );
END
$$;

-- Restore window: p_restore_window_days is validated against the 30-day
-- minimum here (plan Q-r4-1, recommended answer); admin-ops passes its
-- getRestoreWindowDays value, which is never below 30.
CREATE FUNCTION private.claim_tombstoned_image_purge_core(
  p_claim_id uuid,
  p_image_id bigint,
  p_restore_window_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_resp jsonb;
  v_obs_id bigint;
  v_obs_owner uuid;
  v_img public.observation_images%ROWTYPE;
  v_roots text[];
  v_keys text[];
  v_ret_id bigint;
  v_days integer := COALESCE(p_restore_window_days, 30);
BEGIN
  PERFORM private.media_key_require_read_committed();
  IF p_claim_id IS NULL OR p_image_id IS NULL THEN
    RAISE EXCEPTION 'p_claim_id and p_image_id are required' USING ERRCODE = '22023';
  END IF;
  IF v_days < 30 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'window_invalid', 'image_id', p_image_id);
  END IF;

  v_resp := private.media_key_retirement_replay(p_claim_id, NULL, p_image_id, 'purge');
  IF v_resp IS NOT NULL THEN
    RETURN v_resp;
  END IF;

  SELECT i.observation_id INTO v_obs_id FROM public.observation_images i WHERE i.id = p_image_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'image_id', p_image_id);
  END IF;
  -- §L.1 .. §L.5. The owner's measurements of this image are locked and,
  -- like the owning cover, cleared when they point into the family (the
  -- desktop copies the image key into its measurements' image_key/thumb_key).
  SELECT o.user_id INTO v_obs_owner FROM public.observations o WHERE o.id = v_obs_id FOR NO KEY UPDATE;
  IF FOUND THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_obs_owner::text, 42));
  END IF;
  SELECT * INTO v_img FROM public.observation_images i WHERE i.id = p_image_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found', 'image_id', p_image_id);
  END IF;
  PERFORM 1 FROM public.spore_measurements m
    WHERE m.image_id = p_image_id AND m.user_id = v_img.user_id
    ORDER BY m.id FOR NO KEY UPDATE;
  v_roots := ARRAY(
    SELECT DISTINCT private.media_key_root(k)
      FROM pg_catalog.unnest(ARRAY[v_img.storage_path, v_img.original_storage_path]) AS k
     WHERE private.media_key_root(k) IS NOT NULL
  );
  PERFORM private.lock_media_key_roots(v_roots);

  v_resp := private.media_key_retirement_replay(p_claim_id, NULL, p_image_id, 'purge');
  IF v_resp IS NOT NULL THEN
    RETURN v_resp;
  END IF;

  IF v_img.purge_claimed_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_claimed', 'image_id', p_image_id, 'retirement_id', v_img.purge_retirement_id);
  END IF;
  IF v_img.deleted_at IS NULL
     OR v_img.purged_at IS NOT NULL
     OR v_img.deleted_at > pg_catalog.now() - pg_catalog.make_interval(days => v_days) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_eligible', 'image_id', p_image_id);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[v_img.storage_path, v_img.original_storage_path]) AS k
              WHERE k IS NOT NULL AND NOT private.media_key_is_valid(k)) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'key_invalid', 'image_id', p_image_id);
  END IF;
  -- Only keys under the image owner's own prefix are ever retired; a legacy
  -- key elsewhere keeps its bytes (and is listed by deploy precheck 2).
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[v_img.storage_path, v_img.original_storage_path]) AS k
              WHERE k IS NOT NULL
                AND NOT pg_catalog.starts_with(private.media_key_normalize(k), v_img.user_id::text || '/')) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'key_foreign', 'image_id', p_image_id);
  END IF;

  -- Same exemption as the release: the row itself, the owner's measurements
  -- of this image and the owning observation's cover, which this
  -- transaction clears. Any other owned reference refuses.
  IF EXISTS (
    SELECT 1 FROM private.media_key_owner_references(v_roots, v_img.user_id) ref
     WHERE NOT (ref.tbl = 'observation_images' AND ref.row_id = p_image_id)
       AND NOT (ref.tbl = 'spore_measurements' AND ref.parent_image_id = p_image_id AND ref.owner_id = v_img.user_id)
       AND NOT (ref.tbl = 'observations' AND ref.row_id = v_obs_id)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'media_key_shared', 'image_id', p_image_id);
  END IF;

  v_keys := ARRAY(
    SELECT DISTINCT f COLLATE "C"
      FROM pg_catalog.unnest(
             private.media_key_family(v_img.storage_path)
             || private.media_key_family(v_img.original_storage_path)) AS f
     ORDER BY 1
  );

  -- The record first, then the row (the guard checks the link).
  INSERT INTO private.media_key_retirements (user_id, image_id, reason, operation_id, delete_keys)
  VALUES (v_img.user_id, p_image_id, 'purge', p_claim_id, v_keys)
  RETURNING id INTO v_ret_id;
  INSERT INTO private.retired_media_key_roots (user_id, key_root, retirement_id)
  SELECT v_img.user_id, r, v_ret_id FROM pg_catalog.unnest(v_roots) AS r
  ON CONFLICT DO NOTHING;

  PERFORM pg_catalog.set_config('sporely.purge_claim', p_claim_id::text, true);  -- diagnostics only
  UPDATE public.observation_images i
     SET purge_claimed_at = pg_catalog.now(),
         purge_retirement_id = v_ret_id
   WHERE i.id = p_image_id;

  UPDATE public.spore_measurements m
     SET image_key = CASE WHEN private.media_key_root(m.image_key) = ANY (v_roots) THEN NULL ELSE m.image_key END,
         thumb_key = CASE WHEN private.media_key_root(m.thumb_key) = ANY (v_roots) THEN NULL ELSE m.thumb_key END
   WHERE m.image_id = p_image_id
     AND m.user_id = v_img.user_id
     AND (private.media_key_root(m.image_key) = ANY (v_roots)
          OR private.media_key_root(m.thumb_key) = ANY (v_roots));

  UPDATE public.observations o
     SET image_key = CASE WHEN private.media_key_root(o.image_key) = ANY (v_roots) THEN NULL ELSE o.image_key END,
         thumb_key = CASE WHEN private.media_key_root(o.thumb_key) = ANY (v_roots) THEN NULL ELSE o.thumb_key END
   WHERE o.id = v_obs_id
     AND o.user_id = v_img.user_id
     AND (private.media_key_root(o.image_key) = ANY (v_roots)
          OR private.media_key_root(o.thumb_key) = ANY (v_roots));

  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'image_id', p_image_id,
    'retirement_id', v_ret_id,
    'delete_keys', pg_catalog.to_jsonb(v_keys),
    'replayed', false
  );
END
$$;

-- Replaces 20260809130000: refuses unless the row is claimed, still
-- tombstoned, and linked to a 'purge' record of this image and owner. Now
-- SECURITY DEFINER with an empty search_path (it reads the private registry
-- and calls the private isolation check); still service_role only.
CREATE OR REPLACE FUNCTION public.finalize_observation_image_purge(
  p_image_id bigint,
  p_purged_at timestamptz,
  p_storage_bytes bigint
)
RETURNS TABLE(
  image_id bigint,
  purged_at timestamptz,
  accounted_storage_bytes bigint,
  quota_changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_image public.observation_images%ROWTYPE;
  v_bytes bigint;
BEGIN
  PERFORM private.media_key_require_read_committed();

  SELECT *
    INTO v_image
    FROM public.observation_images oi
   WHERE oi.id = p_image_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'observation image % not found', p_image_id;
  END IF;

  IF v_image.purge_claimed_at IS NULL
     OR v_image.deleted_at IS NULL
     OR v_image.purge_retirement_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM private.media_key_retirements r
        WHERE r.id = v_image.purge_retirement_id
          AND r.reason = 'purge'
          AND r.image_id = v_image.id
          AND r.user_id = v_image.user_id
     ) THEN
    RAISE EXCEPTION 'observation image % has no valid purge claim', p_image_id
      USING ERRCODE = 'P0001', HINT = 'sporely_purge_not_claimed';
  END IF;

  v_bytes := greatest(
    0,
    coalesce(p_storage_bytes, 0),
    coalesce(v_image.purge_accounting_bytes, 0),
    coalesce(v_image.stored_bytes, 0)
  );

  IF v_image.purged_at IS NULL THEN
    UPDATE public.observation_images oi
       SET purged_at = coalesce(p_purged_at, pg_catalog.now()),
           purge_attempted_at = coalesce(p_purged_at, pg_catalog.now()),
           purge_error = NULL,
           purge_accounting_bytes = v_bytes
     WHERE oi.id = p_image_id;

    PERFORM public.apply_profile_storage_delta(v_image.user_id, -v_bytes, -1);

    RETURN QUERY
      SELECT p_image_id, coalesce(p_purged_at, pg_catalog.now()), v_bytes, true;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT p_image_id, v_image.purged_at, coalesce(v_image.purge_accounting_bytes, v_bytes), false;
END;
$$;

-- =============================================================
-- 7. Sweep support and the Worker check.
-- =============================================================

CREATE FUNCTION private.claim_retired_key_sweep_core(p_limit integer)
RETURNS TABLE (
  retirement_id bigint,
  user_id uuid,
  image_id bigint,
  reason text,
  delete_keys text[],
  status text,
  blocking_references jsonb,
  image_exists boolean,
  image_purged_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
  v_ids bigint[];
  v_rec record;
  v_roots text[];
  v_refs jsonb;
BEGIN
  PERFORM private.media_key_require_read_committed();

  v_ids := ARRAY(
    SELECT r.id FROM private.media_key_retirements r
     ORDER BY r.last_attempted_at NULLS FIRST, r.id
     LIMIT v_limit
  );
  -- Every handed-out record moves to the back of the queue, whether or not
  -- the caller finishes it, so failing records cannot starve newer ones.
  UPDATE private.media_key_retirements r SET last_attempted_at = pg_catalog.clock_timestamp() WHERE r.id = ANY (v_ids);
  -- One sorted acquisition over every batch root (§L.5), never per record.
  PERFORM private.lock_media_key_roots(ARRAY(
    SELECT private.media_key_root(k)
      FROM private.media_key_retirements r, pg_catalog.unnest(r.delete_keys) AS k
     WHERE r.id = ANY (v_ids)
  ));

  FOR v_rec IN
    SELECT r.* FROM private.media_key_retirements r
     WHERE r.id = ANY (v_ids)
     ORDER BY r.id
  LOOP
    v_roots := ARRAY(SELECT DISTINCT private.media_key_root(k) FROM pg_catalog.unnest(v_rec.delete_keys) AS k);
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'table', ref.tbl, 'id', ref.row_id, 'column', ref.col))
      INTO v_refs
      FROM private.media_key_owner_references(v_roots, v_rec.user_id) ref
     WHERE NOT (v_rec.reason = 'purge'
                AND ref.tbl = 'observation_images'
                AND ref.row_id = v_rec.image_id
                AND ref.is_deleted
                AND ref.is_purge_claimed);
    retirement_id := v_rec.id;
    user_id := v_rec.user_id;
    image_id := v_rec.image_id;
    reason := v_rec.reason;
    delete_keys := v_rec.delete_keys;
    IF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_rec.delete_keys) AS k
                WHERE NOT private.media_key_is_valid(k)
                   OR NOT pg_catalog.starts_with(private.media_key_normalize(k), v_rec.user_id::text || '/')) THEN
      v_refs := coalesce(v_refs, '[]'::jsonb) || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('reason', 'key_outside_owner_prefix'));
    END IF;
    status := CASE WHEN v_refs IS NULL THEN 'ok' ELSE 'guard_failed' END;
    blocking_references := v_refs;
    -- The image row can be gone (account deletion, observation hard delete)
    -- or already purged: the caller then deletes the keys but skips finalize.
    SELECT true, i.purged_at INTO image_exists, image_purged_at
      FROM public.observation_images i WHERE i.id = v_rec.image_id;
    image_exists := coalesce(image_exists, false);
    RETURN NEXT;
    image_exists := NULL;
    image_purged_at := NULL;
  END LOOP;
END
$$;

CREATE FUNCTION private.record_retired_key_sweep_core(p_retirement_ids bigint[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM private.media_key_require_read_committed();
  UPDATE private.media_key_retirements r
     SET last_swept_at = pg_catalog.now()
   WHERE r.id = ANY (p_retirement_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- Global, like the guard: p_user is accepted for the Worker's call shape and
-- diagnostics but does not narrow the check.
CREATE FUNCTION private.media_key_is_retired_core(p_user uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_root text := private.media_key_root(p_key);
BEGIN
  PERFORM private.media_key_require_read_committed();
  IF v_root IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM private.retired_media_key_roots r WHERE r.key_root = v_root);
END
$$;

-- delete-account stage begin_account_deletion: write the account-deletion
-- marker right after the global sign-out, so the write fence covers the whole
-- run. Idempotent; the same marker delete_reference_library_for_account
-- writes later (ON CONFLICT DO NOTHING there too), under the same lock.
CREATE FUNCTION private.begin_account_deletion_core(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 7301));
  INSERT INTO private.reference_account_deletions (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN pg_catalog.jsonb_build_object('status', 'fenced');
END
$$;

-- Account erasure of the registry (delete-account stage
-- erase_media_retirements). Refuses unless media_key_registry_erasable.
CREATE FUNCTION private.erase_account_media_retirements_core(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_roots integer;
  v_records integer;
BEGIN
  PERFORM private.media_key_require_read_committed();
  IF NOT private.media_key_registry_erasable(p_user_id) THEN
    RAISE EXCEPTION 'Media-key registry rows can be erased only for an account whose deletion is in progress and whose content is gone.'
      USING ERRCODE = 'P0001', HINT = 'sporely_account_not_erasable';
  END IF;
  DELETE FROM private.retired_media_key_roots r WHERE r.user_id = p_user_id;
  GET DIAGNOSTICS v_roots = ROW_COUNT;
  DELETE FROM private.media_key_retirements r WHERE r.user_id = p_user_id;
  GET DIAGNOSTICS v_records = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object('status', 'erased', 'roots', v_roots, 'records', v_records);
END
$$;

-- =============================================================
-- 8. Public wrappers (SECURITY DEFINER, empty search_path).
-- =============================================================

CREATE FUNCTION public.release_observation_image_bytes(
  p_release_id uuid,
  p_image_id bigint,
  p_expected_storage_path text,
  p_expected_original text,
  p_metadata_purpose text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.release_observation_image_bytes_core(
    p_release_id, p_image_id, p_expected_storage_path, p_expected_original, p_metadata_purpose)
$$;

CREATE FUNCTION public.media_key_is_retired(p_user uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.media_key_is_retired_core(p_user, p_key)
$$;

CREATE FUNCTION public.claim_tombstoned_image_purge(
  p_claim_id uuid,
  p_image_id bigint,
  p_restore_window_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.claim_tombstoned_image_purge_core(p_claim_id, p_image_id, p_restore_window_days)
$$;

CREATE FUNCTION public.claim_retired_key_sweep(p_limit integer DEFAULT 50)
RETURNS TABLE (
  retirement_id bigint,
  user_id uuid,
  image_id bigint,
  reason text,
  delete_keys text[],
  status text,
  blocking_references jsonb,
  image_exists boolean,
  image_purged_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.claim_retired_key_sweep_core(p_limit)
$$;

CREATE FUNCTION public.begin_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.begin_account_deletion_core(p_user_id)
$$;

CREATE FUNCTION public.erase_account_media_retirements(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.erase_account_media_retirements_core(p_user_id)
$$;

CREATE FUNCTION public.record_retired_key_sweep(p_retirement_ids bigint[])
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.record_retired_key_sweep_core(p_retirement_ids)
$$;

-- =============================================================
-- 9. Function privileges: revoke from every client role, then grant
--    exactly the intended one. Cores, the guard and the other helpers get no
--    grants; only the index-expression helper media_key_root is granted to
--    the writing roles (see below).
-- =============================================================

REVOKE EXECUTE ON FUNCTION
  private.media_key_normalize(text),
  private.media_key_strip_variant_prefixes(text),
  private.media_key_root(text),
  private.media_key_family(text),
  private.lock_media_key_roots(text[]),
  private.media_key_require_read_committed(),
  private.media_key_registry_immutable(),
  private.media_key_references(text[]),
  private.media_key_owner_references(text[], uuid),
  private.media_key_is_valid(text),
  private.media_key_retirement_guard(),
  private.media_key_retirement_replay(uuid, uuid, bigint, text),
  private.release_observation_image_bytes_core(uuid, bigint, text, text, text),
  private.claim_tombstoned_image_purge_core(uuid, bigint, integer),
  private.claim_retired_key_sweep_core(integer),
  private.record_retired_key_sweep_core(bigint[]),
  private.media_key_is_retired_core(uuid, text),
  private.media_key_registry_erasable(uuid),
  private.erase_account_media_retirements_core(uuid),
  public.erase_account_media_retirements(uuid),
  private.begin_account_deletion_core(uuid),
  public.begin_account_deletion(uuid),
  public.release_observation_image_bytes(uuid, bigint, text, text, text),
  public.media_key_is_retired(uuid, text),
  public.claim_tombstoned_image_purge(uuid, bigint, integer),
  public.claim_retired_key_sweep(integer),
  public.record_retired_key_sweep(bigint[])
FROM PUBLIC, anon, authenticated, service_role;

-- The expression indexes evaluate private.media_key_root as the WRITING
-- role, so every role that writes the five tables needs EXECUTE on it (it
-- is a pure, self-contained string function with no data access; no USAGE
-- on schema private is granted). anon does not write these tables.
GRANT EXECUTE ON FUNCTION private.media_key_root(text) TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.release_observation_image_bytes(uuid, bigint, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.media_key_is_retired(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_tombstoned_image_purge(uuid, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_retired_key_sweep(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_retired_key_sweep(bigint[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.erase_account_media_retirements(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_account_deletion(uuid) TO service_role;

-- finalize_observation_image_purge keeps its 20260809130000 grants
-- (service_role only); CREATE OR REPLACE preserves them.

-- =============================================================
-- 10. Expression indexes (reference checks query the same expressions).
-- =============================================================

CREATE INDEX observation_images_storage_path_key_root_idx
  ON public.observation_images (private.media_key_root(storage_path))
  WHERE storage_path IS NOT NULL;
CREATE INDEX observation_images_original_storage_path_key_root_idx
  ON public.observation_images (private.media_key_root(original_storage_path))
  WHERE original_storage_path IS NOT NULL;
CREATE INDEX spore_measurements_image_key_key_root_idx
  ON public.spore_measurements (private.media_key_root(image_key))
  WHERE image_key IS NOT NULL;
CREATE INDEX spore_measurements_thumb_key_key_root_idx
  ON public.spore_measurements (private.media_key_root(thumb_key))
  WHERE thumb_key IS NOT NULL;
CREATE INDEX observations_image_key_key_root_idx
  ON public.observations (private.media_key_root(image_key))
  WHERE image_key IS NOT NULL;
CREATE INDEX observations_thumb_key_key_root_idx
  ON public.observations (private.media_key_root(thumb_key))
  WHERE thumb_key IS NOT NULL;
-- storage_key is NOT NULL, so the planner drops "IS NOT NULL" from queries
-- and could not match a partial predicate: a full index.
CREATE INDEX spore_measurement_mosaics_storage_key_key_root_idx
  ON public.spore_measurement_mosaics (private.media_key_root(storage_key));
CREATE INDEX calibrations_image_storage_path_key_root_idx
  ON public.calibrations (private.media_key_root(image_storage_path))
  WHERE image_storage_path IS NOT NULL;

-- =============================================================
-- 11. Obsolete-desktop brake: accept sync identity '2' or '3'.
--     Body of 20261015090000 verbatim except the identity test.
-- =============================================================

CREATE OR REPLACE FUNCTION private.sync_brake_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_headers jsonb := nullif(current_setting('request.headers', true), '')::jsonb;
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role    text;
  v_ua      text;
BEGIN
  IF v_headers IS NULL THEN
    RETURN coalesce(NEW, OLD);              -- not an API request
  END IF;
  v_role := coalesce(v_claims ->> 'role', '');
  IF v_role NOT IN ('authenticated', 'anon') THEN
    RETURN coalesce(NEW, OLD);              -- service_role and server roles
  END IF;
  IF coalesce(v_headers ->> 'x-sporely-sync-identity', '') IN ('2', '3') THEN
    RETURN coalesce(NEW, OLD);              -- sync-key desktop (identity 2 or 3)
  END IF;
  v_ua := lower(coalesce(v_headers ->> 'user-agent', ''));
  IF v_ua LIKE 'python-requests/%' THEN
    RAISE EXCEPTION 'Sporely Desktop must be updated before it can upload to Sporely Cloud. Install the latest version from sporely.no. Nothing was changed in the cloud.'
      USING ERRCODE = 'P0001', HINT = 'sporely_upgrade_required';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;

COMMENT ON FUNCTION private.sync_brake_guard() IS
  'Obsolete-desktop sync brake (20261015090000; identity 3 accepted since 20261020120000). Refuses row writes from shipped desktops (python-requests User-Agent, end-user JWT, no x-sporely-sync-identity: 2 or 3) with P0001 / sporely_upgrade_required. Not an authorization boundary. Removed only by the sync-key cutover migration, never as a rollback.';

-- =============================================================
-- 12. admin_database_health: classify the registry tables as operator
--     control data. 20261020100100's body verbatim, plus one rule.
-- =============================================================

CREATE OR REPLACE FUNCTION private.admin_database_health_classify(
  p_schema text,
  p_table text,
  p_has_release_id boolean DEFAULT false
)
RETURNS TABLE (category text, component text)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT x[1], x[2]
  FROM (
    SELECT CASE
      -- 1. One row per observation; grows with observations, not releases.
      WHEN p_schema = 'taxonomy_v3' AND p_table IN ('identification_snapshot', 'resolution_link')
        THEN ARRAY['user_data', 'observations']

      -- 2. Taxonomy, matched by pattern.
      WHEN p_schema ~ '^taxonomy_v[0-9]+$'
        THEN ARRAY['taxonomy_reference', p_schema]
      WHEN p_schema = 'public' AND p_table ~ '^taxonomy_' AND p_has_release_id
           AND p_table !~ '_(releases|import_runs)$'
        THEN ARRAY['taxonomy_reference', 'taxonomy_release_payload']
      WHEN p_schema = 'public' AND p_table ~ '^taxonomy_'
        THEN ARRAY['taxonomy_reference', 'taxonomy_registry']
      WHEN p_schema = 'public' AND (p_table ~ '^taxa(_|$)' OR p_table ~ '^taxon_')
        THEN ARRAY['taxonomy_reference', 'legacy_taxonomy']
      WHEN p_schema = 'private' AND p_table ~ '^(taxon_identity_repair|retired_resolution_repair)_'
        THEN ARRAY['taxonomy_reference', 'taxonomy_maintenance']

      -- 3. Other reference datasets, platform and operations.
      WHEN p_schema = 'public' AND p_table IN ('spatial_ref_sys', 'public_regions')
        THEN ARRAY['taxonomy_reference', 'other_reference']
      WHEN p_schema IN ('pg_catalog', 'information_schema')
        THEN ARRAY['system_other', 'postgres_catalog']
      WHEN p_schema ~ '^pg_(toast_)?temp_'
        THEN ARRAY['system_other', 'temporary']
      WHEN p_schema IN (
        'auth', 'storage', 'realtime', '_realtime', 'vault', 'cron', 'net',
        'supabase_migrations', 'supabase_functions', 'extensions', 'graphql',
        'graphql_public', 'pgsodium', 'pgsodium_masks', 'pgbouncer', '_analytics',
        'pgmq', 'supabase_admin'
      )
        THEN ARRAY['system_other', 'supabase_platform']
      WHEN p_schema = 'public' AND p_table IN (
        'admin_action_log', 'client_activity_daily',
        'media_object_deletion_accounting', '_media_worker_config'
      )
        THEN ARRAY['system_other', 'app_operations']
      WHEN p_schema = 'private' AND p_table = 'sync_client_write_block'
        THEN ARRAY['system_other', 'app_operations']
      WHEN p_schema = 'private' AND p_table IN ('media_key_retirements', 'retired_media_key_roots')
        THEN ARRAY['system_other', 'app_operations']

      -- 4. User data, by explicit allowlist.
      WHEN p_schema = 'public' AND p_table IN (
        'observations', 'observation_images', 'observation_identifications',
        'observation_shares', 'observation_spore_summaries',
        'observation_reference_uses', 'spore_measurements', 'spore_annotations',
        'spore_measurement_mosaics', 'spore_measurement_mosaic_tiles'
      )
        THEN ARRAY['user_data', 'observations']
      WHEN p_schema = 'public' AND p_table IN (
        'profiles', 'calibrations', 'comments', 'comment_moderation', 'follows',
        'friendships', 'user_blocks', 'reports'
      )
        THEN ARRAY['user_data', 'accounts_social']
      WHEN (p_schema = 'public' AND p_table IN (
             'reference_values', 'reference_works', 'reference_measurement_sets',
             'reference_taxon_treatments', 'reference_curated_forks',
             'reference_client_devices'
           ))
        OR (p_schema = 'private' AND p_table ~ '^(curated_reference|reference|shared_reference)_')
        THEN ARRAY['user_data', 'reference_library']

      -- 5. Never silently folded into user data.
      ELSE ARRAY['unclassified', 'unclassified']
    END AS x
  ) c;
$$;

ALTER FUNCTION private.admin_database_health_classify(text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_database_health_classify(text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
