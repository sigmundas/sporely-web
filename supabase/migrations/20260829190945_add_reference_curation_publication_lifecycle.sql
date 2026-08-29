-- Dormant Stage 6d publisher materialization and catalogue lifecycle.
-- The sole caller is the authenticated reference-curation Edge boundary.
-- No catalogue read or public client grant is introduced here.

BEGIN;

ALTER TABLE private.reference_curation_moderation_requests
  DROP CONSTRAINT reference_curation_moderation_requests_action_check;
ALTER TABLE private.reference_curation_moderation_requests
  ADD CONSTRAINT reference_curation_moderation_requests_action_check CHECK (action IN (
    'claim', 'request_changes', 'reject', 'accept_to_draft', 'edit_draft',
    'publish', 'deprecate', 'supersede', 'withdraw'
  ));
ALTER TABLE private.reference_curation_moderation_collisions
  DROP CONSTRAINT reference_curation_moderation_collisions_action_check;
ALTER TABLE private.reference_curation_moderation_collisions
  ADD CONSTRAINT reference_curation_moderation_collisions_action_check CHECK (action IN (
    'claim', 'request_changes', 'reject', 'accept_to_draft', 'edit_draft',
    'publish', 'deprecate', 'supersede', 'withdraw'
  ));

CREATE FUNCTION private.reference_curation_publisher_authorized(
  p_actor_user_id uuid,
  p_actor_session_id uuid
)
RETURNS boolean
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
    RETURN false;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor_user_id::text, 7301)
  );
  IF EXISTS (
    SELECT 1 FROM private.reference_account_deletions d
     WHERE d.user_id = p_actor_user_id
  ) THEN
    RETURN false;
  END IF;
  SELECT p.is_admin INTO v_is_admin
    FROM public.profiles p
   WHERE p.id = p_actor_user_id AND NOT p.is_banned
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM 1
    FROM auth.sessions s
   WHERE s.id = p_actor_session_id
     AND s.user_id = p_actor_user_id
     AND (s.not_after IS NULL OR s.not_after > pg_catalog.clock_timestamp())
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_is_admin THEN
    RETURN true;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reference-curator-memberships', 7303)
  );
  SELECT m.role INTO v_role
    FROM private.reference_curator_memberships m
   WHERE m.user_id = p_actor_user_id
   FOR SHARE;
  RETURN FOUND AND v_role = 'reference_publisher';
END
$$;

CREATE FUNCTION private.reference_curated_full_citation(
  p_work private.curated_reference_works
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_author text;
  v_parts text[] := ARRAY[]::text[];
  v_container text[] := ARRAY[]::text[];
BEGIN
  v_author := private.reference_agent_list(p_work.authors_json, true);
  IF v_author = '' THEN
    v_author := private.reference_agent_list(p_work.editors_json, true);
    IF v_author <> '' THEN v_author := v_author || ' (ed.)'; END IF;
  END IF;
  IF nullif(pg_catalog.btrim(v_author), '') IS NOT NULL THEN v_parts := v_parts || v_author; END IF;
  IF p_work.year IS NOT NULL THEN v_parts := v_parts || ('(' || p_work.year::text || ')'); END IF;
  v_parts := v_parts || (pg_catalog.btrim(p_work.title) || '.');
  IF nullif(pg_catalog.btrim(p_work.container_title), '') IS NOT NULL THEN
    v_container := v_container || pg_catalog.btrim(p_work.container_title);
  END IF;
  IF nullif(pg_catalog.btrim(p_work.volume), '') IS NOT NULL THEN
    v_container := v_container || (
      pg_catalog.btrim(p_work.volume) || CASE
        WHEN nullif(pg_catalog.btrim(p_work.issue), '') IS NOT NULL
          THEN '(' || pg_catalog.btrim(p_work.issue) || ')'
        ELSE '' END
    );
  END IF;
  IF nullif(pg_catalog.btrim(p_work.pages), '') IS NOT NULL THEN
    v_container := v_container || pg_catalog.btrim(p_work.pages);
  END IF;
  IF pg_catalog.array_length(v_container, 1) IS NOT NULL THEN
    v_parts := v_parts || (pg_catalog.array_to_string(v_container, ', ') || '.');
  END IF;
  IF nullif(pg_catalog.btrim(p_work.edition), '') IS NOT NULL THEN
    v_parts := v_parts || (pg_catalog.btrim(p_work.edition) || '.');
  END IF;
  IF nullif(pg_catalog.btrim(p_work.publisher), '') IS NOT NULL
     OR nullif(pg_catalog.btrim(p_work.place), '') IS NOT NULL THEN
    v_parts := v_parts || (
      pg_catalog.concat_ws(', ', nullif(pg_catalog.btrim(p_work.publisher), ''),
        nullif(pg_catalog.btrim(p_work.place), '')) || '.'
    );
  END IF;
  IF nullif(pg_catalog.btrim(p_work.doi), '') IS NOT NULL THEN
    v_parts := v_parts || ('https://doi.org/' || pg_catalog.btrim(p_work.doi));
  ELSIF nullif(pg_catalog.btrim(p_work.url), '') IS NOT NULL THEN
    v_parts := v_parts || pg_catalog.btrim(p_work.url);
  END IF;
  RETURN coalesce(
    nullif(pg_catalog.btrim(p_work.citation_override), ''),
    pg_catalog.array_to_string(v_parts, ' ')
  );
END
$$;

CREATE FUNCTION private.reference_curated_snapshot(
  p_set_id uuid,
  p_bundle_revision integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'reference_work_id', w.id,
    'reference_treatment_id', t.id,
    'reference_measurement_set_id', m.id,
    'reference_revision', p_bundle_revision,
    'short_label', w.short_label,
    'full_citation', private.reference_curated_full_citation(w),
    'work_type', w.type,
    'year', w.year,
    'doi', w.doi,
    'isbn', w.isbn,
    'taxon_id', NULL,
    'name_as_published', t.name_as_published,
    'locator_text', t.locator_text,
    'page_from', t.page_from,
    'page_to', t.page_to,
    'character', m.character,
    'data_kind', m.data_kind,
    'raw_text', m.raw_text,
    'measurements', pg_catalog.jsonb_build_object(
      'length_min', m.length_min, 'length_core_min', m.length_core_min,
      'length_core_max', m.length_core_max, 'length_max', m.length_max,
      'width_min', m.width_min, 'width_core_min', m.width_core_min,
      'width_core_max', m.width_core_max, 'width_max', m.width_max,
      'q_min', m.q_min, 'q_max', m.q_max, 'q_mean', m.q_mean,
      'length_mean', m.length_mean, 'width_mean', m.width_mean,
      'sample_size', m.sample_size, 'specimen_count', m.specimen_count
    ),
    'method', pg_catalog.jsonb_build_object(
      'mount_medium', m.mount_medium, 'stain', m.stain,
      'preparation', m.preparation, 'measurement_method', m.measurement_method
    ),
    'raw_points', m.raw_points_json
  )
  FROM private.curated_reference_measurement_sets m
  JOIN private.curated_reference_taxon_treatments t ON t.id = m.taxon_treatment_id
  JOIN private.curated_reference_works w ON w.id = t.reference_work_id
  WHERE m.id = p_set_id
$$;

CREATE FUNCTION private.reference_curated_citation(p_work_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'citation_key', w.citation_key,
    'type', w.type,
    'authors', w.authors_json,
    'editors', w.editors_json,
    'title', w.title,
    'container_title', w.container_title,
    'year', w.year,
    'edition', w.edition,
    'publisher', w.publisher,
    'place', w.place,
    'volume', w.volume,
    'issue', w.issue,
    'pages', w.pages,
    'doi', w.doi,
    'isbn', w.isbn,
    'url', w.url,
    'language', w.language,
    'short_citation', w.short_label,
    'full_citation', private.reference_curated_full_citation(w)
  )
  FROM private.curated_reference_works w
  WHERE w.id = p_work_id
$$;

CREATE FUNCTION private.reference_curated_content_hash(
  p_set_id uuid,
  p_bundle_revision integer
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.encode(extensions.digest(
    pg_catalog.jsonb_build_object(
      'work_id', w.id, 'work_revision', w.revision,
      'treatment_id', t.id, 'treatment_revision', t.revision,
      'measurement_set_id', m.id, 'measurement_set_revision', m.revision,
      'snapshot', private.reference_curated_snapshot(m.id, p_bundle_revision),
      'citation', private.reference_curated_citation(w.id),
      'taxon_assignments', (
        SELECT coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('id', tt.id, 'row_version', tt.row_version)
          ORDER BY tt.id
        ), '[]'::jsonb)
        FROM private.curated_reference_treatment_taxa tt
        WHERE tt.taxon_treatment_id = t.id
      )
    )::text, 'sha256'
  ), 'hex')
  FROM private.curated_reference_measurement_sets m
  JOIN private.curated_reference_taxon_treatments t ON t.id = m.taxon_treatment_id
  JOIN private.curated_reference_works w ON w.id = t.reference_work_id
  WHERE m.id = p_set_id
$$;

CREATE FUNCTION private.reference_curated_assignment_statement_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('private.curated_reference_supersession', 0)
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER curated_reference_treatment_taxa_stage6d_lock_trg
  BEFORE INSERT OR UPDATE OR DELETE ON private.curated_reference_treatment_taxa
  FOR EACH STATEMENT EXECUTE FUNCTION private.reference_curated_assignment_statement_lock();

CREATE FUNCTION private.reference_curation_lifecycle_finish(
  p_request_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_target_id uuid,
  p_request_hash text,
  p_reason text,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_result->>'status' NOT IN ('updated', 'no_change', 'not_found') THEN
    INSERT INTO private.reference_curation_events(
      actor_user_id, action, target_type, target_id, outcome, reason, metadata_json
    ) VALUES (
      p_actor_user_id, p_action, 'curated_measurement_set', p_target_id,
      CASE WHEN p_result->>'status' IN (
        'conflict', 'stale_graph', 'invalid_successor', 'idempotency_conflict'
      ) THEN 'conflict' ELSE 'failed' END,
      p_reason,
      pg_catalog.jsonb_build_object('status', p_result->>'status')
    );
  END IF;
  INSERT INTO private.reference_curation_moderation_requests(
    request_id, actor_user_id, action, target_id, request_hash, result_json
  ) VALUES (
    p_request_id, p_actor_user_id, p_action, p_target_id, p_request_hash, p_result
  );
  RETURN p_result;
END
$$;

CREATE FUNCTION public.mutate_reference_curation_lifecycle(
  p_actor_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_action text,
  p_target_id uuid,
  p_expected_row_version bigint,
  p_reason text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_existing private.reference_curation_moderation_requests%ROWTYPE;
  v_set private.curated_reference_measurement_sets%ROWTYPE;
  v_treatment private.curated_reference_taxon_treatments%ROWTYPE;
  v_work private.curated_reference_works%ROWTYPE;
  v_predecessor private.curated_reference_measurement_sets%ROWTYPE;
  v_predecessor_id uuid;
  v_expected_taxa jsonb;
  v_current_taxa jsonb;
  v_bundle_revision integer;
  v_snapshot jsonb;
  v_citation jsonb;
  v_content_hash text;
  v_before_hash text;
  v_predecessor_hash text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
  v_collision_rows bigint;
BEGIN
  IF p_actor_user_id IS NULL OR p_actor_session_id IS NULL OR p_request_id IS NULL
     OR p_target_id IS NULL OR p_expected_row_version IS NULL OR p_expected_row_version < 1
     OR p_action NOT IN ('publish', 'deprecate', 'supersede', 'withdraw')
     OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
     OR nullif(pg_catalog.btrim(p_reason), '') IS NULL
     OR pg_catalog.char_length(p_reason) > 4000 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_request');
  END IF;

  v_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.jsonb_build_object(
      'actor', p_actor_user_id, 'action', p_action, 'target', p_target_id,
      'expected_row_version', p_expected_row_version, 'reason', p_reason,
      'payload', p_payload
    )::text, 'sha256'
  ), 'hex');

  IF NOT private.reference_curation_publisher_authorized(
    p_actor_user_id, p_actor_session_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 7302)
  );
  SELECT * INTO v_existing
    FROM private.reference_curation_moderation_requests
   WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_hash = v_hash THEN
      IF v_existing.result_json->>'status' = 'updated' THEN
        RETURN v_existing.result_json || pg_catalog.jsonb_build_object('status', 'no_change');
      END IF;
      RETURN v_existing.result_json;
    END IF;
    INSERT INTO private.reference_curation_moderation_collisions(
      request_id, attempted_hash, actor_user_id, action, target_id
    ) VALUES (p_request_id, v_hash, p_actor_user_id, p_action, p_target_id)
    ON CONFLICT (request_id, attempted_hash) DO NOTHING;
    GET DIAGNOSTICS v_collision_rows = ROW_COUNT;
    IF v_collision_rows > 0 THEN
      INSERT INTO private.reference_curation_events(
        actor_user_id, action, target_type, target_id, outcome, reason, metadata_json
      ) VALUES (
        p_actor_user_id, p_action, 'curated_measurement_set', p_target_id,
        'conflict', 'idempotency_conflict', '{}'::jsonb
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'idempotency_conflict');
  END IF;

  IF p_action = 'supersede'
     OR (p_action = 'publish'
         AND p_payload ?& ARRAY['predecessor_id', 'expected_predecessor_row_version']) THEN
    IF p_action = 'supersede'
       AND NOT (p_payload ?& ARRAY['predecessor_id', 'expected_predecessor_row_version']) THEN
      RETURN private.reference_curation_lifecycle_finish(
        p_request_id, p_actor_user_id, p_action, p_target_id, v_hash, p_reason,
        pg_catalog.jsonb_build_object('status', 'invalid_payload')
      );
    END IF;
    v_predecessor_id := (p_payload->>'predecessor_id')::uuid;
    PERFORM 1
      FROM private.curated_reference_measurement_sets m
     WHERE m.id = ANY (ARRAY[p_target_id, v_predecessor_id])
     ORDER BY m.id
     FOR UPDATE;
  END IF;

  SELECT * INTO v_set
    FROM private.curated_reference_measurement_sets m
   WHERE m.id = p_target_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN private.reference_curation_lifecycle_finish(
      p_request_id, p_actor_user_id, p_action, p_target_id, v_hash,
      p_reason,
      pg_catalog.jsonb_build_object('status', 'not_found')
    );
  END IF;
  IF v_set.row_version <> p_expected_row_version THEN
    RETURN private.reference_curation_lifecycle_finish(
      p_request_id, p_actor_user_id, p_action, p_target_id, v_hash,
      p_reason,
      pg_catalog.jsonb_build_object('status', 'conflict')
    );
  END IF;

  IF p_action IN ('deprecate', 'withdraw') THEN
    IF p_payload <> '{}'::jsonb THEN
      v_result := pg_catalog.jsonb_build_object('status', 'invalid_payload');
    ELSIF p_action = 'deprecate' AND v_set.catalogue_status <> 'published' THEN
      v_result := pg_catalog.jsonb_build_object('status', 'invalid_state');
    ELSIF p_action = 'withdraw' AND v_set.catalogue_status NOT IN ('published', 'deprecated') THEN
      v_result := pg_catalog.jsonb_build_object('status', 'invalid_state');
    ELSE
      SELECT p.content_hash INTO v_before_hash
        FROM private.curated_reference_publications p
       WHERE p.curated_measurement_set_id = v_set.id
         AND p.bundle_revision = v_set.latest_bundle_revision;
      UPDATE private.curated_reference_measurement_sets
         SET catalogue_status = CASE WHEN p_action = 'deprecate' THEN 'deprecated' ELSE 'withdrawn' END,
             deprecated_at = CASE WHEN p_action = 'deprecate' THEN v_now ELSE deprecated_at END,
             withdrawn_at = CASE WHEN p_action = 'withdraw' THEN v_now ELSE withdrawn_at END,
             status_changed_at = v_now,
             row_version = row_version + 1,
             updated_by = p_actor_user_id
       WHERE id = v_set.id;
      INSERT INTO private.reference_curation_events(
        actor_user_id, action, target_type, target_id, bundle_revision,
        outcome, reason, before_content_hash, after_content_hash, metadata_json
      ) VALUES (
        p_actor_user_id, p_action, 'curated_measurement_set', v_set.id,
        v_set.latest_bundle_revision, 'succeeded', p_reason,
        v_before_hash, v_before_hash,
        pg_catalog.jsonb_build_object('row_version', v_set.row_version + 1)
      );
      v_result := pg_catalog.jsonb_build_object('status', 'updated', 'target_id', v_set.id);
    END IF;
  ELSE
    IF private.reference_payload_has_unknown_keys(
         p_payload,
         CASE WHEN p_action = 'publish' THEN ARRAY[
           'expected_work_row_version', 'expected_treatment_row_version',
           'expected_taxon_assignments', 'predecessor_id',
           'expected_predecessor_row_version'
         ] ELSE ARRAY[
           'expected_work_row_version', 'expected_treatment_row_version',
           'expected_taxon_assignments', 'predecessor_id',
           'expected_predecessor_row_version'
         ] END
       )
       OR NOT (p_payload ?& ARRAY[
         'expected_work_row_version', 'expected_treatment_row_version',
         'expected_taxon_assignments'
       ])
       OR pg_catalog.jsonb_typeof(p_payload->'expected_taxon_assignments') <> 'array'
       OR pg_catalog.jsonb_array_length(p_payload->'expected_taxon_assignments') NOT BETWEEN 1 AND 100 THEN
      v_result := pg_catalog.jsonb_build_object('status', 'invalid_payload');
    ELSE
      SELECT * INTO v_treatment
        FROM private.curated_reference_taxon_treatments t
       WHERE t.id = v_set.taxon_treatment_id
       FOR UPDATE;
      SELECT * INTO v_work
        FROM private.curated_reference_works w
       WHERE w.id = v_treatment.reference_work_id
       FOR UPDATE;
      PERFORM 1
        FROM private.curated_reference_treatment_taxa tt
       WHERE tt.taxon_treatment_id = v_treatment.id
       ORDER BY tt.id
       FOR SHARE;
      PERFORM 1
        FROM private.curated_reference_treatment_taxa tt
        JOIN taxonomy_v3.registry_concept c
          ON c.sporely_taxon_id = tt.sporely_taxon_id
       WHERE tt.taxon_treatment_id = v_treatment.id
       ORDER BY c.sporely_taxon_id
       FOR SHARE OF c;
      SELECT coalesce(pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('id', tt.id, 'row_version', tt.row_version)
               ORDER BY tt.id
             ), '[]'::jsonb)
        INTO v_current_taxa
        FROM private.curated_reference_treatment_taxa tt
       WHERE tt.taxon_treatment_id = v_treatment.id;
      v_expected_taxa := p_payload->'expected_taxon_assignments';

      IF (p_action = 'supersede' AND v_set.catalogue_status <> 'draft')
         OR (p_action = 'publish' AND v_set.catalogue_status = 'published') THEN
        v_result := pg_catalog.jsonb_build_object('status', 'invalid_state');
      ELSIF p_action = 'publish' AND EXISTS (
        SELECT 1
          FROM private.curated_reference_measurement_sets successor
         WHERE successor.supersedes_id = v_set.id
           AND successor.catalogue_status <> 'withdrawn'
      ) THEN
        v_result := pg_catalog.jsonb_build_object('status', 'invalid_state');
      ELSIF NOT EXISTS (
        SELECT 1 FROM private.reference_curation_submissions s
         WHERE s.status = 'accepted'
           AND s.accepted_curated_measurement_set_id = v_set.id
           AND s.accepted_curated_treatment_id = v_treatment.id
           AND s.accepted_curated_work_id = v_work.id
      ) THEN
        v_result := pg_catalog.jsonb_build_object('status', 'invalid_state');
      ELSIF v_work.row_version <> (p_payload->>'expected_work_row_version')::bigint
         OR v_treatment.row_version <> (p_payload->>'expected_treatment_row_version')::bigint
         OR v_expected_taxa IS DISTINCT FROM v_current_taxa THEN
        v_result := pg_catalog.jsonb_build_object('status', 'stale_graph');
      ELSIF EXISTS (
        SELECT 1
          FROM private.curated_reference_treatment_taxa tt
          LEFT JOIN taxonomy_v3.registry_concept c
            ON c.sporely_taxon_id = tt.sporely_taxon_id
         WHERE tt.taxon_treatment_id = v_treatment.id
           AND (c.sporely_taxon_id IS NULL OR c.rank IS DISTINCT FROM 'species'
                OR nullif(pg_catalog.btrim(c.canonical_name), '') IS NULL)
      ) OR v_current_taxa = '[]'::jsonb THEN
        v_result := pg_catalog.jsonb_build_object('status', 'invalid_state');
      ELSIF p_action = 'supersede' AND (
        NOT (p_payload ?& ARRAY['predecessor_id', 'expected_predecessor_row_version'])
        OR v_predecessor_id = v_set.id
      ) THEN
        v_result := pg_catalog.jsonb_build_object('status', 'invalid_payload');
      ELSE
        IF p_action = 'supersede' THEN
          SELECT * INTO v_predecessor
            FROM private.curated_reference_measurement_sets m
           WHERE m.id = v_predecessor_id
           FOR UPDATE;
          IF NOT FOUND OR v_predecessor.catalogue_status NOT IN ('published', 'deprecated')
             OR v_predecessor.row_version <> (p_payload->>'expected_predecessor_row_version')::bigint
             OR v_predecessor.character <> v_set.character
             OR NOT EXISTS (
               SELECT 1
                 FROM private.curated_reference_treatment_taxa successor_taxon
                 JOIN private.curated_reference_treatment_taxa predecessor_taxon
                   ON predecessor_taxon.sporely_taxon_id = successor_taxon.sporely_taxon_id
                WHERE successor_taxon.taxon_treatment_id = v_treatment.id
                  AND predecessor_taxon.taxon_treatment_id = v_predecessor.taxon_treatment_id
             )
             OR EXISTS (
               SELECT 1 FROM private.curated_reference_measurement_sets other
                WHERE other.supersedes_id = v_predecessor.id
                  AND other.catalogue_status <> 'withdrawn'
             ) THEN
            v_result := pg_catalog.jsonb_build_object('status', 'invalid_successor');
          END IF;
        ELSIF v_set.supersedes_id IS NOT NULL THEN
          IF NOT (p_payload ?& ARRAY['predecessor_id', 'expected_predecessor_row_version']) THEN
            v_result := pg_catalog.jsonb_build_object('status', 'invalid_payload');
          ELSIF v_predecessor_id <> v_set.supersedes_id THEN
            v_result := pg_catalog.jsonb_build_object('status', 'invalid_successor');
          ELSE
            SELECT * INTO v_predecessor
              FROM private.curated_reference_measurement_sets m
             WHERE m.id = v_predecessor_id
             FOR UPDATE;
            IF v_predecessor.row_version <>
               (p_payload->>'expected_predecessor_row_version')::bigint THEN
              v_result := pg_catalog.jsonb_build_object('status', 'conflict');
            END IF;
          END IF;
        ELSIF p_payload ? 'predecessor_id'
           OR p_payload ? 'expected_predecessor_row_version' THEN
          v_result := pg_catalog.jsonb_build_object('status', 'invalid_payload');
        END IF;

        IF v_result IS NULL THEN
          v_bundle_revision := coalesce(v_set.latest_bundle_revision, 0) + 1;
          IF v_set.latest_bundle_revision IS NOT NULL THEN
            SELECT p.content_hash INTO v_before_hash
              FROM private.curated_reference_publications p
             WHERE p.curated_measurement_set_id = v_set.id
               AND p.bundle_revision = v_set.latest_bundle_revision;
          END IF;
          v_snapshot := private.reference_curated_snapshot(v_set.id, v_bundle_revision);
          v_citation := private.reference_curated_citation(v_work.id);
          IF private.reference_snapshot_valid(
               v_snapshot, v_work.id, v_treatment.id, v_set.id, v_bundle_revision
             ) IS NOT TRUE
             OR nullif(pg_catalog.btrim(v_citation->>'full_citation'), '') IS NULL
             OR nullif(pg_catalog.btrim(v_citation->>'short_citation'), '') IS NULL THEN
            v_result := pg_catalog.jsonb_build_object('status', 'invalid_state');
          ELSE
            v_content_hash := private.reference_curated_content_hash(
              v_set.id, v_bundle_revision
            );
            INSERT INTO private.curated_reference_publications(
              curated_measurement_set_id, bundle_revision,
              curated_taxon_treatment_id, curated_work_id,
              measurement_set_revision, treatment_revision, work_revision,
              snapshot_schema_version, snapshot_json,
              citation_schema_version, citation_json,
              content_hash, published_at, published_by
            ) VALUES (
              v_set.id, v_bundle_revision, v_treatment.id, v_work.id,
              v_set.revision, v_treatment.revision, v_work.revision,
              1, v_snapshot, 1, v_citation, v_content_hash, v_now, p_actor_user_id
            );
            INSERT INTO private.curated_reference_publication_taxa(
              curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name
            )
            SELECT v_set.id, v_bundle_revision, tt.sporely_taxon_id, c.canonical_name
              FROM private.curated_reference_treatment_taxa tt
              JOIN taxonomy_v3.registry_concept c
                ON c.sporely_taxon_id = tt.sporely_taxon_id
             WHERE tt.taxon_treatment_id = v_treatment.id
             ORDER BY tt.sporely_taxon_id;
            UPDATE private.curated_reference_measurement_sets
               SET supersedes_id = CASE WHEN p_action = 'supersede' THEN v_predecessor.id ELSE supersedes_id END,
                   catalogue_status = 'published', latest_bundle_revision = v_bundle_revision,
                   published_at = v_now, deprecated_at = NULL, withdrawn_at = NULL,
                   status_changed_at = v_now, row_version = row_version + 1,
                   updated_by = p_actor_user_id
             WHERE id = v_set.id;
            IF p_action = 'supersede'
               OR (p_action = 'publish' AND v_set.supersedes_id IS NOT NULL
                   AND v_predecessor.catalogue_status = 'published') THEN
              SELECT p.content_hash INTO v_predecessor_hash
                FROM private.curated_reference_publications p
               WHERE p.curated_measurement_set_id = v_predecessor.id
                 AND p.bundle_revision = v_predecessor.latest_bundle_revision;
              IF v_predecessor.catalogue_status = 'published' THEN
                UPDATE private.curated_reference_measurement_sets
                   SET catalogue_status = 'deprecated', deprecated_at = v_now,
                       status_changed_at = v_now, row_version = row_version + 1,
                       updated_by = p_actor_user_id
                 WHERE id = v_predecessor.id;
              END IF;
              INSERT INTO private.reference_curation_events(
                actor_user_id, action, target_type, target_id, bundle_revision,
                outcome, reason, before_content_hash, after_content_hash, metadata_json
              ) VALUES (
                p_actor_user_id, p_action, 'curated_measurement_set', v_predecessor.id,
                v_predecessor.latest_bundle_revision, 'succeeded', p_reason,
                v_predecessor_hash, v_predecessor_hash,
                pg_catalog.jsonb_build_object(
                  'successor_id', v_set.id,
                  'transition', CASE WHEN p_action = 'publish'
                    THEN 'restored_successor' ELSE 'superseded' END
                )
              );
            END IF;
            INSERT INTO private.reference_curation_events(
              actor_user_id, action, target_type, target_id, bundle_revision,
              outcome, reason, before_content_hash, after_content_hash, metadata_json
            ) VALUES (
              p_actor_user_id, p_action, 'publication', v_set.id, v_bundle_revision,
              'succeeded', p_reason, v_before_hash, v_content_hash,
              pg_catalog.jsonb_build_object(
                'work_id', v_work.id, 'work_revision', v_work.revision,
                'treatment_id', v_treatment.id, 'treatment_revision', v_treatment.revision,
                'measurement_set_revision', v_set.revision
              )
            );
            SET CONSTRAINTS
              private.curated_reference_publications_lifecycle_trg,
              private.curated_reference_measurement_sets_publication_lifecycle_trg,
              private.curated_reference_publications_taxa_trg,
              private.curated_reference_publication_taxa_complete_trg,
              private.curated_reference_measurement_sets_supersession_taxa_trg,
              private.curated_reference_treatment_taxa_supersession_trg
              IMMEDIATE;
            SET CONSTRAINTS
              private.curated_reference_publications_lifecycle_trg,
              private.curated_reference_measurement_sets_publication_lifecycle_trg,
              private.curated_reference_publications_taxa_trg,
              private.curated_reference_publication_taxa_complete_trg,
              private.curated_reference_measurement_sets_supersession_taxa_trg,
              private.curated_reference_treatment_taxa_supersession_trg
              DEFERRED;
            v_result := pg_catalog.jsonb_build_object(
              'status', 'updated', 'target_id', v_set.id,
              'bundle_revision', v_bundle_revision
            );
            IF p_action = 'supersede' THEN
              v_result := v_result || pg_catalog.jsonb_build_object(
                'predecessor_id', v_predecessor.id
              );
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN private.reference_curation_lifecycle_finish(
    p_request_id, p_actor_user_id, p_action, p_target_id, v_hash, p_reason, v_result
  );
EXCEPTION
  WHEN deadlock_detected OR serialization_failure THEN
    RAISE;
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN private.reference_curation_lifecycle_finish(
      p_request_id, p_actor_user_id, p_action, p_target_id, v_hash,
      p_reason,
      pg_catalog.jsonb_build_object('status', 'invalid_payload')
    );
  WHEN check_violation OR foreign_key_violation OR unique_violation THEN
    RETURN private.reference_curation_lifecycle_finish(
      p_request_id, p_actor_user_id, p_action, p_target_id, v_hash,
      p_reason,
      pg_catalog.jsonb_build_object(
        'status', CASE WHEN p_action = 'supersede' THEN 'invalid_successor' ELSE 'invalid_state' END
      )
    );
  WHEN OTHERS THEN
    RETURN private.reference_curation_lifecycle_finish(
      p_request_id, p_actor_user_id, p_action, p_target_id, v_hash,
      p_reason,
      pg_catalog.jsonb_build_object('status', 'failed')
    );
END
$$;

ALTER FUNCTION public.mutate_reference_curation_lifecycle(
  uuid, uuid, uuid, text, uuid, bigint, text, jsonb
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.mutate_reference_curation_lifecycle(
  uuid, uuid, uuid, text, uuid, bigint, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_reference_curation_lifecycle(
  uuid, uuid, uuid, text, uuid, bigint, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION private.reference_curation_publisher_authorized(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_full_citation(private.curated_reference_works)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_snapshot(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_citation(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_content_hash(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_assignment_statement_lock()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_lifecycle_finish(
  uuid, uuid, text, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
