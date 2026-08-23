-- Cheap per-user recorded primary-image byte breakdown for admin diagnostics.
-- No R2 HEAD calls; reads observation_images.stored_bytes only.
-- Called once per snapshot with all top-storage user IDs (no N+1).
--
-- Parameters:
--   p_user_ids         – UUIDs to aggregate; only these rows are returned.
--   p_restore_cutoff_at – Timestamp computed server-side from getRestoreWindowDays(env).
--                         Rows with deleted_at <= cutoff are reclaimable; > cutoff are in
--                         the restore window. Keeping the cutoff in the Edge Function
--                         prevents config drift between the preview and this breakdown.

CREATE OR REPLACE FUNCTION public.admin_media_storage_breakdown(
  p_user_ids        uuid[],
  p_restore_cutoff_at timestamptz
)
RETURNS TABLE (
  user_id                                    uuid,
  -- Row counts
  active_rows                                bigint,
  metadata_only_anchor_rows                  bigint,
  deleted_retained_rows                      bigint,
  reclaimable_rows                           bigint,
  restore_window_rows                        bigint,
  purge_error_rows                           bigint,
  purged_rows                                bigint,
  -- Recorded primary-image byte estimates (NULLs excluded from sums)
  active_recorded_primary_bytes              bigint,
  deleted_retained_recorded_primary_bytes    bigint,
  reclaimable_recorded_primary_bytes         bigint,
  restore_window_recorded_primary_bytes      bigint,
  -- Unknown-size counts
  active_unknown_primary_size_rows           bigint,
  deleted_retained_unknown_primary_size_rows bigint
)
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT
    u.user_id,

    -- active: deleted_at IS NULL, purged_at IS NULL, storage_path present and non-blank
    COUNT(*) FILTER (
      WHERE oi.deleted_at IS NULL
        AND oi.purged_at  IS NULL
        AND oi.storage_path IS NOT NULL
        AND oi.storage_path <> ''
    )::bigint AS active_rows,

    -- metadata_only_anchor: blank/absent storage path, image_type = 'microscope'
    -- (case-insensitive), not deleted — counted separately, never as byte-backed.
    -- Treats both NULL and '' as "no storage path" to match Stage 2 classifier semantics.
    COUNT(*) FILTER (
      WHERE oi.deleted_at IS NULL
        AND (oi.storage_path IS NULL OR oi.storage_path = '')
        AND lower(oi.image_type) = 'microscope'
    )::bigint AS metadata_only_anchor_rows,

    -- deleted_retained: soft-deleted but not yet purged
    COUNT(*) FILTER (
      WHERE oi.deleted_at IS NOT NULL
        AND oi.purged_at IS NULL
    )::bigint AS deleted_retained_rows,

    -- reclaimable: deleted_retained AND past the restore window
    COUNT(*) FILTER (
      WHERE oi.deleted_at IS NOT NULL
        AND oi.purged_at  IS NULL
        AND oi.deleted_at <= p_restore_cutoff_at
    )::bigint AS reclaimable_rows,

    -- restore_window: deleted_retained AND still within the restore window
    COUNT(*) FILTER (
      WHERE oi.deleted_at IS NOT NULL
        AND oi.purged_at  IS NULL
        AND oi.deleted_at > p_restore_cutoff_at
    )::bigint AS restore_window_rows,

    -- purge_error: non-blank purge_error, not yet purged (blank '' is not a failure)
    COUNT(*) FILTER (
      WHERE oi.purge_error IS NOT NULL
        AND oi.purge_error <> ''
        AND oi.purged_at IS NULL
    )::bigint AS purge_error_rows,

    -- purged: physically removed
    COUNT(*) FILTER (
      WHERE oi.purged_at IS NOT NULL
    )::bigint AS purged_rows,

    -- Byte estimates — NULLs are excluded by FILTER; no coalesce-to-zero
    SUM(oi.stored_bytes) FILTER (
      WHERE oi.deleted_at IS NULL
        AND oi.purged_at  IS NULL
        AND oi.storage_path IS NOT NULL
        AND oi.storage_path <> ''
        AND oi.stored_bytes IS NOT NULL
    ) AS active_recorded_primary_bytes,

    SUM(oi.stored_bytes) FILTER (
      WHERE oi.deleted_at IS NOT NULL
        AND oi.purged_at  IS NULL
        AND oi.stored_bytes IS NOT NULL
    ) AS deleted_retained_recorded_primary_bytes,

    SUM(oi.stored_bytes) FILTER (
      WHERE oi.deleted_at IS NOT NULL
        AND oi.purged_at  IS NULL
        AND oi.deleted_at <= p_restore_cutoff_at
        AND oi.stored_bytes IS NOT NULL
    ) AS reclaimable_recorded_primary_bytes,

    SUM(oi.stored_bytes) FILTER (
      WHERE oi.deleted_at IS NOT NULL
        AND oi.purged_at  IS NULL
        AND oi.deleted_at > p_restore_cutoff_at
        AND oi.stored_bytes IS NOT NULL
    ) AS restore_window_recorded_primary_bytes,

    -- Unknown-size counts (byte-backed rows where stored_bytes was never recorded)
    COUNT(*) FILTER (
      WHERE oi.deleted_at IS NULL
        AND oi.purged_at  IS NULL
        AND oi.storage_path IS NOT NULL
        AND oi.storage_path <> ''
        AND oi.stored_bytes IS NULL
    )::bigint AS active_unknown_primary_size_rows,

    COUNT(*) FILTER (
      WHERE oi.deleted_at IS NOT NULL
        AND oi.purged_at  IS NULL
        AND oi.stored_bytes IS NULL
    )::bigint AS deleted_retained_unknown_primary_size_rows

  FROM (SELECT DISTINCT uid AS user_id FROM unnest(p_user_ids) AS uid) AS u
  LEFT JOIN public.observation_images oi
         ON oi.user_id = u.user_id
  GROUP BY u.user_id;
$$;

COMMENT ON FUNCTION public.admin_media_storage_breakdown(uuid[], timestamptz) IS
  'Cheap DB-side estimate of recorded primary-image bytes per user. '
  'Not physical R2 usage; the on-demand recalculation path (full/thumb/original/mosaic classes via R2 HEAD) is the exact measurement. '
  'stored_bytes NULLs are excluded from sums and counted separately in unknown_primary_size_rows columns. '
  'metadata_only_anchor_rows counts microscope rows with NULL or blank storage_path (matches Stage 2 classifier). '
  'Duplicate UUIDs in p_user_ids are deduplicated before joining. '
  'Returns one row per distinct requested user_id (including zero-image users). '
  'Service-role only; not callable by anon or authenticated roles.';

REVOKE ALL ON FUNCTION public.admin_media_storage_breakdown(uuid[], timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_media_storage_breakdown(uuid[], timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.admin_media_storage_breakdown(uuid[], timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_media_storage_breakdown(uuid[], timestamptz) TO service_role;
