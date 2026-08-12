-- Replace the broad identification projection with an explicit public schema.
-- Candidate JSON is rebuilt field-by-field so legacy provider/debug payloads
-- cannot pass through the public view inside `results`.

BEGIN;

DROP VIEW public.observation_identifications_community_view;

CREATE VIEW public.observation_identifications_community_view
  WITH (security_barrier = true) AS
SELECT
  oi.id,
  oi.observation_id,
  oi.service,
  oi.status,
  safe_results.results,
  oi.top_scientific_name,
  oi.top_vernacular_name,
  oi.top_taxon_id,
  oi.top_probability,
  oi.top_species_url,
  oi.top_redlist_category,
  oi.top_redlist_status,
  oi.top_redlist_source,
  oi.created_at,
  oi.updated_at
FROM public.observation_identifications oi
JOIN public.observations o ON o.id = oi.observation_id
CROSS JOIN LATERAL (
  SELECT coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'rank', coalesce(candidate.value->'rank', to_jsonb(candidate.ordinality::integer)),
        'service', coalesce(candidate.value->'service', to_jsonb(oi.service)),
        'taxon_id', coalesce(candidate.value->'taxon_id', candidate.value->'taxonId'),
        'scientific_name', coalesce(candidate.value->'scientific_name', candidate.value->'scientificName'),
        'vernacular_name', coalesce(candidate.value->'vernacular_name', candidate.value->'vernacularName'),
        'probability', coalesce(candidate.value->'probability', candidate.value->'score'),
        'species_url', coalesce(candidate.value->'species_url', candidate.value->'speciesUrl'),
        'redlist_category', coalesce(candidate.value->'redlist_category', candidate.value->'redlistCategory'),
        'redlist_status', coalesce(candidate.value->'redlist_status', candidate.value->'redlistStatus'),
        'redlist_source', coalesce(candidate.value->'redlist_source', candidate.value->'redlistSource'),
        'picture_url', coalesce(
          candidate.value->'picture_url',
          candidate.value->'pictureUrl',
          candidate.value->'photo_url',
          candidate.value->'photoUrl',
          candidate.value->'image_url',
          candidate.value->'imageUrl',
          candidate.value->'thumbnail_url',
          candidate.value->'thumbnailUrl'
        ),
        'external_ids', nullif(
          jsonb_strip_nulls(jsonb_build_object(
            'gbif', candidate.value->'external_ids'->'gbif',
            'inat', candidate.value->'external_ids'->'inat',
            'nbic', candidate.value->'external_ids'->'nbic'
          )),
          '{}'::jsonb
        )
      ))
      ORDER BY candidate.ordinality
    ),
    '[]'::jsonb
  ) AS results
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(oi.results) = 'array' THEN oi.results
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS candidate(value, ordinality)
) safe_results
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
  AND NOT public.current_user_is_blocked_with(o.user_id);

ALTER VIEW public.observation_identifications_community_view OWNER TO postgres;

REVOKE ALL ON TABLE public.observation_identifications_community_view
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.observation_identifications_community_view
  TO anon, authenticated;
GRANT ALL ON TABLE public.observation_identifications_community_view
  TO service_role;

COMMENT ON VIEW public.observation_identifications_community_view IS
  'Public AI-identification display projection. Excludes user/source fields, fingerprints, request/language/model metadata, raw provider/debug payloads, and error details.';

NOTIFY pgrst, 'reload schema';

COMMIT;
