


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



CREATE OR REPLACE FUNCTION "public"."apply_profile_storage_delta"("p_user_id" "uuid", "p_storage_delta" bigint, "p_image_delta" integer) RETURNS TABLE("total_storage_bytes" bigint, "storage_used_bytes" bigint, "image_count" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
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
    JOIN public.spore_measurements m
      ON m.image_id = i.id
    WHERE lower(coalesce(o.genus, '')) = lower(trim(coalesce(p_genus, '')))
      AND (trim(coalesce(p_species, '')) = '' OR lower(coalesce(o.species, '')) = lower(trim(p_species)))
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
  IF coalesce(NEW.visibility, 'public') = 'public'
     AND coalesce(NEW.location_precision, 'exact') = 'exact' THEN
    RETURN NEW;
  END IF;

  IF public.profile_has_pro_access(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
  INTO current_count
  FROM public.observations o
  WHERE o.user_id = NEW.user_id
    AND (
      coalesce(o.visibility, 'public') <> 'public'
      OR coalesce(o.location_precision, 'exact') = 'fuzzed'
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


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
    insert into public.profiles (id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));
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
    AND (
      coalesce(o.visibility, 'public') <> 'public'
      OR coalesce(o.location_precision, 'exact') = 'fuzzed'
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


CREATE OR REPLACE FUNCTION "public"."search_people_directory"("p_query" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 24) RETURNS TABLE("user_id" "uuid", "username" "text", "display_name" "text", "bio" "text", "avatar_url" "text", "public_find_count" bigint, "public_species_count" bigint, "public_spore_count" bigint, "latest_public_observation_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH normalized AS (
    SELECT
      nullif(btrim(coalesce(p_query, '')), '') AS q,
      greatest(1, least(coalesce(p_limit, 24), 100)) AS lim
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
  public_observations AS (
    SELECT
      o.id,
      o.user_id,
      o.created_at,
      o.genus,
      o.species,
      o.spore_data_visibility
    FROM public.observations_community_view o
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
      ) AS public_species_count,
      max(po.created_at) AS latest_public_observation_at
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
    vp.id AS user_id,
    vp.username,
    vp.display_name,
    vp.bio,
    vp.avatar_url,
    coalesce(pos.public_find_count, 0) AS public_find_count,
    coalesce(pos.public_species_count, 0) AS public_species_count,
    coalesce(ps.public_spore_count, 0) AS public_spore_count,
    pos.latest_public_observation_at
  FROM visible_profiles vp
  LEFT JOIN public_observation_stats pos
    ON pos.user_id = vp.id
  LEFT JOIN public_spore_stats ps
    ON ps.user_id = vp.id
  CROSS JOIN normalized n
  WHERE n.q IS NOT NULL
     OR pos.latest_public_observation_at IS NOT NULL
  ORDER BY
    CASE
      WHEN n.q IS NULL THEN 0
      WHEN lower(coalesce(vp.username, '')) = lower(n.q) THEN 0
      WHEN lower(coalesce(vp.display_name, '')) = lower(n.q) THEN 1
      WHEN lower(coalesce(vp.username, '')) LIKE lower(n.q) || '%' THEN 2
      WHEN lower(coalesce(vp.display_name, '')) LIKE lower(n.q) || '%' THEN 3
      ELSE 4
    END,
    pos.latest_public_observation_at DESC NULLS LAST,
    coalesce(vp.display_name, vp.username, '') ASC
  LIMIT (SELECT lim FROM normalized);
$$;


ALTER FUNCTION "public"."search_people_directory"("p_query" "text", "p_limit" integer) OWNER TO "postgres";


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
    "created_at" timestamp with time zone DEFAULT "now"()
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



CREATE TABLE IF NOT EXISTS "public"."comments" (
    "id" bigint NOT NULL,
    "observation_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."comments" OWNER TO "postgres";


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



CREATE TABLE IF NOT EXISTS "public"."observation_images" (
    "id" bigint NOT NULL,
    "observation_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
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
    CONSTRAINT "observation_images_image_type_check" CHECK (("image_type" = ANY (ARRAY['field'::"text", 'microscope'::"text"]))),
    CONSTRAINT "observation_images_upload_mode_check" CHECK ((("upload_mode" IS NULL) OR ("upload_mode" = ANY (ARRAY['reduced'::"text", 'full'::"text"]))))
);


ALTER TABLE "public"."observation_images" OWNER TO "postgres";


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
    CONSTRAINT "observations_location_precision_check" CHECK (("location_precision" = ANY (ARRAY['exact'::"text", 'fuzzed'::"text"]))),
    CONSTRAINT "observations_spore_data_visibility_check" CHECK (("spore_data_visibility" = ANY (ARRAY['private'::"text", 'friends'::"text", 'public'::"text"]))),
    CONSTRAINT "observations_visibility_check" CHECK (("visibility" = ANY (ARRAY['private'::"text", 'friends'::"text", 'public'::"text"])))
);


ALTER TABLE "public"."observations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."observations"."gps_altitude" IS 'Altitude in meters above sea level';



COMMENT ON COLUMN "public"."observations"."gps_accuracy" IS 'Horizontal accuracy of the GPS coordinates in meters';



CREATE TABLE IF NOT EXISTS "public"."observation_identifications" (
    "id" bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    "observation_id" bigint NOT NULL,
    "user_id" uuid NOT NULL,
    "service" "text" NOT NULL,
    "source" "text" NOT NULL DEFAULT 'ai'::"text",
    "status" "text" NOT NULL DEFAULT 'success'::"text",
    "image_fingerprint" "text" NOT NULL DEFAULT ''::"text",
    "crop_fingerprint" "text",
    "request_fingerprint" "text" NOT NULL,
    "language" "text",
    "model_version" "text",
    "results" "jsonb" NOT NULL DEFAULT '[]'::"jsonb",
    "top_scientific_name" "text",
    "top_vernacular_name" "text",
    "top_taxon_id" "text",
    "top_probability" numeric,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "observation_identifications_service_check" CHECK (("service" = ANY (ARRAY['artsorakel'::"text", 'inat'::"text", 'inaturalist'::"text"]))),
    CONSTRAINT "observation_identifications_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'no_match'::"text", 'error'::"text", 'stale'::"text", 'unavailable'::"text"]))),
    CONSTRAINT "observation_identifications_probability_check" CHECK ((("top_probability" IS NULL) OR (("top_probability" >= (0)::numeric) AND ("top_probability" <= (1)::numeric)))),
    CONSTRAINT "observation_identifications_unique_run" UNIQUE ("observation_id", "service", "request_fingerprint"),
    CONSTRAINT "observation_identifications_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE CASCADE,
    CONSTRAINT "observation_identifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);


ALTER TABLE "public"."observation_identifications" OWNER TO "postgres";


CREATE INDEX "observation_identifications_observation_idx" ON "public"."observation_identifications" USING "btree" ("observation_id", "created_at" DESC);


CREATE INDEX "observation_identifications_user_idx" ON "public"."observation_identifications" USING "btree" ("user_id", "created_at" DESC);


CREATE INDEX "observation_identifications_service_idx" ON "public"."observation_identifications" USING "btree" ("observation_id", "service", "created_at" DESC);


ALTER TABLE "public"."observation_identifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Users can read own observation identifications" ON "public"."observation_identifications" FOR SELECT USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));


CREATE POLICY "Users can insert own observation identifications" ON "public"."observation_identifications" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));


CREATE POLICY "Users can update own observation identifications" ON "public"."observation_identifications" FOR UPDATE USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"())))))) WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));


CREATE POLICY "Users can delete own observation identifications" ON "public"."observation_identifications" FOR DELETE USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_identifications"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));


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
    CONSTRAINT "profiles_cloud_plan_check" CHECK (("cloud_plan" = ANY (ARRAY['free'::"text", 'pro'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


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
  WHERE ((COALESCE("visibility", 'public'::"text") = 'public'::"text") AND (NOT (EXISTS ( SELECT 1
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
  WHERE ("public"."can_read_observation"("o"."user_id", "o"."visibility") AND (NOT (EXISTS ( SELECT 1
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
  WHERE ((COALESCE("visibility", 'public'::"text") = ANY (ARRAY['friends'::"text", 'public'::"text"])) AND "public"."are_friends"("auth"."uid"(), "user_id") AND (NOT (EXISTS ( SELECT 1
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
    CONSTRAINT "reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewed'::"text", 'resolved'::"text"])))
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


ALTER TABLE ONLY "public"."comments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."comments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."taxa_vernacular" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."taxa_vernacular_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."calibrations"
    ADD CONSTRAINT "calibrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_pkey" PRIMARY KEY ("user_id", "target_type", "target_id");



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_requester_id_addressee_id_key" UNIQUE ("requester_id", "addressee_id");



ALTER TABLE ONLY "public"."observation_images"
    ADD CONSTRAINT "observation_images_desktop_id_user_unique" UNIQUE ("desktop_id", "user_id");



ALTER TABLE ONLY "public"."observation_images"
    ADD CONSTRAINT "observation_images_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."observation_shares"
    ADD CONSTRAINT "observation_shares_observation_id_shared_with_id_key" UNIQUE ("observation_id", "shared_with_id");



ALTER TABLE ONLY "public"."observation_shares"
    ADD CONSTRAINT "observation_shares_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."observations"
    ADD CONSTRAINT "observations_desktop_id_user_unique" UNIQUE ("desktop_id", "user_id");



ALTER TABLE ONLY "public"."observations"
    ADD CONSTRAINT "observations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");



ALTER TABLE ONLY "public"."reference_values"
    ADD CONSTRAINT "reference_values_genus_species_source_mount_medium_stain_key" UNIQUE ("genus", "species", "source", "mount_medium", "stain");



ALTER TABLE ONLY "public"."reference_values"
    ADD CONSTRAINT "reference_values_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spore_annotations"
    ADD CONSTRAINT "spore_annotations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spore_measurements"
    ADD CONSTRAINT "spore_measurements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."taxa"
    ADD CONSTRAINT "taxa_pkey" PRIMARY KEY ("taxon_id");



ALTER TABLE ONLY "public"."taxa_vernacular"
    ADD CONSTRAINT "taxa_vernacular_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id");



CREATE INDEX "idx_calibrations_user_objective" ON "public"."calibrations" USING "btree" ("user_id", "objective_key", "is_active", "calibration_date" DESC);



CREATE INDEX "idx_follows_target" ON "public"."follows" USING "btree" ("target_type", "target_id");



CREATE INDEX "idx_observation_images_observation_id" ON "public"."observation_images" USING "btree" ("observation_id");



CREATE INDEX "idx_observations_image_key" ON "public"."observations" USING "btree" ("image_key");



CREATE INDEX "idx_observations_is_draft" ON "public"."observations" USING "btree" ("is_draft");



CREATE INDEX "idx_observations_location_precision" ON "public"."observations" USING "btree" ("location_precision");



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



CREATE INDEX "observation_images_observation_id_idx" ON "public"."observation_images" USING "btree" ("observation_id");



CREATE INDEX "observation_images_user_id_idx" ON "public"."observation_images" USING "btree" ("user_id");



CREATE INDEX "observations_date_idx" ON "public"."observations" USING "btree" ("date" DESC);



CREATE INDEX "observations_genus_species_idx" ON "public"."observations" USING "btree" ("genus", "species");



CREATE INDEX "observations_user_id_idx" ON "public"."observations" USING "btree" ("user_id");



CREATE INDEX "spore_measurements_image_id_idx" ON "public"."spore_measurements" USING "btree" ("image_id");



CREATE INDEX "spore_measurements_user_id_idx" ON "public"."spore_measurements" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "enforce_non_public_observation_limit_trigger" BEFORE INSERT OR UPDATE OF "user_id", "visibility", "location_precision" ON "public"."observations" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_non_public_observation_limit"();



CREATE OR REPLACE TRIGGER "trg_friendships_updated_at" BEFORE UPDATE ON "public"."friendships" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_observations_updated_at" BEFORE UPDATE ON "public"."observations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."calibrations"
    ADD CONSTRAINT "calibrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



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



CREATE POLICY "Users can delete their own blocks" ON "public"."user_blocks" FOR DELETE USING (("auth"."uid"() = "blocker_id"));



CREATE POLICY "Users can delete their own measurements" ON "public"."spore_measurements" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert their own blocks" ON "public"."user_blocks" FOR INSERT WITH CHECK (("auth"."uid"() = "blocker_id"));



CREATE POLICY "Users can insert their own measurements" ON "public"."spore_measurements" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update their own measurements" ON "public"."spore_measurements" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view their own blocks" ON "public"."user_blocks" FOR SELECT USING ((("auth"."uid"() = "blocker_id") OR ("auth"."uid"() = "blocked_id")));



CREATE POLICY "Users can view their own measurements" ON "public"."spore_measurements" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."calibrations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "calibrations: owner full" ON "public"."calibrations" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "comments_delete" ON "public"."comments" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "comments_insert" ON "public"."comments" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "comments_select" ON "public"."comments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "comments"."observation_id") AND (("o"."user_id" = "auth"."uid"()) OR ("o"."visibility" = 'public'::"text") OR (("o"."visibility" = 'friends'::"text") AND (EXISTS ( SELECT 1
           FROM "public"."friendships" "f"
          WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester_id" = "auth"."uid"()) AND ("f"."addressee_id" = "o"."user_id")) OR (("f"."addressee_id" = "auth"."uid"()) AND ("f"."requester_id" = "o"."user_id"))))))))))));



ALTER TABLE "public"."follows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."friendships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "friendships: parties can delete" ON "public"."friendships" FOR DELETE USING ((("auth"."uid"() = "requester_id") OR ("auth"."uid"() = "addressee_id")));



CREATE POLICY "friendships: parties can read" ON "public"."friendships" FOR SELECT USING ((("auth"."uid"() = "requester_id") OR ("auth"."uid"() = "addressee_id")));



CREATE POLICY "friendships: parties can update" ON "public"."friendships" FOR UPDATE USING ((("auth"."uid"() = "requester_id") OR ("auth"."uid"() = "addressee_id")));



CREATE POLICY "friendships: requester can insert" ON "public"."friendships" FOR INSERT WITH CHECK (("auth"."uid"() = "requester_id"));



ALTER TABLE "public"."observation_images" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "observation_images friend read" ON "public"."observation_images" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."friendships" "f"
  WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester_id" = "auth"."uid"()) AND ("f"."addressee_id" = "observation_images"."user_id")) OR (("f"."addressee_id" = "auth"."uid"()) AND ("f"."requester_id" = "observation_images"."user_id")))))) OR (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND ("o"."visibility" = 'public'::"text"))))));



CREATE POLICY "observation_images: friends read" ON "public"."observation_images" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."observations" "o"
     JOIN "public"."friendships" "f" ON ((("f"."status" = 'accepted'::"text") AND ((("f"."requester_id" = "auth"."uid"()) AND ("f"."addressee_id" = "o"."user_id")) OR (("f"."addressee_id" = "auth"."uid"()) AND ("f"."requester_id" = "o"."user_id"))))))
  WHERE ("o"."id" = "observation_images"."observation_id"))));



CREATE POLICY "observation_images: owner full" ON "public"."observation_images" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."observation_shares" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "observation_shares: owner full" ON "public"."observation_shares" USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "observation_shares: recipient read" ON "public"."observation_shares" FOR SELECT USING (("auth"."uid"() = "shared_with_id"));



ALTER TABLE "public"."observations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "observations: friends read public" ON "public"."observations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."friendships" "f"
  WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester_id" = "auth"."uid"()) AND ("f"."addressee_id" = "observations"."user_id")) OR (("f"."addressee_id" = "auth"."uid"()) AND ("f"."requester_id" = "observations"."user_id")))))));



CREATE POLICY "observations: owner full" ON "public"."observations" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_comments_delete_own" ON "public"."comments" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_comments_insert_visible" ON "public"."comments" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "comments"."observation_id") AND "public"."can_read_observation"("o"."user_id", "o"."visibility"))))));



CREATE POLICY "phase7_comments_read" ON "public"."comments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "comments"."observation_id") AND "public"."can_read_observation"("o"."user_id", "o"."visibility")))));



CREATE POLICY "phase7_comments_update_own" ON "public"."comments" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_follows_delete_own" ON "public"."follows" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_follows_insert_own" ON "public"."follows" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_follows_read_own" ON "public"."follows" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_observation_images_delete_own" ON "public"."observation_images" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_observation_images_insert_own" ON "public"."observation_images" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND ("storage_path" ~~ (("auth"."uid"())::"text" || '/%'::"text")) AND (EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND ("o"."user_id" = "auth"."uid"()))))));



CREATE POLICY "phase7_observation_images_read" ON "public"."observation_images" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."observations" "o"
  WHERE (("o"."id" = "observation_images"."observation_id") AND "public"."can_read_observation"("o"."user_id", "o"."visibility")))));



CREATE POLICY "phase7_observation_images_update_own" ON "public"."observation_images" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK ((("auth"."uid"() = "user_id") AND (("storage_path" IS NULL) OR ("storage_path" ~~ (("auth"."uid"())::"text" || '/%'::"text")))));



CREATE POLICY "phase7_observations_delete_own" ON "public"."observations" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_observations_insert_own" ON "public"."observations" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "phase7_observations_read" ON "public"."observations" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") OR ((COALESCE("visibility", 'draft'::"text") = ANY (ARRAY['friends'::"text", 'public'::"text"])) AND "public"."are_friends"("auth"."uid"(), "user_id") AND (NOT "public"."is_blocked_between"("auth"."uid"(), "user_id")))));



CREATE POLICY "phase7_observations_update_own" ON "public"."observations" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles public read" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "profiles: friends can read" ON "public"."profiles" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."friendships" "f"
  WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester_id" = "auth"."uid"()) AND ("f"."addressee_id" = "profiles"."id")) OR (("f"."addressee_id" = "auth"."uid"()) AND ("f"."requester_id" = "profiles"."id")))))));



CREATE POLICY "profiles: owner read-write" ON "public"."profiles" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



ALTER TABLE "public"."reference_values" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reference_values: authenticated read" ON "public"."reference_values" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spore_annotations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spore_annotations: owner full" ON "public"."spore_annotations" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."spore_measurements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spore_measurements: friends read" ON "public"."spore_measurements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (("public"."observation_images" "oi"
     JOIN "public"."observations" "o" ON (("o"."id" = "oi"."observation_id")))
     JOIN "public"."friendships" "f" ON ((("f"."status" = 'accepted'::"text") AND ((("f"."requester_id" = "auth"."uid"()) AND ("f"."addressee_id" = "o"."user_id")) OR (("f"."addressee_id" = "auth"."uid"()) AND ("f"."requester_id" = "o"."user_id"))))))
  WHERE ("oi"."id" = "spore_measurements"."image_id"))));



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



GRANT ALL ON FUNCTION "public"."apply_profile_storage_delta"("p_user_id" "uuid", "p_storage_delta" bigint, "p_image_delta" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."apply_profile_storage_delta"("p_user_id" "uuid", "p_storage_delta" bigint, "p_image_delta" integer) TO "authenticated";
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



GRANT ALL ON FUNCTION "public"."search_community_spore_datasets"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_community_spore_datasets"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_community_spore_datasets"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_people_directory"("p_query" "text", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_people_directory"("p_query" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_people_directory"("p_query" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_people_directory"("p_query" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_reference_values"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_reference_values"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_reference_values"("p_genus" "text", "p_species" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_taxa"("q" "text", "lang" "text", "lim" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_taxa"("q" "text", "lang" "text", "lim" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_taxa"("q" "text", "lang" "text", "lim" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON TABLE "public"."calibrations" TO "anon";
GRANT ALL ON TABLE "public"."calibrations" TO "authenticated";
GRANT ALL ON TABLE "public"."calibrations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."calibrations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."calibrations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."calibrations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."comments" TO "anon";
GRANT ALL ON TABLE "public"."comments" TO "authenticated";
GRANT ALL ON TABLE "public"."comments" TO "service_role";



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



GRANT ALL ON TABLE "public"."observation_images" TO "anon";
GRANT ALL ON TABLE "public"."observation_images" TO "authenticated";
GRANT ALL ON TABLE "public"."observation_images" TO "service_role";



GRANT ALL ON SEQUENCE "public"."observation_images_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."observation_images_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."observation_images_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."observation_shares" TO "anon";
GRANT ALL ON TABLE "public"."observation_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."observation_shares" TO "service_role";



GRANT ALL ON SEQUENCE "public"."observation_shares_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."observation_shares_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."observation_shares_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."observations" TO "anon";
GRANT ALL ON TABLE "public"."observations" TO "authenticated";
GRANT ALL ON TABLE "public"."observations" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



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






