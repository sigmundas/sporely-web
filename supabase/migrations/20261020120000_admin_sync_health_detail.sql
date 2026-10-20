-- Sync health S2b-1: warning rule fixes and a row drill-down.
--
-- Plan: sporely-admin docs/plans/2026-10-20-sync-health-monitoring.md, Stage S2b.
--
-- 1. CREATE OR REPLACE public.admin_sync_health(text): same signature, gate,
--    grants and schema_version 1. Additive changes only:
--    * media_metadata.live_with_bytes_no_path no longer counts
--      image_type = 'microscope' rows (pathless microscope anchors are valid);
--      they are counted in the new info-only microscope_anchors_with_bytes.
--    * each sync_key table entry gains null_sync_key_after_cutoff_desktop (row
--      has desktop_id) and null_sync_key_after_cutoff_other; the old
--      null_sync_key_after_cutoff stays as their sum. The after-cutoff warning
--      is now split: key null_sync_key_after_cutoff.<table>.desktop (watch) and
--      null_sync_key_after_cutoff.<table>.other (info). spore_measurements
--      stays null (measured_at is client-set).
--    * warnings whose rows can be listed carry detail_key. The two duplicate
--      warnings span tables, so they carry detail_keys (one per nonzero
--      table/rule) instead; each duplicate_groups.by_table_rule entry carries
--      its detail_key too.
-- 2. public.admin_sync_health_detail(p_key text, p_limit int default 50):
--    lists the rows behind one count. p_key is checked against a fixed list
--    (no dynamic SQL), p_limit is clamped to 1..200. Output:
--    {schema_version: 1, key, total, truncated, rows: [...]}, newest first,
--    then by id. Usernames come from public.profiles.username; no email.
--
-- Shared predicates: every listable metric is defined once in a private
-- STABLE SQL helper (search_path '', owner postgres, EXECUTE revoked from
-- everyone; the SECURITY DEFINER callers run as postgres). Both RPCs read the
-- same helper, so a summary count and its detail total cannot drift.
--
-- below_min_desktop uses the summary's default threshold (0.9.26): the detail
-- signature has no version parameter.

-- ---------------------------------------------------------------
-- Private helpers.
-- ---------------------------------------------------------------

-- Version parse: longer than 32 characters before trimming, or, once trimmed,
-- not 1-4 dot-separated groups of 1-5 ASCII digits -> NULL. Missing trailing
-- groups are 0.
CREATE OR REPLACE FUNCTION private.sync_health_parse_version(p_version text)
RETURNS integer[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN pg_catalog.length(p_version) <= 32
     AND pg_catalog.btrim(p_version) ~ '^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$'
    THEN ARRAY[
      coalesce(NULLIF(pg_catalog.split_part(pg_catalog.btrim(p_version), '.', 1), ''), '0')::integer,
      coalesce(NULLIF(pg_catalog.split_part(pg_catalog.btrim(p_version), '.', 2), ''), '0')::integer,
      coalesce(NULLIF(pg_catalog.split_part(pg_catalog.btrim(p_version), '.', 3), ''), '0')::integer,
      coalesce(NULLIF(pg_catalog.split_part(pg_catalog.btrim(p_version), '.', 4), ''), '0')::integer
    ]
  END
$$;

-- Desktop devices seen in the last 30 days.
CREATE OR REPLACE FUNCTION private.sync_health_desktop_devices()
RETURNS TABLE (user_id uuid, device_id uuid, app_version text, last_seen_at timestamptz,
               in_d7 boolean, parsed integer[])
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT rcd.user_id, rcd.device_id, rcd.app_version, rcd.last_seen_at,
         rcd.last_seen_at >= pg_catalog.now() - interval '7 days',
         private.sync_health_parse_version(rcd.app_version)
    FROM public.reference_client_devices rcd
   WHERE rcd.client = 'desktop_app'
     AND rcd.last_seen_at >= pg_catalog.now() - interval '30 days'
$$;

-- Live keyless observations and images created on or after the sync_key
-- migration date (2026-10-13 00:00 UTC). from_desktop: the row has desktop_id.
CREATE OR REPLACE FUNCTION private.sync_health_keyless_after_cutoff()
RETURNS TABLE (tbl text, id bigint, observation_id bigint, user_id uuid,
               created_at timestamptz, from_desktop boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 'observations'::text, o.id, o.id, o.user_id, o.created_at, o.desktop_id IS NOT NULL
    FROM public.observations o
   WHERE o.sync_key IS NULL AND o.created_at >= '2026-10-13 00:00:00+00'::timestamptz
  UNION ALL
  SELECT 'observation_images', i.id, i.observation_id, i.user_id, i.created_at, i.desktop_id IS NOT NULL
    FROM public.observation_images i
   WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
     AND i.sync_key IS NULL AND i.created_at >= '2026-10-13 00:00:00+00'::timestamptz
$$;

-- Live rows carrying both sync_key and desktop_id. Measurements have no
-- server creation time; created_at is their client-set measured_at.
CREATE OR REPLACE FUNCTION private.sync_health_keyed_with_desktop_id()
RETURNS TABLE (tbl text, id bigint, observation_id bigint, user_id uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 'observations'::text, o.id, o.id, o.user_id, o.created_at
    FROM public.observations o
   WHERE o.sync_key IS NOT NULL AND o.desktop_id IS NOT NULL
  UNION ALL
  SELECT 'observation_images', i.id, i.observation_id, i.user_id, i.created_at
    FROM public.observation_images i
   WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
     AND i.sync_key IS NOT NULL AND i.desktop_id IS NOT NULL
  UNION ALL
  SELECT 'spore_measurements', m.id, i.observation_id, m.user_id, m.measured_at
    FROM public.spore_measurements m
    JOIN public.observation_images i ON i.id = m.image_id
   WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
     AND m.sync_key IS NOT NULL AND m.desktop_id IS NOT NULL
$$;

-- Duplicate groups, rule (b), live rows only.
--   shared_key: >= 2 rows with the same (user_id, sync_key).
--   keyed_keyless_twin: a keyed and a keyless row that look like the same
--     record. Images: same (user_id, observation_id, original_filename
--     (non-blank), image_type). Measurements: same (user_id, image_id,
--     measurement_type, length_um, width_um).
-- ids are sorted; created_at is the newest member (measured_at for
-- measurements).
CREATE OR REPLACE FUNCTION private.sync_health_duplicate_groups()
RETURNS TABLE (tbl text, rule text, user_id uuid, observation_id bigint, ids bigint[], created_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH live_images AS (
    SELECT i.id, i.user_id, i.observation_id, i.sync_key, i.original_filename, i.image_type, i.created_at
      FROM public.observation_images i
     WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
  ),
  meas AS (
    SELECT m.id, m.user_id, m.image_id, i.observation_id, m.sync_key,
           m.measurement_type, m.length_um, m.width_um, m.measured_at
      FROM public.spore_measurements m
      JOIN public.observation_images i ON i.id = m.image_id
     WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
  )
  SELECT 'observation_images'::text, 'shared_key'::text, li.user_id,
         CASE WHEN min(li.observation_id) = max(li.observation_id) THEN min(li.observation_id) END,
         pg_catalog.array_agg(li.id ORDER BY li.id), max(li.created_at)
    FROM live_images li
   WHERE li.sync_key IS NOT NULL
   GROUP BY li.user_id, li.sync_key
  HAVING count(*) >= 2
  UNION ALL
  SELECT 'spore_measurements', 'shared_key', me.user_id,
         CASE WHEN min(me.observation_id) = max(me.observation_id) THEN min(me.observation_id) END,
         pg_catalog.array_agg(me.id ORDER BY me.id), max(me.measured_at)
    FROM meas me
   WHERE me.sync_key IS NOT NULL
   GROUP BY me.user_id, me.sync_key
  HAVING count(*) >= 2
  UNION ALL
  SELECT 'observation_images', 'keyed_keyless_twin', li.user_id, li.observation_id,
         pg_catalog.array_agg(li.id ORDER BY li.id), max(li.created_at)
    FROM live_images li
   WHERE NULLIF(pg_catalog.btrim(li.original_filename), '') IS NOT NULL
   GROUP BY li.user_id, li.observation_id, li.original_filename, li.image_type
  HAVING count(*) FILTER (WHERE li.sync_key IS NOT NULL) >= 1
     AND count(*) FILTER (WHERE li.sync_key IS NULL) >= 1
  UNION ALL
  SELECT 'spore_measurements', 'keyed_keyless_twin', me.user_id, min(me.observation_id),
         pg_catalog.array_agg(me.id ORDER BY me.id), max(me.measured_at)
    FROM meas me
   GROUP BY me.user_id, me.image_id, me.measurement_type, me.length_um, me.width_um
  HAVING count(*) FILTER (WHERE me.sync_key IS NOT NULL) >= 1
     AND count(*) FILTER (WHERE me.sync_key IS NULL) >= 1
$$;

-- Live images with recorded bytes and no storage path. is_microscope rows are
-- metadata-only anchors (valid); the rest are the consistency warning.
CREATE OR REPLACE FUNCTION private.sync_health_bytes_no_path()
RETURNS TABLE (id bigint, observation_id bigint, user_id uuid, created_at timestamptz, is_microscope boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT i.id, i.observation_id, i.user_id, i.created_at, i.image_type IS NOT DISTINCT FROM 'microscope'
    FROM public.observation_images i
   WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
     AND coalesce(i.stored_bytes, 0) > 0
     AND NULLIF(pg_catalog.btrim(i.storage_path), '') IS NULL
$$;

CREATE OR REPLACE FUNCTION private.sync_health_external_unresolved()
RETURNS TABLE (id bigint, user_id uuid, created_at timestamptz,
               taxon_identity_external_id text, taxon_identity_namespace text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT o.id, o.user_id, o.created_at, o.taxon_identity_external_id::text, o.taxon_identity_namespace::text
    FROM public.observations o
   WHERE o.taxon_identity_state = 'external_unresolved'
$$;

ALTER FUNCTION private.sync_health_parse_version(text) OWNER TO postgres;
ALTER FUNCTION private.sync_health_desktop_devices() OWNER TO postgres;
ALTER FUNCTION private.sync_health_keyless_after_cutoff() OWNER TO postgres;
ALTER FUNCTION private.sync_health_keyed_with_desktop_id() OWNER TO postgres;
ALTER FUNCTION private.sync_health_duplicate_groups() OWNER TO postgres;
ALTER FUNCTION private.sync_health_bytes_no_path() OWNER TO postgres;
ALTER FUNCTION private.sync_health_external_unresolved() OWNER TO postgres;

REVOKE ALL ON FUNCTION private.sync_health_parse_version(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_health_desktop_devices() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_health_keyless_after_cutoff() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_health_keyed_with_desktop_id() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_health_duplicate_groups() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_health_bytes_no_path() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_health_external_unresolved() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------
-- public.admin_sync_health (replaced; see 20261020100000 for the base
-- contract and its security notes, which still hold).
-- ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_sync_health(
  p_min_desktop_version text DEFAULT '0.9.26'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_sync_key_cutoff constant timestamptz := '2026-10-13 00:00:00+00';
  c_list_limit constant integer := 50;
  c_ids_limit constant integer := 10;
  c_runs_limit constant integer := 5;
  v_user uuid := auth.uid();
  v_is_admin boolean;
  v_now timestamptz := pg_catalog.now();
  v_today date := (pg_catalog.now() AT TIME ZONE 'utc')::date;
  v_min_text text;
  v_min integer[];
  v_write_block jsonb;
  v_write_block_count integer;
  v_desktop jsonb;
  v_activity jsonb;
  v_tables jsonb;
  v_dups jsonb;
  v_dup_counts jsonb;
  v_dup_keys jsonb;
  v_media jsonb;
  v_taxonomy jsonb;
  v_external_unresolved bigint;
  v_warnings jsonb := '[]'::jsonb;
  r record;
BEGIN
  -- Gate first, before any read.
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'admin_sync_health requires an authenticated user';
  END IF;

  SELECT p.is_admin INTO v_is_admin FROM public.profiles p WHERE p.id = v_user;
  IF coalesce(v_is_admin, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_sync_health requires an admin profile';
  END IF;

  -- Parameter: same parse as stored versions; unparseable raises.
  v_min_text := pg_catalog.btrim(p_min_desktop_version);
  v_min := private.sync_health_parse_version(p_min_desktop_version);
  IF v_min IS NULL THEN
    RAISE EXCEPTION 'admin_sync_health: p_min_desktop_version must look like 1.2.3 (1-4 numeric parts)';
  END IF;

  -- -------------------------------------------------------------
  -- Desktop write stop.
  -- -------------------------------------------------------------
  SELECT count(*)::integer INTO v_write_block_count FROM private.sync_client_write_block;

  SELECT pg_catalog.jsonb_build_object(
           'count', v_write_block_count,
           'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                     'client_version', t.client_version,
                     'reason', pg_catalog.left(t.reason, 200),
                     'created_at', t.created_at)
                   ORDER BY t.created_at DESC, t.client_version), '[]'::jsonb))
    INTO v_write_block
    FROM (
      SELECT b.client_version, b.reason, b.created_at
        FROM private.sync_client_write_block b
       ORDER BY b.created_at DESC, b.client_version
       LIMIT c_list_limit
    ) t;

  -- -------------------------------------------------------------
  -- Desktop versions (reference_client_devices, client = desktop_app).
  -- -------------------------------------------------------------
  WITH d AS (
    SELECT * FROM private.sync_health_desktop_devices()
  ),
  by_version AS (
    SELECT d.app_version,
           count(*)::integer AS devices,
           count(DISTINCT d.user_id)::integer AS users
      FROM d
     WHERE d.in_d7
     GROUP BY d.app_version
  ),
  by_version_listed AS (
    SELECT * FROM by_version
     ORDER BY devices DESC, users DESC, app_version
     LIMIT c_list_limit
  )
  SELECT pg_catalog.jsonb_build_object(
    'source', 'reference_client_devices',
    'reporting', pg_catalog.jsonb_build_object(
      'd7', pg_catalog.jsonb_build_object(
        'devices', (SELECT count(*) FROM d WHERE d.in_d7),
        'users', (SELECT count(DISTINCT d.user_id) FROM d WHERE d.in_d7)),
      'd30', pg_catalog.jsonb_build_object(
        'devices', (SELECT count(*) FROM d),
        'users', (SELECT count(DISTINCT d.user_id) FROM d))),
    'below_min', pg_catalog.jsonb_build_object(
      'd7', pg_catalog.jsonb_build_object(
        'devices', (SELECT count(*) FROM d WHERE d.in_d7 AND d.parsed < v_min),
        'users', (SELECT count(DISTINCT d.user_id) FROM d WHERE d.in_d7 AND d.parsed < v_min)),
      'd30', pg_catalog.jsonb_build_object(
        'devices', (SELECT count(*) FROM d WHERE d.parsed < v_min),
        'users', (SELECT count(DISTINCT d.user_id) FROM d WHERE d.parsed < v_min))),
    'unparseable_d30', (SELECT count(*) FROM d WHERE d.parsed IS NULL),
    'by_version_d7', pg_catalog.jsonb_build_object(
      'total', (SELECT count(*) FROM by_version),
      'truncated', (SELECT count(*) FROM by_version) > c_list_limit,
      'rows', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'app_version', l.app_version, 'devices', l.devices, 'users', l.users)
               ORDER BY l.devices DESC, l.users DESC, l.app_version)
          FROM by_version_listed l), '[]'::jsonb))
  ) INTO v_desktop;

  -- -------------------------------------------------------------
  -- client_activity_daily, last 7 UTC days.
  -- -------------------------------------------------------------
  WITH g AS (
    SELECT cad.client, cad.app_version, count(DISTINCT cad.user_id)::integer AS users
      FROM public.client_activity_daily cad
     WHERE cad.activity_date >= v_today - 6
     GROUP BY cad.client, cad.app_version
  )
  SELECT pg_catalog.jsonb_build_object(
    'total', (SELECT count(*) FROM g),
    'truncated', (SELECT count(*) FROM g) > c_list_limit,
    'rows', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'client', l.client, 'app_version', l.app_version, 'users', l.users)
             ORDER BY l.users DESC, l.client, l.app_version)
        FROM (SELECT * FROM g ORDER BY g.users DESC, g.client, g.app_version LIMIT c_list_limit) l),
      '[]'::jsonb)
  ) INTO v_activity;

  -- -------------------------------------------------------------
  -- sync_key coverage. live_rows and null_sync_key are summary-only; the
  -- listable counts come from the shared helpers.
  -- -------------------------------------------------------------
  WITH ac AS (
    SELECT a.tbl,
           count(*) FILTER (WHERE a.from_desktop) AS n_desktop,
           count(*) FILTER (WHERE NOT a.from_desktop) AS n_other
      FROM private.sync_health_keyless_after_cutoff() a
     GROUP BY a.tbl
  ),
  kd AS (
    SELECT k.tbl, count(*) AS n FROM private.sync_health_keyed_with_desktop_id() k GROUP BY k.tbl
  ),
  base AS (
    SELECT 1 AS ord, 'observations'::text AS tbl, count(*) AS live_rows,
           count(*) FILTER (WHERE o.sync_key IS NULL) AS null_sync_key
      FROM public.observations o
    UNION ALL
    SELECT 2, 'observation_images', count(*), count(*) FILTER (WHERE i.sync_key IS NULL)
      FROM public.observation_images i
     WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
    UNION ALL
    SELECT 3, 'spore_measurements', count(*), count(*) FILTER (WHERE m.sync_key IS NULL)
      FROM public.spore_measurements m
      JOIN public.observation_images i ON i.id = m.image_id
     WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
  )
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'table', b.tbl,
           'live_rows', b.live_rows,
           'null_sync_key', b.null_sync_key,
           -- spore_measurements: no server-set creation time (measured_at is
           -- client-supplied), so null = "not measurable", never 0.
           'null_sync_key_after_cutoff',
             CASE WHEN b.tbl <> 'spore_measurements' THEN coalesce(ac.n_desktop, 0) + coalesce(ac.n_other, 0) END,
           'null_sync_key_after_cutoff_desktop',
             CASE WHEN b.tbl <> 'spore_measurements' THEN coalesce(ac.n_desktop, 0) END,
           'null_sync_key_after_cutoff_other',
             CASE WHEN b.tbl <> 'spore_measurements' THEN coalesce(ac.n_other, 0) END,
           'keyed_with_desktop_id', coalesce(kd.n, 0))
         ORDER BY b.ord)
    INTO v_tables
    FROM base b
    LEFT JOIN ac ON ac.tbl = b.tbl
    LEFT JOIN kd ON kd.tbl = b.tbl;

  -- -------------------------------------------------------------
  -- Duplicate groups, rule (b) (private.sync_health_duplicate_groups).
  -- -------------------------------------------------------------
  WITH groups AS (
    SELECT * FROM private.sync_health_duplicate_groups()
  ),
  listed AS (
    SELECT * FROM groups g
     ORDER BY CASE g.rule WHEN 'shared_key' THEN 0 ELSE 1 END, g.tbl, g.user_id, g.ids[1]
     LIMIT c_list_limit
  ),
  counts AS (
    SELECT g.tbl, g.rule, count(*) AS n FROM groups g GROUP BY g.tbl, g.rule
  )
  SELECT pg_catalog.jsonb_build_object(
           'total', (SELECT count(*) FROM groups),
           'truncated', (SELECT count(*) FROM groups) > c_list_limit,
           'rows', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'table', l.tbl,
                      'rule', l.rule,
                      'user_id', l.user_id,
                      'observation_id', l.observation_id,
                      'ids', pg_catalog.to_jsonb(l.ids[1:c_ids_limit]),
                      'ids_truncated', pg_catalog.cardinality(l.ids) > c_ids_limit)
                    ORDER BY CASE l.rule WHEN 'shared_key' THEN 0 ELSE 1 END, l.tbl, l.user_id, l.ids[1])
               FROM listed l), '[]'::jsonb),
           -- Per (table, rule) counts, so groups cut by the list cap still show.
           'by_table_rule', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'table', c.tbl, 'rule', c.rule, 'count', c.n,
                      'detail_key', 'duplicate_groups.' || c.tbl || '.' || c.rule) ORDER BY c.tbl, c.rule)
               FROM counts c), '[]'::jsonb)),
         pg_catalog.jsonb_build_object(
           'shared_key', (SELECT count(*) FROM groups g WHERE g.rule = 'shared_key'),
           'keyed_keyless_twin', (SELECT count(*) FROM groups g WHERE g.rule = 'keyed_keyless_twin')),
         pg_catalog.jsonb_build_object(
           'shared_key', coalesce((SELECT pg_catalog.jsonb_agg('duplicate_groups.' || c.tbl || '.' || c.rule ORDER BY c.tbl)
                                     FROM counts c WHERE c.rule = 'shared_key'), '[]'::jsonb),
           'keyed_keyless_twin', coalesce((SELECT pg_catalog.jsonb_agg('duplicate_groups.' || c.tbl || '.' || c.rule ORDER BY c.tbl)
                                             FROM counts c WHERE c.rule = 'keyed_keyless_twin'), '[]'::jsonb))
    INTO v_dups, v_dup_counts, v_dup_keys;

  -- -------------------------------------------------------------
  -- Media metadata consistency. Pathless microscope rows are anchors, valid
  -- and info-only.
  -- -------------------------------------------------------------
  SELECT pg_catalog.jsonb_build_object(
           'live_with_bytes_no_path',
             (SELECT count(*) FROM private.sync_health_bytes_no_path() b WHERE NOT b.is_microscope),
           'microscope_anchors_with_bytes',
             (SELECT count(*) FROM private.sync_health_bytes_no_path() b WHERE b.is_microscope),
           'recorded_primary_bytes', coalesce(sum(i.stored_bytes), 0))
    INTO v_media
    FROM public.observation_images i
   WHERE i.deleted_at IS NULL AND i.purged_at IS NULL;

  -- -------------------------------------------------------------
  -- Taxonomy identity state and recent repair runs.
  -- -------------------------------------------------------------
  SELECT count(*) INTO v_external_unresolved FROM private.sync_health_external_unresolved();

  SELECT pg_catalog.jsonb_build_object(
    'by_state', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('state', s.state, 'count', s.n) ORDER BY s.state)
        FROM (SELECT coalesce(o.taxon_identity_state, 'legacy_null') AS state, count(*) AS n
                FROM public.observations o
               GROUP BY 1) s), '[]'::jsonb),
    'repair_runs', pg_catalog.jsonb_build_object(
      'taxon_identity', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'run_id', t.run_id, 'release_id', t.release_id,
                 'candidate_count', t.candidate_count, 'promoted_count', t.promoted_count,
                 'outcome_counts', t.outcome_counts, 'applied_at', t.applied_at)
               ORDER BY t.applied_at DESC, t.run_id DESC)
          FROM (SELECT * FROM private.taxon_identity_repair_runs x
                 ORDER BY x.applied_at DESC, x.run_id DESC LIMIT c_runs_limit) t), '[]'::jsonb),
      'retired_resolution', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'run_id', t.run_id, 'release_id', t.release_id,
                 'link_count', t.link_count, 'observation_count', t.observation_count,
                 'orphan_link_count', t.orphan_link_count,
                 'registry_added_count', t.registry_added_count, 'applied_at', t.applied_at)
               ORDER BY t.applied_at DESC, t.run_id DESC)
          FROM (SELECT * FROM private.retired_resolution_repair_runs x
                 ORDER BY x.applied_at DESC, x.run_id DESC LIMIT c_runs_limit) t), '[]'::jsonb))
  ) INTO v_taxonomy;

  -- -------------------------------------------------------------
  -- Warnings: the one authoritative severity policy.
  -- -------------------------------------------------------------
  IF v_write_block_count > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'write_block_active', 'severity', 'warning',
      'detail_key', 'write_block',
      'message', pg_catalog.format('%s desktop version(s) are blocked from writing synced rows.', v_write_block_count));
  END IF;

  IF (v_desktop #>> '{below_min,d7,devices}')::bigint > 0 THEN
    -- The detail lists against the default 0.9.26 only; other thresholds get no detail_key.
    v_warnings := v_warnings || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'key', 'desktop_below_min_d7', 'severity', 'warning',
      'detail_key', CASE WHEN v_min = private.sync_health_parse_version('0.9.26') THEN 'below_min_desktop' END,
      'message', pg_catalog.format('%s desktop device(s) seen in the last 7 days report a version below %s.',
        v_desktop #>> '{below_min,d7,devices}', v_min_text)));
  END IF;

  IF (v_dup_counts ->> 'shared_key')::bigint > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'sync_key_shared_key', 'severity', 'warning',
      'detail_keys', v_dup_keys -> 'shared_key',
      'message', pg_catalog.format('%s group(s) of live rows share one sync_key; the unique index should prevent this.',
        v_dup_counts ->> 'shared_key'));
  END IF;

  FOR r IN SELECT e FROM pg_catalog.jsonb_array_elements(v_tables) AS e LOOP
    IF (r.e ->> 'keyed_with_desktop_id')::bigint > 0 THEN
      v_warnings := v_warnings || pg_catalog.jsonb_build_object(
        'key', 'keyed_with_desktop_id.' || (r.e ->> 'table'), 'severity', 'watch',
        'detail_key', 'keyed_with_desktop_id.' || (r.e ->> 'table'),
        'message', pg_catalog.format('%s %s row(s) carry both sync_key and desktop_id.',
          r.e ->> 'keyed_with_desktop_id', r.e ->> 'table'));
    END IF;
    -- A null count (spore_measurements) is not measurable and never fires.
    IF (r.e ->> 'null_sync_key_after_cutoff_desktop')::bigint > 0 THEN
      v_warnings := v_warnings || pg_catalog.jsonb_build_object(
        'key', 'null_sync_key_after_cutoff.' || (r.e ->> 'table') || '.desktop', 'severity', 'watch',
        'detail_key', 'null_sync_key_after_cutoff.' || (r.e ->> 'table') || '.desktop',
        'message', pg_catalog.format('%s %s row(s) with desktop_id and without sync_key were created after the sync_key migration (2026-10-13).',
          r.e ->> 'null_sync_key_after_cutoff_desktop', r.e ->> 'table'));
    END IF;
    IF (r.e ->> 'null_sync_key_after_cutoff_other')::bigint > 0 THEN
      v_warnings := v_warnings || pg_catalog.jsonb_build_object(
        'key', 'null_sync_key_after_cutoff.' || (r.e ->> 'table') || '.other', 'severity', 'info',
        'detail_key', 'null_sync_key_after_cutoff.' || (r.e ->> 'table') || '.other',
        'message', pg_catalog.format('%s %s row(s) without sync_key or desktop_id were created after the sync_key migration (2026-10-13), likely from older web or Android builds.',
          r.e ->> 'null_sync_key_after_cutoff_other', r.e ->> 'table'));
    END IF;
  END LOOP;

  IF (v_dup_counts ->> 'keyed_keyless_twin')::bigint > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'sync_key_keyed_keyless_twin', 'severity', 'watch',
      'detail_keys', v_dup_keys -> 'keyed_keyless_twin',
      'message', pg_catalog.format('%s group(s) pair a keyed row with a keyless twin.', v_dup_counts ->> 'keyed_keyless_twin'));
  END IF;

  IF v_external_unresolved > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'taxonomy_external_unresolved', 'severity', 'watch',
      'detail_key', 'external_unresolved',
      'message', pg_catalog.format('%s observation(s) hold an unresolved external taxon identity.', v_external_unresolved));
  END IF;

  IF (v_media ->> 'live_with_bytes_no_path')::bigint > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'media_bytes_no_path', 'severity', 'watch',
      'detail_key', 'media_bytes_no_path',
      'message', pg_catalog.format('%s live non-microscope image(s) record stored bytes but have no storage path.',
        v_media ->> 'live_with_bytes_no_path'));
  END IF;

  IF (SELECT sum((e ->> 'null_sync_key')::bigint) FROM pg_catalog.jsonb_array_elements(v_tables) AS e) > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'legacy_keyless_rows', 'severity', 'info',
      'message', pg_catalog.format('%s live row(s) have no sync_key (legacy, keyed by desktop_id or created before sync keys).',
        (SELECT sum((e ->> 'null_sync_key')::bigint) FROM pg_catalog.jsonb_array_elements(v_tables) AS e)));
  END IF;

  IF (v_desktop ->> 'unparseable_d30')::bigint > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'desktop_unparseable_d30', 'severity', 'info',
      'message', pg_catalog.format('%s desktop device(s) seen in the last 30 days report an unparseable version.',
        v_desktop ->> 'unparseable_d30'));
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'generated_at', v_now,
    'min_desktop_version', v_min_text,
    'write_block', v_write_block,
    'desktop_versions', v_desktop,
    'activity_by_version_d7', v_activity,
    'sync_key', pg_catalog.jsonb_build_object(
      'cutoff', c_sync_key_cutoff,
      'tables', v_tables,
      'duplicate_groups', v_dups),
    'media_metadata', v_media,
    'taxonomy', v_taxonomy,
    'warnings', v_warnings
  );
END;
$$;

ALTER FUNCTION public.admin_sync_health(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.admin_sync_health(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_sync_health(text) TO authenticated;

-- ---------------------------------------------------------------
-- public.admin_sync_health_detail
-- ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_sync_health_detail(
  p_key text,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_ids_limit constant integer := 10;
  c_keys constant text[] := ARRAY[
    'write_block',
    'below_min_desktop',
    'null_sync_key_after_cutoff.observations.desktop',
    'null_sync_key_after_cutoff.observations.other',
    'null_sync_key_after_cutoff.observation_images.desktop',
    'null_sync_key_after_cutoff.observation_images.other',
    'keyed_with_desktop_id.observations',
    'keyed_with_desktop_id.observation_images',
    'keyed_with_desktop_id.spore_measurements',
    'duplicate_groups.observation_images.shared_key',
    'duplicate_groups.observation_images.keyed_keyless_twin',
    'duplicate_groups.spore_measurements.shared_key',
    'duplicate_groups.spore_measurements.keyed_keyless_twin',
    'external_unresolved',
    'media_bytes_no_path',
    'microscope_anchors_with_bytes'
  ];
  v_user uuid := auth.uid();
  v_is_admin boolean;
  v_limit integer;
  v_family text;
  v_tbl text;
  v_part text;
  v_min integer[];
  v_total bigint;
  v_rows jsonb;
BEGIN
  -- Gate first, before any read.
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'admin_sync_health_detail requires an authenticated user';
  END IF;

  SELECT p.is_admin INTO v_is_admin FROM public.profiles p WHERE p.id = v_user;
  IF coalesce(v_is_admin, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_sync_health_detail requires an admin profile';
  END IF;

  -- Fixed allowlist; the error never echoes the input.
  IF p_key IS NULL OR NOT (p_key = ANY (c_keys)) THEN
    RAISE EXCEPTION 'admin_sync_health_detail: unknown key';
  END IF;

  v_limit := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  -- Safe: p_key is one of the literals above.
  v_family := pg_catalog.split_part(p_key, '.', 1);
  v_tbl := pg_catalog.split_part(p_key, '.', 2);
  v_part := pg_catalog.split_part(p_key, '.', 3);

  IF v_family = 'write_block' THEN
    SELECT count(*) INTO v_total FROM private.sync_client_write_block;
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'client_version', t.client_version,
             'reason', pg_catalog.left(t.reason, 200),
             'created_at', t.created_at)
           ORDER BY t.created_at DESC, t.client_version), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT b.client_version, b.reason, b.created_at
              FROM private.sync_client_write_block b
             ORDER BY b.created_at DESC, b.client_version
             LIMIT v_limit) t;

  ELSIF v_family = 'below_min_desktop' THEN
    v_min := private.sync_health_parse_version('0.9.26');
    SELECT count(*) INTO v_total
      FROM private.sync_health_desktop_devices() d WHERE d.in_d7 AND d.parsed < v_min;
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'device_id', t.device_id,
             'user_id', t.user_id,
             'username', t.username,
             'client', 'desktop_app',
             'app_version', t.app_version,
             'last_seen_at', t.last_seen_at)
           ORDER BY t.last_seen_at DESC, t.device_id), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT d.device_id, d.user_id, p.username, d.app_version, d.last_seen_at
              FROM private.sync_health_desktop_devices() d
              LEFT JOIN public.profiles p ON p.id = d.user_id
             WHERE d.in_d7 AND d.parsed < v_min
             ORDER BY d.last_seen_at DESC, d.device_id
             LIMIT v_limit) t;

  ELSIF v_family = 'null_sync_key_after_cutoff' THEN
    SELECT count(*) INTO v_total
      FROM private.sync_health_keyless_after_cutoff() a
     WHERE a.tbl = v_tbl AND a.from_desktop = (v_part = 'desktop');
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id', t.id, 'table', t.tbl, 'observation_id', t.observation_id,
             'user_id', t.user_id, 'username', t.username, 'created_at', t.created_at)
           ORDER BY t.created_at DESC, t.id), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT a.id, a.tbl, a.observation_id, a.user_id, p.username, a.created_at
              FROM private.sync_health_keyless_after_cutoff() a
              LEFT JOIN public.profiles p ON p.id = a.user_id
             WHERE a.tbl = v_tbl AND a.from_desktop = (v_part = 'desktop')
             ORDER BY a.created_at DESC, a.id
             LIMIT v_limit) t;

  ELSIF v_family = 'keyed_with_desktop_id' THEN
    SELECT count(*) INTO v_total FROM private.sync_health_keyed_with_desktop_id() k WHERE k.tbl = v_tbl;
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id', t.id, 'table', t.tbl, 'observation_id', t.observation_id,
             'user_id', t.user_id, 'username', t.username, 'created_at', t.created_at)
           ORDER BY t.created_at DESC NULLS LAST, t.id), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT k.id, k.tbl, k.observation_id, k.user_id, p.username, k.created_at
              FROM private.sync_health_keyed_with_desktop_id() k
              LEFT JOIN public.profiles p ON p.id = k.user_id
             WHERE k.tbl = v_tbl
             ORDER BY k.created_at DESC NULLS LAST, k.id
             LIMIT v_limit) t;

  ELSIF v_family = 'duplicate_groups' THEN
    SELECT count(*) INTO v_total
      FROM private.sync_health_duplicate_groups() g WHERE g.tbl = v_tbl AND g.rule = v_part;
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'table', t.tbl, 'rule', t.rule, 'observation_id', t.observation_id,
             'user_id', t.user_id, 'username', t.username, 'created_at', t.created_at,
             'ids', pg_catalog.to_jsonb(t.ids[1:c_ids_limit]),
             'ids_truncated', pg_catalog.cardinality(t.ids) > c_ids_limit)
           ORDER BY t.created_at DESC NULLS LAST, t.ids[1]), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT g.tbl, g.rule, g.observation_id, g.user_id, p.username, g.created_at, g.ids
              FROM private.sync_health_duplicate_groups() g
              LEFT JOIN public.profiles p ON p.id = g.user_id
             WHERE g.tbl = v_tbl AND g.rule = v_part
             ORDER BY g.created_at DESC NULLS LAST, g.ids[1]
             LIMIT v_limit) t;

  ELSIF v_family = 'external_unresolved' THEN
    SELECT count(*) INTO v_total FROM private.sync_health_external_unresolved();
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id', t.id, 'table', 'observations', 'observation_id', t.id,
             'user_id', t.user_id, 'username', t.username, 'created_at', t.created_at,
             'taxon_identity_external_id', t.taxon_identity_external_id,
             'taxon_identity_namespace', t.taxon_identity_namespace)
           ORDER BY t.created_at DESC, t.id), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT x.id, x.user_id, p.username, x.created_at,
                   x.taxon_identity_external_id, x.taxon_identity_namespace
              FROM private.sync_health_external_unresolved() x
              LEFT JOIN public.profiles p ON p.id = x.user_id
             ORDER BY x.created_at DESC, x.id
             LIMIT v_limit) t;

  ELSE -- media_bytes_no_path, microscope_anchors_with_bytes
    SELECT count(*) INTO v_total
      FROM private.sync_health_bytes_no_path() b
     WHERE b.is_microscope = (v_family = 'microscope_anchors_with_bytes');
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id', t.id, 'table', 'observation_images', 'observation_id', t.observation_id,
             'user_id', t.user_id, 'username', t.username, 'created_at', t.created_at)
           ORDER BY t.created_at DESC, t.id), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT b.id, b.observation_id, b.user_id, p.username, b.created_at
              FROM private.sync_health_bytes_no_path() b
              LEFT JOIN public.profiles p ON p.id = b.user_id
             WHERE b.is_microscope = (v_family = 'microscope_anchors_with_bytes')
             ORDER BY b.created_at DESC, b.id
             LIMIT v_limit) t;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'key', p_key,
    'total', v_total,
    'truncated', v_total > v_limit,
    'rows', v_rows
  );
END;
$$;

ALTER FUNCTION public.admin_sync_health_detail(text, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.admin_sync_health_detail(text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_sync_health_detail(text, integer) TO authenticated;
