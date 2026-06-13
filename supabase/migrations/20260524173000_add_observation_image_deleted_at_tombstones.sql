ALTER TABLE public.observation_images
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER POLICY "observation_images friend read" ON public.observation_images
  USING (
    (
      (
        (user_id = auth.uid())
        OR EXISTS (
          SELECT 1
          FROM public.friendships f
          WHERE f.status = 'accepted'::text
            AND (
              (f.requester_id = auth.uid() AND f.addressee_id = observation_images.user_id)
              OR (f.addressee_id = auth.uid() AND f.requester_id = observation_images.user_id)
            )
        )
        OR EXISTS (
          SELECT 1
          FROM public.observations o
          WHERE o.id = observation_images.observation_id
            AND o.visibility = 'public'::text
        )
      )
      AND observation_images.deleted_at IS NULL
    )
  );

ALTER POLICY "observation_images: friends read" ON public.observation_images
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      JOIN public.friendships f
        ON f.status = 'accepted'::text
       AND (
         (f.requester_id = auth.uid() AND f.addressee_id = o.user_id)
         OR (f.addressee_id = auth.uid() AND f.requester_id = o.user_id)
       )
      WHERE o.id = observation_images.observation_id
    )
    AND observation_images.deleted_at IS NULL
  );

ALTER POLICY "observation_images: owner full" ON public.observation_images
  USING (
    auth.uid() = user_id
    AND observation_images.deleted_at IS NULL
  );

CREATE POLICY "observation_images: owner select including deleted" ON public.observation_images
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
  );

ALTER POLICY "phase7_observation_images_delete_own" ON public.observation_images
  USING (
    auth.uid() = user_id
    AND observation_images.deleted_at IS NULL
  );

ALTER POLICY "phase7_observation_images_read" ON public.observation_images
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND public.can_read_observation(o.user_id, o.visibility)
    )
    AND observation_images.deleted_at IS NULL
  );

ALTER POLICY "phase7_observation_images_update_own" ON public.observation_images
  USING (
    auth.uid() = user_id
    AND observation_images.deleted_at IS NULL
  );

ALTER POLICY "spore_measurements: friends read" ON public.spore_measurements
  USING (
    EXISTS (
      SELECT 1
      FROM public.observation_images oi
      JOIN public.observations o
        ON o.id = oi.observation_id
      JOIN public.friendships f
        ON f.status = 'accepted'::text
       AND (
         (f.requester_id = auth.uid() AND f.addressee_id = o.user_id)
         OR (f.addressee_id = auth.uid() AND f.requester_id = o.user_id)
       )
      WHERE oi.id = spore_measurements.image_id
        AND oi.deleted_at IS NULL
    )
  );

ALTER POLICY "Users can view their own measurements" ON public.spore_measurements
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.observation_images oi
      WHERE oi.id = spore_measurements.image_id
        AND oi.deleted_at IS NULL
    )
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
     AND i.deleted_at IS NULL
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

CREATE OR REPLACE FUNCTION public.get_person_stats(p_user_id uuid)
RETURNS TABLE(
  user_id uuid,
  public_find_count bigint,
  public_species_count bigint,
  public_spore_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
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
     AND i.deleted_at IS NULL
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

CREATE OR REPLACE FUNCTION public.search_people_directory(
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0,
  p_query text DEFAULT NULL::text
)
RETURNS TABLE(
  user_id uuid,
  username text,
  display_name text,
  bio text,
  avatar_url text,
  public_find_count bigint,
  public_species_count bigint,
  public_spore_count bigint,
  latest_public_observation_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
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
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized);
$$;
