-- Dormant Stage 6e private curator-workspace reads.
--
-- These SECURITY DEFINER RPCs are callable only by the service-role Edge
-- boundary. They revalidate the caller's current database-backed session,
-- account state, and curator membership and return only allowlisted fields.

BEGIN;

CREATE INDEX reference_curation_submissions_queue_all_idx
  ON private.reference_curation_submissions(created_at DESC, id);
CREATE INDEX reference_curation_submissions_queue_status_idx
  ON private.reference_curation_submissions(status, created_at DESC, id);

CREATE FUNCTION private.reference_curation_workspace_capabilities(
  p_actor_user_id uuid,
  p_actor_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_admin boolean;
  v_role text;
BEGIN
  IF p_actor_user_id IS NULL OR p_actor_session_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor_user_id::text, 7301)
  );
  IF EXISTS (
    SELECT 1 FROM private.reference_account_deletions d
    WHERE d.user_id = p_actor_user_id
  ) THEN
    RETURN NULL;
  END IF;
  SELECT p.is_admin
    INTO v_is_admin
    FROM public.profiles p
   WHERE p.id = p_actor_user_id
     AND NOT p.is_banned
   FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1
    FROM auth.sessions s
   WHERE s.id = p_actor_session_id
     AND s.user_id = p_actor_user_id
     AND (s.not_after IS NULL OR s.not_after > pg_catalog.clock_timestamp())
   FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_is_admin THEN
    v_role := 'admin';
  ELSE
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('reference-curator-memberships', 7303)
    );
    SELECT m.role
      INTO v_role
      FROM private.reference_curator_memberships m
     WHERE m.user_id = p_actor_user_id
     FOR SHARE;
    IF NOT FOUND OR v_role NOT IN ('reference_reviewer', 'reference_publisher') THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'actor_user_id', p_actor_user_id,
    'role', v_role,
    'can_review', true,
    'can_publish', v_role IN ('reference_publisher', 'admin')
  );
END
$$;

CREATE FUNCTION private.reference_curation_submission_projection(
  p_submission private.reference_curation_submissions
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_submission.id,
    'status', p_submission.status,
    'row_version', p_submission.row_version,
    'current_candidate_revision', p_submission.current_candidate_revision,
    'current_content_hash', p_submission.current_content_hash,
    'claimed_by', p_submission.claimed_by,
    'claimed_at', p_submission.claimed_at,
    'feedback_text', p_submission.review_feedback,
    'created_at', p_submission.created_at,
    'updated_at', p_submission.updated_at,
    'accepted_curated_measurement_set_id', p_submission.accepted_curated_measurement_set_id
  )
$$;

CREATE FUNCTION private.reference_curation_accepted_graph(
  p_submission private.reference_curation_submissions
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_work private.curated_reference_works%ROWTYPE;
  v_treatment private.curated_reference_taxon_treatments%ROWTYPE;
  v_set private.curated_reference_measurement_sets%ROWTYPE;
  v_taxa jsonb;
BEGIN
  IF p_submission.status <> 'accepted'
     OR p_submission.accepted_curated_work_id IS NULL
     OR p_submission.accepted_curated_treatment_id IS NULL
     OR p_submission.accepted_curated_measurement_set_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO STRICT v_work
    FROM private.curated_reference_works w
   WHERE w.id = p_submission.accepted_curated_work_id;
  SELECT * INTO STRICT v_treatment
    FROM private.curated_reference_taxon_treatments t
   WHERE t.id = p_submission.accepted_curated_treatment_id
     AND t.reference_work_id = v_work.id;
  SELECT * INTO STRICT v_set
    FROM private.curated_reference_measurement_sets m
   WHERE m.id = p_submission.accepted_curated_measurement_set_id
     AND m.taxon_treatment_id = v_treatment.id;

  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', a.id,
        'taxon_treatment_id', a.taxon_treatment_id,
        'sporely_taxon_id', a.sporely_taxon_id,
        'canonical_name', c.canonical_name,
        'assignment_reason', a.assignment_reason,
        'revision', a.revision,
        'row_version', a.row_version
      ) ORDER BY a.id
    ),
    '[]'::jsonb
  ) INTO v_taxa
    FROM private.curated_reference_treatment_taxa a
    JOIN taxonomy_v3.registry_concept c
      ON c.sporely_taxon_id = a.sporely_taxon_id
   WHERE a.taxon_treatment_id = v_treatment.id;

  RETURN pg_catalog.jsonb_build_object(
    'work', pg_catalog.jsonb_build_object(
      'id', v_work.id, 'type', v_work.type, 'citation_key', v_work.citation_key,
      'authors', v_work.authors_json, 'editors', v_work.editors_json,
      'title', v_work.title, 'container_title', v_work.container_title,
      'year', v_work.year, 'edition', v_work.edition, 'publisher', v_work.publisher,
      'place', v_work.place, 'volume', v_work.volume, 'issue', v_work.issue,
      'pages', v_work.pages, 'doi', v_work.doi, 'isbn', v_work.isbn,
      'url', v_work.url, 'language', v_work.language,
      'short_label', v_work.short_label, 'citation_override', v_work.citation_override,
      'revision', v_work.revision, 'row_version', v_work.row_version
    ),
    'treatment', pg_catalog.jsonb_build_object(
      'id', v_treatment.id, 'reference_work_id', v_treatment.reference_work_id,
      'name_as_published', v_treatment.name_as_published,
      'page_from', v_treatment.page_from, 'page_to', v_treatment.page_to,
      'locator_text', v_treatment.locator_text,
      'treatment_notes', v_treatment.treatment_notes,
      'revision', v_treatment.revision, 'row_version', v_treatment.row_version
    ),
    'measurement_set', pg_catalog.jsonb_build_object(
      'id', v_set.id, 'taxon_treatment_id', v_set.taxon_treatment_id,
      'character', v_set.character, 'raw_text', v_set.raw_text,
      'data_kind', v_set.data_kind, 'length_min', v_set.length_min,
      'length_core_min', v_set.length_core_min, 'length_core_max', v_set.length_core_max,
      'length_max', v_set.length_max, 'width_min', v_set.width_min,
      'width_core_min', v_set.width_core_min, 'width_core_max', v_set.width_core_max,
      'width_max', v_set.width_max, 'q_min', v_set.q_min, 'q_max', v_set.q_max,
      'q_mean', v_set.q_mean, 'length_mean', v_set.length_mean,
      'width_mean', v_set.width_mean, 'sample_size', v_set.sample_size,
      'specimen_count', v_set.specimen_count, 'mount_medium', v_set.mount_medium,
      'stain', v_set.stain, 'preparation', v_set.preparation,
      'measurement_method', v_set.measurement_method, 'notes', v_set.notes,
      'raw_points', v_set.raw_points_json, 'supersedes_id', v_set.supersedes_id,
      'catalogue_status', v_set.catalogue_status,
      'latest_bundle_revision', v_set.latest_bundle_revision,
      'revision', v_set.revision, 'row_version', v_set.row_version
    ),
    'taxon_assignments', v_taxa
  );
END
$$;

CREATE FUNCTION public.get_reference_curation_capabilities(
  p_actor_user_id uuid,
  p_actor_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capabilities jsonb;
BEGIN
  v_capabilities := private.reference_curation_workspace_capabilities(
    p_actor_user_id, p_actor_session_id
  );
  IF v_capabilities IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'ok', 'capabilities', v_capabilities);
END
$$;

CREATE FUNCTION public.list_reference_curation_queue(
  p_actor_user_id uuid,
  p_actor_session_id uuid,
  p_status text,
  p_limit integer,
  p_after_created_at timestamptz,
  p_after_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capabilities jsonb;
  v_rows jsonb;
  v_items jsonb;
  v_next_cursor jsonb := NULL;
BEGIN
  v_capabilities := private.reference_curation_workspace_capabilities(
    p_actor_user_id, p_actor_session_id
  );
  IF v_capabilities IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50
     OR (p_status IS NOT NULL AND p_status NOT IN (
       'submitted', 'in_review', 'changes_requested', 'rejected', 'accepted', 'withdrawn'
     ))
     OR ((p_after_created_at IS NULL) <> (p_after_id IS NULL)) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(q.item ORDER BY q.created_at DESC, q.id), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT s.id, s.created_at, private.reference_curation_submission_projection(s) AS item
        FROM private.reference_curation_submissions s
       WHERE (p_status IS NULL OR s.status = p_status)
         AND (
           p_after_created_at IS NULL OR s.created_at < p_after_created_at
           OR (s.created_at = p_after_created_at AND s.id > p_after_id)
         )
       ORDER BY s.created_at DESC, s.id
       LIMIT p_limit + 1
    ) q;

  v_items := (
    SELECT coalesce(pg_catalog.jsonb_agg(e.value ORDER BY e.ordinality), '[]'::jsonb)
      FROM pg_catalog.jsonb_array_elements(v_rows) WITH ORDINALITY e(value, ordinality)
     WHERE e.ordinality <= p_limit
  );
  IF pg_catalog.jsonb_array_length(v_rows) > p_limit THEN
    SELECT pg_catalog.jsonb_build_object('created_at', s.created_at, 'id', s.id)
      INTO v_next_cursor
      FROM private.reference_curation_submissions s
     WHERE s.id = (v_items->(p_limit - 1)->>'id')::uuid;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok', 'capabilities', v_capabilities,
    'items', v_items, 'next_cursor', v_next_cursor
  );
END
$$;

CREATE FUNCTION public.get_reference_curation_detail(
  p_actor_user_id uuid,
  p_actor_session_id uuid,
  p_submission_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capabilities jsonb;
  v_submission private.reference_curation_submissions%ROWTYPE;
  v_candidate jsonb;
BEGIN
  v_capabilities := private.reference_curation_workspace_capabilities(
    p_actor_user_id, p_actor_session_id
  );
  IF v_capabilities IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;
  SELECT * INTO v_submission
    FROM private.reference_curation_submissions s
   WHERE s.id = p_submission_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT v.candidate_json INTO v_candidate
    FROM private.reference_curation_submission_versions v
   WHERE v.submission_id = v_submission.id
     AND v.candidate_revision = v_submission.current_candidate_revision;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'capabilities', v_capabilities,
    'detail', pg_catalog.jsonb_build_object(
      'submission', private.reference_curation_submission_projection(v_submission),
      'candidate', v_candidate,
      'accepted_graph', private.reference_curation_accepted_graph(v_submission)
    )
  );
END
$$;

REVOKE ALL ON FUNCTION private.reference_curation_workspace_capabilities(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_curation_submission_projection(private.reference_curation_submissions)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_curation_accepted_graph(private.reference_curation_submissions)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_reference_curation_capabilities(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_reference_curation_queue(uuid, uuid, text, integer, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_reference_curation_detail(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_reference_curation_capabilities(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_reference_curation_queue(uuid, uuid, text, integer, timestamptz, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_reference_curation_detail(uuid, uuid, uuid)
  TO service_role;

COMMIT;
