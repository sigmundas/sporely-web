CREATE OR REPLACE FUNCTION public.enforce_non_public_observation_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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

DROP TRIGGER IF EXISTS enforce_non_public_observation_limit_trigger ON public.observations;

CREATE TRIGGER enforce_non_public_observation_limit_trigger
BEFORE INSERT OR UPDATE OF user_id, visibility, location_precision, is_draft ON public.observations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_non_public_observation_limit();

CREATE OR REPLACE FUNCTION public.non_public_observation_count(profile_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT count(*)::integer
  FROM public.observations o
  WHERE o.user_id = profile_id
    AND NOT coalesce(o.is_draft, false)
    AND (
      coalesce(o.visibility, 'public') <> 'public'
      OR coalesce(o.location_precision, 'exact') = 'fuzzed'
    )
$$;

CREATE OR REPLACE VIEW public.observations_follow_view AS
 SELECT DISTINCT o.id,
    o.user_id,
    o.desktop_id,
    o.date,
    o.captured_at,
    o.created_at,
    o.genus,
    o.species,
    o.common_name,
    o.author,
    o.location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
            ELSE o.gps_longitude
        END AS gps_longitude,
    o.source_type,
    o.spore_data_visibility,
    o.image_key,
    o.thumb_key,
    o.is_draft,
    o.location_precision
   FROM public.observations o
     JOIN public.follows f ON (
       f.user_id = auth.uid()
       AND (
         (f.target_type = 'user'::text AND f.target_id = (o.user_id)::text)
         OR (f.target_type = 'observation'::text AND f.target_id = (o.id)::text)
         OR (f.target_type = 'genus'::text AND lower(f.target_id) = lower(coalesce(o.genus, ''::text)))
         OR (f.target_type = 'species'::text AND lower(f.target_id) = lower(trim(both from concat_ws(' '::text, o.genus, o.species))))
       )
     )
  WHERE public.can_read_observation(o.user_id, o.visibility)
    AND NOT coalesce(o.is_draft, false)
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.observations_friend_view AS
 SELECT o.id,
    o.user_id,
    o.desktop_id,
    o.date,
    o.captured_at,
    o.created_at,
    o.genus,
    o.species,
    o.common_name,
    o.author,
    o.location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
            ELSE o.gps_longitude
        END AS gps_longitude,
    o.source_type,
    o.spore_data_visibility,
    o.image_key,
    o.thumb_key,
    o.is_draft,
    o.location_precision
   FROM public.observations o
  WHERE (COALESCE(o.visibility, 'public'::text) = ANY (ARRAY['friends'::text, 'public'::text]))
    AND NOT coalesce(o.is_draft, false)
    AND public.are_friends(auth.uid(), o.user_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.observation_images_community_view AS
 SELECT oi.id,
    oi.observation_id,
    oi.user_id,
    oi.storage_path,
    oi.original_filename,
    oi.sort_order,
    oi.image_type,
    oi.micro_category,
    oi.objective_name,
    oi.scale_microns_per_pixel,
    oi.resample_scale_factor,
    oi.mount_medium,
    oi.stain,
    oi.sample_type,
    oi.contrast,
    oi.measure_color,
    oi.notes,
    oi.ai_crop_x1,
    oi.ai_crop_y1,
    oi.ai_crop_x2,
    oi.ai_crop_y2,
    oi.ai_crop_source_w,
    oi.ai_crop_source_h,
    oi.crop_mode,
    oi.scale_bar_x1,
    oi.scale_bar_y1,
    oi.scale_bar_x2,
    oi.scale_bar_y2,
    oi.gps_source,
    oi.desktop_id,
    oi.created_at,
    oi.upload_mode,
    oi.source_width,
    oi.source_height,
    oi.stored_width,
    oi.stored_height,
    oi.stored_bytes,
    oi.ai_crop_is_custom,
    oi.deleted_at,
    oi.calibration_uuid,
    oi.original_storage_path,
    o.user_id AS observation_user_id,
    o.visibility AS observation_visibility,
    o.is_draft AS observation_is_draft,
    o.spore_data_visibility AS observation_spore_data_visibility
   FROM public.observation_images oi
   JOIN public.observations o ON o.id = oi.observation_id
  WHERE (
      o.user_id = auth.uid()
      OR (
        NOT coalesce(o.is_draft, false)
        AND public.can_read_observation(o.user_id, o.visibility)
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.observation_identifications_community_view AS
 -- Preserve the existing view signature so replaying this migration does not
 -- trip over a column-order mismatch on a fresh reset.
 SELECT oi.*
   FROM public.observation_identifications oi
   JOIN public.observations o ON o.id = oi.observation_id
  WHERE (
      o.user_id = auth.uid()
      OR (
        NOT coalesce(o.is_draft, false)
        AND public.can_read_observation(o.user_id, o.visibility)
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.comments_community_view AS
SELECT
  c.id,
  c.observation_id,
  c.user_id,
  c.body,
  c.created_at,
  c.mentioned_user_ids
FROM public.comments c
JOIN public.observations o ON o.id = c.observation_id
WHERE (
    o.user_id = auth.uid()
    OR (
      NOT coalesce(o.is_draft, false)
      AND public.can_read_observation(o.user_id, o.visibility)
    )
  )
  AND NOT public.is_blocked_between(auth.uid(), c.user_id)
  AND NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = c.user_id
      AND p.is_banned = true
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.comment_moderation cm
    WHERE cm.comment_id = c.id
      AND cm.hidden_at IS NOT NULL
  );

CREATE OR REPLACE FUNCTION public.community_spore_taxon_summary(p_genus text, p_species text)
RETURNS TABLE(
  dataset_count bigint,
  measurement_count bigint,
  length_min double precision,
  length_p05 double precision,
  length_p50 double precision,
  length_p95 double precision,
  length_max double precision,
  length_avg double precision,
  width_min double precision,
  width_p05 double precision,
  width_p50 double precision,
  width_p95 double precision,
  width_max double precision,
  width_avg double precision,
  q_min double precision,
  q_p50 double precision,
  q_max double precision,
  q_avg double precision
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
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

CREATE OR REPLACE FUNCTION public.get_community_spore_dataset(p_observation_id bigint)
RETURNS TABLE(
  dataset_type text,
  observation_id bigint,
  genus text,
  species text,
  common_name text,
  contributor_label text,
  observed_on date,
  measurement_count bigint,
  image_count bigint,
  mount_media text[],
  stains text[],
  sample_types text[],
  contrasts text[],
  objectives text[],
  scale_min double precision,
  scale_max double precision,
  qc_flags jsonb,
  length_min double precision,
  length_p05 double precision,
  length_p50 double precision,
  length_p95 double precision,
  length_max double precision,
  length_avg double precision,
  width_min double precision,
  width_p05 double precision,
  width_p50 double precision,
  width_p95 double precision,
  width_max double precision,
  width_avg double precision,
  q_min double precision,
  q_p50 double precision,
  q_max double precision,
  q_avg double precision,
  measurements_json jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
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

CREATE OR REPLACE FUNCTION public.search_community_spore_datasets(
  p_genus text,
  p_species text,
  p_limit integer DEFAULT 50
)
RETURNS TABLE(
  dataset_type text,
  observation_id bigint,
  genus text,
  species text,
  contributor_label text,
  observed_on date,
  measurement_count bigint,
  image_count bigint,
  length_min double precision,
  length_p05 double precision,
  length_p50 double precision,
  length_p95 double precision,
  length_max double precision,
  width_min double precision,
  width_p05 double precision,
  width_p50 double precision,
  width_p95 double precision,
  width_max double precision,
  q_min double precision,
  q_p50 double precision,
  q_max double precision,
  qc_flags jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
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

ALTER POLICY "observations: friends read public" ON public.observations
  USING (
    NOT coalesce(is_draft, false)
    AND public.can_read_observation(user_id, visibility)
  );

ALTER POLICY "phase7_observations_read" ON public.observations
  USING (
    auth.uid() = user_id
    OR (
      NOT coalesce(is_draft, false)
      AND public.can_read_observation(user_id, visibility)
    )
  );

ALTER POLICY "comments_select" ON public.comments
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = comments.observation_id
        AND (
          o.user_id = auth.uid()
          OR (
            NOT coalesce(o.is_draft, false)
            AND (
              o.visibility = 'public'::text
              OR (
                o.visibility = 'friends'::text
                AND EXISTS (
                  SELECT 1
                  FROM public.friendships f
                  WHERE f.status = 'accepted'::text
                    AND (
                      (f.requester_id = auth.uid() AND f.addressee_id = o.user_id)
                      OR (f.addressee_id = auth.uid() AND f.requester_id = o.user_id)
                    )
                )
              )
            )
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.comment_moderation cm
      WHERE cm.comment_id = comments.id
        AND cm.hidden_at IS NOT NULL
    )
  );

ALTER POLICY "phase7_comments_insert_visible" ON public.comments
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = comments.observation_id
        AND (
          o.user_id = auth.uid()
          OR (
            NOT coalesce(o.is_draft, false)
            AND public.can_read_observation(o.user_id, o.visibility)
          )
        )
    )
  );

ALTER POLICY "phase7_comments_read" ON public.comments
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = comments.observation_id
        AND (
          o.user_id = auth.uid()
          OR (
            NOT coalesce(o.is_draft, false)
            AND public.can_read_observation(o.user_id, o.visibility)
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.comment_moderation cm
      WHERE cm.comment_id = comments.id
        AND cm.hidden_at IS NOT NULL
    )
  );

ALTER POLICY "observation_images friend read" ON public.observation_images
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND NOT coalesce(o.is_draft, false)
        AND public.can_read_observation(o.user_id, o.visibility)
    )
  );

ALTER POLICY "observation_images: friends read" ON public.observation_images
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND NOT coalesce(o.is_draft, false)
        AND public.can_read_observation(o.user_id, o.visibility)
    )
  );

ALTER POLICY "phase7_observation_images_read" ON public.observation_images
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND NOT coalesce(o.is_draft, false)
        AND public.can_read_observation(o.user_id, o.visibility)
    )
  );

ALTER POLICY "Users can read observation identifications for visible observations" ON public.observation_identifications
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_identifications.observation_id
        AND (
          o.user_id = auth.uid()
          OR (
            NOT coalesce(o.is_draft, false)
            AND public.can_read_observation(o.user_id, o.visibility)
          )
        )
    )
  );

ALTER POLICY "spore_measurements: friends read" ON public.spore_measurements
  USING (
    EXISTS (
      SELECT 1
      FROM public.observation_images oi
      JOIN public.observations o ON o.id = oi.observation_id
      WHERE oi.id = spore_measurements.image_id
        AND NOT coalesce(o.is_draft, false)
        AND public.can_read_observation(o.user_id, o.visibility)
        AND public.can_access_spore_data(o.user_id, o.spore_data_visibility)
    )
  );

NOTIFY pgrst, 'reload schema';
