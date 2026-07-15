


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."admin_database_health"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog'
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


ALTER FUNCTION "public"."admin_database_health"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_profile_storage_delta"("p_user_id" "uuid", "p_storage_delta" bigint, "p_image_delta" integer) RETURNS TABLE("total_storage_bytes" bigint, "storage_used_bytes" bigint, "image_count" integer)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  return query
  update public.profiles
  set
    total_storage_bytes = greatest(0, coalesce(profiles.total_storage_bytes, 0) + coalesce(p_storage_delta, 0)),
    storage_used_bytes = greatest(0, coalesce(profiles.storage_used_bytes, 0) + coalesce(p_storage_delta, 0)),
    image_count = greatest(0, coalesce(profiles.image_count, 0) + coalesce(p_image_delta, 0))
  where profiles.id = p_user_id
  returning profiles.total_storage_bytes, profiles.storage_used_bytes, profiles.image_count;
end;
$$;


ALTER FUNCTION "public"."apply_profile_storage_delta"("p_user_id" "uuid", "p_storage_delta" bigint, "p_image_delta" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."are_friends"("user_a" "uuid", "user_b" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT user_a IS NOT NULL
     AND user_b IS NOT NULL
     AND user_a <> user_b
     AND EXISTS (
       SELECT 1
       FROM public.friendships f
       WHERE f.status = 'accepted'
         AND (
           (f.requester_id = user_a AND f.addressee_id = user_b)
           OR
           (f.requester_id = user_b AND f.addressee_id = user_a)
         )
     )
$$;


ALTER FUNCTION "public"."are_friends"("user_a" "uuid", "user_b" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_access_spore_data"("owner_id" "uuid", "spore_visibility" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT CASE
    WHEN auth.uid() = owner_id THEN true
    WHEN coalesce(spore_visibility, 'public') = 'public' THEN true
    WHEN coalesce(spore_visibility, 'public') = 'friends'
      THEN public.are_friends(auth.uid(), owner_id)
    ELSE false
  END
$$;


ALTER FUNCTION "public"."can_access_spore_data"("owner_id" "uuid", "spore_visibility" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_read_observation"("owner_id" "uuid", "visibility_value" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT CASE
    WHEN auth.uid() = owner_id THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = owner_id
        AND p.is_banned = true
    ) THEN false
    WHEN public.is_blocked_between(auth.uid(), owner_id) THEN false
    WHEN coalesce(visibility_value, 'public') = 'public' THEN true
    WHEN coalesce(visibility_value, 'public') = 'friends'
      THEN public.are_friends(auth.uid(), owner_id)
    ELSE false
  END
$$;


ALTER FUNCTION "public"."can_read_observation"("owner_id" "uuid", "visibility_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_see_exact_observation_location"("observation_id" bigint, "owner_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT auth.uid() = owner_id
      OR public.are_friends(auth.uid(), owner_id)
      OR EXISTS (
        SELECT 1
        FROM public.observation_shares s
        WHERE s.shared_with_id = auth.uid()
          AND s.observation_id = observation_id
      )
$$;


ALTER FUNCTION "public"."can_see_exact_observation_location"("observation_id" bigint, "owner_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."community_contributor_label"("profile_id" "uuid", "fallback_author" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT nullif(
    coalesce(
      nullif(p.display_name, ''),
      nullif(p.username, ''),
      nullif(fallback_author, '')
    ),
    ''
  )
  FROM public.profiles p
  WHERE p.id = profile_id
  UNION ALL
  SELECT nullif(fallback_author, '')
  WHERE NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = profile_id
  )
  LIMIT 1
$$;


ALTER FUNCTION "public"."community_contributor_label"("profile_id" "uuid", "fallback_author" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."community_spore_taxon_summary"("p_genus" "text", "p_species" "text") RETURNS TABLE("dataset_count" bigint, "measurement_count" bigint, "length_min" double precision, "length_p05" double precision, "length_p50" double precision, "length_p95" double precision, "length_max" double precision, "length_avg" double precision, "width_min" double precision, "width_p05" double precision, "width_p50" double precision, "width_p95" double precision, "width_max" double precision, "width_avg" double precision, "q_min" double precision, "q_p50" double precision, "q_max" double precision, "q_avg" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH public_points AS (
    SELECT
      o.id AS observation_id,
      m.length_um,
      m.width_um,
      (m.length_um / nullif(m.width_um, 0)) AS q_value
    FROM public.observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
     AND i.deleted_at IS NULL
    JOIN public.spore_measurements m
      ON m.image_id = i.id
    WHERE lower(coalesce(o.genus, '')) = lower(trim(coalesce(p_genus, '')))
      AND (trim(coalesce(p_species, '')) = '' OR lower(coalesce(o.species, '')) = lower(trim(p_species)))
      AND NOT coalesce(o.is_draft, false)
      AND o.spore_data_visibility = 'public'
      AND m.length_um IS NOT NULL
      AND m.width_um IS NOT NULL
      AND m.width_um <> 0
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  )
  SELECT
    count(distinct observation_id) AS dataset_count,
    count(*) AS measurement_count,
    min(length_um) AS length_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um)::double precision AS length_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY length_um)::double precision AS length_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um)::double precision AS length_p95,
    max(length_um) AS length_max,
    avg(length_um) AS length_avg,
    min(width_um) AS width_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY width_um)::double precision AS width_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY width_um)::double precision AS width_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY width_um)::double precision AS width_p95,
    max(width_um) AS width_max,
    avg(width_um) AS width_avg,
    min(q_value) AS q_min,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY q_value)::double precision AS q_p50,
    max(q_value) AS q_max,
    avg(q_value) AS q_avg
  FROM public_points
$$;


ALTER FUNCTION "public"."community_spore_taxon_summary"("p_genus" "text", "p_species" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enable_spatial_ref_sys_rls"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
BEGIN
  EXECUTE 'ALTER TABLE public.spatial_ref_sys ENABLE ROW LEVEL SECURITY';

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename='spatial_ref_sys'
      AND policyname='spatial_ref_sys_select'
  ) THEN
    EXECUTE $q$
      CREATE POLICY spatial_ref_sys_select
      ON public.spatial_ref_sys
      FOR SELECT
      TO PUBLIC
      USING (true);
    $q$;
  END IF;
END;
$_$;


ALTER FUNCTION "public"."enable_spatial_ref_sys_rls"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_non_public_observation_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  current_count integer;
BEGIN
  IF coalesce(NEW.is_draft, false) THEN
    RETURN NEW;
  END IF;

  IF coalesce(NEW.visibility, 'public') = 'public'
     AND coalesce(NEW.location_precision, 'exact') = 'exact' THEN
    RETURN NEW;
  END IF;

  IF public.profile_has_pro_access(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));

  SELECT count(*)::integer
  INTO current_count
  FROM public.observations o
  WHERE o.user_id = NEW.user_id
    AND NOT coalesce(o.is_draft, false)
    AND (
      coalesce(o.visibility, 'public') <> 'public'
      OR coalesce(o.location_precision, 'exact') IN ('fuzzed', 'region', 'hidden')
    )
    AND (TG_OP = 'INSERT' OR o.id <> NEW.id);

  IF current_count >= 20 THEN
    RAISE EXCEPTION
      'Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;


ALTER FUNCTION "public"."enforce_non_public_observation_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_community_spore_dataset"("p_observation_id" bigint) RETURNS TABLE("dataset_type" "text", "observation_id" bigint, "genus" "text", "species" "text", "common_name" "text", "contributor_label" "text", "observed_on" "date", "measurement_count" bigint, "image_count" bigint, "mount_media" "text"[], "stains" "text"[], "sample_types" "text"[], "contrasts" "text"[], "objectives" "text"[], "scale_min" double precision, "scale_max" double precision, "qc_flags" "jsonb", "length_min" double precision, "length_p05" double precision, "length_p50" double precision, "length_p95" double precision, "length_max" double precision, "length_avg" double precision, "width_min" double precision, "width_p05" double precision, "width_p50" double precision, "width_p95" double precision, "width_max" double precision, "width_avg" double precision, "q_min" double precision, "q_p50" double precision, "q_max" double precision, "q_avg" double precision, "measurements_json" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH filtered AS (
    SELECT
      o.id AS observation_id,
      o.user_id,
      o.genus,
      o.species,
      o.common_name,
      o.date,
      o.author,
      i.id AS image_id,
      i.mount_medium,
      i.stain,
      i.sample_type,
      i.contrast,
      i.objective_name,
      i.scale_microns_per_pixel,
      m.id AS measurement_id,
      m.length_um,
      m.width_um,
      m.p1_x,
      m.p1_y,
      m.p2_x,
      m.p2_y,
      m.p3_x,
      m.p3_y,
      m.p4_x,
      m.p4_y,
      m.measured_at
    FROM public.observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
    JOIN public.spore_measurements m
      ON m.image_id = i.id
    WHERE o.id = p_observation_id
      AND NOT coalesce(o.is_draft, false)
      AND public.can_access_spore_data(o.user_id, o.spore_data_visibility)
      AND m.length_um IS NOT NULL
      AND m.width_um IS NOT NULL
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  )
  SELECT
    'observation'::text AS dataset_type,
    max(f.observation_id) AS observation_id,
    max(f.genus) AS genus,
    max(f.species) AS species,
    max(f.common_name) AS common_name,
    public.community_contributor_label((array_agg(f.user_id))[1], max(f.author)) AS contributor_label,
    max(f.date) AS observed_on,
    count(f.measurement_id) AS measurement_count,
    count(distinct f.image_id) AS image_count,
    array_remove(array_agg(distinct nullif(f.mount_medium, '')), NULL) AS mount_media,
    array_remove(array_agg(distinct nullif(f.stain, '')), NULL) AS stains,
    array_remove(array_agg(distinct nullif(f.sample_type, '')), NULL) AS sample_types,
    array_remove(array_agg(distinct nullif(f.contrast, '')), NULL) AS contrasts,
    array_remove(array_agg(distinct nullif(f.objective_name, '')), NULL) AS objectives,
    min(f.scale_microns_per_pixel) AS scale_min,
    max(f.scale_microns_per_pixel) AS scale_max,
    jsonb_build_object(
      'has_mount', bool_or(nullif(f.mount_medium, '') IS NOT NULL),
      'has_stain', bool_or(nullif(f.stain, '') IS NOT NULL),
      'has_sample_type', bool_or(nullif(f.sample_type, '') IS NOT NULL),
      'has_contrast', bool_or(nullif(f.contrast, '') IS NOT NULL),
      'has_objective', bool_or(nullif(f.objective_name, '') IS NOT NULL),
      'has_scale', bool_or(f.scale_microns_per_pixel IS NOT NULL),
      'has_point_geometry', bool_or(
        f.p1_x IS NOT NULL OR f.p1_y IS NOT NULL OR f.p2_x IS NOT NULL OR f.p2_y IS NOT NULL
      ),
      'measurement_count', count(f.measurement_id)
    ) AS qc_flags,
    min(f.length_um) AS length_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p95,
    max(f.length_um) AS length_max,
    avg(f.length_um) AS length_avg,
    min(f.width_um) AS width_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p95,
    max(f.width_um) AS width_max,
    avg(f.width_um) AS width_avg,
    min(f.length_um / nullif(f.width_um, 0)) AS q_min,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY (f.length_um / nullif(f.width_um, 0)))::double precision AS q_p50,
    max(f.length_um / nullif(f.width_um, 0)) AS q_max,
    avg(f.length_um / nullif(f.width_um, 0)) AS q_avg,
    jsonb_agg(
      jsonb_build_object(
        'measurement_id', f.measurement_id,
        'image_id', f.image_id,
        'length_um', f.length_um,
        'width_um', f.width_um,
        'p1_x', f.p1_x,
        'p1_y', f.p1_y,
        'p2_x', f.p2_x,
        'p2_y', f.p2_y,
        'p3_x', f.p3_x,
        'p3_y', f.p3_y,
        'p4_x', f.p4_x,
        'p4_y', f.p4_y,
        'measured_at', f.measured_at
      )
      ORDER BY f.measured_at, f.measurement_id
    ) AS measurements_json
  FROM filtered f
$$;


ALTER FUNCTION "public"."get_community_spore_dataset"("p_observation_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_person_stats"("p_user_id" "uuid") RETURNS TABLE("user_id" "uuid", "public_find_count" bigint, "public_species_count" bigint, "public_spore_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH public_observations AS (
    SELECT
      o.id,
      o.user_id,
      o.genus,
      o.species,
      o.spore_data_visibility
    FROM public.observations_community_view o
    WHERE o.user_id = p_user_id
  ),
  public_observation_stats AS (
    SELECT
      po.user_id,
      count(distinct po.id) AS public_find_count,
      count(
        distinct CASE
          WHEN nullif(trim(coalesce(po.genus, '')), '') IS NOT NULL
            OR nullif(trim(coalesce(po.species, '')), '') IS NOT NULL
          THEN lower(trim(coalesce(po.genus, ''))) || '|' || lower(trim(coalesce(po.species, '')))
          ELSE NULL
        END
      ) AS public_species_count
    FROM public_observations po
    GROUP BY po.user_id
  ),
  public_spore_stats AS (
    SELECT
      po.user_id,
      count(*) AS public_spore_count
    FROM public_observations po
    JOIN public.observation_images i
      ON i.observation_id = po.id
     AND i.deleted_at IS NULL
    JOIN public.spore_measurements m
      ON m.image_id = i.id
    WHERE coalesce(po.spore_data_visibility, 'public') = 'public'
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
    GROUP BY po.user_id
  )
  SELECT
    p_user_id AS user_id,
    coalesce(pos.public_find_count, 0) AS public_find_count,
    coalesce(pos.public_species_count, 0) AS public_species_count,
    coalesce(ps.public_spore_count, 0) AS public_spore_count
  FROM (SELECT p_user_id AS id) vp
  LEFT JOIN public_observation_stats pos
    ON pos.user_id = vp.id
  LEFT JOIN public_spore_stats ps
    ON ps.user_id = vp.id;
$$;


ALTER FUNCTION "public"."get_person_stats"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_map_points"("p_species_slug" "text" DEFAULT NULL::"text", "p_genus" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text", "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_has_spores" boolean DEFAULT NULL::boolean, "p_limit" integer DEFAULT 3000) RETURNS TABLE("observationId" bigint, "speciesSlug" "text", "speciesName" "text", "speciesCommonName" "text", "observedOn" "date", "country" "text", "regionId" "text", "locationLabel" "text", "mapLat" double precision, "mapLon" double precision, "locationPrecision" "text", "hasMicroscopy" boolean, "sporeMeasurementCount" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH norm AS (
    SELECT
      -- Species slug: double regexp_replace same as all other species RPCs.
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(coalesce(p_species_slug, ''))),
            '[^a-z0-9]+', '-', 'g'
          ),
          '(^-|-$)', '', 'g'
        ),
        ''
      ) AS slug,
      nullif(btrim(lower(coalesce(p_genus,  ''))),          '') AS genus,
      nullif(btrim(coalesce(p_search, '')),                  '') AS search,
      nullif(btrim(upper(coalesce(p_country, ''))),          '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),               '') AS region_id,
      p_date_from                                               AS date_from,
      p_date_to                                                 AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type,     ''))),  '') AS sample_type,
      nullif(btrim(lower(coalesce(p_mount_reagent,   ''))),  '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))),  '') AS contrast_method,
      p_has_microscopy                                          AS has_microscopy,
      p_has_spores                                              AS has_spores,
      greatest(1, least(coalesce(p_limit, 3000), 5000))        AS lim
  ),

  candidate AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus,        '')), '') AS genus,
      nullif(btrim(coalesce(o.species,      '')), '') AS species,
      nullif(btrim(coalesce(o.common_name,  '')), '') AS common_name,
      o.date                                          AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country,
      nullif(btrim(coalesce(o.region_id,    '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden')        AS location_precision,
      nullif(btrim(coalesce(o.location,     '')), '') AS location,
      nullif(btrim(coalesce(r.label,        '')), '') AS region_label,
      o.gps_latitude,
      o.gps_longitude,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
    LEFT JOIN public.public_regions r ON r.id = o.region_id
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = o.user_id AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
      -- Taxon filter: species slug wins, then genus, then free-text search.
      -- If all three are null, no taxon restriction (return all public observations).
      AND (
        n.slug IS NULL AND n.genus IS NULL AND n.search IS NULL
        OR (
          n.slug IS NOT NULL
          AND nullif(
                regexp_replace(
                  regexp_replace(
                    lower(btrim(concat_ws(' ',
                      nullif(btrim(coalesce(o.genus,   '')), ''),
                      nullif(btrim(coalesce(o.species, '')), '')
                    ))),
                    '[^a-z0-9]+', '-', 'g'
                  ),
                  '(^-|-$)', '', 'g'
                ),
                ''
              ) = n.slug
        )
        OR (
          n.slug IS NULL AND n.genus IS NOT NULL
          AND lower(coalesce(o.genus, '')) = n.genus
        )
        OR (
          n.slug IS NULL AND n.genus IS NULL AND n.search IS NOT NULL
          AND (
            lower(coalesce(o.genus,    '')) ILIKE '%' || n.search || '%'
            OR lower(coalesce(o.species, '')) ILIKE '%' || n.search || '%'
          )
        )
      )
      -- Geo / date filters.
      AND (n.country   IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from IS NULL OR o.date >= n.date_from)
      AND (n.date_to   IS NULL OR o.date <= n.date_to)
      -- Prep filters via EXISTS: observation qualifies when ANY matching-prep
      -- microscope image exists, not just the latest one.
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.sample_type, '')) = n.sample_type
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.mount_medium, '')) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.contrast, '')) = n.contrast_method
      ))
      -- p_has_microscopy = true: must have at least one non-deleted/purged microscope image.
      AND (n.has_microscopy IS NOT TRUE OR EXISTS (
        SELECT 1 FROM public.observation_images i3
        WHERE i3.observation_id = o.id
          AND i3.deleted_at IS NULL AND i3.purged_at IS NULL
          AND i3.image_type = 'microscope'
      ))
      -- p_has_spores = true: spore_data_visibility must be public AND have
      -- at least one qualifying spore measurement.
      AND (n.has_spores IS NOT TRUE OR (
        o.spore_data_visibility = 'public'
        AND EXISTS (
          SELECT 1
          FROM public.observation_images i4
          JOIN public.spore_measurements m ON m.image_id = i4.id
          WHERE i4.observation_id = o.id
            AND i4.deleted_at IS NULL AND i4.purged_at IS NULL
            AND i4.image_type = 'microscope'
            AND m.length_um IS NOT NULL
            AND (
              m.measurement_type IS NULL
              OR m.measurement_type = ''
              OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
            )
        )
      ))
  )

  SELECT
    c.id AS "observationId",
    -- speciesSlug: double regexp_replace same as search_public_observations.
    nullif(
      regexp_replace(
        regexp_replace(
          lower(btrim(concat_ws(' ', c.genus, c.species))),
          '[^a-z0-9]+', '-', 'g'
        ),
        '(^-|-$)', '', 'g'
      ),
      ''
    ) AS "speciesSlug",
    nullif(btrim(concat_ws(' ', c.genus, c.species)), '') AS "speciesName",
    c.common_name AS "speciesCommonName",
    c.observed_on AS "observedOn",
    c.country     AS country,
    c.region_id   AS "regionId",
    -- locationLabel: privacy-safe same as existing RPCs.
    CASE c.location_precision
      WHEN 'exact'  THEN c.location
      WHEN 'fuzzed' THEN coalesce(c.region_label, c.country)
      WHEN 'region' THEN c.region_label
      ELSE NULL
    END AS "locationLabel",
    -- Privacy-safe coordinates.
    CASE c.location_precision
      WHEN 'exact'  THEN c.gps_latitude
      WHEN 'fuzzed' THEN round(c.gps_latitude::numeric, 2)::double precision
      ELSE NULL
    END AS "mapLat",
    CASE c.location_precision
      WHEN 'exact'  THEN c.gps_longitude
      WHEN 'fuzzed' THEN round(c.gps_longitude::numeric, 2)::double precision
      ELSE NULL
    END AS "mapLon",
    c.location_precision AS "locationPrecision",
    -- hasMicroscopy: observation's overall flag, regardless of prep filter.
    (EXISTS (
      SELECT 1 FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
    )) AS "hasMicroscopy",
    -- sporeMeasurementCount: public measurements only.
    CASE WHEN c.spore_data_visibility = 'public' THEN (
      SELECT count(m.id)::bigint
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) ELSE 0 END AS "sporeMeasurementCount"
  FROM candidate c
  CROSS JOIN norm n
  ORDER BY c.observed_on DESC, c.id DESC
  LIMIT (SELECT lim FROM norm)
$_$;


ALTER FUNCTION "public"."get_public_map_points"("p_species_slug" "text", "p_genus" "text", "p_search" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_observation"("p_observation_id" bigint) RETURNS TABLE("id" bigint, "speciesSlug" "text", "speciesName" "text", "speciesCommonName" "text", "observerDisplayName" "text", "observedOn" "date", "country" "text", "regionId" "text", "locationPrecision" "text", "locationLabel" "text", "hasMicroscopy" boolean, "sporeMeasurementCount" bigint, "sporeSummary" "jsonb", "sporePoints" "jsonb", "sporeMosaic" "jsonb", "contrastMethod" "text", "mountReagent" "text", "sampleType" "text", "sampleSource" "text", "mapLat" double precision, "mapLon" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH candidate_base AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.user_id,
      o.author,
      o.date AS observed_on,
      nullif(btrim(coalesce(o.country_code, '')), '') AS country,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden') AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '') AS location,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      public.community_contributor_label(o.user_id, o.author) AS observer_display_name
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    WHERE o.id = p_observation_id
      AND o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = o.user_id
          AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
  ),
  enriched AS (
    SELECT
      c.*,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      latest_image.sample_type AS sample_type,
      latest_image.sample_source AS sample_source,
      (latest_image.id IS NOT NULL) AS has_microscopy,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN o.spore_statistics
        ELSE NULL::jsonb
      END AS spore_summary,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN point_agg.spore_points
        ELSE NULL::jsonb
      END AS spore_points,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
             AND latest_mosaic.id IS NOT NULL
          THEN jsonb_build_object(
            'url',      concat('https://media.sporely.no/', latest_mosaic.storage_key),
            'width',    latest_mosaic.width_px,
            'height',   latest_mosaic.height_px,
            'tileSize', latest_mosaic.tile_size_px,
            'version',  latest_mosaic.version
          )
        ELSE NULL::jsonb
      END AS spore_mosaic,
      CASE
        WHEN c.location_precision = 'exact'::text
          THEN o.gps_latitude
        WHEN c.location_precision = 'fuzzed'::text
          THEN round(o.gps_latitude::numeric, 2)::double precision
        ELSE NULL::double precision
      END AS map_lat,
      CASE
        WHEN c.location_precision = 'exact'::text
          THEN o.gps_longitude
        WHEN c.location_precision = 'fuzzed'::text
          THEN round(o.gps_longitude::numeric, 2)::double precision
        ELSE NULL::double precision
      END AS map_lon
    FROM candidate_base c
    JOIN public.observations o
      ON o.id = c.id
    LEFT JOIN LATERAL (
      SELECT
        i.id,
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.sample_source
      FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (
          i.image_type = 'microscope'::text
          OR (
            i.image_type IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.spore_measurements m2
              WHERE m2.image_id = i.id
                AND (
                  m2.measurement_type IS NULL
                  OR m2.measurement_type = ''
                  OR lower(m2.measurement_type) IN ('manual', 'spore', 'spores')
                )
            )
          )
        )
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_image ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS spore_measurement_count
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type IS NULL OR i.image_type = 'microscope'::text)
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        sm.id,
        sm.storage_key,
        sm.width_px,
        sm.height_px,
        sm.tile_size_px,
        sm.version
      FROM public.spore_measurement_mosaics sm
      WHERE sm.observation_id = c.id
        AND sm.user_id = c.user_id
      ORDER BY sm.version DESC, sm.id DESC
      LIMIT 1
    ) latest_mosaic ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        (
          jsonb_build_object(
            'id',             m.id::text,
            'observationId',  c.id::text,
            'imageId',        i.id::text,
            'lengthUm',       m.length_um,
            'widthUm',        m.width_um,
            'q',              round((m.length_um / nullif(m.width_um, 0))::numeric, 4)::double precision,
            'cropUrl',        CASE
                                WHEN m.thumb_key IS NOT NULL
                                  THEN concat('https://media.sporely.no/', m.thumb_key)
                                ELSE NULL
                              END
          )
          || CASE
               WHEN t.measurement_id IS NOT NULL
                 THEN jsonb_build_object(
                   'mosaicX', t.x_px,
                   'mosaicY', t.y_px,
                   'mosaicW', t.w_px,
                   'mosaicH', t.h_px
                 )
                 || CASE
                      WHEN t.overlay_json IS NOT NULL
                        THEN jsonb_build_object('overlay', t.overlay_json)
                      ELSE '{}'::jsonb
                    END
               ELSE '{}'::jsonb
             END
        )
        ORDER BY m.id
      ) AS spore_points
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      LEFT JOIN public.spore_measurement_mosaic_tiles t
        ON t.measurement_id = m.id
       AND t.mosaic_id = latest_mosaic.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type IS NULL OR i.image_type = 'microscope'::text)
        AND m.length_um IS NOT NULL
        AND m.width_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) point_agg ON true
  )
  SELECT
    e.id AS id,
    nullif(
      regexp_replace(
        regexp_replace(lower(btrim(concat_ws(' ', e.genus, e.species))), '[^a-z0-9]+', '-', 'g'),
        '(^-|-$)',
        '',
        'g'
      ),
      ''
    ) AS "speciesSlug",
    nullif(btrim(concat_ws(' ', e.genus, e.species)), '') AS "speciesName",
    e.common_name AS "speciesCommonName",
    e.observer_display_name AS "observerDisplayName",
    e.observed_on AS "observedOn",
    e.country AS country,
    e.region_id AS "regionId",
    e.location_precision AS "locationPrecision",
    CASE
      WHEN e.location_precision = 'exact'::text THEN e.location
      WHEN e.location_precision = 'fuzzed'::text THEN coalesce(e.region_label, e.country)
      WHEN e.location_precision = 'region'::text THEN e.region_label
      ELSE NULL::text
    END AS "locationLabel",
    e.has_microscopy AS "hasMicroscopy",
    e.spore_measurement_count AS "sporeMeasurementCount",
    e.spore_summary AS "sporeSummary",
    e.spore_points AS "sporePoints",
    e.spore_mosaic AS "sporeMosaic",
    e.contrast_method AS "contrastMethod",
    e.mount_reagent AS "mountReagent",
    CASE
      WHEN lower(btrim(coalesce(e.sample_type, ''))) IN ('fresh', 'dried')
        THEN lower(btrim(e.sample_type))
      ELSE NULL::text
    END AS "sampleType",
    CASE
      WHEN lower(btrim(coalesce(e.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
        THEN lower(btrim(e.sample_source))
      ELSE NULL::text
    END AS "sampleSource",
    e.map_lat AS "mapLat",
    e.map_lon AS "mapLon"
  FROM enriched e
  LIMIT 1
$_$;


ALTER FUNCTION "public"."get_public_observation"("p_observation_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_observation_facets"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH visible_observations AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      nullif(lower(btrim(coalesce(latest_image.sample_type, ''))), '') AS sample_type
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT
        i.contrast,
        i.mount_medium,
        i.sample_type
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_image ON true
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = o.user_id
          AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
  ),
  country_labels AS (
    SELECT *
    FROM (
      VALUES
        ('DE'::text, 'Germany'::text),
        ('FI'::text, 'Finland'::text),
        ('GB'::text, 'United Kingdom'::text),
        ('NO'::text, 'Norway'::text),
        ('SE'::text, 'Sweden'::text)
    ) AS c(country_code, label)
  ),
  genera AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.genus AS value,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.genus,
          'label', grouped.genus,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.genus,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.genus IS NOT NULL
        GROUP BY vo.genus
      ) grouped
    ) items
  ),
  species AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.species_name AS value,
        grouped.species_name AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.species_name,
          'label', grouped.species_name,
          'genus', grouped.genus,
          'species', grouped.species,
          'speciesName', grouped.species_name,
          'commonName', grouped.common_name,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.genus,
          vo.species,
          nullif(btrim(concat_ws(' ', vo.genus, vo.species)), '') AS species_name,
          min(vo.common_name) AS common_name,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.genus IS NOT NULL
          AND vo.species IS NOT NULL
        GROUP BY vo.genus, vo.species
      ) grouped
    ) items
  ),
  countries AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.country_code AS value,
        coalesce(cl.label, grouped.country_code) AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.country_code,
          'label', coalesce(cl.label, grouped.country_code),
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.country_code IS NOT NULL
        GROUP BY vo.country_code
      ) grouped
      LEFT JOIN country_labels cl
        ON cl.country_code = grouped.country_code
    ) items
  ),
  regions AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.region_id AS value,
        grouped.region_label AS label,
        grouped.region_country_code AS country_code,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.region_id,
          'label', grouped.region_label,
          'countryCode', grouped.region_country_code,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.region_id,
          coalesce(vo.region_label, vo.region_id) AS region_label,
          coalesce(vo.region_country_code, vo.country_code) AS region_country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.region_id IS NOT NULL
        GROUP BY
          vo.region_id,
          coalesce(vo.region_label, vo.region_id),
          coalesce(vo.region_country_code, vo.country_code)
      ) grouped
    ) items
  ),
  sample_types AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.sample_type AS value,
        CASE
          WHEN grouped.sample_type ~ '^[A-Z0-9]+$' THEN grouped.sample_type
          ELSE initcap(grouped.sample_type)
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.sample_type,
          'label', CASE
            WHEN grouped.sample_type ~ '^[A-Z0-9]+$' THEN grouped.sample_type
            ELSE initcap(grouped.sample_type)
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.sample_type,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.sample_type IS NOT NULL
        GROUP BY vo.sample_type
      ) grouped
    ) items
  ),
  contrast_methods AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.contrast_method AS value,
        CASE
          WHEN grouped.contrast_method ~ '^[A-Z0-9]+$' THEN grouped.contrast_method
          ELSE initcap(lower(grouped.contrast_method))
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.contrast_method,
          'label', CASE
            WHEN grouped.contrast_method ~ '^[A-Z0-9]+$' THEN grouped.contrast_method
            ELSE initcap(lower(grouped.contrast_method))
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.contrast_method,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.contrast_method IS NOT NULL
        GROUP BY vo.contrast_method
      ) grouped
    ) items
  ),
  mount_reagents AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.mount_reagent AS value,
        CASE
          WHEN grouped.mount_reagent ~ '^[A-Z0-9]+$' THEN grouped.mount_reagent
          ELSE initcap(lower(grouped.mount_reagent))
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.mount_reagent,
          'label', CASE
            WHEN grouped.mount_reagent ~ '^[A-Z0-9]+$' THEN grouped.mount_reagent
            ELSE initcap(lower(grouped.mount_reagent))
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.mount_reagent,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.mount_reagent IS NOT NULL
        GROUP BY vo.mount_reagent
      ) grouped
    ) items
  )
  SELECT jsonb_build_object(
    'genera', (SELECT items FROM genera),
    'species', (SELECT items FROM species),
    'countries', (SELECT items FROM countries),
    'regions', (SELECT items FROM regions),
    'sampleTypes', (SELECT items FROM sample_types),
    'contrastMethods', (SELECT items FROM contrast_methods),
    'mountReagents', (SELECT items FROM mount_reagents)
  )
$_$;


ALTER FUNCTION "public"."get_public_observation_facets"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_observation_images"("p_observation_id" bigint) RETURNS TABLE("observationId" bigint, "imageId" bigint, "sortOrder" integer, "imageType" "text", "width" integer, "height" integer, "thumbUrl" "text", "previewUrl" "text", "fullUrl" "text", "aiCropX1" double precision, "aiCropY1" double precision, "aiCropX2" double precision, "aiCropY2" double precision, "aiCropSourceW" integer, "aiCropSourceH" integer, "aiCropIsCustom" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT *
  FROM public.search_public_observation_images(ARRAY[p_observation_id])
$$;


ALTER FUNCTION "public"."get_public_observation_images"("p_observation_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_observation_spore_summaries"("p_observation_ids" bigint[], "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_stain_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text") RETURNS TABLE("observation_id" bigint, "contributor_label" "text", "context_hash" "text", "context_json" "jsonb", "measurement_type" "text", "sample_type" "text", "mount_reagent" "text", "stain_reagent" "text", "contrast_method" "text", "n_spores" integer, "n_paired" integer, "n_length" integer, "n_width" integer, "length_min_um" double precision, "length_p05_um" double precision, "length_mean_um" double precision, "length_median_um" double precision, "length_p95_um" double precision, "length_max_um" double precision, "length_sd_um" double precision, "width_min_um" double precision, "width_p05_um" double precision, "width_mean_um" double precision, "width_median_um" double precision, "width_p95_um" double precision, "width_max_um" double precision, "width_sd_um" double precision, "q_min" double precision, "q_p05" double precision, "q_mean" double precision, "q_median" double precision, "q_p95" double precision, "q_max" double precision, "q_sd" double precision, "stats_version" integer, "computed_at" timestamp with time zone, "source_app" "text", "source_app_version" "text", "mean_source" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- Normalize each filter once: NULL / whitespace-only / empty becomes
  -- NULL, otherwise trimmed + lower-cased. Rows compare the same way.
  WITH filters AS (
    SELECT
      NULLIF(lower(btrim(coalesce(p_sample_type,     ''))), '') AS sample_type,
      NULLIF(lower(btrim(coalesce(p_mount_reagent,   ''))), '') AS mount_reagent,
      NULLIF(lower(btrim(coalesce(p_stain_reagent,   ''))), '') AS stain_reagent,
      NULLIF(lower(btrim(coalesce(p_contrast_method, ''))), '') AS contrast_method
  )
  SELECT
    s.observation_id,
    public.community_contributor_label(o.user_id, o.author) AS contributor_label,
    s.context_hash,
    s.context_json,
    s.measurement_type,
    s.sample_type,
    s.mount_reagent,
    s.stain_reagent,
    s.contrast_method,
    s.n_spores,
    s.n_paired,
    s.n_length,
    s.n_width,
    s.length_min_um,
    s.length_p05_um,
    s.length_mean_um,
    s.length_median_um,
    s.length_p95_um,
    s.length_max_um,
    s.length_sd_um,
    s.width_min_um,
    s.width_p05_um,
    s.width_mean_um,
    s.width_median_um,
    s.width_p95_um,
    s.width_max_um,
    s.width_sd_um,
    s.q_min,
    s.q_p05,
    s.q_mean,
    s.q_median,
    s.q_p95,
    s.q_max,
    s.q_sd,
    s.stats_version,
    s.computed_at,
    s.source_app,
    s.source_app_version,
    'measured'::text AS mean_source
  FROM public.observation_spore_summaries s
  JOIN public.observations o
    ON o.id = s.observation_id
  CROSS JOIN filters f
  WHERE s.observation_id = ANY(coalesce(p_observation_ids, ARRAY[]::bigint[]))
    AND NOT coalesce(o.is_draft, false)
    AND public.can_read_observation(o.user_id, o.visibility)
    AND public.can_access_spore_data(o.user_id, o.spore_data_visibility)
    AND (
      f.sample_type IS NULL
      OR lower(btrim(coalesce(s.sample_type, ''))) = f.sample_type
    )
    AND (
      f.mount_reagent IS NULL
      OR lower(btrim(coalesce(s.mount_reagent, ''))) = f.mount_reagent
    )
    AND (
      f.stain_reagent IS NULL
      OR lower(btrim(coalesce(s.stain_reagent, ''))) = f.stain_reagent
    )
    AND (
      f.contrast_method IS NULL
      OR lower(btrim(coalesce(s.contrast_method, ''))) = f.contrast_method
    );
$$;


ALTER FUNCTION "public"."get_public_observation_spore_summaries"("p_observation_ids" bigint[], "p_sample_type" "text", "p_mount_reagent" "text", "p_stain_reagent" "text", "p_contrast_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_species"("p_species_slug" "text") RETURNS TABLE("speciesSlug" "text", "genus" "text", "species" "text", "speciesName" "text", "commonName" "text", "observationCount" bigint, "microscopyObservationCount" bigint, "sporeMeasurementCount" bigint, "firstObservedOn" "date", "lastObservedOn" "date", "countries" "jsonb", "regions" "jsonb", "representativeThumbUrl" "text", "recentObservationIds" bigint[])
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH normalized AS (
    SELECT nullif(
      regexp_replace(
        lower(btrim(coalesce(p_species_slug, ''))),
        '[^a-z0-9]+',
        '-',
        'g'
      ),
      ''
    ) AS species_slug
  ),
  country_labels AS (
    SELECT *
    FROM (
      VALUES
        ('DE'::text, 'Germany'::text),
        ('FI'::text, 'Finland'::text),
        ('GB'::text, 'United Kingdom'::text),
        ('NO'::text, 'Norway'::text),
        ('SE'::text, 'Sweden'::text)
    ) AS c(country_code, label)
  ),
  visible_observations AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(o.genus, '')), ''), nullif(btrim(coalesce(o.species, '')), ''))), '') AS species_name,
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(concat_ws(' ', nullif(btrim(coalesce(o.genus, '')), ''), nullif(btrim(coalesce(o.species, '')), '')))),
            '[^a-z0-9]+',
            '-',
            'g'
          ),
          '(^-|-$)',
          '',
          'g'
        ),
        ''
      ) AS species_slug,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      (latest_microscope_image.id IS NOT NULL) AS has_microscopy
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS spore_measurement_count
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_stats ON true
    LEFT JOIN LATERAL (
      SELECT i.id
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_microscope_image ON true
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = o.user_id
          AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
  ),
  species_groups AS (
    SELECT
      vo.species_slug,
      vo.genus,
      vo.species,
      vo.species_name,
      min(vo.common_name) AS common_name,
      count(*)::bigint AS observation_count,
      count(*) FILTER (WHERE vo.has_microscopy)::bigint AS microscopy_observation_count,
      coalesce(sum(vo.spore_measurement_count), 0)::bigint AS spore_measurement_count,
      min(vo.observed_on) AS first_observed_on,
      max(vo.observed_on) AS last_observed_on
    FROM visible_observations vo
    WHERE vo.species_slug IS NOT NULL
    GROUP BY vo.species_slug, vo.genus, vo.species, vo.species_name
  ),
  target_species AS (
    SELECT sg.*
    FROM species_groups sg
    JOIN normalized n
      ON n.species_slug = sg.species_slug
  )
  SELECT
    ts.species_slug AS "speciesSlug",
    ts.genus AS genus,
    ts.species AS species,
    ts.species_name AS "speciesName",
    ts.common_name AS "commonName",
    ts.observation_count AS "observationCount",
    ts.microscopy_observation_count AS "microscopyObservationCount",
    ts.spore_measurement_count AS "sporeMeasurementCount",
    ts.first_observed_on AS "firstObservedOn",
    ts.last_observed_on AS "lastObservedOn",
    coalesce(countries.items, '[]'::jsonb) AS countries,
    coalesce(regions.items, '[]'::jsonb) AS regions,
    rep.representative_thumb_url AS "representativeThumbUrl",
    recent.recent_observation_ids AS "recentObservationIds"
  FROM target_species ts
  LEFT JOIN LATERAL (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.country_code AS value,
        coalesce(cl.label, grouped.country_code) AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.country_code,
          'label', coalesce(cl.label, grouped.country_code),
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.species_slug = ts.species_slug
          AND vo.country_code IS NOT NULL
        GROUP BY vo.country_code
      ) grouped
      LEFT JOIN country_labels cl
        ON cl.country_code = grouped.country_code
    ) items
  ) countries ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.region_id AS value,
        grouped.region_label AS label,
        grouped.region_country_code AS country_code,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.region_id,
          'label', grouped.region_label,
          'countryCode', grouped.region_country_code,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.region_id,
          coalesce(vo.region_label, vo.region_id) AS region_label,
          coalesce(vo.region_country_code, vo.country_code) AS region_country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.species_slug = ts.species_slug
          AND vo.region_id IS NOT NULL
        GROUP BY
          vo.region_id,
          coalesce(vo.region_label, vo.region_id),
          coalesce(vo.region_country_code, vo.country_code)
      ) grouped
    ) items
  ) regions ON true
  LEFT JOIN LATERAL (
    SELECT concat(
      'https://media.sporely.no/',
      concat(
        CASE WHEN rep.storage_dir IS NULL THEN '' ELSE rep.storage_dir || '/' END,
        'thumb_',
        regexp_replace(rep.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      )
    ) AS representative_thumb_url
    FROM (
      SELECT
        nullif(
          regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''),
          btrim(i.storage_path, '/')
        ) AS storage_dir,
        regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
        vo.observed_on,
        i.sort_order,
        i.created_at,
        i.id
      FROM visible_observations vo
      JOIN public.observation_images i
        ON i.observation_id = vo.id
      WHERE vo.species_slug = ts.species_slug
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.storage_path IS NOT NULL
    ) rep
    ORDER BY rep.observed_on DESC, rep.sort_order NULLS LAST, rep.created_at DESC NULLS LAST, rep.id DESC
    LIMIT 1
  ) rep ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(
      array_agg(x.id ORDER BY x.observed_on DESC, x.id DESC),
      '{}'::bigint[]
    ) AS recent_observation_ids
    FROM (
      SELECT vo.id, vo.observed_on
      FROM visible_observations vo
      WHERE vo.species_slug = ts.species_slug
      ORDER BY vo.observed_on DESC, vo.id DESC
      LIMIT 5
    ) x
  ) recent ON true
$_$;


ALTER FUNCTION "public"."get_public_species"("p_species_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_species_distribution_summary"("p_species_slug" "text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text", "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_has_spores" boolean DEFAULT NULL::boolean) RETURNS TABLE("observationCount" bigint, "microscopyObservationCount" bigint, "sporeMeasurementCount" bigint, "firstObservedOn" "date", "lastObservedOn" "date", "sampleTypeFacets" "jsonb", "mountReagentFacets" "jsonb", "contrastMethodFacets" "jsonb", "mapPoints" "jsonb", "monthCounts" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH norm AS (
    SELECT
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(coalesce(p_species_slug, ''))),
            '[^a-z0-9]+', '-', 'g'
          ),
          '(^-|-$)', '', 'g'
        ),
        ''
      ) AS slug,
      nullif(btrim(upper(coalesce(p_country,       ''))), '') AS country,
      nullif(btrim(coalesce(p_region_id,           '')),  '') AS region_id,
      p_date_from                                             AS date_from,
      p_date_to                                               AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type,     ''))), '') AS sample_type,
      nullif(btrim(lower(coalesce(p_mount_reagent,   ''))), '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))), '') AS contrast_method,
      p_has_microscopy                                        AS has_microscopy,
      p_has_spores                                            AS has_spores
  ),

  -- All public, non-draft, non-banned-user observations for this species.
  -- No geographic or preparation filters — full set for facets and the
  -- existence gate (returns 0 rows when empty).
  all_obs AS (
    SELECT
      o.id,
      o.date                                                    AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), ''))    AS country_code,
      nullif(btrim(coalesce(o.region_id,           '')), '')    AS region_id,
      coalesce(o.location_precision, 'hidden')                  AS location_precision,
      o.gps_latitude,
      o.gps_longitude,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = o.user_id AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
      AND n.slug IS NOT NULL
      AND nullif(
            regexp_replace(
              regexp_replace(
                lower(btrim(concat_ws(' ',
                  nullif(btrim(coalesce(o.genus,   '')), ''),
                  nullif(btrim(coalesce(o.species, '')), '')
                ))),
                '[^a-z0-9]+', '-', 'g'
              ),
              '(^-|-$)', '', 'g'
            ),
            ''
          ) = n.slug
  ),

  -- Filtered observations: apply all input parameters to all_obs.
  -- Preparation filters use EXISTS so an observation qualifies when ANY
  -- of its microscope images matches (observation-level granularity for
  -- map/month counts).
  filtered_obs AS (
    SELECT
      ao.id,
      ao.observed_on,
      ao.location_precision,
      ao.gps_latitude,
      ao.gps_longitude,
      ao.spore_data_visibility
    FROM all_obs ao
    CROSS JOIN norm n
    WHERE (n.country    IS NULL OR ao.country_code = n.country)
      AND (n.region_id  IS NULL OR ao.region_id    = n.region_id)
      AND (n.date_from  IS NULL OR ao.observed_on >= n.date_from)
      AND (n.date_to    IS NULL OR ao.observed_on <= n.date_to)
      -- Preparation filters via EXISTS (any matching image, not just latest).
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.sample_type, '')) = n.sample_type
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.mount_medium, '')) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.contrast, '')) = n.contrast_method
      ))
      -- p_has_microscopy = true: must have at least one non-deleted/purged microscope image.
      AND (n.has_microscopy IS NOT TRUE OR EXISTS (
        SELECT 1 FROM public.observation_images i3
        WHERE i3.observation_id = ao.id
          AND i3.deleted_at IS NULL AND i3.purged_at IS NULL
          AND i3.image_type = 'microscope'
      ))
      -- p_has_spores = true: public spore_data_visibility + at least one qualifying measurement.
      AND (n.has_spores IS NOT TRUE OR (
        ao.spore_data_visibility = 'public'
        AND EXISTS (
          SELECT 1
          FROM public.observation_images i4
          JOIN public.spore_measurements m ON m.image_id = i4.id
          WHERE i4.observation_id = ao.id
            AND i4.deleted_at IS NULL AND i4.purged_at IS NULL
            AND i4.image_type = 'microscope'
            AND m.length_um IS NOT NULL
            AND (
              m.measurement_type IS NULL
              OR m.measurement_type = ''
              OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
            )
        )
      ))
  ),

  -- Per-observation enriched filtered set: microscopy flag and prep-filtered
  -- spore count.
  --
  -- FIX (Bug 2): CROSS JOIN norm n brings prep filter values into scope.
  -- The spore_measurement_count subquery now applies the same image-level prep
  -- conditions so only measurements from matching-preparation images are
  -- counted.  Map/month counts still use observation-level EXISTS (above).
  filtered_obs_enriched AS (
    SELECT
      fo.id,
      fo.observed_on,
      fo.location_precision,
      fo.gps_latitude,
      fo.gps_longitude,
      -- Microscopy presence: any non-deleted/purged microscope image.
      (EXISTS (
        SELECT 1 FROM public.observation_images i
        WHERE i.observation_id = fo.id
          AND i.deleted_at IS NULL AND i.purged_at IS NULL
          AND i.image_type = 'microscope'
      )) AS has_microscopy,
      -- Spore measurement count (public only, prep-filtered).
      CASE
        WHEN fo.spore_data_visibility = 'public' THEN (
          SELECT count(m.id)::bigint
          FROM public.observation_images i
          JOIN public.spore_measurements m ON m.image_id = i.id
          WHERE i.observation_id = fo.id
            AND i.deleted_at IS NULL AND i.purged_at IS NULL
            AND i.image_type = 'microscope'
            AND m.length_um IS NOT NULL
            AND (
              m.measurement_type IS NULL
              OR m.measurement_type = ''
              OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
            )
            -- Image-level prep filters (same conditions as filtered_obs EXISTS).
            AND (n.sample_type     IS NULL OR lower(coalesce(i.sample_type,  '')) = n.sample_type)
            AND (n.mount_reagent   IS NULL OR lower(coalesce(i.mount_medium, '')) = n.mount_reagent)
            AND (n.contrast_method IS NULL OR lower(coalesce(i.contrast,     '')) = n.contrast_method)
        )
        ELSE 0::bigint
      END AS spore_measurement_count
    FROM filtered_obs fo
    CROSS JOIN norm n   -- needed to reference n.sample_type etc. inside subquery
  ),

  -- Coverage aggregate over all filtered enriched observations.
  coverage AS (
    SELECT
      count(foe.id)::bigint                                 AS observation_count,
      count(*) FILTER (WHERE foe.has_microscopy)::bigint    AS microscopy_observation_count,
      coalesce(sum(foe.spore_measurement_count), 0)::bigint AS spore_measurement_count,
      min(foe.observed_on)                                  AS first_observed_on,
      max(foe.observed_on)                                  AS last_observed_on
    FROM filtered_obs_enriched foe
  ),

  -- sampleTypeFacets: FIX (Bug 1): join ALL microscopy images (not latest only).
  -- Count DISTINCT observation IDs per prep value so an observation with two
  -- fresh images is counted once.  Matches the EXISTS filter used for selection.
  sample_type_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', st.sv, 'count', st.cnt)
        ORDER BY st.cnt DESC, st.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(lower(btrim(coalesce(i.sample_type, ''))), '') AS sv,
        count(DISTINCT ao.id)::bigint                          AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
      WHERE nullif(lower(btrim(coalesce(i.sample_type, ''))), '') IS NOT NULL
      GROUP BY nullif(lower(btrim(coalesce(i.sample_type, ''))), '')
    ) st
  ),

  -- mountReagentFacets: same fix — all microscopy images, distinct obs per value.
  mount_reagent_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', mr.sv, 'count', mr.cnt)
        ORDER BY mr.cnt DESC, mr.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(lower(btrim(coalesce(i.mount_medium, ''))), '') AS sv,
        count(DISTINCT ao.id)::bigint                           AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
      WHERE nullif(lower(btrim(coalesce(i.mount_medium, ''))), '') IS NOT NULL
      GROUP BY nullif(lower(btrim(coalesce(i.mount_medium, ''))), '')
    ) mr
  ),

  -- contrastMethodFacets: same fix.  Note: contrast values are NOT lowercased
  -- in the facet output (DIC/BF etc. are conventionally uppercase), but are
  -- lowercased in the filter norm for case-insensitive matching.
  contrast_method_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', cm.sv, 'count', cm.cnt)
        ORDER BY cm.cnt DESC, cm.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(btrim(coalesce(i.contrast, '')), '') AS sv,
        count(DISTINCT ao.id)::bigint               AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
      WHERE nullif(btrim(coalesce(i.contrast, '')), '') IS NOT NULL
      GROUP BY nullif(btrim(coalesce(i.contrast, '')), '')
    ) cm
  ),

  -- mapPoints: privacy-safe coordinates from filtered_obs. LIMIT 1000.
  map_points AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'observationId',     pt.id,
          'mapLat',            pt.map_lat,
          'mapLon',            pt.map_lon,
          'locationPrecision', pt.location_precision,
          'observedOn',        pt.observed_on,
          'hasMicroscopy',     pt.has_microscopy
        )
        ORDER BY pt.observed_on DESC, pt.id DESC
      ),
      '[]'::jsonb
    ) AS points
    FROM (
      SELECT
        foe.id,
        foe.observed_on,
        foe.location_precision,
        foe.has_microscopy,
        CASE
          WHEN foe.location_precision = 'exact'  THEN foe.gps_latitude
          WHEN foe.location_precision = 'fuzzed' THEN round(foe.gps_latitude::numeric, 2)::double precision
          ELSE NULL::double precision
        END AS map_lat,
        CASE
          WHEN foe.location_precision = 'exact'  THEN foe.gps_longitude
          WHEN foe.location_precision = 'fuzzed' THEN round(foe.gps_longitude::numeric, 2)::double precision
          ELSE NULL::double precision
        END AS map_lon
      FROM filtered_obs_enriched foe
      WHERE foe.gps_latitude IS NOT NULL
      ORDER BY foe.observed_on DESC, foe.id DESC
      LIMIT 1000
    ) pt
  ),

  -- monthCounts: calendar month distribution from filtered_obs.
  month_counts AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('month', mc.month, 'count', mc.cnt)
        ORDER BY mc.month ASC
      ),
      '[]'::jsonb
    ) AS counts
    FROM (
      SELECT
        EXTRACT(MONTH FROM foe.observed_on)::int AS month,
        count(*)::bigint                         AS cnt
      FROM filtered_obs_enriched foe
      GROUP BY EXTRACT(MONTH FROM foe.observed_on)::int
      HAVING count(*) > 0
    ) mc
  )

  SELECT
    c.observation_count            AS "observationCount",
    c.microscopy_observation_count AS "microscopyObservationCount",
    c.spore_measurement_count      AS "sporeMeasurementCount",
    c.first_observed_on            AS "firstObservedOn",
    c.last_observed_on             AS "lastObservedOn",
    (SELECT facets FROM sample_type_facets)     AS "sampleTypeFacets",
    (SELECT facets FROM mount_reagent_facets)   AS "mountReagentFacets",
    (SELECT facets FROM contrast_method_facets) AS "contrastMethodFacets",
    (SELECT points FROM map_points)             AS "mapPoints",
    (SELECT counts FROM month_counts)           AS "monthCounts"
  FROM coverage c
  WHERE EXISTS (SELECT 1 FROM all_obs)
$_$;


ALTER FUNCTION "public"."get_public_species_distribution_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_species_spore_summary"("p_species_slug" "text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date") RETURNS TABLE("speciesSlug" "text", "speciesName" "text", "speciesCommonName" "text", "observationCount" bigint, "microscopyObservationCount" bigint, "sporeObservationCount" bigint, "sporeMeasurementCount" bigint, "firstObservedOn" "date", "lastObservedOn" "date", "countries" "jsonb", "regions" "jsonb", "sporeSummary" "jsonb", "observations" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH norm AS (
    SELECT
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(coalesce(p_species_slug, ''))),
            '[^a-z0-9]+', '-', 'g'
          ),
          '(^-|-$)', '', 'g'
        ),
        ''
      ) AS slug,
      nullif(btrim(upper(coalesce(p_country, ''))),   '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),        '') AS region_id,
      p_date_from AS date_from,
      p_date_to   AS date_to
  ),
  country_labels AS (
    SELECT *
    FROM (VALUES
      ('DE'::text, 'Germany'::text),
      ('FI'::text, 'Finland'::text),
      ('GB'::text, 'United Kingdom'::text),
      ('NO'::text, 'Norway'::text),
      ('SE'::text, 'Sweden'::text)
    ) AS c(code, label)
  ),
  -- All public, non-draft, non-banned observations matching the target species
  -- and the optional geographic / date filters.
  species_obs AS (
    SELECT
      o.id,
      nullif(btrim(concat_ws(' ',
        nullif(btrim(coalesce(o.genus,   '')), ''),
        nullif(btrim(coalesce(o.species, '')), '')
      )), '') AS species_name,
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(concat_ws(' ',
              nullif(btrim(coalesce(o.genus,   '')), ''),
              nullif(btrim(coalesce(o.species, '')), '')
            ))),
            '[^a-z0-9]+', '-', 'g'
          ),
          '(^-|-$)', '', 'g'
        ),
        ''
      ) AS species_slug,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      coalesce(o.location_precision, 'hidden') AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '') AS location_text,
      o.spore_data_visibility,
      o.spore_statistics,
      (micro.id IS NOT NULL) AS has_microscopy
    FROM public.observations o
    CROSS JOIN norm n
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT i.id
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
      LIMIT 1
    ) micro ON true
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = o.user_id AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
      -- Species slug match (same normalisation as search_public_species).
      AND nullif(
            regexp_replace(
              regexp_replace(
                lower(btrim(concat_ws(' ',
                  nullif(btrim(coalesce(o.genus,   '')), ''),
                  nullif(btrim(coalesce(o.species, '')), '')
                ))),
                '[^a-z0-9]+', '-', 'g'
              ),
              '(^-|-$)', '', 'g'
            ),
            ''
          ) = n.slug
      -- Optional filters.
      AND (n.country   IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from IS NULL OR o.date >= n.date_from)
      AND (n.date_to   IS NULL OR o.date <= n.date_to)
  ),
  -- Subset: observations with public spore data and ≥1 qualifying measurement.
  spore_eligible AS (
    SELECT
      so.id,
      so.observed_on,
      so.country_code,
      so.region_id,
      so.region_label,
      so.location_precision,
      so.location_text,
      so.spore_statistics,
      spore_counts.spore_n
    FROM species_obs so
    JOIN LATERAL (
      SELECT count(m.id)::bigint AS spore_n
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = so.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_counts ON spore_counts.spore_n > 0
    WHERE so.spore_data_visibility = 'public'
  ),
  -- Flat raw measurements for aggregate statistics.
  raw_meas AS (
    SELECT m.length_um, m.width_um
    FROM spore_eligible se
    JOIN public.observation_images i
      ON i.observation_id = se.id
      AND i.deleted_at IS NULL
      AND i.purged_at  IS NULL
      AND i.image_type = 'microscope'
    JOIN public.spore_measurements m ON m.image_id = i.id
      AND m.length_um IS NOT NULL
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  ),
  -- Aggregate length stats over all qualifying measurements.
  agg_len AS (
    SELECT
      count(*)::bigint                                                            AS n,
      min(length_um)                                                              AS len_min,
      max(length_um)                                                              AS len_max,
      avg(length_um)                                                              AS len_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um)::double precision  AS len_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um)::double precision  AS len_p95
    FROM raw_meas
  ),
  -- Aggregate width and Q stats over measurements that have a valid width.
  agg_wq AS (
    SELECT
      min(width_um)                                                               AS wid_min,
      max(width_um)                                                               AS wid_max,
      avg(width_um)                                                               AS wid_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY width_um)::double precision   AS wid_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY width_um)::double precision   AS wid_p95,
      min(length_um / nullif(width_um, 0))                                        AS q_min,
      max(length_um / nullif(width_um, 0))                                        AS q_max,
      avg(length_um / nullif(width_um, 0))                                        AS q_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p95
    FROM raw_meas
    WHERE width_um IS NOT NULL AND width_um > 0
  ),
  -- Per-observation means computed fresh from raw measurements (not from stored spore_statistics).
  obs_means AS (
    SELECT
      se.id            AS observation_id,
      se.observed_on,
      se.country_code,
      se.region_id,
      CASE
        WHEN se.location_precision = 'exact'  THEN se.location_text
        WHEN se.location_precision = 'fuzzed' THEN coalesce(se.region_label, se.country_code)
        WHEN se.location_precision = 'region' THEN se.region_label
        ELSE NULL
      END              AS location_label,
      se.spore_n,
      se.spore_statistics,
      obs_stats.length_mean,
      obs_stats.width_mean,
      obs_stats.q_mean
    FROM spore_eligible se
    JOIN LATERAL (
      SELECT
        avg(m.length_um) AS length_mean,
        avg(m.width_um)  FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS width_mean,
        avg(m.length_um / nullif(m.width_um, 0))
                         FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS q_mean
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) obs_stats ON true
  )
  SELECT
    -- Species identity (from first matching observation).
    (SELECT species_slug  FROM species_obs LIMIT 1)  AS "speciesSlug",
    (SELECT species_name  FROM species_obs LIMIT 1)  AS "speciesName",
    (SELECT common_name   FROM species_obs LIMIT 1)  AS "speciesCommonName",
    -- Coverage.
    (SELECT count(*)::bigint  FROM species_obs)                          AS "observationCount",
    (SELECT count(*)::bigint  FROM species_obs WHERE has_microscopy)     AS "microscopyObservationCount",
    (SELECT count(*)::bigint  FROM spore_eligible)                       AS "sporeObservationCount",
    coalesce((SELECT sum(spore_n) FROM spore_eligible), 0)::bigint       AS "sporeMeasurementCount",
    (SELECT min(observed_on) FROM species_obs)                           AS "firstObservedOn",
    (SELECT max(observed_on) FROM species_obs)                           AS "lastObservedOn",
    -- Countries facet.
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'value', g.cc,
          'label', coalesce(cl.label, g.cc),
          'count', g.cnt
        )
        ORDER BY g.cnt DESC, g.cc ASC
      )
      FROM (
        SELECT country_code AS cc, count(*)::bigint AS cnt
        FROM species_obs
        WHERE country_code IS NOT NULL
        GROUP BY country_code
      ) g
      LEFT JOIN country_labels cl ON cl.code = g.cc
    ), '[]'::jsonb) AS countries,
    -- Regions facet.
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'value',       g.rid,
          'label',       g.rlabel,
          'countryCode', g.rcc,
          'count',       g.cnt
        )
        ORDER BY g.cnt DESC, g.rid ASC
      )
      FROM (
        SELECT
          region_id AS rid,
          coalesce(region_label, region_id) AS rlabel,
          coalesce(region_country_code, country_code) AS rcc,
          count(*)::bigint AS cnt
        FROM species_obs
        WHERE region_id IS NOT NULL
        GROUP BY
          region_id,
          coalesce(region_label, region_id),
          coalesce(region_country_code, country_code)
      ) g
    ), '[]'::jsonb) AS regions,
    -- Aggregate spore summary (NULL when no public measurements).
    -- length_core_min/max are aliases for p05/p95 so the landing SporeSummary
    -- type picks them up via its firstFiniteNumber preference chain.
    CASE WHEN (SELECT n FROM agg_len) > 0 THEN
      jsonb_strip_nulls(jsonb_build_object(
        'n',                  (SELECT n        FROM agg_len),
        'length_min_um',      (SELECT len_min  FROM agg_len),
        'length_max_um',      (SELECT len_max  FROM agg_len),
        'length_p05_um',      (SELECT len_p05  FROM agg_len),
        'length_p95_um',      (SELECT len_p95  FROM agg_len),
        'length_core_min_um', (SELECT len_p05  FROM agg_len),
        'length_core_max_um', (SELECT len_p95  FROM agg_len),
        'length_mean_um',     (SELECT len_mean FROM agg_len),
        'width_min_um',       (SELECT wid_min  FROM agg_wq),
        'width_max_um',       (SELECT wid_max  FROM agg_wq),
        'width_p05_um',       (SELECT wid_p05  FROM agg_wq),
        'width_p95_um',       (SELECT wid_p95  FROM agg_wq),
        'width_core_min_um',  (SELECT wid_p05  FROM agg_wq),
        'width_core_max_um',  (SELECT wid_p95  FROM agg_wq),
        'width_mean_um',      (SELECT wid_mean FROM agg_wq),
        'q_min',              (SELECT q_min    FROM agg_wq),
        'q_max',              (SELECT q_max    FROM agg_wq),
        'q_p05',              (SELECT q_p05    FROM agg_wq),
        'q_p95',              (SELECT q_p95    FROM agg_wq),
        'q_core_min',         (SELECT q_p05    FROM agg_wq),
        'q_core_max',         (SELECT q_p95    FROM agg_wq),
        'q_mean',             (SELECT q_mean   FROM agg_wq)
      ))
    ELSE NULL END AS "sporeSummary",
    -- Per-observation array ordered most-recent first.
    coalesce((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'observationId', om.observation_id,
          'observedOn',    om.observed_on,
          'country',       om.country_code,
          'regionId',      om.region_id,
          'locationLabel', om.location_label,
          'sporeN',        om.spore_n,
          'lengthMeanUm',  om.length_mean,
          'widthMeanUm',   om.width_mean,
          'qMean',         om.q_mean,
          'sporeSummary',  om.spore_statistics
        ))
        ORDER BY om.observed_on DESC, om.observation_id DESC
      )
      FROM obs_means om
    ), '[]'::jsonb) AS "observations"
  FROM (SELECT 1) AS _single
  WHERE EXISTS (SELECT 1 FROM species_obs)
$_$;


ALTER FUNCTION "public"."get_public_species_spore_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_spore_comparison_set"("p_species_slug" "text" DEFAULT NULL::"text", "p_genus" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text") RETURNS TABLE("sourceType" "text", "taxonRank" "text", "speciesSlug" "text", "genus" "text", "label" "text", "filters" "jsonb", "observationCount" bigint, "sporeObservationCount" bigint, "sporeMeasurementCount" bigint, "sporeSummary" "jsonb", "observations" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH norm AS (
    SELECT
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(coalesce(p_species_slug, ''))),
            '[^a-z0-9]+', '-', 'g'
          ),
          '(^-|-$)', '', 'g'
        ),
        ''
      ) AS slug,
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(upper(coalesce(p_country, ''))),    '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),         '') AS region_id,
      p_date_from AS date_from,
      p_date_to   AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type, ''))),     '') AS sample_type,
      nullif(btrim(lower(coalesce(p_mount_reagent, ''))),   '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))), '') AS contrast_method
  ),
  taxon AS (
    SELECT
      CASE
        WHEN n.slug IS NOT NULL THEN 'species'
        WHEN n.genus IS NOT NULL THEN 'genus'
        ELSE NULL
      END AS rank,
      n.slug  AS species_slug,
      n.genus AS genus_filter
    FROM norm n
  ),
  taxon_obs AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '')    AS obs_genus,
      nullif(btrim(coalesce(o.species, '')), '')  AS obs_species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS obs_common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden')     AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '')  AS location_text,
      nullif(btrim(coalesce(r.label, '')), '')     AS region_label,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
    CROSS JOIN taxon t
    LEFT JOIN public.public_regions r ON r.id = o.region_id
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = o.user_id AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
      AND (
        CASE t.rank
          WHEN 'species' THEN
            nullif(
              regexp_replace(
                regexp_replace(
                  lower(btrim(concat_ws(' ',
                    nullif(btrim(coalesce(o.genus,   '')), ''),
                    nullif(btrim(coalesce(o.species, '')), '')
                  ))),
                  '[^a-z0-9]+', '-', 'g'
                ),
                '(^-|-$)', '', 'g'
              ),
              ''
            ) = t.species_slug
          WHEN 'genus' THEN
            lower(coalesce(o.genus, '')) = lower(t.genus_filter)
          ELSE false
        END
      )
      AND (n.country    IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id  IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from  IS NULL OR o.date >= n.date_from)
      AND (n.date_to    IS NULL OR o.date <= n.date_to)
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(btrim(coalesce(i2.sample_type, ''))) = n.sample_type
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(btrim(coalesce(i2.mount_medium, ''))) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(btrim(coalesce(i2.contrast, ''))) = n.contrast_method
      ))
  ),
  spore_eligible AS (
    SELECT
      to_id.id,
      to_id.observed_on,
      to_id.obs_genus,
      to_id.obs_species,
      to_id.obs_common_name,
      to_id.country_code,
      to_id.region_id,
      to_id.location_precision,
      to_id.location_text,
      to_id.region_label,
      spore_counts.spore_n,
      n.sample_type     AS filter_sample_type,
      n.mount_reagent   AS filter_mount_reagent,
      n.contrast_method AS filter_contrast_method
    FROM taxon_obs to_id
    CROSS JOIN norm n
    JOIN LATERAL (
      SELECT count(m.id)::bigint AS spore_n
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = to_id.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (n.sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = n.sample_type)
        AND (n.mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = n.mount_reagent)
        AND (n.contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = n.contrast_method)
    ) spore_counts ON spore_counts.spore_n > 0
    WHERE to_id.spore_data_visibility = 'public'
  ),
  raw_meas AS (
    SELECT m.length_um, m.width_um
    FROM spore_eligible se
    JOIN public.observation_images i
      ON i.observation_id = se.id
      AND i.deleted_at IS NULL
      AND i.purged_at  IS NULL
      AND i.image_type = 'microscope'
      AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
      AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
      AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    JOIN public.spore_measurements m ON m.image_id = i.id
      AND m.length_um IS NOT NULL
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  ),
  agg_len AS (
    SELECT
      count(*)::bigint                                                           AS n,
      min(length_um)                                                             AS len_min,
      max(length_um)                                                             AS len_max,
      avg(length_um)                                                             AS len_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um)::double precision AS len_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um)::double precision AS len_p95
    FROM raw_meas
  ),
  agg_wq AS (
    SELECT
      min(width_um)                                                              AS wid_min,
      max(width_um)                                                              AS wid_max,
      avg(width_um)                                                              AS wid_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY width_um)::double precision  AS wid_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY width_um)::double precision  AS wid_p95,
      min(length_um / nullif(width_um, 0))                                       AS q_min,
      max(length_um / nullif(width_um, 0))                                       AS q_max,
      avg(length_um / nullif(width_um, 0))                                       AS q_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p95
    FROM raw_meas
    WHERE width_um IS NOT NULL AND width_um > 0
  ),
  obs_means AS (
    SELECT
      se.id               AS observation_id,
      se.observed_on,
      se.obs_genus,
      se.obs_species,
      se.obs_common_name,
      se.country_code,
      se.region_id,
      CASE
        WHEN se.location_precision = 'exact'  THEN se.location_text
        WHEN se.location_precision = 'fuzzed' THEN coalesce(se.region_label, se.country_code)
        WHEN se.location_precision = 'region' THEN se.region_label
        ELSE NULL
      END                 AS location_label,
      se.spore_n,
      se.filter_sample_type,
      se.filter_mount_reagent,
      se.filter_contrast_method,
      rep_img.sample_type    AS rep_sample_type,
      rep_img.sample_source  AS rep_sample_source,
      rep_img.mount_medium   AS rep_mount_reagent,
      rep_img.contrast       AS rep_contrast_method,
      rep_img.stain          AS rep_stain_reagent,
      obs_stats.length_mean,
      obs_stats.width_mean,
      obs_stats.q_mean,
      obs_agg.obs_spore_summary
    FROM spore_eligible se
    LEFT JOIN LATERAL (
      SELECT
        i.sample_type,
        i.sample_source,
        i.mount_medium,
        i.contrast,
        i.stain
      FROM public.observation_images i
      JOIN LATERAL (
        SELECT count(*)::bigint AS n
        FROM public.spore_measurements m
        WHERE m.image_id = i.id
          AND m.length_um IS NOT NULL
          AND m.width_um  IS NOT NULL
          AND m.width_um > 0
          AND (
            m.measurement_type IS NULL
            OR m.measurement_type = ''
            OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
          )
      ) contrib ON contrib.n > 0
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
        AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
      ORDER BY contrib.n DESC, i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) rep_img ON true
    JOIN LATERAL (
      SELECT
        avg(m.length_um) AS length_mean,
        avg(m.width_um)  FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS width_mean,
        avg(m.length_um / nullif(m.width_um, 0))
                         FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS q_mean
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    ) obs_stats ON true
    JOIN LATERAL (
      SELECT
        jsonb_strip_nulls(jsonb_build_object(
          'n',               count(m.id)::bigint,
          'length_min_um',   min(m.length_um),
          'length_max_um',   max(m.length_um),
          'length_mean_um',  avg(m.length_um),
          'width_min_um',    min(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'width_max_um',    max(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'width_mean_um',   avg(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_min',           min(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_max',           max(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_mean',          avg(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0)
        )) AS obs_spore_summary
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    ) obs_agg ON true
  ),
  first_obs AS (
    SELECT obs_genus, obs_species, obs_common_name
    FROM taxon_obs
    LIMIT 1
  )
  SELECT
    'taxon_filter'::text AS "sourceType",
    (SELECT rank FROM taxon) AS "taxonRank",
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (
        SELECT nullif(
          regexp_replace(
            regexp_replace(
              lower(btrim(concat_ws(' ',
                nullif(btrim(coalesce(fo.obs_genus,   '')), ''),
                nullif(btrim(coalesce(fo.obs_species, '')), '')
              ))),
              '[^a-z0-9]+', '-', 'g'
            ),
            '(^-|-$)', '', 'g'
          ),
          ''
        )
        FROM first_obs fo
      )
      ELSE NULL
    END AS "speciesSlug",
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (SELECT nullif(btrim(coalesce(fo.obs_genus, '')), '') FROM first_obs fo)
      WHEN 'genus'   THEN (SELECT genus_filter FROM taxon)
      ELSE NULL
    END AS genus,
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (
        SELECT nullif(btrim(concat_ws(' ',
          nullif(btrim(coalesce(fo.obs_genus,   '')), ''),
          nullif(btrim(coalesce(fo.obs_species, '')), '')
        )), '')
        FROM first_obs fo
      )
      WHEN 'genus' THEN (SELECT genus_filter FROM taxon)
      ELSE NULL
    END AS label,
    jsonb_strip_nulls(jsonb_build_object(
      'country',         (SELECT country    FROM norm),
      'regionId',        (SELECT region_id  FROM norm),
      'dateFrom',        (SELECT date_from  FROM norm),
      'dateTo',          (SELECT date_to    FROM norm),
      'sampleType',      (SELECT sample_type     FROM norm),
      'mountReagent',    (SELECT mount_reagent   FROM norm),
      'contrastMethod',  (SELECT contrast_method FROM norm)
    ))                   AS filters,
    (SELECT count(*)::bigint FROM taxon_obs)           AS "observationCount",
    (SELECT count(*)::bigint FROM spore_eligible)      AS "sporeObservationCount",
    coalesce((SELECT sum(spore_n) FROM spore_eligible), 0)::bigint AS "sporeMeasurementCount",
    CASE WHEN (SELECT n FROM agg_len) > 0 THEN
      jsonb_strip_nulls(jsonb_build_object(
        'n',                  (SELECT n        FROM agg_len),
        'length_min_um',      (SELECT len_min  FROM agg_len),
        'length_max_um',      (SELECT len_max  FROM agg_len),
        'length_p05_um',      (SELECT len_p05  FROM agg_len),
        'length_p95_um',      (SELECT len_p95  FROM agg_len),
        'length_core_min_um', (SELECT len_p05  FROM agg_len),
        'length_core_max_um', (SELECT len_p95  FROM agg_len),
        'length_mean_um',     (SELECT len_mean FROM agg_len),
        'width_min_um',       (SELECT wid_min  FROM agg_wq),
        'width_max_um',       (SELECT wid_max  FROM agg_wq),
        'width_p05_um',       (SELECT wid_p05  FROM agg_wq),
        'width_p95_um',       (SELECT wid_p95  FROM agg_wq),
        'width_core_min_um',  (SELECT wid_p05  FROM agg_wq),
        'width_core_max_um',  (SELECT wid_p95  FROM agg_wq),
        'width_mean_um',      (SELECT wid_mean FROM agg_wq),
        'q_min',              (SELECT q_min    FROM agg_wq),
        'q_max',              (SELECT q_max    FROM agg_wq),
        'q_p05',              (SELECT q_p05    FROM agg_wq),
        'q_p95',              (SELECT q_p95    FROM agg_wq),
        'q_core_min',         (SELECT q_p05    FROM agg_wq),
        'q_core_max',         (SELECT q_p95    FROM agg_wq),
        'q_mean',             (SELECT q_mean   FROM agg_wq)
      ))
    ELSE NULL END AS "sporeSummary",
    coalesce((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'observationId',      om.observation_id,
          'observedOn',         om.observed_on,
          'speciesSlug',        nullif(
                                  regexp_replace(
                                    regexp_replace(
                                      lower(btrim(concat_ws(' ',
                                        nullif(btrim(coalesce(om.obs_genus,   '')), ''),
                                        nullif(btrim(coalesce(om.obs_species, '')), '')
                                      ))),
                                      '[^a-z0-9]+', '-', 'g'
                                    ),
                                    '(^-|-$)', '', 'g'
                                  ),
                                  ''
                                ),
          'speciesName',        nullif(btrim(concat_ws(' ',
                                  nullif(btrim(coalesce(om.obs_genus,   '')), ''),
                                  nullif(btrim(coalesce(om.obs_species, '')), '')
                                )), ''),
          'speciesCommonName',  om.obs_common_name,
          'country',            om.country_code,
          'regionId',           om.region_id,
          'locationLabel',      om.location_label,
          'sampleType',         CASE
                                  WHEN lower(btrim(coalesce(coalesce(om.rep_sample_type, om.filter_sample_type), ''))) IN ('fresh', 'dried')
                                    THEN lower(btrim(coalesce(om.rep_sample_type, om.filter_sample_type)))
                                  ELSE NULL::text
                                END,
          'sampleSource',       CASE
                                  WHEN lower(btrim(coalesce(om.rep_sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
                                    THEN lower(btrim(om.rep_sample_source))
                                  ELSE NULL::text
                                END,
          'mountReagent',       coalesce(om.rep_mount_reagent,   om.filter_mount_reagent),
          'contrastMethod',     coalesce(om.rep_contrast_method, om.filter_contrast_method),
          'stainReagent',       nullif(btrim(coalesce(om.rep_stain_reagent, '')), ''),
          'sporeN',             om.spore_n,
          'lengthMeanUm',       om.length_mean,
          'widthMeanUm',        om.width_mean,
          'qMean',              om.q_mean,
          'sporeSummary',       om.obs_spore_summary
        ))
        ORDER BY om.observed_on DESC, om.observation_id DESC
      )
      FROM obs_means om
    ), '[]'::jsonb) AS "observations"
  FROM (SELECT 1) AS _single
  WHERE (SELECT rank FROM taxon) IS NOT NULL
    AND EXISTS (SELECT 1 FROM taxon_obs)
$_$;


ALTER FUNCTION "public"."get_public_spore_comparison_set"("p_species_slug" "text", "p_genus" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  candidate_username text;
  candidate_display_name text;
begin
  candidate_username := coalesce(
    nullif(btrim(new.raw_user_meta_data->>'username'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), '')
  );

  candidate_display_name := coalesce(
    nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
    candidate_username,
    new.email,
    new.id::text
  );

  if candidate_username is not null
     and exists (
       select 1
       from public.profiles p
       where lower(p.username) = lower(candidate_username)
     ) then
    candidate_username :=
      candidate_username || '_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    candidate_username,
    candidate_display_name
  )
  on conflict (id) do nothing;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_blocked_between"("user_a" "uuid", "user_b" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT user_a IS NOT NULL
     AND user_b IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.user_blocks ub
       WHERE (ub.blocker_id = user_a AND ub.blocked_id = user_b)
          OR (ub.blocker_id = user_b AND ub.blocked_id = user_a)
     )
$$;


ALTER FUNCTION "public"."is_blocked_between"("user_a" "uuid", "user_b" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."non_public_observation_count"("profile_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT count(*)::integer
  FROM public.observations o
  WHERE o.user_id = profile_id
    AND NOT coalesce(o.is_draft, false)
    AND (
      coalesce(o.visibility, 'public') <> 'public'
      OR coalesce(o.location_precision, 'exact') IN ('fuzzed', 'region', 'hidden')
    )
$$;


ALTER FUNCTION "public"."non_public_observation_count"("profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profile_has_pro_access"("profile_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT coalesce(p.is_pro, false) OR coalesce(p.cloud_plan, 'free') = 'pro'
  FROM public.profiles p
  WHERE p.id = profile_id
$$;


ALTER FUNCTION "public"."profile_has_pro_access"("profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_profile_privileged_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Keep entitlement, quota, and moderation fields server-owned.
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  NEW.cloud_plan = OLD.cloud_plan;
  NEW.full_res_storage_enabled = OLD.full_res_storage_enabled;
  NEW.storage_quota_bytes = OLD.storage_quota_bytes;
  NEW.storage_used_bytes = OLD.storage_used_bytes;
  NEW.billing_status = OLD.billing_status;
  NEW.billing_provider = OLD.billing_provider;
  NEW.billing_customer_id = OLD.billing_customer_id;
  NEW.billing_payment_id = OLD.billing_payment_id;
  NEW.billing_checkout_session_id = OLD.billing_checkout_session_id;
  NEW.billing_updated_at = OLD.billing_updated_at;
  NEW.total_storage_bytes = OLD.total_storage_bytes;
  NEW.image_count = OLD.image_count;
  NEW.is_admin = OLD.is_admin;
  NEW.is_banned = OLD.is_banned;
  NEW.is_pro = OLD.is_pro;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_profile_privileged_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_community_spore_datasets"("p_genus" "text", "p_species" "text", "p_limit" integer DEFAULT 50) RETURNS TABLE("dataset_type" "text", "observation_id" bigint, "genus" "text", "species" "text", "contributor_label" "text", "observed_on" "date", "measurement_count" bigint, "image_count" bigint, "length_min" double precision, "length_p05" double precision, "length_p50" double precision, "length_p95" double precision, "length_max" double precision, "width_min" double precision, "width_p05" double precision, "width_p50" double precision, "width_p95" double precision, "width_max" double precision, "q_min" double precision, "q_p50" double precision, "q_max" double precision, "qc_flags" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH filtered AS (
    SELECT
      o.id AS observation_id,
      o.user_id,
      o.genus,
      o.species,
      o.date,
      o.author,
      i.id AS image_id,
      i.mount_medium,
      i.stain,
      i.sample_type,
      i.contrast,
      i.objective_name,
      i.scale_microns_per_pixel,
      m.id AS measurement_id,
      m.length_um,
      m.width_um,
      m.p1_x,
      m.p1_y,
      m.p2_x,
      m.p2_y,
      m.p3_x,
      m.p3_y,
      m.p4_x,
      m.p4_y
    FROM public.observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
    JOIN public.spore_measurements m
      ON m.image_id = i.id
    WHERE lower(coalesce(o.genus, '')) = lower(trim(coalesce(p_genus, '')))
      AND (trim(coalesce(p_species, '')) = '' OR lower(coalesce(o.species, '')) = lower(trim(p_species)))
      AND NOT coalesce(o.is_draft, false)
      AND public.can_access_spore_data(o.user_id, o.spore_data_visibility)
      AND m.length_um IS NOT NULL
      AND m.width_um IS NOT NULL
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  )
  SELECT
    'observation'::text AS dataset_type,
    f.observation_id,
    max(f.genus) AS genus,
    max(f.species) AS species,
    public.community_contributor_label((array_agg(f.user_id))[1], max(f.author)) AS contributor_label,
    max(f.date) AS observed_on,
    count(f.measurement_id) AS measurement_count,
    count(distinct f.image_id) AS image_count,
    min(f.length_um) AS length_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p95,
    max(f.length_um) AS length_max,
    min(f.width_um) AS width_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p95,
    max(f.width_um) AS width_max,
    min(f.length_um / nullif(f.width_um, 0)) AS q_min,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY (f.length_um / nullif(f.width_um, 0)))::double precision AS q_p50,
    max(f.length_um / nullif(f.width_um, 0)) AS q_max,
    jsonb_build_object(
      'has_mount', bool_or(nullif(f.mount_medium, '') IS NOT NULL),
      'has_stain', bool_or(nullif(f.stain, '') IS NOT NULL),
      'has_sample_type', bool_or(nullif(f.sample_type, '') IS NOT NULL),
      'has_contrast', bool_or(nullif(f.contrast, '') IS NOT NULL),
      'has_objective', bool_or(nullif(f.objective_name, '') IS NOT NULL),
      'has_scale', bool_or(f.scale_microns_per_pixel IS NOT NULL),
      'has_point_geometry', bool_or(
        f.p1_x IS NOT NULL OR f.p1_y IS NOT NULL OR f.p2_x IS NOT NULL OR f.p2_y IS NOT NULL
      ),
      'measurement_count', count(f.measurement_id)
    ) AS qc_flags
  FROM filtered f
  GROUP BY f.observation_id
  ORDER BY
    count(f.measurement_id) DESC,
    max(f.date) DESC,
    f.observation_id DESC
  LIMIT greatest(coalesce(p_limit, 50), 1)
$$;


ALTER FUNCTION "public"."search_community_spore_datasets"("p_genus" "text", "p_species" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_people_directory"("p_limit" integer DEFAULT 24, "p_offset" integer DEFAULT 0, "p_query" "text" DEFAULT NULL::"text") RETURNS TABLE("user_id" "uuid", "username" "text", "display_name" "text", "bio" "text", "avatar_url" "text", "public_find_count" bigint, "public_species_count" bigint, "public_spore_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH normalized AS (
    SELECT
      nullif(btrim(coalesce(p_query, '')), '') AS q,
      greatest(1, least(coalesce(p_limit, 24), 100)) AS lim,
      greatest(coalesce(p_offset, 0), 0) AS off
  ),
  visible_profiles AS (
    SELECT
      p.id,
      p.username,
      p.display_name,
      p.bio,
      p.avatar_url
    FROM public.profiles p
    CROSS JOIN normalized n
    WHERE p.is_banned IS NOT TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks ub
        WHERE (ub.blocker_id = auth.uid() AND ub.blocked_id = p.id)
           OR (ub.blocker_id = p.id AND ub.blocked_id = auth.uid())
      )
      AND (
        n.q IS NULL
        OR coalesce(p.username, '') ILIKE '%' || n.q || '%'
        OR coalesce(p.display_name, '') ILIKE '%' || n.q || '%'
      )
  ),
  visible_profiles_with_stats AS (
    SELECT
      vp.id,
      vp.username,
      vp.display_name,
      vp.bio,
      vp.avatar_url,
      coalesce(s.public_find_count, 0) AS public_find_count,
      coalesce(s.public_species_count, 0) AS public_species_count,
      coalesce(s.public_spore_count, 0) AS public_spore_count
    FROM visible_profiles vp
    LEFT JOIN LATERAL public.get_person_stats(vp.id) s ON true
  )
  SELECT
    vps.id AS user_id,
    vps.username,
    vps.display_name,
    vps.bio,
    vps.avatar_url,
    vps.public_find_count,
    vps.public_species_count,
    vps.public_spore_count
  FROM visible_profiles_with_stats vps
  CROSS JOIN normalized n
  ORDER BY
    CASE
      WHEN n.q IS NULL THEN 0
      WHEN lower(coalesce(vps.username, '')) = lower(n.q) THEN 0
      WHEN lower(coalesce(vps.display_name, '')) = lower(n.q) THEN 1
      WHEN lower(coalesce(vps.username, '')) LIKE lower(n.q) || '%' THEN 2
      WHEN lower(coalesce(vps.display_name, '')) LIKE lower(n.q) || '%' THEN 3
      ELSE 4
    END,
    CASE WHEN n.q IS NULL THEN vps.public_find_count END DESC,
    CASE WHEN n.q IS NULL THEN coalesce(vps.display_name, vps.username, '') END ASC,
    CASE WHEN n.q IS NOT NULL THEN vps.public_find_count END DESC,
    coalesce(vps.display_name, vps.username, '') ASC,
    vps.id ASC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized);
$$;


ALTER FUNCTION "public"."search_people_directory"("p_limit" integer, "p_offset" integer, "p_query" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_observation_images"("p_observation_ids" bigint[] DEFAULT NULL::bigint[]) RETURNS TABLE("observationId" bigint, "imageId" bigint, "sortOrder" integer, "imageType" "text", "width" integer, "height" integer, "thumbUrl" "text", "previewUrl" "text", "fullUrl" "text", "aiCropX1" double precision, "aiCropY1" double precision, "aiCropX2" double precision, "aiCropY2" double precision, "aiCropSourceW" integer, "aiCropSourceH" integer, "aiCropIsCustom" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH visible_observations AS (
    SELECT
      o.id,
      o.user_id
    FROM public.observations o
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND o.id = ANY (coalesce(p_observation_ids, '{}'::bigint[]))
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = o.user_id
          AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
  ),
  visible_images AS (
    SELECT
      o.id AS observation_id,
      i.id AS image_id,
      i.sort_order,
      i.image_type,
      coalesce(i.stored_width, i.source_width) AS width,
      coalesce(i.stored_height, i.source_height) AS height,
      nullif(
        regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''),
        btrim(i.storage_path, '/')
      ) AS storage_dir,
      regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
      i.ai_crop_x1,
      i.ai_crop_y1,
      i.ai_crop_x2,
      i.ai_crop_y2,
      i.ai_crop_source_w,
      i.ai_crop_source_h,
      coalesce(i.ai_crop_is_custom, false) AS ai_crop_is_custom,
      coalesce(i.storage_exif_safe, false) AS storage_exif_safe,
      i.created_at
    FROM visible_observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
    WHERE i.deleted_at IS NULL
      AND i.purged_at IS NULL
      -- Metadata-only microscope anchors have no downloadable bytes and
      -- must not appear in the public gallery. This is the only line
      -- that differs from migration 20260711130000; every other clause
      -- is preserved verbatim.
      AND i.storage_path IS NOT NULL
      AND btrim(i.storage_path) <> ''
  ),
  prepared AS (
    SELECT
      vi.observation_id,
      vi.image_id,
      vi.sort_order,
      vi.image_type,
      vi.width,
      vi.height,
      vi.ai_crop_x1,
      vi.ai_crop_y1,
      vi.ai_crop_x2,
      vi.ai_crop_y2,
      vi.ai_crop_source_w,
      vi.ai_crop_source_h,
      vi.ai_crop_is_custom,
      vi.storage_exif_safe,
      vi.created_at,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        'thumb_',
        regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS thumb_path,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS full_path
    FROM visible_images vi
  )
  SELECT
    p.observation_id AS "observationId",
    p.image_id AS "imageId",
    p.sort_order AS "sortOrder",
    p.image_type AS "imageType",
    p.width AS "width",
    p.height AS "height",
    concat('https://media.sporely.no/', p.thumb_path) AS "thumbUrl",
    concat('https://media.sporely.no/', p.thumb_path) AS "previewUrl",
    CASE
      WHEN p.storage_exif_safe
        THEN concat('https://media.sporely.no/', p.full_path)
      ELSE NULL
    END AS "fullUrl",
    p.ai_crop_x1 AS "aiCropX1",
    p.ai_crop_y1 AS "aiCropY1",
    p.ai_crop_x2 AS "aiCropX2",
    p.ai_crop_y2 AS "aiCropY2",
    p.ai_crop_source_w AS "aiCropSourceW",
    p.ai_crop_source_h AS "aiCropSourceH",
    p.ai_crop_is_custom AS "aiCropIsCustom"
  FROM prepared p
  ORDER BY p.observation_id, p.sort_order NULLS LAST, p.created_at DESC NULLS LAST, p.image_id DESC
$_$;


ALTER FUNCTION "public"."search_public_observation_images"("p_observation_ids" bigint[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_observations"("p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0, "p_genus" "text" DEFAULT NULL::"text", "p_species" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_has_spores" boolean DEFAULT NULL::boolean, "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_contrast" "text" DEFAULT NULL::"text", "p_mount" "text" DEFAULT NULL::"text", "p_sample" "text" DEFAULT NULL::"text", "p_observer" "text" DEFAULT NULL::"text") RETURNS TABLE("id" bigint, "speciesSlug" "text", "speciesName" "text", "speciesCommonName" "text", "observerDisplayName" "text", "observedOn" "date", "country" "text", "regionId" "text", "locationPrecision" "text", "locationLabel" "text", "hasMicroscopy" boolean, "sporeMeasurementCount" bigint, "sporeSummary" "jsonb", "contrastMethod" "text", "mountReagent" "text", "sampleType" "text", "sampleSource" "text", "stainReagent" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH normalized AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 50), 100)) AS lim,
      greatest(coalesce(p_offset, 0), 0) AS off,
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(coalesce(p_species, '')), '') AS species,
      nullif(btrim(coalesce(p_country, '')), '') AS country,
      nullif(btrim(coalesce(p_region, '')), '') AS region,
      p_date_from AS date_from,
      p_date_to AS date_to,
      p_has_spores AS has_spores,
      p_has_microscopy AS has_microscopy,
      nullif(btrim(coalesce(p_contrast, '')), '') AS contrast,
      nullif(btrim(coalesce(p_mount, '')), '') AS mount,
      nullif(btrim(coalesce(p_sample, '')), '') AS sample,
      nullif(btrim(coalesce(p_observer, '')), '') AS observer
  ),
  candidate_base AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.user_id,
      o.author,
      o.date AS observed_on,
      nullif(btrim(coalesce(o.country_code, '')), '') AS country,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden') AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '') AS location,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      public.community_contributor_label(o.user_id, o.author) AS observer_display_name
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = o.user_id
          AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
  ),
  candidate AS (
    SELECT cb.*
    FROM candidate_base cb
    CROSS JOIN normalized n
    WHERE (n.genus IS NULL OR lower(coalesce(cb.genus, '')) = lower(n.genus))
      AND (n.species IS NULL OR lower(coalesce(cb.species, '')) = lower(n.species))
      AND (n.country IS NULL OR lower(coalesce(cb.country, '')) = lower(n.country))
      AND (n.region IS NULL OR cb.region_id = n.region)
      AND (n.date_from IS NULL OR cb.observed_on >= n.date_from)
      AND (n.date_to IS NULL OR cb.observed_on <= n.date_to)
      AND (
        n.observer IS NULL
        OR coalesce(cb.observer_display_name, '') ILIKE '%' || n.observer || '%'
      )
  ),
  enriched AS (
    SELECT
      c.*,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      latest_image.sample_type AS sample_type,
      latest_image.sample_source AS sample_source,
      latest_image.stain AS stain_reagent,
      (latest_image.id IS NOT NULL) AS has_microscopy,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN o.spore_statistics
        ELSE NULL::jsonb
      END AS spore_summary
    FROM candidate c
    JOIN public.observations o
      ON o.id = c.id
    CROSS JOIN normalized n
    LEFT JOIN LATERAL (
      SELECT
        i.id,
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.sample_source,
        i.stain
      FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
        AND (n.contrast IS NULL OR lower(btrim(coalesce(i.contrast, '')))     = lower(btrim(n.contrast)))
        AND (n.mount    IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = lower(btrim(n.mount)))
        AND (n.sample   IS NULL OR lower(btrim(coalesce(i.sample_type, '')))  = lower(btrim(n.sample)))
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_image ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS spore_measurement_count
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_stats ON true
  )
  SELECT
    e.id AS id,
    nullif(
      regexp_replace(
        regexp_replace(lower(btrim(concat_ws(' ', e.genus, e.species))), '[^a-z0-9]+', '-', 'g'),
        '(^-|-$)',
        '',
        'g'
      ),
      ''
    ) AS "speciesSlug",
    nullif(btrim(concat_ws(' ', e.genus, e.species)), '') AS "speciesName",
    e.common_name AS "speciesCommonName",
    e.observer_display_name AS "observerDisplayName",
    e.observed_on AS "observedOn",
    e.country AS country,
    e.region_id AS "regionId",
    e.location_precision AS "locationPrecision",
    CASE
      WHEN e.location_precision = 'exact'::text THEN e.location
      WHEN e.location_precision = 'fuzzed'::text THEN coalesce(e.region_label, e.country)
      WHEN e.location_precision = 'region'::text THEN e.region_label
      ELSE NULL::text
    END AS "locationLabel",
    e.has_microscopy AS "hasMicroscopy",
    e.spore_measurement_count AS "sporeMeasurementCount",
    e.spore_summary AS "sporeSummary",
    e.contrast_method AS "contrastMethod",
    e.mount_reagent AS "mountReagent",
    CASE
      WHEN lower(btrim(coalesce(e.sample_type, ''))) IN ('fresh', 'dried')
        THEN lower(btrim(e.sample_type))
      ELSE NULL::text
    END AS "sampleType",
    CASE
      WHEN lower(btrim(coalesce(e.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
        THEN lower(btrim(e.sample_source))
      ELSE NULL::text
    END AS "sampleSource",
    nullif(btrim(coalesce(e.stain_reagent, '')), '') AS "stainReagent"
  FROM enriched e
  CROSS JOIN normalized n
  WHERE (n.has_microscopy IS NULL OR e.has_microscopy = n.has_microscopy)
    AND (
      n.has_spores IS NULL
      OR (e.spore_measurement_count > 0) = n.has_spores
    )
    AND (n.contrast IS NULL OR EXISTS (
      SELECT 1 FROM public.observation_images i2
      WHERE i2.observation_id = e.id
        AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
        AND i2.image_type = 'microscope'
        AND lower(btrim(coalesce(i2.contrast, ''))) = lower(btrim(n.contrast))
    ))
    AND (n.mount IS NULL OR EXISTS (
      SELECT 1 FROM public.observation_images i2
      WHERE i2.observation_id = e.id
        AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
        AND i2.image_type = 'microscope'
        AND lower(btrim(coalesce(i2.mount_medium, ''))) = lower(btrim(n.mount))
    ))
    AND (n.sample IS NULL OR EXISTS (
      SELECT 1 FROM public.observation_images i2
      WHERE i2.observation_id = e.id
        AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
        AND i2.image_type = 'microscope'
        AND lower(btrim(coalesce(i2.sample_type, ''))) = lower(btrim(n.sample))
    ))
  ORDER BY e.observed_on DESC, e.id DESC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized)
$_$;


ALTER FUNCTION "public"."search_public_observations"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_species" "text", "p_country" "text", "p_region" "text", "p_date_from" "date", "p_date_to" "date", "p_has_spores" boolean, "p_has_microscopy" boolean, "p_contrast" "text", "p_mount" "text", "p_sample" "text", "p_observer" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_reference_values"("p_genus" "text", "p_species" "text", "p_limit" integer DEFAULT 50) RETURNS TABLE("reference_id" bigint, "genus" "text", "species" "text", "source" "text", "mount_medium" "text", "stain" "text", "length_min" double precision, "length_p05" double precision, "length_p50" double precision, "length_p95" double precision, "length_max" double precision, "width_min" double precision, "width_p05" double precision, "width_p50" double precision, "width_p95" double precision, "width_max" double precision, "q_min" double precision, "q_p50" double precision, "q_max" double precision, "updated_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    r.id,
    r.genus,
    r.species,
    r.source,
    r.mount_medium,
    r.stain,
    r.length_min,
    r.length_p05,
    r.length_p50,
    r.length_p95,
    r.length_max,
    r.width_min,
    r.width_p05,
    r.width_p50,
    r.width_p95,
    r.width_max,
    r.q_min,
    r.q_p50,
    r.q_max,
    r.updated_at
  FROM public.reference_values r
  WHERE lower(r.genus) = lower(trim(coalesce(p_genus, '')))
    AND (trim(coalesce(p_species, '')) = '' OR lower(r.species) = lower(trim(p_species)))
  ORDER BY r.updated_at DESC, r.id DESC
  LIMIT greatest(coalesce(p_limit, 50), 1)
$$;


ALTER FUNCTION "public"."search_public_reference_values"("p_genus" "text", "p_species" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_species"("p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0, "p_genus" "text" DEFAULT NULL::"text", "p_query" "text" DEFAULT NULL::"text") RETURNS TABLE("speciesSlug" "text", "genus" "text", "species" "text", "speciesName" "text", "commonName" "text", "observationCount" bigint, "microscopyObservationCount" bigint, "sporeMeasurementCount" bigint, "firstObservedOn" "date", "lastObservedOn" "date", "countries" "jsonb", "regions" "jsonb", "representativeThumbUrl" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH normalized AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 50), 100)) AS lim,
      greatest(coalesce(p_offset, 0), 0) AS off,
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(coalesce(p_query, '')), '') AS query
  ),
  country_labels AS (
    SELECT *
    FROM (
      VALUES
        ('DE'::text, 'Germany'::text),
        ('FI'::text, 'Finland'::text),
        ('GB'::text, 'United Kingdom'::text),
        ('NO'::text, 'Norway'::text),
        ('SE'::text, 'Sweden'::text)
    ) AS c(country_code, label)
  ),
  visible_observations AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(o.genus, '')), ''), nullif(btrim(coalesce(o.species, '')), ''))), '') AS species_name,
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(concat_ws(' ', nullif(btrim(coalesce(o.genus, '')), ''), nullif(btrim(coalesce(o.species, '')), '')))),
            '[^a-z0-9]+',
            '-',
            'g'
          ),
          '(^-|-$)',
          '',
          'g'
        ),
        ''
      ) AS species_slug,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      (latest_microscope_image.id IS NOT NULL) AS has_microscopy
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS spore_measurement_count
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_stats ON true
    LEFT JOIN LATERAL (
      SELECT i.id
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_microscope_image ON true
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = o.user_id
          AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
  ),
  species_groups AS (
    SELECT
      vo.species_slug,
      vo.genus,
      vo.species,
      vo.species_name,
      min(vo.common_name) AS common_name,
      count(*)::bigint AS observation_count,
      count(*) FILTER (WHERE vo.has_microscopy)::bigint AS microscopy_observation_count,
      coalesce(sum(vo.spore_measurement_count), 0)::bigint AS spore_measurement_count,
      min(vo.observed_on) AS first_observed_on,
      max(vo.observed_on) AS last_observed_on
    FROM visible_observations vo
    WHERE vo.species_slug IS NOT NULL
    GROUP BY vo.species_slug, vo.genus, vo.species, vo.species_name
  ),
  filtered_species AS (
    SELECT sg.*
    FROM species_groups sg
    CROSS JOIN normalized n
    WHERE (n.genus IS NULL OR lower(coalesce(sg.genus, '')) = lower(n.genus))
      AND (
        n.query IS NULL
        OR coalesce(sg.species_name, '') ILIKE '%' || n.query || '%'
        OR coalesce(sg.common_name, '') ILIKE '%' || n.query || '%'
        OR coalesce(sg.genus, '') ILIKE '%' || n.query || '%'
        OR coalesce(sg.species, '') ILIKE '%' || n.query || '%'
        OR lower(coalesce(sg.species_slug, '')) ILIKE '%' || lower(n.query) || '%'
      )
  )
  SELECT
    fs.species_slug AS "speciesSlug",
    fs.genus AS genus,
    fs.species AS species,
    fs.species_name AS "speciesName",
    fs.common_name AS "commonName",
    fs.observation_count AS "observationCount",
    fs.microscopy_observation_count AS "microscopyObservationCount",
    fs.spore_measurement_count AS "sporeMeasurementCount",
    fs.first_observed_on AS "firstObservedOn",
    fs.last_observed_on AS "lastObservedOn",
    coalesce(countries.items, '[]'::jsonb) AS countries,
    coalesce(regions.items, '[]'::jsonb) AS regions,
    rep.representative_thumb_url AS "representativeThumbUrl"
  FROM filtered_species fs
  LEFT JOIN LATERAL (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.country_code AS value,
        coalesce(cl.label, grouped.country_code) AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.country_code,
          'label', coalesce(cl.label, grouped.country_code),
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.species_slug = fs.species_slug
          AND vo.country_code IS NOT NULL
        GROUP BY vo.country_code
      ) grouped
      LEFT JOIN country_labels cl
        ON cl.country_code = grouped.country_code
    ) items
  ) countries ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.region_id AS value,
        grouped.region_label AS label,
        grouped.region_country_code AS country_code,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.region_id,
          'label', grouped.region_label,
          'countryCode', grouped.region_country_code,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.region_id,
          coalesce(vo.region_label, vo.region_id) AS region_label,
          coalesce(vo.region_country_code, vo.country_code) AS region_country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.species_slug = fs.species_slug
          AND vo.region_id IS NOT NULL
        GROUP BY
          vo.region_id,
          coalesce(vo.region_label, vo.region_id),
          coalesce(vo.region_country_code, vo.country_code)
      ) grouped
    ) items
  ) regions ON true
  LEFT JOIN LATERAL (
    SELECT concat(
      'https://media.sporely.no/',
      concat(
        CASE WHEN rep.storage_dir IS NULL THEN '' ELSE rep.storage_dir || '/' END,
        'thumb_',
        regexp_replace(rep.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      )
    ) AS representative_thumb_url
    FROM (
      SELECT
        nullif(
          regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''),
          btrim(i.storage_path, '/')
        ) AS storage_dir,
        regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
        vo.observed_on,
        i.sort_order,
        i.created_at,
        i.id
      FROM visible_observations vo
      JOIN public.observation_images i
        ON i.observation_id = vo.id
      WHERE vo.species_slug = fs.species_slug
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.storage_path IS NOT NULL
    ) rep
    ORDER BY rep.observed_on DESC, rep.sort_order NULLS LAST, rep.created_at DESC NULLS LAST, rep.id DESC
    LIMIT 1
  ) rep ON true
  ORDER BY fs.observation_count DESC, fs.last_observed_on DESC, fs.species_name ASC, fs.species_slug ASC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized)
$_$;


ALTER FUNCTION "public"."search_public_species"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_query" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_taxa"("q" "text", "lang" "text" DEFAULT 'no'::"text", "lim" integer DEFAULT 20) RETURNS TABLE("taxon_id" integer, "genus" "text", "specific_epithet" "text", "canonical_scientific_name" "text", "family" "text", "vernacular_name" "text", "norwegian_taxon_id" integer, "swedish_taxon_id" integer, "inaturalist_taxon_id" integer, "artportalen_taxon_id" integer, "match_type" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  WITH candidates AS (
    SELECT DISTINCT t.taxon_id, t.genus, t.specific_epithet,
      CASE WHEN EXISTS (
        SELECT 1 FROM public.taxa_vernacular mv
        WHERE mv.taxon_id = t.taxon_id
          AND mv.vernacular_name ILIKE q || '%'
      ) THEN 0 ELSE 1 END AS score
    FROM public.taxa t
    WHERE
      EXISTS (
        SELECT 1 FROM public.taxa_vernacular mv
        WHERE mv.taxon_id = t.taxon_id
          AND mv.vernacular_name ILIKE q || '%'
      )
      OR t.canonical_scientific_name ILIKE q || '%'
      OR (t.genus || ' ' || t.specific_epithet) ILIKE q || '%'
      OR t.genus ILIKE q || '%'
    ORDER BY score, t.genus, t.specific_epithet
    LIMIT lim
  )
  SELECT
    t.taxon_id,
    t.genus,
    t.specific_epithet,
    t.canonical_scientific_name,
    t.family,
    pv.vernacular_name,
    t.norwegian_taxon_id,
    t.swedish_taxon_id,
    t.inaturalist_taxon_id,
    t.artportalen_taxon_id,
    CASE WHEN c.score = 0 THEN 'vernacular' ELSE 'scientific' END AS match_type
  FROM candidates c
  JOIN public.taxa t ON t.taxon_id = c.taxon_id
  LEFT JOIN public.taxa_vernacular pv
    ON pv.taxon_id = t.taxon_id
   AND pv.language_code = lang
   AND pv.is_preferred = true
  ORDER BY c.score, t.genus, t.specific_epithet
$$;


ALTER FUNCTION "public"."search_taxa"("q" "text", "lang" "text", "lim" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
    new.updated_at = now();
    return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."admin_action_log" (
    "id" bigint NOT NULL,
    "admin_user_id" "uuid",
    "admin_email" "text",
    "action" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "reason" "text",
    "request_payload" "jsonb",
    "before_snapshot" "jsonb",
    "result_snapshot" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_action_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."admin_action_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."admin_action_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."admin_action_log_id_seq" OWNED BY "public"."admin_action_log"."id";



CREATE TABLE IF NOT EXISTS "public"."calibrations" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "objective_key" "text" NOT NULL,
    "calibration_date" "date" NOT NULL,
    "calibration_image_date" "date",
    "microns_per_pixel" double precision NOT NULL,
    "microns_per_pixel_std" double precision,
    "confidence_interval_low" double precision,
    "confidence_interval_high" double precision,
    "num_measurements" integer,
    "measurements_json" "jsonb",
    "image_storage_path" "text",
    "camera" "text",
    "megapixels" double precision,
    "target_sampling_pct" double precision,
    "resample_scale_factor" double precision,
    "calibration_image_width" integer,
    "calibration_image_height" integer,
    "notes" "text",
    "is_active" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "calibration_uuid" "uuid" DEFAULT "gen_random_uuid"() NOT NULL
);


ALTER TABLE "public"."calibrations" OWNER TO "postgres";


ALTER TABLE "public"."calibrations" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."calibrations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."comment_moderation" (
    "comment_id" bigint NOT NULL,
    "report_id" "uuid",
    "hidden_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "hidden_by" "uuid",
    "hidden_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."comment_moderation" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comments" (
    "id" bigint NOT NULL,
    "observation_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "mentioned_user_ids" "uuid"[] DEFAULT '{}'::"uuid"[]
);


ALTER TABLE "public"."comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."observations" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "genus" "text",
    "species" "text",
    "common_name" "text",
    "species_guess" "text",
    "uncertain" boolean DEFAULT false,
    "unspontaneous" boolean DEFAULT false,
    "determination_method" integer,
    "location" "text",
    "gps_latitude" double precision,
    "gps_longitude" double precision,
    "location_public" boolean DEFAULT true,
    "habitat" "text",
    "habitat_nin2_path" "text",
    "habitat_substrate_path" "text",
    "habitat_host_genus" "text",
    "habitat_host_species" "text",
    "habitat_host_common_name" "text",
    "habitat_nin2_note" "text",
    "habitat_substrate_note" "text",
    "habitat_grows_on_note" "text",
    "publish_target" "text" DEFAULT 'artsobs_no'::"text",
    "artsdata_id" integer,
    "artportalen_id" integer,
    "inaturalist_id" integer,
    "mushroomobserver_id" integer,
    "notes" "text",
    "open_comment" "text",
    "private_comment" "text",
    "interesting_comment" boolean DEFAULT false,
    "spore_statistics" "jsonb",
    "auto_threshold" double precision,
    "ai_state_json" "jsonb",
    "source_type" "text" DEFAULT 'personal'::"text",
    "citation" "text",
    "data_provider" "text",
    "author" "text",
    "desktop_id" integer,
    "synced_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "visibility" "text" DEFAULT 'public'::"text" NOT NULL,
    "captured_at" timestamp with time zone,
    "spore_data_visibility" "text" DEFAULT 'public'::"text",
    "image_key" "text",
    "thumb_key" "text",
    "gps_altitude" real,
    "gps_accuracy" real,
    "is_draft" boolean DEFAULT true NOT NULL,
    "location_precision" "text" DEFAULT 'exact'::"text" NOT NULL,
    "ai_selected_service" "text",
    "ai_selected_taxon_id" "text",
    "ai_selected_scientific_name" "text",
    "ai_selected_probability" numeric,
    "ai_selected_at" timestamp with time zone,
    "country_code" "text",
    "region_id" "text",
    "red_list_category" "text",
    "red_list_categories_json" "jsonb",
    CONSTRAINT "observations_country_code_check" CHECK ((("country_code" IS NULL) OR ("country_code" ~ '^[A-Z]{2}$'::"text"))),
    CONSTRAINT "observations_location_precision_check" CHECK (("location_precision" = ANY (ARRAY['exact'::"text", 'fuzzed'::"text", 'region'::"text", 'hidden'::"text"]))),
    CONSTRAINT "observations_red_list_categories_json_object_chk" CHECK ((("red_list_categories_json" IS NULL) OR ("jsonb_typeof"("red_list_categories_json") = 'object'::"text"))),
    CONSTRAINT "observations_spore_data_visibility_check" CHECK (("spore_data_visibility" = ANY (ARRAY['private'::"text", 'friends'::"text", 'public'::"text"]))),
    CONSTRAINT "observations_visibility_check" CHECK (("visibility" = ANY (ARRAY['private'::"text", 'friends'::"text", 'public'::"text"])))
);


ALTER TABLE "public"."observations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."observations"."gps_altitude" IS 'Altitude in meters above sea level';



COMMENT ON COLUMN "public"."observations"."gps_accuracy" IS 'Horizontal accuracy of the GPS coordinates in meters';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "username" "text",
    "display_name" "text",
    "avatar_url" "text",
    "bio" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "cloud_plan" "text" DEFAULT 'free'::"text" NOT NULL,
    "full_res_storage_enabled" boolean DEFAULT false NOT NULL,
    "storage_quota_bytes" bigint,
    "storage_used_bytes" bigint DEFAULT 0 NOT NULL,
    "billing_status" "text",
    "billing_provider" "text",
    "total_storage_bytes" bigint DEFAULT 0 NOT NULL,
    "image_count" integer DEFAULT 0 NOT NULL,
    "is_admin" boolean DEFAULT false NOT NULL,
    "is_banned" boolean DEFAULT false NOT NULL,
    "is_pro" boolean DEFAULT false NOT NULL,
    "billing_customer_id" "text",
    "billing_payment_id" "text",
    "billing_checkout_session_id" "text",
    "billing_updated_at" timestamp with time zone,
    CONSTRAINT "profiles_cloud_plan_check" CHECK (("cloud_plan" = ANY (ARRAY['free'::"text", 'pro'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."comments_community_view" AS
 SELECT "c"."id",
    "c"."observation_id",
    "c"."user_id",
    "c"."body",
    "c"."created_at",
    "c"."mentioned_user_ids"
   FROM ("public"."comments" "c"
     JOIN "public"."observations" "o" ON (("o"."id" = "c"."observation_id")))
  WHERE ((("o"."user_id" = "auth"."uid"()) OR ((NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility"))) AND (NOT "public"."is_blocked_between"("auth"."uid"(), "c"."user_id")) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = "c"."user_id") AND ("p"."is_banned" = true))))) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."comment_moderation" "cm"
          WHERE (("cm"."comment_id" = "c"."id") AND ("cm"."hidden_at" IS NOT NULL))))));


ALTER VIEW "public"."comments_community_view" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."comments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."comments_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."comments_id_seq" OWNED BY "public"."comments"."id";



CREATE TABLE IF NOT EXISTS "public"."follows" (
    "user_id" "uuid" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "follows_target_id_not_blank" CHECK (("length"(TRIM(BOTH FROM "target_id")) > 0)),
    CONSTRAINT "follows_target_type_check" CHECK (("target_type" = ANY (ARRAY['user'::"text", 'observation'::"text", 'species'::"text", 'genus'::"text"])))
);


ALTER TABLE "public"."follows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."friendships" (
    "id" bigint NOT NULL,
    "requester_id" "uuid" NOT NULL,
    "addressee_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "friendships_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'blocked'::"text"])))
);


ALTER TABLE "public"."friendships" OWNER TO "postgres";


ALTER TABLE "public"."friendships" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."friendships_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."observation_identifications" (
    "id" bigint NOT NULL,
    "observation_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "service" "text" NOT NULL,
    "source" "text" DEFAULT 'ai'::"text" NOT NULL,
    "status" "text" DEFAULT 'success'::"text" NOT NULL,
    "image_fingerprint" "text" DEFAULT ''::"text" NOT NULL,
    "crop_fingerprint" "text",
    "request_fingerprint" "text" NOT NULL,
    "language" "text",
    "model_version" "text",
    "results" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "top_scientific_name" "text",
    "top_vernacular_name" "text",
    "top_taxon_id" "text",
    "top_probability" numeric,
    "top_species_url" "text",
    "top_redlist_category" "text",
    "top_redlist_status" "text",
    "top_redlist_source" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "observation_identifications_probability_check" CHECK ((("top_probability" IS NULL) OR (("top_probability" >= (0)::numeric) AND ("top_probability" <= (1)::numeric)))),
    CONSTRAINT "observation_identifications_service_check" CHECK (("service" = ANY (ARRAY['artsorakel'::"text", 'inat'::"text", 'inaturalist'::"text"]))),
    CONSTRAINT "observation_identifications_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'no_match'::"text", 'error'::"text", 'stale'::"text", 'unavailable'::"text"])))
);


ALTER TABLE "public"."observation_identifications" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."observation_identifications_community_view" AS
 SELECT "oi"."id",
    "oi"."observation_id",
    "oi"."user_id",
    "oi"."service",
    "oi"."source",
    "oi"."status",
    "oi"."image_fingerprint",
    "oi"."crop_fingerprint",
    "oi"."request_fingerprint",
    "oi"."language",
    "oi"."model_version",
    "oi"."results",
    "oi"."top_scientific_name",
    "oi"."top_vernacular_name",
    "oi"."top_taxon_id",
    "oi"."top_probability",
    "oi"."top_species_url",
    "oi"."top_redlist_category",
    "oi"."top_redlist_status",
    "oi"."top_redlist_source",
    "oi"."error_message",
    "oi"."created_at",
    "oi"."updated_at"
   FROM ("public"."observation_identifications" "oi"
     JOIN "public"."observations" "o" ON (("o"."id" = "oi"."observation_id")))
  WHERE ((("o"."user_id" = "auth"."uid"()) OR ((NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility"))) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = "o"."user_id") AND ("p"."is_banned" = true))))) AND (NOT "public"."is_blocked_between"("auth"."uid"(), "o"."user_id")));


ALTER VIEW "public"."observation_identifications_community_view" OWNER TO "postgres";


ALTER TABLE "public"."observation_identifications" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."observation_identifications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."observation_images" (
    "id" bigint NOT NULL,
    "observation_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "storage_path" "text",
    "original_filename" "text",
    "sort_order" integer,
    "image_type" "text",
    "micro_category" "text",
    "objective_name" "text",
    "scale_microns_per_pixel" double precision,
    "resample_scale_factor" double precision,
    "mount_medium" "text",
    "stain" "text",
    "sample_type" "text",
    "contrast" "text",
    "measure_color" "text",
    "notes" "text",
    "ai_crop_x1" double precision,
    "ai_crop_y1" double precision,
    "ai_crop_x2" double precision,
    "ai_crop_y2" double precision,
    "ai_crop_source_w" integer,
    "ai_crop_source_h" integer,
    "crop_mode" "text",
    "scale_bar_x1" double precision,
    "scale_bar_y1" double precision,
    "scale_bar_x2" double precision,
    "scale_bar_y2" double precision,
    "gps_source" boolean DEFAULT false,
    "desktop_id" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "upload_mode" "text",
    "source_width" integer,
    "source_height" integer,
    "stored_width" integer,
    "stored_height" integer,
    "stored_bytes" bigint,
    "ai_crop_is_custom" boolean DEFAULT false NOT NULL,
    "deleted_at" timestamp with time zone,
    "calibration_uuid" "uuid",
    "original_storage_path" "text",
    "purged_at" timestamp with time zone,
    "purge_attempted_at" timestamp with time zone,
    "purge_error" "text",
    "storage_exif_safe" boolean DEFAULT false NOT NULL,
    "sample_source" "text",
    CONSTRAINT "observation_images_image_type_check" CHECK (("image_type" = ANY (ARRAY['field'::"text", 'microscope'::"text"]))),
    CONSTRAINT "observation_images_storage_path_required_unless_microscope" CHECK ((("storage_path" IS NOT NULL) OR (NOT ("image_type" IS DISTINCT FROM 'microscope'::"text")))),
    CONSTRAINT "observation_images_upload_mode_check" CHECK ((("upload_mode" IS NULL) OR ("upload_mode" = ANY (ARRAY['reduced'::"text", 'full'::"text"]))))
);


ALTER TABLE "public"."observation_images" OWNER TO "postgres";


COMMENT ON COLUMN "public"."observation_images"."storage_exif_safe" IS 'True only when observation_images.storage_path is known to be public-safe / EXIF-GPS stripped. Public fullUrl exposure must be gated on this.';



COMMENT ON COLUMN "public"."observation_images"."sample_source" IS 'Where microscopy sample/material came from, e.g. spore_print, hymenium, stipe, pileus, context, other. Separate from sample_type/specimen condition.';



CREATE OR REPLACE VIEW "public"."observation_images_community_view" AS
 SELECT "oi"."id",
    "oi"."observation_id",
    "oi"."user_id",
    "oi"."storage_path",
    "oi"."original_filename",
    "oi"."sort_order",
    "oi"."image_type",
    "oi"."micro_category",
    "oi"."objective_name",
    "oi"."scale_microns_per_pixel",
    "oi"."resample_scale_factor",
    "oi"."mount_medium",
    "oi"."stain",
    "oi"."sample_type",
    "oi"."contrast",
    "oi"."measure_color",
    "oi"."notes",
    "oi"."ai_crop_x1",
    "oi"."ai_crop_y1",
    "oi"."ai_crop_x2",
    "oi"."ai_crop_y2",
    "oi"."ai_crop_source_w",
    "oi"."ai_crop_source_h",
    "oi"."crop_mode",
    "oi"."scale_bar_x1",
    "oi"."scale_bar_y1",
    "oi"."scale_bar_x2",
    "oi"."scale_bar_y2",
    "oi"."gps_source",
    "oi"."desktop_id",
    "oi"."created_at",
    "oi"."upload_mode",
    "oi"."source_width",
    "oi"."source_height",
    "oi"."stored_width",
    "oi"."stored_height",
    "oi"."stored_bytes",
    "oi"."ai_crop_is_custom",
    "oi"."deleted_at",
    "oi"."calibration_uuid",
    "oi"."original_storage_path",
    "o"."user_id" AS "observation_user_id",
    "o"."visibility" AS "observation_visibility",
    "o"."is_draft" AS "observation_is_draft",
    "o"."spore_data_visibility" AS "observation_spore_data_visibility"
   FROM ("public"."observation_images" "oi"
     JOIN "public"."observations" "o" ON (("o"."id" = "oi"."observation_id")))
  WHERE ((("o"."user_id" = "auth"."uid"()) OR ((NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility"))) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = "o"."user_id") AND ("p"."is_banned" = true))))) AND (NOT "public"."is_blocked_between"("auth"."uid"(), "o"."user_id")));


ALTER VIEW "public"."observation_images_community_view" OWNER TO "postgres";


ALTER TABLE "public"."observation_images" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."observation_images_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."observation_shares" (
    "id" bigint NOT NULL,
    "observation_id" bigint NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "shared_with_id" "uuid" NOT NULL,
    "share_location" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."observation_shares" OWNER TO "postgres";


ALTER TABLE "public"."observation_shares" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."observation_shares_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."observation_spore_summaries" (
    "id" bigint NOT NULL,
    "observation_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "context_hash" "text" NOT NULL,
    "context_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "measurement_type" "text" DEFAULT 'spore'::"text" NOT NULL,
    "sample_type" "text",
    "mount_reagent" "text",
    "stain_reagent" "text",
    "contrast_method" "text",
    "n_spores" integer DEFAULT 0 NOT NULL,
    "n_paired" integer DEFAULT 0 NOT NULL,
    "n_length" integer DEFAULT 0 NOT NULL,
    "n_width" integer DEFAULT 0 NOT NULL,
    "length_min_um" double precision,
    "length_p05_um" double precision,
    "length_mean_um" double precision,
    "length_median_um" double precision,
    "length_p95_um" double precision,
    "length_max_um" double precision,
    "length_sd_um" double precision,
    "width_min_um" double precision,
    "width_p05_um" double precision,
    "width_mean_um" double precision,
    "width_median_um" double precision,
    "width_p95_um" double precision,
    "width_max_um" double precision,
    "width_sd_um" double precision,
    "q_min" double precision,
    "q_p05" double precision,
    "q_mean" double precision,
    "q_median" double precision,
    "q_p95" double precision,
    "q_max" double precision,
    "q_sd" double precision,
    "stats_version" integer DEFAULT 1 NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_app" "text",
    "source_app_version" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "observation_spore_summaries_context_hash_nonempty_chk" CHECK (("btrim"("context_hash") <> ''::"text")),
    CONSTRAINT "observation_spore_summaries_context_json_object_chk" CHECK (("jsonb_typeof"("context_json") = 'object'::"text")),
    CONSTRAINT "observation_spore_summaries_n_length_chk" CHECK (("n_length" >= 0)),
    CONSTRAINT "observation_spore_summaries_n_paired_chk" CHECK (("n_paired" >= 0)),
    CONSTRAINT "observation_spore_summaries_n_spores_chk" CHECK (("n_spores" >= 0)),
    CONSTRAINT "observation_spore_summaries_n_width_chk" CHECK (("n_width" >= 0)),
    CONSTRAINT "observation_spore_summaries_stats_version_chk" CHECK (("stats_version" >= 1))
);


ALTER TABLE "public"."observation_spore_summaries" OWNER TO "postgres";


COMMENT ON TABLE "public"."observation_spore_summaries" IS 'Structured per-observation spore statistics keyed by measurement context. Species-level canonical means MUST be unweighted arithmetic means of the per-observation *_mean_um / q_mean values; never weight by n_spores or n_paired.';



COMMENT ON COLUMN "public"."observation_spore_summaries"."context_hash" IS 'sha256 hex of the normalized context JSON (measurement_type, sample_type, mount_reagent, stain_reagent, contrast_method) computed by the writer.';



COMMENT ON COLUMN "public"."observation_spore_summaries"."context_json" IS 'Normalized context object used to derive context_hash. Exposed via RPCs for debugging and filtering.';



COMMENT ON COLUMN "public"."observation_spore_summaries"."measurement_type" IS 'Kind of structure summarized (default ''spore''). Distinct from spore_measurements.measurement_type, which stores raw-measurement provenance (''manual''/''spore'').';



COMMENT ON COLUMN "public"."observation_spore_summaries"."n_paired" IS 'Count of measurements with both length_um and width_um valid. Inclusion threshold for species profiles, never a weight.';



COMMENT ON COLUMN "public"."observation_spore_summaries"."length_mean_um" IS 'Arithmetic mean of length_um values for this observation/context. Species profiles should average this value unweighted across observation summaries.';



COMMENT ON COLUMN "public"."observation_spore_summaries"."width_mean_um" IS 'Arithmetic mean of width_um values for this observation/context. Species profiles should average this value unweighted across observation summaries.';



COMMENT ON COLUMN "public"."observation_spore_summaries"."q_mean" IS 'Mean of individual length_i/width_i ratios across paired measurements. Do NOT derive from length_mean_um / width_mean_um.';



COMMENT ON COLUMN "public"."observation_spore_summaries"."stats_version" IS 'Bump when the writer changes percentile convention, SD convention, or any semantic that would invalidate stored values without a row rewrite.';



ALTER TABLE "public"."observation_spore_summaries" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."observation_spore_summaries_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."observations_community_view" AS
 SELECT "id",
    "user_id",
    "desktop_id",
    "date",
    "captured_at",
    "created_at",
    "genus",
    "species",
    "common_name",
    "author",
    "location",
    "habitat",
    "notes",
    "uncertain",
    "location_public",
    "visibility",
        CASE
            WHEN (COALESCE("location_precision", 'exact'::"text") = 'fuzzed'::"text") THEN ("round"(("gps_latitude")::numeric, 2))::double precision
            WHEN (COALESCE("location_precision", 'exact'::"text") = ANY (ARRAY['region'::"text", 'hidden'::"text"])) THEN NULL::double precision
            ELSE "gps_latitude"
        END AS "gps_latitude",
        CASE
            WHEN (COALESCE("location_precision", 'exact'::"text") = 'fuzzed'::"text") THEN ("round"(("gps_longitude")::numeric, 2))::double precision
            WHEN (COALESCE("location_precision", 'exact'::"text") = ANY (ARRAY['region'::"text", 'hidden'::"text"])) THEN NULL::double precision
            ELSE "gps_longitude"
        END AS "gps_longitude",
    "source_type",
    "spore_data_visibility",
    "image_key",
    "thumb_key",
    "is_draft",
    "location_precision",
    "ai_selected_service",
    "ai_selected_taxon_id",
    "ai_selected_scientific_name",
    "ai_selected_probability",
    "ai_selected_at",
        CASE
            WHEN (COALESCE("spore_data_visibility", 'public'::"text") = 'public'::"text") THEN "spore_statistics"
            ELSE NULL::"jsonb"
        END AS "spore_statistics"
   FROM "public"."observations" "o"
  WHERE ((COALESCE("visibility", 'public'::"text") = 'public'::"text") AND (NOT COALESCE("is_draft", false)) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = "o"."user_id") AND ("p"."is_banned" = true))))) AND (NOT "public"."is_blocked_between"("auth"."uid"(), "user_id")));


ALTER VIEW "public"."observations_community_view" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."observations_follow_view" AS
 SELECT DISTINCT "o"."id",
    "o"."user_id",
    "o"."desktop_id",
    "o"."date",
    "o"."captured_at",
    "o"."created_at",
    "o"."genus",
    "o"."species",
    "o"."common_name",
    "o"."author",
    "o"."location",
    "o"."habitat",
    "o"."notes",
    "o"."uncertain",
    "o"."location_public",
    "o"."visibility",
        CASE
            WHEN (COALESCE("o"."location_precision", 'exact'::"text") = 'fuzzed'::"text") THEN ("round"(("o"."gps_latitude")::numeric, 2))::double precision
            ELSE "o"."gps_latitude"
        END AS "gps_latitude",
        CASE
            WHEN (COALESCE("o"."location_precision", 'exact'::"text") = 'fuzzed'::"text") THEN ("round"(("o"."gps_longitude")::numeric, 2))::double precision
            ELSE "o"."gps_longitude"
        END AS "gps_longitude",
    "o"."source_type",
    "o"."spore_data_visibility",
    "o"."image_key",
    "o"."thumb_key",
    "o"."is_draft",
    "o"."location_precision"
   FROM ("public"."observations" "o"
     JOIN "public"."follows" "f" ON ((("f"."user_id" = "auth"."uid"()) AND ((("f"."target_type" = 'user'::"text") AND ("f"."target_id" = ("o"."user_id")::"text")) OR (("f"."target_type" = 'observation'::"text") AND ("f"."target_id" = ("o"."id")::"text")) OR (("f"."target_type" = 'genus'::"text") AND ("lower"("f"."target_id") = "lower"(COALESCE("o"."genus", ''::"text")))) OR (("f"."target_type" = 'species'::"text") AND ("lower"("f"."target_id") = "lower"(TRIM(BOTH FROM "concat_ws"(' '::"text", "o"."genus", "o"."species")))))))))
  WHERE ("public"."can_read_observation"("o"."user_id", "o"."visibility") AND (NOT COALESCE("o"."is_draft", false)) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = "o"."user_id") AND ("p"."is_banned" = true))))) AND (NOT "public"."is_blocked_between"("auth"."uid"(), "o"."user_id")));


ALTER VIEW "public"."observations_follow_view" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."observations_friend_view" AS
 SELECT "id",
    "user_id",
    "desktop_id",
    "date",
    "captured_at",
    "created_at",
    "genus",
    "species",
    "common_name",
    "author",
    "location",
    "habitat",
    "notes",
    "uncertain",
    "location_public",
    "visibility",
        CASE
            WHEN (COALESCE("location_precision", 'exact'::"text") = 'fuzzed'::"text") THEN ("round"(("gps_latitude")::numeric, 2))::double precision
            ELSE "gps_latitude"
        END AS "gps_latitude",
        CASE
            WHEN (COALESCE("location_precision", 'exact'::"text") = 'fuzzed'::"text") THEN ("round"(("gps_longitude")::numeric, 2))::double precision
            ELSE "gps_longitude"
        END AS "gps_longitude",
    "source_type",
    "spore_data_visibility",
    "image_key",
    "thumb_key",
    "is_draft",
    "location_precision"
   FROM "public"."observations" "o"
  WHERE ((COALESCE("visibility", 'public'::"text") = ANY (ARRAY['friends'::"text", 'public'::"text"])) AND (NOT COALESCE("is_draft", false)) AND "public"."are_friends"("auth"."uid"(), "user_id") AND (NOT (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = "o"."user_id") AND ("p"."is_banned" = true))))) AND (NOT "public"."is_blocked_between"("auth"."uid"(), "user_id")));


ALTER VIEW "public"."observations_friend_view" OWNER TO "postgres";


ALTER TABLE "public"."observations" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."observations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."public_regions" (
    "id" "text" NOT NULL,
    "country_code" "text" NOT NULL,
    "label" "text" NOT NULL,
    "sort_order" integer,
    "map_x" numeric,
    "map_y" numeric,
    CONSTRAINT "public_regions_country_code_check" CHECK (("country_code" ~ '^[A-Z]{2}$'::"text"))
);


ALTER TABLE "public"."public_regions" OWNER TO "postgres";


COMMENT ON TABLE "public"."public_regions" IS 'Normalized region lookup rows for public explorer filters and schematic map layout.';



COMMENT ON COLUMN "public"."public_regions"."map_x" IS 'Schematic map coordinate, not GPS.';



COMMENT ON COLUMN "public"."public_regions"."map_y" IS 'Schematic map coordinate, not GPS.';



CREATE TABLE IF NOT EXISTS "public"."reference_values" (
    "id" bigint NOT NULL,
    "genus" "text" NOT NULL,
    "species" "text" NOT NULL,
    "source" "text",
    "mount_medium" "text",
    "stain" "text",
    "plot_color" "text",
    "parmasto_length_mean" double precision,
    "parmasto_width_mean" double precision,
    "parmasto_q_mean" double precision,
    "parmasto_v_sp_length" double precision,
    "parmasto_v_sp_width" double precision,
    "parmasto_v_sp_q" double precision,
    "parmasto_v_ind_length" double precision,
    "parmasto_v_ind_width" double precision,
    "parmasto_v_ind_q" double precision,
    "length_min" double precision,
    "length_p05" double precision,
    "length_p50" double precision,
    "length_p95" double precision,
    "length_max" double precision,
    "length_avg" double precision,
    "width_min" double precision,
    "width_p05" double precision,
    "width_p50" double precision,
    "width_p95" double precision,
    "width_max" double precision,
    "width_avg" double precision,
    "q_min" double precision,
    "q_p50" double precision,
    "q_max" double precision,
    "q_avg" double precision,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."reference_values" OWNER TO "postgres";


ALTER TABLE "public"."reference_values" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."reference_values_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reporter_id" "uuid" NOT NULL,
    "reported_user_id" "uuid" NOT NULL,
    "observation_id" bigint,
    "comment_id" bigint,
    "reason" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolution" "text",
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid",
    "dismissed_at" timestamp with time zone,
    "dismissed_by" "uuid",
    CONSTRAINT "reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewed'::"text", 'resolved'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spore_annotations" (
    "id" bigint NOT NULL,
    "image_id" bigint NOT NULL,
    "measurement_id" bigint,
    "user_id" "uuid" NOT NULL,
    "spore_number" integer,
    "bbox_x" integer,
    "bbox_y" integer,
    "bbox_width" integer,
    "bbox_height" integer,
    "center_x" double precision,
    "center_y" double precision,
    "length_um" double precision,
    "width_um" double precision,
    "rotation_angle" double precision,
    "annotation_source" "text" DEFAULT 'manual'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."spore_annotations" OWNER TO "postgres";


ALTER TABLE "public"."spore_annotations" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."spore_annotations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."spore_measurement_mosaic_tiles" (
    "measurement_id" bigint NOT NULL,
    "mosaic_id" bigint NOT NULL,
    "x_px" integer NOT NULL,
    "y_px" integer NOT NULL,
    "w_px" integer NOT NULL,
    "h_px" integer NOT NULL,
    "overlay_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "spore_measurement_mosaic_tiles_check" CHECK ((("x_px" >= 0) AND ("y_px" >= 0) AND ("w_px" > 0) AND ("h_px" > 0)))
);


ALTER TABLE "public"."spore_measurement_mosaic_tiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spore_measurement_mosaics" (
    "id" bigint NOT NULL,
    "observation_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "storage_key" "text" NOT NULL,
    "width_px" integer NOT NULL,
    "height_px" integer NOT NULL,
    "tile_size_px" integer NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "spore_measurement_mosaics_check" CHECK ((("width_px" > 0) AND ("height_px" > 0) AND ("tile_size_px" > 0)))
);


ALTER TABLE "public"."spore_measurement_mosaics" OWNER TO "postgres";


ALTER TABLE "public"."spore_measurement_mosaics" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."spore_measurement_mosaics_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."spore_measurements" (
    "id" bigint NOT NULL,
    "image_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "length_um" double precision NOT NULL,
    "width_um" double precision,
    "measurement_type" "text" DEFAULT 'manual'::"text",
    "gallery_rotation" integer DEFAULT 0,
    "p1_x" double precision,
    "p1_y" double precision,
    "p2_x" double precision,
    "p2_y" double precision,
    "p3_x" double precision,
    "p3_y" double precision,
    "p4_x" double precision,
    "p4_y" double precision,
    "notes" "text",
    "desktop_id" integer,
    "measured_at" timestamp with time zone DEFAULT "now"(),
    "image_key" "text",
    "thumb_key" "text"
);


ALTER TABLE "public"."spore_measurements" OWNER TO "postgres";


ALTER TABLE "public"."spore_measurements" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."spore_measurements_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."taxa" (
    "taxon_id" integer NOT NULL,
    "genus" "text" NOT NULL,
    "specific_epithet" "text" NOT NULL,
    "canonical_scientific_name" "text",
    "family" "text",
    "taxon_rank" "text",
    "norwegian_taxon_id" integer,
    "swedish_taxon_id" integer,
    "inaturalist_taxon_id" integer,
    "artportalen_taxon_id" integer
);


ALTER TABLE "public"."taxa" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."taxa_vernacular" (
    "id" integer NOT NULL,
    "taxon_id" integer NOT NULL,
    "language_code" "text" NOT NULL,
    "vernacular_name" "text" NOT NULL,
    "is_preferred" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."taxa_vernacular" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."taxa_vernacular_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."taxa_vernacular_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."taxa_vernacular_id_seq" OWNED BY "public"."taxa_vernacular"."id";



CREATE TABLE IF NOT EXISTS "public"."user_blocks" (
    "blocker_id" "uuid" NOT NULL,
    "blocked_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_blocks" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_action_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."admin_action_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."comments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."comments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."taxa_vernacular" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."taxa_vernacular_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."admin_action_log"
    ADD CONSTRAINT "admin_action_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calibrations"
    ADD CONSTRAINT "calibrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calibrations"
    ADD CONSTRAINT "calibrations_user_calibration_uuid_key" UNIQUE ("user_id", "calibration_uuid");



ALTER TABLE ONLY "public"."comment_moderation"
    ADD CONSTRAINT "comment_moderation_pkey" PRIMARY KEY ("comment_id");



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_pkey" PRIMARY KEY ("user_id", "target_type", "target_id");



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_requester_id_addressee_id_key" UNIQUE ("requester_id", "addressee_id");



ALTER TABLE ONLY "public"."observation_identifications"
    ADD CONSTRAINT "observation_identifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."observation_identifications"
    ADD CONSTRAINT "observation_identifications_unique_run" UNIQUE ("observation_id", "service", "request_fingerprint");



ALTER TABLE ONLY "public"."observation_images"
    ADD CONSTRAINT "observation_images_desktop_id_user_unique" UNIQUE ("desktop_id", "user_id");



ALTER TABLE ONLY "public"."observation_images"
    ADD CONSTRAINT "observation_images_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."observation_shares"
    ADD CONSTRAINT "observation_shares_observation_id_shared_with_id_key" UNIQUE ("observation_id", "shared_with_id");



ALTER TABLE ONLY "public"."observation_shares"
    ADD CONSTRAINT "observation_shares_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."observation_spore_summaries"
    ADD CONSTRAINT "observation_spore_summaries_obs_context_uk" UNIQUE ("observation_id", "context_hash");



ALTER TABLE ONLY "public"."observation_spore_summaries"
    ADD CONSTRAINT "observation_spore_summaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."observations"
    ADD CONSTRAINT "observations_desktop_id_user_unique" UNIQUE ("desktop_id", "user_id");



ALTER TABLE ONLY "public"."observations"
    ADD CONSTRAINT "observations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");



ALTER TABLE ONLY "public"."public_regions"
    ADD CONSTRAINT "public_regions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reference_values"
    ADD CONSTRAINT "reference_values_genus_species_source_mount_medium_stain_key" UNIQUE ("genus", "species", "source", "mount_medium", "stain");



ALTER TABLE ONLY "public"."reference_values"
    ADD CONSTRAINT "reference_values_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spore_annotations"
    ADD CONSTRAINT "spore_annotations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spore_measurement_mosaic_tiles"
    ADD CONSTRAINT "spore_measurement_mosaic_tiles_pkey" PRIMARY KEY ("measurement_id");



ALTER TABLE ONLY "public"."spore_measurement_mosaics"
    ADD CONSTRAINT "spore_measurement_mosaics_observation_id_version_key" UNIQUE ("observation_id", "version");



ALTER TABLE ONLY "public"."spore_measurement_mosaics"
    ADD CONSTRAINT "spore_measurement_mosaics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spore_measurements"
    ADD CONSTRAINT "spore_measurements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."taxa"
    ADD CONSTRAINT "taxa_pkey" PRIMARY KEY ("taxon_id");



ALTER TABLE ONLY "public"."taxa_vernacular"
    ADD CONSTRAINT "taxa_vernacular_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id");



CREATE INDEX "comments_mentioned_user_ids_gin_idx" ON "public"."comments" USING "gin" ("mentioned_user_ids");



CREATE INDEX "idx_calibrations_user_objective" ON "public"."calibrations" USING "btree" ("user_id", "objective_key", "is_active", "calibration_date" DESC);



CREATE INDEX "idx_follows_target" ON "public"."follows" USING "btree" ("target_type", "target_id");



CREATE INDEX "idx_observation_images_deleted_purged_at" ON "public"."observation_images" USING "btree" ("deleted_at", "purged_at");



CREATE INDEX "idx_observation_images_observation_id" ON "public"."observation_images" USING "btree" ("observation_id");



CREATE INDEX "idx_observations_image_key" ON "public"."observations" USING "btree" ("image_key");



CREATE INDEX "idx_observations_is_draft" ON "public"."observations" USING "btree" ("is_draft");



CREATE INDEX "idx_observations_location_precision" ON "public"."observations" USING "btree" ("location_precision");



CREATE INDEX "idx_observations_public_country_code" ON "public"."observations" USING "btree" ("country_code") WHERE (("country_code" IS NOT NULL) AND (COALESCE("visibility", 'public'::"text") = 'public'::"text") AND (NOT COALESCE("is_draft", false)));



CREATE INDEX "idx_observations_public_region_id" ON "public"."observations" USING "btree" ("region_id") WHERE (("region_id" IS NOT NULL) AND (COALESCE("visibility", 'public'::"text") = 'public'::"text") AND (NOT COALESCE("is_draft", false)));



CREATE INDEX "idx_observations_species_spore_visibility" ON "public"."observations" USING "btree" ("genus", "species", "spore_data_visibility");



CREATE INDEX "idx_observations_spore_visibility" ON "public"."observations" USING "btree" ("spore_data_visibility");



CREATE INDEX "idx_observations_user_visibility" ON "public"."observations" USING "btree" ("user_id", "visibility");



CREATE INDEX "idx_observations_visibility" ON "public"."observations" USING "btree" ("visibility");



CREATE INDEX "idx_profiles_cloud_plan" ON "public"."profiles" USING "btree" ("cloud_plan");



CREATE INDEX "idx_profiles_is_pro" ON "public"."profiles" USING "btree" ("is_pro");



CREATE UNIQUE INDEX "idx_spore_measurements_desktop_user" ON "public"."spore_measurements" USING "btree" ("desktop_id", "user_id") WHERE (("desktop_id" IS NOT NULL) AND ("user_id" IS NOT NULL));



CREATE INDEX "idx_spore_measurements_image_type" ON "public"."spore_measurements" USING "btree" ("image_id", "measurement_type");



CREATE INDEX "idx_spore_measurements_thumb_key" ON "public"."spore_measurements" USING "btree" ("thumb_key");



CREATE INDEX "idx_spore_measurements_user_id" ON "public"."spore_measurements" USING "btree" ("user_id");



CREATE INDEX "idx_taxa_genus" ON "public"."taxa" USING "btree" ("genus" "text_pattern_ops");



CREATE INDEX "idx_taxa_genus_species" ON "public"."taxa" USING "btree" ("genus", "specific_epithet");



CREATE INDEX "idx_taxa_scientific" ON "public"."taxa" USING "btree" ("canonical_scientific_name" "text_pattern_ops");



CREATE INDEX "idx_vernacular_lang" ON "public"."taxa_vernacular" USING "btree" ("language_code", "is_preferred");



CREATE INDEX "idx_vernacular_name" ON "public"."taxa_vernacular" USING "btree" ("vernacular_name" "text_pattern_ops");



CREATE INDEX "idx_vernacular_taxon" ON "public"."taxa_vernacular" USING "btree" ("taxon_id");



CREATE INDEX "observation_identifications_observation_idx" ON "public"."observation_identifications" USING "btree" ("observation_id", "created_at" DESC);



CREATE INDEX "observation_identifications_service_idx" ON "public"."observation_identifications" USING "btree" ("observation_id", "service", "created_at" DESC);



CREATE INDEX "observation_identifications_user_idx" ON "public"."observation_identifications" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "observation_images_observation_id_idx" ON "public"."observation_images" USING "btree" ("observation_id");



CREATE INDEX "observation_images_user_id_idx" ON "public"."observation_images" USING "btree" ("user_id");



CREATE INDEX "observation_spore_summaries_context_idx" ON "public"."observation_spore_summaries" USING "btree" ("context_hash");



CREATE INDEX "observation_spore_summaries_measurement_context_idx" ON "public"."observation_spore_summaries" USING "btree" ("measurement_type", "sample_type", "mount_reagent", "stain_reagent", "contrast_method");



CREATE INDEX "observation_spore_summaries_observation_idx" ON "public"."observation_spore_summaries" USING "btree" ("observation_id");



CREATE INDEX "observation_spore_summaries_user_idx" ON "public"."observation_spore_summaries" USING "btree" ("user_id");



CREATE INDEX "observations_date_idx" ON "public"."observations" USING "btree" ("date" DESC);



CREATE INDEX "observations_genus_species_idx" ON "public"."observations" USING "btree" ("genus", "species");



CREATE INDEX "observations_user_id_idx" ON "public"."observations" USING "btree" ("user_id");



CREATE INDEX "spore_measurement_mosaic_tiles_mosaic_id_idx" ON "public"."spore_measurement_mosaic_tiles" USING "btree" ("mosaic_id");



CREATE INDEX "spore_measurement_mosaics_observation_id_idx" ON "public"."spore_measurement_mosaics" USING "btree" ("observation_id");



CREATE INDEX "spore_measurements_image_id_idx" ON "public"."spore_measurements" USING "btree" ("image_id");



CREATE INDEX "spore_measurements_user_id_idx" ON "public"."spore_measurements" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "enforce_non_public_observation_limit_trigger" BEFORE INSERT OR UPDATE OF "user_id", "visibility", "location_precision", "is_draft" ON "public"."observations" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_non_public_observation_limit"();



CREATE OR REPLACE TRIGGER "trg_friendships_updated_at" BEFORE UPDATE ON "public"."friendships" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_observation_spore_summaries_updated_at" BEFORE UPDATE ON "public"."observation_spore_summaries" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_observations_updated_at" BEFORE UPDATE ON "public"."observations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_profiles_protect_privileged_fields" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."protect_profile_privileged_fields"();



CREATE OR REPLACE TRIGGER "trg_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."calibrations"
    ADD CONSTRAINT "calibrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comment_moderation"
    ADD CONSTRAINT "comment_moderation_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_identifications"
    ADD CONSTRAINT "observation_identifications_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_identifications"
    ADD CONSTRAINT "observation_identifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_images"
    ADD CONSTRAINT "observation_images_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_images"
    ADD CONSTRAINT "observation_images_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_shares"
    ADD CONSTRAINT "observation_shares_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_shares"
    ADD CONSTRAINT "observation_shares_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_shares"
    ADD CONSTRAINT "observation_shares_shared_with_id_fkey" FOREIGN KEY ("shared_with_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_spore_summaries"
    ADD CONSTRAINT "observation_spore_summaries_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observation_spore_summaries"
    ADD CONSTRAINT "observation_spore_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."observations"
    ADD CONSTRAINT "observations_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "public"."public_regions"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."observations"
    ADD CONSTRAINT "observations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spore_annotations"
    ADD CONSTRAINT "spore_annotations_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "public"."observation_images"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spore_annotations"
    ADD CONSTRAINT "spore_annotations_measurement_id_fkey" FOREIGN KEY ("measurement_id") REFERENCES "public"."spore_measurements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spore_annotations"
    ADD CONSTRAINT "spore_annotations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spore_measurement_mosaic_tiles"
    ADD CONSTRAINT "spore_measurement_mosaic_tiles_measurement_id_fkey" FOREIGN KEY ("measurement_id") REFERENCES "public"."spore_measurements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spore_measurement_mosaic_tiles"
    ADD CONSTRAINT "spore_measurement_mosaic_tiles_mosaic_id_fkey" FOREIGN KEY ("mosaic_id") REFERENCES "public"."spore_measurement_mosaics"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spore_measurement_mosaics"
    ADD CONSTRAINT "spore_measurement_mosaics_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spore_measurement_mosaics"
    ADD CONSTRAINT "spore_measurement_mosaics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spore_measurements"
    ADD CONSTRAINT "spore_measurements_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "public"."observation_images"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spore_measurements"
    ADD CONSTRAINT "spore_measurements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."taxa_vernacular"
    ADD CONSTRAINT "taxa_vernacular_taxon_id_fkey" FOREIGN KEY ("taxon_id") REFERENCES "public"."taxa"("taxon_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Users can create reports" ON "public"."reports" FOR INSERT WITH CHECK (("auth"."uid"() = "reporter_id"));



CREATE POLICY "Users can delete own observation identifications" ON "public"."observation_identifications" FOR DELETE USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can delete their own blocks" ON "public"."user_blocks" FOR DELETE USING (("auth"."uid"() = "blocker_id"));



CREATE POLICY "Users can delete their own measurements" ON "public"."spore_measurements" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can delete their own spore mosaics" ON "public"."spore_measurement_mosaics" FOR DELETE USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "spore_measurement_mosaics"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can delete tiles for their own mosaics" ON "public"."spore_measurement_mosaic_tiles" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM (("public"."spore_measurement_mosaics" "sm"
     JOIN "public"."spore_measurements" "meas" ON (("meas"."id" = "spore_measurement_mosaic_tiles"."measurement_id")))
     JOIN "public"."observation_images" "img" ON (("img"."id" = "meas"."image_id")))
  WHERE (("sm"."id" = "spore_measurement_mosaic_tiles"."mosaic_id") AND ("sm"."user_id" = "auth"."uid"()) AND ("img"."observation_id" = "sm"."observation_id")))));



CREATE POLICY "Users can insert own observation identifications" ON "public"."observation_identifications" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can insert their own blocks" ON "public"."user_blocks" FOR INSERT WITH CHECK (("auth"."uid"() = "blocker_id"));



CREATE POLICY "Users can insert their own measurements" ON "public"."spore_measurements" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert their own spore mosaics" ON "public"."spore_measurement_mosaics" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "spore_measurement_mosaics"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can insert tiles for their own mosaics" ON "public"."spore_measurement_mosaic_tiles" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM (("public"."spore_measurement_mosaics" "sm"
     JOIN "public"."spore_measurements" "meas" ON (("meas"."id" = "spore_measurement_mosaic_tiles"."measurement_id")))
     JOIN "public"."observation_images" "img" ON (("img"."id" = "meas"."image_id")))
  WHERE (("sm"."id" = "spore_measurement_mosaic_tiles"."mosaic_id") AND ("sm"."user_id" = "auth"."uid"()) AND ("img"."observation_id" = "sm"."observation_id")))));



CREATE POLICY "Users can read observation identifications for visible observat" ON "public"."observation_identifications" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND (("o"."user_id" = "auth"."uid"()) OR ((NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility")))))));



CREATE POLICY "Users can update own observation identifications" ON "public"."observation_identifications" FOR UPDATE USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"())))))) WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can update their own measurements" ON "public"."spore_measurements" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update their own spore mosaics" ON "public"."spore_measurement_mosaics" FOR UPDATE USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "spore_measurement_mosaics"."observation_id") AND ("o"."user_id" = "auth"."uid"())))))) WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "spore_measurement_mosaics"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can update tiles for their own mosaics" ON "public"."spore_measurement_mosaic_tiles" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM (("public"."spore_measurement_mosaics" "sm"
     JOIN "public"."spore_measurements" "meas" ON (("meas"."id" = "spore_measurement_mosaic_tiles"."measurement_id")))
     JOIN "public"."observation_images" "img" ON (("img"."id" = "meas"."image_id")))
  WHERE (("sm"."id" = "spore_measurement_mosaic_tiles"."mosaic_id") AND ("sm"."user_id" = "auth"."uid"()) AND ("img"."observation_id" = "sm"."observation_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (("public"."spore_measurement_mosaics" "sm"
     JOIN "public"."spore_measurements" "meas" ON (("meas"."id" = "spore_measurement_mosaic_tiles"."measurement_id")))
     JOIN "public"."observation_images" "img" ON (("img"."id" = "meas"."image_id")))
  WHERE (("sm"."id" = "spore_measurement_mosaic_tiles"."mosaic_id") AND ("sm"."user_id" = "auth"."uid"()) AND ("img"."observation_id" = "sm"."observation_id")))));



CREATE POLICY "Users can view their own blocks" ON "public"."user_blocks" FOR SELECT USING ((("auth"."uid"() = "blocker_id") OR ("auth"."uid"() = "blocked_id")));



CREATE POLICY "Users can view their own measurements" ON "public"."spore_measurements" FOR SELECT USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observation_images" "oi"
  WHERE (("oi"."id" = "spore_measurements"."image_id") AND ("oi"."deleted_at" IS NULL))))));



CREATE POLICY "Users can view their own spore mosaics" ON "public"."spore_measurement_mosaics" FOR SELECT USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "spore_measurement_mosaics"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can view tiles for their own mosaics" ON "public"."spore_measurement_mosaic_tiles" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (("public"."spore_measurement_mosaics" "sm"
     JOIN "public"."spore_measurements" "meas" ON (("meas"."id" = "spore_measurement_mosaic_tiles"."measurement_id")))
     JOIN "public"."observation_images" "img" ON (("img"."id" = "meas"."image_id")))
  WHERE (("sm"."id" = "spore_measurement_mosaic_tiles"."mosaic_id") AND ("sm"."user_id" = "auth"."uid"()) AND ("img"."observation_id" = "sm"."observation_id")))));



ALTER TABLE "public"."admin_action_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calibrations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "calibrations: owner full" ON "public"."calibrations" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."comment_moderation" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "comments_delete" ON "public"."comments" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "comments_insert" ON "public"."comments" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "comments_select" ON "public"."comments" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "comments"."observation_id") AND (("o"."user_id" = "auth"."uid"()) OR ((NOT COALESCE("o"."is_draft", false)) AND (("o"."visibility" = 'public'::"text") OR (("o"."visibility" = 'friends'::"text") AND (EXISTS ( SELECT 1
           FROM "public"."friendships" "f"
          WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester_id" = "auth"."uid"()) AND ("f"."addressee_id" = "o"."user_id")) OR (("f"."addressee_id" = "auth"."uid"()) AND ("f"."requester_id" = "o"."user_id"))))))))))))) AND (NOT (EXISTS ( SELECT 1
   FROM "public"."comment_moderation" "cm"
  WHERE (("cm"."comment_id" = "comments"."id") AND ("cm"."hidden_at" IS NOT NULL)))))));



ALTER TABLE "public"."follows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."friendships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "friendships: parties can delete" ON "public"."friendships" FOR DELETE USING ((("auth"."uid"() = "requester_id") OR ("auth"."uid"() = "addressee_id")));



CREATE POLICY "friendships: parties can read" ON "public"."friendships" FOR SELECT USING ((("auth"."uid"() = "requester_id") OR ("auth"."uid"() = "addressee_id")));



CREATE POLICY "friendships: parties can update" ON "public"."friendships" FOR UPDATE USING ((("auth"."uid"() = "requester_id") OR ("auth"."uid"() = "addressee_id")));



CREATE POLICY "friendships: requester can insert" ON "public"."friendships" FOR INSERT WITH CHECK (("auth"."uid"() = "requester_id"));



ALTER TABLE "public"."observation_identifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."observation_images" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "observation_images friend read" ON "public"."observation_images" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND (NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility")))));



CREATE POLICY "observation_images: friends read" ON "public"."observation_images" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND (NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility")))));



CREATE POLICY "observation_images: owner select including deleted" ON "public"."observation_images" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."observation_shares" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "observation_shares: owner full" ON "public"."observation_shares" USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "observation_shares: recipient read" ON "public"."observation_shares" FOR SELECT USING (("auth"."uid"() = "shared_with_id"));



ALTER TABLE "public"."observation_spore_summaries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "observation_spore_summaries: owner full" ON "public"."observation_spore_summaries" USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_spore_summaries"."observation_id") AND ("o"."user_id" = "auth"."uid"())))))) WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_spore_summaries"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."observations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "observations: friends read public" ON "public"."observations" FOR SELECT USING (((NOT COALESCE("is_draft", false)) AND "public"."can_read_observation"("user_id", "visibility")));



CREATE POLICY "observations: owner full" ON "public"."observations" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_comments_delete_own" ON "public"."comments" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_comments_insert_visible" ON "public"."comments" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "comments"."observation_id") AND (("o"."user_id" = "auth"."uid"()) OR ((NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility"))))))));



CREATE POLICY "phase7_comments_read" ON "public"."comments" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "comments"."observation_id") AND (("o"."user_id" = "auth"."uid"()) OR ((NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility")))))) AND (NOT (EXISTS ( SELECT 1
   FROM "public"."comment_moderation" "cm"
  WHERE (("cm"."comment_id" = "comments"."id") AND ("cm"."hidden_at" IS NOT NULL)))))));



CREATE POLICY "phase7_comments_update_own" ON "public"."comments" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_follows_delete_own" ON "public"."follows" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_follows_insert_own" ON "public"."follows" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_follows_read_own" ON "public"."follows" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_observation_images_delete_own" ON "public"."observation_images" FOR DELETE TO "authenticated" USING ((("auth"."uid"() = "user_id") AND ("deleted_at" IS NULL) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "phase7_observation_images_insert_own" ON "public"."observation_images" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND ("o"."user_id" = "auth"."uid"())))) AND (("storage_path" ~~ (("auth"."uid"())::"text" || '/%'::"text")) OR (("storage_path" IS NULL) AND ("image_type" = 'microscope'::"text")))));



CREATE POLICY "phase7_observation_images_read" ON "public"."observation_images" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND (NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility")))));



CREATE POLICY "phase7_observation_images_update_own" ON "public"."observation_images" FOR UPDATE TO "authenticated" USING ((("auth"."uid"() = "user_id") AND ("deleted_at" IS NULL) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND ("o"."user_id" = "auth"."uid"())))))) WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND ("o"."user_id" = "auth"."uid"())))) AND (("storage_path" ~~ (("auth"."uid"())::"text" || '/%'::"text")) OR (("storage_path" IS NULL) AND ("image_type" = 'microscope'::"text")))));



CREATE POLICY "phase7_observations_delete_own" ON "public"."observations" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_observations_insert_own" ON "public"."observations" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_observations_read" ON "public"."observations" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR ((NOT COALESCE("is_draft", false)) AND "public"."can_read_observation"("user_id", "visibility"))));



CREATE POLICY "phase7_observations_update_own" ON "public"."observations" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles public read" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "profiles: friends can read" ON "public"."profiles" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."friendships" "f"
  WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester_id" = "auth"."uid"()) AND ("f"."addressee_id" = "profiles"."id")) OR (("f"."addressee_id" = "auth"."uid"()) AND ("f"."requester_id" = "profiles"."id")))))));



CREATE POLICY "profiles: owner read-write" ON "public"."profiles" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



ALTER TABLE "public"."public_regions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public_regions: public read" ON "public"."public_regions" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."reference_values" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reference_values: authenticated read" ON "public"."reference_values" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spore_annotations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spore_annotations: owner full" ON "public"."spore_annotations" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."spore_measurement_mosaic_tiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spore_measurement_mosaics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spore_measurements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spore_measurements: friends read" ON "public"."spore_measurements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."observation_images" "oi"
     JOIN "public"."observations" "o" ON (("o"."id" = "oi"."observation_id")))
  WHERE (("oi"."id" = "spore_measurements"."image_id") AND (NOT COALESCE("o"."is_draft", false)) AND "public"."can_read_observation"("o"."user_id", "o"."visibility") AND "public"."can_access_spore_data"("o"."user_id", "o"."spore_data_visibility")))));



CREATE POLICY "spore_measurements: owner full" ON "public"."spore_measurements" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."taxa" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "taxa read" ON "public"."taxa" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."taxa_vernacular" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_blocks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vernacular read" ON "public"."taxa_vernacular" FOR SELECT TO "authenticated" USING (true);



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_database_health"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_database_health"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_profile_storage_delta"("p_user_id" "uuid", "p_storage_delta" bigint, "p_image_delta" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_profile_storage_delta"("p_user_id" "uuid", "p_storage_delta" bigint, "p_image_delta" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."are_friends"("user_a" "uuid", "user_b" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."are_friends"("user_a" "uuid", "user_b" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."are_friends"("user_a" "uuid", "user_b" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."are_friends"("user_a" "uuid", "user_b" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."can_access_spore_data"("owner_id" "uuid", "spore_visibility" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_access_spore_data"("owner_id" "uuid", "spore_visibility" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."can_access_spore_data"("owner_id" "uuid", "spore_visibility" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_access_spore_data"("owner_id" "uuid", "spore_visibility" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_read_observation"("owner_id" "uuid", "visibility_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."can_read_observation"("owner_id" "uuid", "visibility_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_read_observation"("owner_id" "uuid", "visibility_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_see_exact_observation_location"("observation_id" bigint, "owner_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_see_exact_observation_location"("observation_id" bigint, "owner_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_see_exact_observation_location"("observation_id" bigint, "owner_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."community_contributor_label"("profile_id" "uuid", "fallback_author" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."community_contributor_label"("profile_id" "uuid", "fallback_author" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."community_contributor_label"("profile_id" "uuid", "fallback_author" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."community_contributor_label"("profile_id" "uuid", "fallback_author" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."community_spore_taxon_summary"("p_genus" "text", "p_species" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."community_spore_taxon_summary"("p_genus" "text", "p_species" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."community_spore_taxon_summary"("p_genus" "text", "p_species" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."enable_spatial_ref_sys_rls"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enable_spatial_ref_sys_rls"() TO "anon";
GRANT ALL ON FUNCTION "public"."enable_spatial_ref_sys_rls"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enable_spatial_ref_sys_rls"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_non_public_observation_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_non_public_observation_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_non_public_observation_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_community_spore_dataset"("p_observation_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."get_community_spore_dataset"("p_observation_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_community_spore_dataset"("p_observation_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_person_stats"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_person_stats"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_person_stats"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_person_stats"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_map_points"("p_species_slug" "text", "p_genus" "text", "p_search" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_map_points"("p_species_slug" "text", "p_genus" "text", "p_search" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean, "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_map_points"("p_species_slug" "text", "p_genus" "text", "p_search" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_map_points"("p_species_slug" "text", "p_genus" "text", "p_search" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean, "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_observation"("p_observation_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_observation"("p_observation_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_observation"("p_observation_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_observation"("p_observation_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_observation_facets"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_observation_facets"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_observation_facets"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_observation_facets"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_observation_images"("p_observation_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_observation_images"("p_observation_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_observation_images"("p_observation_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_observation_images"("p_observation_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_observation_spore_summaries"("p_observation_ids" bigint[], "p_sample_type" "text", "p_mount_reagent" "text", "p_stain_reagent" "text", "p_contrast_method" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_observation_spore_summaries"("p_observation_ids" bigint[], "p_sample_type" "text", "p_mount_reagent" "text", "p_stain_reagent" "text", "p_contrast_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_observation_spore_summaries"("p_observation_ids" bigint[], "p_sample_type" "text", "p_mount_reagent" "text", "p_stain_reagent" "text", "p_contrast_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_observation_spore_summaries"("p_observation_ids" bigint[], "p_sample_type" "text", "p_mount_reagent" "text", "p_stain_reagent" "text", "p_contrast_method" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_species"("p_species_slug" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_species"("p_species_slug" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_species"("p_species_slug" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_species"("p_species_slug" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_species_distribution_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_species_distribution_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_species_distribution_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_species_distribution_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text", "p_has_microscopy" boolean, "p_has_spores" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_species_spore_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_species_spore_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_species_spore_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_species_spore_summary"("p_species_slug" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_spore_comparison_set"("p_species_slug" "text", "p_genus" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_spore_comparison_set"("p_species_slug" "text", "p_genus" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_spore_comparison_set"("p_species_slug" "text", "p_genus" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_spore_comparison_set"("p_species_slug" "text", "p_genus" "text", "p_country" "text", "p_region_id" "text", "p_date_from" "date", "p_date_to" "date", "p_sample_type" "text", "p_mount_reagent" "text", "p_contrast_method" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_blocked_between"("user_a" "uuid", "user_b" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_blocked_between"("user_a" "uuid", "user_b" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_blocked_between"("user_a" "uuid", "user_b" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."non_public_observation_count"("profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."non_public_observation_count"("profile_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."non_public_observation_count"("profile_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."non_public_observation_count"("profile_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."profile_has_pro_access"("profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."profile_has_pro_access"("profile_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."profile_has_pro_access"("profile_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."profile_has_pro_access"("profile_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_profile_privileged_fields"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_profile_privileged_fields"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_profile_privileged_fields"() TO "service_role";



GRANT ALL ON FUNCTION "public"."search_community_spore_datasets"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_community_spore_datasets"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_community_spore_datasets"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_people_directory"("p_limit" integer, "p_offset" integer, "p_query" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_people_directory"("p_limit" integer, "p_offset" integer, "p_query" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_people_directory"("p_limit" integer, "p_offset" integer, "p_query" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_people_directory"("p_limit" integer, "p_offset" integer, "p_query" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_public_observation_images"("p_observation_ids" bigint[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_public_observation_images"("p_observation_ids" bigint[]) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_observation_images"("p_observation_ids" bigint[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_observation_images"("p_observation_ids" bigint[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_public_observations"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_species" "text", "p_country" "text", "p_region" "text", "p_date_from" "date", "p_date_to" "date", "p_has_spores" boolean, "p_has_microscopy" boolean, "p_contrast" "text", "p_mount" "text", "p_sample" "text", "p_observer" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_public_observations"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_species" "text", "p_country" "text", "p_region" "text", "p_date_from" "date", "p_date_to" "date", "p_has_spores" boolean, "p_has_microscopy" boolean, "p_contrast" "text", "p_mount" "text", "p_sample" "text", "p_observer" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_observations"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_species" "text", "p_country" "text", "p_region" "text", "p_date_from" "date", "p_date_to" "date", "p_has_spores" boolean, "p_has_microscopy" boolean, "p_contrast" "text", "p_mount" "text", "p_sample" "text", "p_observer" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_observations"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_species" "text", "p_country" "text", "p_region" "text", "p_date_from" "date", "p_date_to" "date", "p_has_spores" boolean, "p_has_microscopy" boolean, "p_contrast" "text", "p_mount" "text", "p_sample" "text", "p_observer" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_reference_values"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_reference_values"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_reference_values"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_public_species"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_query" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_public_species"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_query" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_species"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_query" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_species"("p_limit" integer, "p_offset" integer, "p_genus" "text", "p_query" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_taxa"("q" "text", "lang" "text", "lim" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_taxa"("q" "text", "lang" "text", "lim" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_taxa"("q" "text", "lang" "text", "lim" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON TABLE "public"."admin_action_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."admin_action_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."calibrations" TO "anon";
GRANT ALL ON TABLE "public"."calibrations" TO "authenticated";
GRANT ALL ON TABLE "public"."calibrations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."calibrations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."calibrations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."calibrations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."comment_moderation" TO "service_role";



GRANT ALL ON TABLE "public"."comments" TO "anon";
GRANT ALL ON TABLE "public"."comments" TO "authenticated";
GRANT ALL ON TABLE "public"."comments" TO "service_role";



GRANT ALL ON TABLE "public"."observations" TO "anon";
GRANT ALL ON TABLE "public"."observations" TO "authenticated";
GRANT ALL ON TABLE "public"."observations" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."comments_community_view" TO "anon";
GRANT ALL ON TABLE "public"."comments_community_view" TO "authenticated";
GRANT ALL ON TABLE "public"."comments_community_view" TO "service_role";



GRANT ALL ON SEQUENCE "public"."comments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."comments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."comments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."follows" TO "anon";
GRANT ALL ON TABLE "public"."follows" TO "authenticated";
GRANT ALL ON TABLE "public"."follows" TO "service_role";



GRANT ALL ON TABLE "public"."friendships" TO "anon";
GRANT ALL ON TABLE "public"."friendships" TO "authenticated";
GRANT ALL ON TABLE "public"."friendships" TO "service_role";



GRANT ALL ON SEQUENCE "public"."friendships_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."friendships_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."friendships_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."observation_identifications" TO "anon";
GRANT ALL ON TABLE "public"."observation_identifications" TO "authenticated";
GRANT ALL ON TABLE "public"."observation_identifications" TO "service_role";



GRANT ALL ON TABLE "public"."observation_identifications_community_view" TO "anon";
GRANT ALL ON TABLE "public"."observation_identifications_community_view" TO "authenticated";
GRANT ALL ON TABLE "public"."observation_identifications_community_view" TO "service_role";



GRANT ALL ON SEQUENCE "public"."observation_identifications_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."observation_identifications_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."observation_identifications_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."observation_images" TO "anon";
GRANT ALL ON TABLE "public"."observation_images" TO "authenticated";
GRANT ALL ON TABLE "public"."observation_images" TO "service_role";



GRANT ALL ON TABLE "public"."observation_images_community_view" TO "anon";
GRANT ALL ON TABLE "public"."observation_images_community_view" TO "authenticated";
GRANT ALL ON TABLE "public"."observation_images_community_view" TO "service_role";



GRANT ALL ON SEQUENCE "public"."observation_images_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."observation_images_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."observation_images_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."observation_shares" TO "anon";
GRANT ALL ON TABLE "public"."observation_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."observation_shares" TO "service_role";



GRANT ALL ON SEQUENCE "public"."observation_shares_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."observation_shares_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."observation_shares_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."observation_spore_summaries" TO "anon";
GRANT ALL ON TABLE "public"."observation_spore_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."observation_spore_summaries" TO "service_role";



GRANT ALL ON SEQUENCE "public"."observation_spore_summaries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."observation_spore_summaries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."observation_spore_summaries_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."observations_community_view" TO "anon";
GRANT ALL ON TABLE "public"."observations_community_view" TO "authenticated";
GRANT ALL ON TABLE "public"."observations_community_view" TO "service_role";



GRANT ALL ON TABLE "public"."observations_follow_view" TO "anon";
GRANT ALL ON TABLE "public"."observations_follow_view" TO "authenticated";
GRANT ALL ON TABLE "public"."observations_follow_view" TO "service_role";



GRANT ALL ON TABLE "public"."observations_friend_view" TO "anon";
GRANT ALL ON TABLE "public"."observations_friend_view" TO "authenticated";
GRANT ALL ON TABLE "public"."observations_friend_view" TO "service_role";



GRANT ALL ON SEQUENCE "public"."observations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."observations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."observations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."public_regions" TO "anon";
GRANT ALL ON TABLE "public"."public_regions" TO "authenticated";
GRANT ALL ON TABLE "public"."public_regions" TO "service_role";



GRANT ALL ON TABLE "public"."reference_values" TO "anon";
GRANT ALL ON TABLE "public"."reference_values" TO "authenticated";
GRANT ALL ON TABLE "public"."reference_values" TO "service_role";



GRANT ALL ON SEQUENCE "public"."reference_values_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."reference_values_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."reference_values_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."reports" TO "anon";
GRANT ALL ON TABLE "public"."reports" TO "authenticated";
GRANT ALL ON TABLE "public"."reports" TO "service_role";



GRANT ALL ON TABLE "public"."spore_annotations" TO "anon";
GRANT ALL ON TABLE "public"."spore_annotations" TO "authenticated";
GRANT ALL ON TABLE "public"."spore_annotations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."spore_annotations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."spore_annotations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."spore_annotations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."spore_measurement_mosaic_tiles" TO "anon";
GRANT ALL ON TABLE "public"."spore_measurement_mosaic_tiles" TO "authenticated";
GRANT ALL ON TABLE "public"."spore_measurement_mosaic_tiles" TO "service_role";



GRANT ALL ON TABLE "public"."spore_measurement_mosaics" TO "anon";
GRANT ALL ON TABLE "public"."spore_measurement_mosaics" TO "authenticated";
GRANT ALL ON TABLE "public"."spore_measurement_mosaics" TO "service_role";



GRANT ALL ON SEQUENCE "public"."spore_measurement_mosaics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."spore_measurement_mosaics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."spore_measurement_mosaics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."spore_measurements" TO "anon";
GRANT ALL ON TABLE "public"."spore_measurements" TO "authenticated";
GRANT ALL ON TABLE "public"."spore_measurements" TO "service_role";



GRANT ALL ON SEQUENCE "public"."spore_measurements_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."spore_measurements_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."spore_measurements_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."taxa" TO "anon";
GRANT ALL ON TABLE "public"."taxa" TO "authenticated";
GRANT ALL ON TABLE "public"."taxa" TO "service_role";



GRANT ALL ON TABLE "public"."taxa_vernacular" TO "anon";
GRANT ALL ON TABLE "public"."taxa_vernacular" TO "authenticated";
GRANT ALL ON TABLE "public"."taxa_vernacular" TO "service_role";



GRANT ALL ON SEQUENCE "public"."taxa_vernacular_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."taxa_vernacular_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."taxa_vernacular_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_blocks" TO "anon";
GRANT ALL ON TABLE "public"."user_blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."user_blocks" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
