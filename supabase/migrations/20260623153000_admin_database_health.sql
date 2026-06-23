DROP FUNCTION IF EXISTS public.admin_database_health();

CREATE OR REPLACE FUNCTION public.admin_database_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
WITH relation_sizes AS (
  SELECT
    schemaname,
    relname,
    pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass)::bigint AS bytes
  FROM pg_stat_user_tables
  WHERE schemaname = 'public'
),
reference_tables AS (
  SELECT *
  FROM relation_sizes
  WHERE relname IN ('taxa', 'taxa_vernacular', 'spatial_ref_sys')
),
content_tables AS (
  SELECT *
  FROM relation_sizes
  WHERE relname NOT IN ('taxa', 'taxa_vernacular', 'spatial_ref_sys')
),
summary AS (
  SELECT
    now() AS refreshed_at,
    pg_database_size(current_database())::bigint AS total_database_bytes,
    (500 * 1024 * 1024)::bigint AS free_limit_bytes,
    (250 * 1024 * 1024)::bigint AS watch_limit_bytes,
    (350 * 1024 * 1024)::bigint AS warning_limit_bytes,
    (450 * 1024 * 1024)::bigint AS critical_limit_bytes,
    coalesce((SELECT sum(bytes) FROM reference_tables), 0)::bigint AS static_reference_bytes,
    coalesce((SELECT sum(bytes) FROM content_tables), 0)::bigint AS user_content_bytes,
    coalesce((SELECT count(*) FROM public.observations), 0)::bigint AS observation_count,
    coalesce((SELECT count(*) FROM public.observation_images), 0)::bigint AS image_count
),
derived AS (
  SELECT
    s.*,
    CASE
      WHEN s.total_database_bytes >= s.free_limit_bytes THEN true
      ELSE false
    END AS free_limit_reached,
    CASE
      WHEN s.total_database_bytes >= s.free_limit_bytes THEN 'critical'
      WHEN s.total_database_bytes >= s.critical_limit_bytes THEN 'critical'
      WHEN s.total_database_bytes >= s.warning_limit_bytes THEN 'warning'
      WHEN s.total_database_bytes >= s.watch_limit_bytes THEN 'watch'
      ELSE 'ok'
    END AS status_key,
    CASE
      WHEN s.total_database_bytes >= s.free_limit_bytes THEN 'Critical'
      WHEN s.total_database_bytes >= s.critical_limit_bytes THEN 'Critical'
      WHEN s.total_database_bytes >= s.warning_limit_bytes THEN 'Warning'
      WHEN s.total_database_bytes >= s.watch_limit_bytes THEN 'Watch'
      ELSE 'OK'
    END AS status_label,
    CASE
      WHEN s.total_database_bytes >= s.free_limit_bytes THEN 'Free read-only danger state'
      WHEN s.total_database_bytes >= s.critical_limit_bytes THEN 'Critical before Free read-only limit'
      WHEN s.total_database_bytes >= s.warning_limit_bytes THEN 'Warning before Free read-only limit'
      WHEN s.total_database_bytes >= s.watch_limit_bytes THEN 'Upgrade watch threshold'
      ELSE 'Healthy Free-tier headroom'
    END AS status_detail,
    CASE
      WHEN s.observation_count > 0 AND s.user_content_bytes > 0
      THEN round((s.user_content_bytes::numeric / s.observation_count), 0)::bigint
      ELSE NULL
    END AS bytes_per_observation
  FROM summary s
)
SELECT jsonb_build_object(
  'refreshed_at', d.refreshed_at,
  'total_database_bytes', d.total_database_bytes,
  'total_database_pretty', pg_size_pretty(d.total_database_bytes),
  'free_limit_bytes', d.free_limit_bytes,
  'free_limit_pretty', pg_size_pretty(d.free_limit_bytes),
  'percent_used', round((d.total_database_bytes::numeric / nullif(d.free_limit_bytes, 0)) * 100, 1),
  'status_key', d.status_key,
  'status_label', d.status_label,
  'status_detail', d.status_detail,
  'free_limit_reached', d.free_limit_reached,
  'headroom_bytes', greatest(d.free_limit_bytes - d.total_database_bytes, 0),
  'headroom_pretty', pg_size_pretty(greatest(d.free_limit_bytes - d.total_database_bytes, 0)),
  'reference_data', jsonb_build_object(
    'bytes', d.static_reference_bytes,
    'pretty_size', pg_size_pretty(d.static_reference_bytes),
    'tables', coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'schema', rs.schemaname,
            'table', rs.relname,
            'bytes', rs.bytes,
            'pretty_size', pg_size_pretty(rs.bytes)
          )
          ORDER BY rs.bytes DESC, rs.schemaname, rs.relname
        )
        FROM reference_tables rs
      ),
      '[]'::jsonb
    )
  ),
  'user_content_data', jsonb_build_object(
    'bytes', d.user_content_bytes,
    'pretty_size', pg_size_pretty(d.user_content_bytes),
    'tables', coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'schema', cs.schemaname,
            'table', cs.relname,
            'bytes', cs.bytes,
            'pretty_size', pg_size_pretty(cs.bytes)
          )
          ORDER BY cs.bytes DESC, cs.schemaname, cs.relname
        )
        FROM content_tables cs
      ),
      '[]'::jsonb
    )
  ),
  'top_relations', coalesce(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'schema', rs.schemaname,
          'table', rs.relname,
          'bytes', rs.bytes,
          'pretty_size', pg_size_pretty(rs.bytes)
        )
        ORDER BY rs.bytes DESC, rs.schemaname, rs.relname
      )
      FROM (
        SELECT *
        FROM relation_sizes
        ORDER BY bytes DESC, schemaname, relname
        LIMIT 20
      ) rs
    ),
    '[]'::jsonb
  ),
  'observation_count', d.observation_count,
  'image_count', d.image_count,
  'bytes_per_observation', d.bytes_per_observation,
  'estimated_remaining_observations', jsonb_build_object(
    'to_250_mb', CASE
      WHEN d.bytes_per_observation IS NULL OR d.bytes_per_observation <= 0 THEN NULL
      ELSE greatest(0, floor(((250 * 1024 * 1024)::numeric - d.total_database_bytes::numeric) / d.bytes_per_observation))::bigint
    END,
    'to_350_mb', CASE
      WHEN d.bytes_per_observation IS NULL OR d.bytes_per_observation <= 0 THEN NULL
      ELSE greatest(0, floor(((350 * 1024 * 1024)::numeric - d.total_database_bytes::numeric) / d.bytes_per_observation))::bigint
    END,
    'to_500_mb', CASE
      WHEN d.bytes_per_observation IS NULL OR d.bytes_per_observation <= 0 THEN NULL
      ELSE greatest(0, floor(((500 * 1024 * 1024)::numeric - d.total_database_bytes::numeric) / d.bytes_per_observation))::bigint
    END
  )
)
FROM derived d;
$$;

ALTER FUNCTION public.admin_database_health() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.admin_database_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_database_health() FROM anon;
REVOKE ALL ON FUNCTION public.admin_database_health() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_database_health() TO service_role;

NOTIFY pgrst, 'reload schema';
