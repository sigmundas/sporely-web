-- Admin-only, read-only "Sync health" snapshot for the admin app.
--
-- Plan: sporely-admin docs/plans/2026-10-20-sync-health-monitoring.md, Stage S1.
--
-- public.admin_sync_health(p_min_desktop_version text default '0.9.26')
-- returns one jsonb document (schema_version 1) with:
--   * the desktop write stop rows (private.sync_client_write_block), reason
--     cut to 200 characters;
--   * desktop versions reported through public.reference_client_devices
--     (client = 'desktop_app'), over 7 and 30 days, and how many are below
--     p_min_desktop_version;
--   * client_activity_daily users by (client, app_version) over 7 UTC days;
--   * sync_key coverage on observations, observation_images and
--     spore_measurements, plus duplicate groups (rule (b): shared_key and
--     keyed_keyless_twin);
--   * a metadata-consistency count for images (bytes recorded, no path);
--   * taxon identity state counts and the latest taxonomy repair runs;
--   * warnings[], decided here only. The UI shows them and never derives
--     severity itself.
--
-- Purge lifecycle counts are NOT computed here: admin-ops already returns them
-- in media_health, and the restore window lives in Edge env.
--
-- Security: SECURITY DEFINER with an empty search_path (every name below is
-- schema-qualified), gate before any read (auth.uid() present and
-- profiles.is_admin true; see 20260723130000 for why is_admin is trusted),
-- SELECT only, no PII beyond user/row ids and the owner-typed block reason.
-- EXECUTE is revoked from PUBLIC, anon and service_role (the baseline's
-- default privileges grant service_role on new functions) and granted to
-- authenticated only.
--
-- Version parsing (same rule for the parameter and stored versions): longer
-- than 32 characters before trimming, or, once trimmed, not 1-4 dot-separated groups of 1-5 ASCII
-- digits, is unparseable (stored values never raise; the parameter raises);
-- missing trailing groups are 0, so 0.9.26 = 0.9.26.0; compared as int[4].
--
-- null_sync_key_after_cutoff counts keyless rows created on or after
-- 2026-10-13 00:00 UTC, the sync_key migration date (20261013210000); no
-- deployment doc records a more precise production deploy time.
-- spore_measurements has no created_at, so measured_at is used there.

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
  IF v_min_text IS NULL
     OR pg_catalog.length(p_min_desktop_version) > 32
     OR v_min_text !~ '^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$' THEN
    RAISE EXCEPTION 'admin_sync_health: p_min_desktop_version must look like 1.2.3 (1-4 numeric parts)';
  END IF;
  v_min := ARRAY[
    coalesce(NULLIF(pg_catalog.split_part(v_min_text, '.', 1), ''), '0')::integer,
    coalesce(NULLIF(pg_catalog.split_part(v_min_text, '.', 2), ''), '0')::integer,
    coalesce(NULLIF(pg_catalog.split_part(v_min_text, '.', 3), ''), '0')::integer,
    coalesce(NULLIF(pg_catalog.split_part(v_min_text, '.', 4), ''), '0')::integer
  ];

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
    SELECT rcd.user_id,
           rcd.device_id,
           rcd.app_version,
           rcd.last_seen_at >= v_now - interval '7 days' AS in_d7,
           CASE
             WHEN pg_catalog.length(rcd.app_version) <= 32
              AND pg_catalog.btrim(rcd.app_version) ~ '^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$'
             THEN ARRAY[
               coalesce(NULLIF(pg_catalog.split_part(pg_catalog.btrim(rcd.app_version), '.', 1), ''), '0')::integer,
               coalesce(NULLIF(pg_catalog.split_part(pg_catalog.btrim(rcd.app_version), '.', 2), ''), '0')::integer,
               coalesce(NULLIF(pg_catalog.split_part(pg_catalog.btrim(rcd.app_version), '.', 3), ''), '0')::integer,
               coalesce(NULLIF(pg_catalog.split_part(pg_catalog.btrim(rcd.app_version), '.', 4), ''), '0')::integer
             ]
           END AS parsed
      FROM public.reference_client_devices rcd
     WHERE rcd.client = 'desktop_app'
       AND rcd.last_seen_at >= v_now - interval '30 days'
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
  -- sync_key coverage. Live images: deleted_at and purged_at both NULL.
  -- Observations and measurements are hard-deleted, so every row is live.
  -- -------------------------------------------------------------
  SELECT pg_catalog.jsonb_agg(t.j ORDER BY t.ord) INTO v_tables
    FROM (
      SELECT 1 AS ord, pg_catalog.jsonb_build_object(
               'table', 'observations',
               'live_rows', count(*),
               'null_sync_key', count(*) FILTER (WHERE o.sync_key IS NULL),
               'null_sync_key_after_cutoff', count(*) FILTER (WHERE o.sync_key IS NULL AND o.created_at >= c_sync_key_cutoff),
               'keyed_with_desktop_id', count(*) FILTER (WHERE o.sync_key IS NOT NULL AND o.desktop_id IS NOT NULL)) AS j
        FROM public.observations o
      UNION ALL
      SELECT 2, pg_catalog.jsonb_build_object(
               'table', 'observation_images',
               'live_rows', count(*),
               'null_sync_key', count(*) FILTER (WHERE i.sync_key IS NULL),
               'null_sync_key_after_cutoff', count(*) FILTER (WHERE i.sync_key IS NULL AND i.created_at >= c_sync_key_cutoff),
               'keyed_with_desktop_id', count(*) FILTER (WHERE i.sync_key IS NOT NULL AND i.desktop_id IS NOT NULL))
        FROM public.observation_images i
       WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
      UNION ALL
      SELECT 3, pg_catalog.jsonb_build_object(
               'table', 'spore_measurements',
               'live_rows', count(*),
               'null_sync_key', count(*) FILTER (WHERE m.sync_key IS NULL),
               'null_sync_key_after_cutoff', count(*) FILTER (WHERE m.sync_key IS NULL AND m.measured_at >= c_sync_key_cutoff),
               'keyed_with_desktop_id', count(*) FILTER (WHERE m.sync_key IS NOT NULL AND m.desktop_id IS NOT NULL))
        FROM public.spore_measurements m
    ) t;

  -- -------------------------------------------------------------
  -- Duplicate groups, rule (b), live rows only.
  --   shared_key: >= 2 rows with the same (user_id, sync_key).
  --   keyed_keyless_twin: a keyed and a keyless row that look like the same
  --     record. Images: same (user_id, observation_id, original_filename
  --     (non-blank), image_type). Measurements (no filename): same
  --     (user_id, image_id, measurement_type, length_um, width_um).
  -- -------------------------------------------------------------
  WITH live_images AS (
    SELECT i.id, i.user_id, i.observation_id, i.sync_key, i.original_filename, i.image_type
      FROM public.observation_images i
     WHERE i.deleted_at IS NULL AND i.purged_at IS NULL
  ),
  meas AS (
    SELECT m.id, m.user_id, m.image_id, i.observation_id, m.sync_key,
           m.measurement_type, m.length_um, m.width_um
      FROM public.spore_measurements m
      LEFT JOIN public.observation_images i ON i.id = m.image_id
  ),
  groups AS (
    SELECT 'observation_images'::text AS tbl, 'shared_key'::text AS rule, li.user_id,
           CASE WHEN min(li.observation_id) = max(li.observation_id) THEN min(li.observation_id) END AS observation_id,
           pg_catalog.array_agg(li.id ORDER BY li.id) AS ids
      FROM live_images li
     WHERE li.sync_key IS NOT NULL
     GROUP BY li.user_id, li.sync_key
    HAVING count(*) >= 2
    UNION ALL
    SELECT 'spore_measurements', 'shared_key', me.user_id,
           CASE WHEN min(me.observation_id) = max(me.observation_id) THEN min(me.observation_id) END,
           pg_catalog.array_agg(me.id ORDER BY me.id)
      FROM meas me
     WHERE me.sync_key IS NOT NULL
     GROUP BY me.user_id, me.sync_key
    HAVING count(*) >= 2
    UNION ALL
    SELECT 'observation_images', 'keyed_keyless_twin', li.user_id, li.observation_id,
           pg_catalog.array_agg(li.id ORDER BY li.id)
      FROM live_images li
     WHERE NULLIF(pg_catalog.btrim(li.original_filename), '') IS NOT NULL
     GROUP BY li.user_id, li.observation_id, li.original_filename, li.image_type
    HAVING count(*) FILTER (WHERE li.sync_key IS NOT NULL) >= 1
       AND count(*) FILTER (WHERE li.sync_key IS NULL) >= 1
    UNION ALL
    SELECT 'spore_measurements', 'keyed_keyless_twin', me.user_id, min(me.observation_id),
           pg_catalog.array_agg(me.id ORDER BY me.id)
      FROM meas me
     GROUP BY me.user_id, me.image_id, me.measurement_type, me.length_um, me.width_um
    HAVING count(*) FILTER (WHERE me.sync_key IS NOT NULL) >= 1
       AND count(*) FILTER (WHERE me.sync_key IS NULL) >= 1
  ),
  listed AS (
    SELECT * FROM groups g
     ORDER BY CASE g.rule WHEN 'shared_key' THEN 0 ELSE 1 END, g.tbl, g.user_id, g.ids[1]
     LIMIT c_list_limit
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
               FROM listed l), '[]'::jsonb)),
         pg_catalog.jsonb_build_object(
           'shared_key', (SELECT count(*) FROM groups g WHERE g.rule = 'shared_key'),
           'keyed_keyless_twin', (SELECT count(*) FROM groups g WHERE g.rule = 'keyed_keyless_twin'))
    INTO v_dups, v_dup_counts;

  -- -------------------------------------------------------------
  -- Media metadata consistency (not an upload backlog: desktop may reserve a
  -- path before bytes exist, and pathless anchors are valid).
  -- -------------------------------------------------------------
  SELECT pg_catalog.jsonb_build_object(
           'live_with_bytes_no_path',
             count(*) FILTER (WHERE coalesce(i.stored_bytes, 0) > 0
                                AND NULLIF(pg_catalog.btrim(i.storage_path), '') IS NULL),
           'recorded_primary_bytes', coalesce(sum(i.stored_bytes), 0))
    INTO v_media
    FROM public.observation_images i
   WHERE i.deleted_at IS NULL AND i.purged_at IS NULL;

  -- -------------------------------------------------------------
  -- Taxonomy identity state and recent repair runs.
  -- -------------------------------------------------------------
  SELECT count(*) INTO v_external_unresolved
    FROM public.observations o
   WHERE o.taxon_identity_state = 'external_unresolved';

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
      'message', pg_catalog.format('%s desktop version(s) are blocked from writing synced rows.', v_write_block_count));
  END IF;

  IF (v_desktop #>> '{below_min,d7,devices}')::bigint > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'desktop_below_min_d7', 'severity', 'warning',
      'message', pg_catalog.format('%s desktop device(s) seen in the last 7 days report a version below %s.',
        v_desktop #>> '{below_min,d7,devices}', v_min_text));
  END IF;

  IF (v_dup_counts ->> 'shared_key')::bigint > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'sync_key_shared_key', 'severity', 'warning',
      'message', pg_catalog.format('%s group(s) of live rows share one sync_key; the unique index should prevent this.',
        v_dup_counts ->> 'shared_key'));
  END IF;

  FOR r IN SELECT e FROM pg_catalog.jsonb_array_elements(v_tables) AS e LOOP
    IF (r.e ->> 'keyed_with_desktop_id')::bigint > 0 THEN
      v_warnings := v_warnings || pg_catalog.jsonb_build_object(
        'key', 'keyed_with_desktop_id.' || (r.e ->> 'table'), 'severity', 'watch',
        'message', pg_catalog.format('%s %s row(s) carry both sync_key and desktop_id.',
          r.e ->> 'keyed_with_desktop_id', r.e ->> 'table'));
    END IF;
    IF (r.e ->> 'null_sync_key_after_cutoff')::bigint > 0 THEN
      v_warnings := v_warnings || pg_catalog.jsonb_build_object(
        'key', 'null_sync_key_after_cutoff.' || (r.e ->> 'table'), 'severity', 'watch',
        'message', pg_catalog.format('%s %s row(s) without sync_key were created after the sync_key migration (2026-10-13).',
          r.e ->> 'null_sync_key_after_cutoff', r.e ->> 'table'));
    END IF;
  END LOOP;

  IF (v_dup_counts ->> 'keyed_keyless_twin')::bigint > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'sync_key_keyed_keyless_twin', 'severity', 'watch',
      'message', pg_catalog.format('%s group(s) pair a keyed row with a keyless twin.', v_dup_counts ->> 'keyed_keyless_twin'));
  END IF;

  IF v_external_unresolved > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'taxonomy_external_unresolved', 'severity', 'watch',
      'message', pg_catalog.format('%s observation(s) hold an unresolved external taxon identity.', v_external_unresolved));
  END IF;

  IF (v_media ->> 'live_with_bytes_no_path')::bigint > 0 THEN
    v_warnings := v_warnings || pg_catalog.jsonb_build_object('key', 'media_bytes_no_path', 'severity', 'watch',
      'message', pg_catalog.format('%s live image(s) record stored bytes but have no storage path.', v_media ->> 'live_with_bytes_no_path'));
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
