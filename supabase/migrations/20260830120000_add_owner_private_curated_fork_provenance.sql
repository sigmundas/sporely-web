-- Dormant owner-private provenance for explicit curated-to-personal forks.
-- This does not expose curated data or create/attach a personal graph.

BEGIN;

ALTER TABLE public.reference_taxon_treatments
  ADD CONSTRAINT reference_taxon_treatments_owner_graph_key
  UNIQUE (user_id, id, reference_work_id);

ALTER TABLE public.reference_measurement_sets
  ADD CONSTRAINT reference_measurement_sets_owner_graph_key
  UNIQUE (user_id, id, taxon_treatment_id);

CREATE TABLE public.reference_curated_forks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  curated_measurement_set_id uuid NOT NULL,
  bundle_revision integer NOT NULL CHECK (bundle_revision >= 1),
  sporely_taxon_id integer NOT NULL CHECK (sporely_taxon_id > 0),
  reference_work_id uuid NOT NULL,
  taxon_treatment_id uuid NOT NULL,
  reference_measurement_set_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_envelope_json text NOT NULL CHECK (
    octet_length(source_envelope_json) BETWEEN 2 AND 1048576
  ),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, curated_measurement_set_id, bundle_revision),
  UNIQUE (id),
  UNIQUE (user_id, reference_measurement_set_id),
  FOREIGN KEY (curated_measurement_set_id, bundle_revision, sporely_taxon_id)
    REFERENCES private.curated_reference_publication_taxa(
      curated_measurement_set_id, bundle_revision, sporely_taxon_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, reference_work_id)
    REFERENCES public.reference_works(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, taxon_treatment_id, reference_work_id)
    REFERENCES public.reference_taxon_treatments(user_id, id, reference_work_id)
    ON DELETE CASCADE,
  FOREIGN KEY (user_id, reference_measurement_set_id, taxon_treatment_id)
    REFERENCES public.reference_measurement_sets(user_id, id, taxon_treatment_id)
    ON DELETE CASCADE
);

CREATE INDEX reference_curated_forks_owner_cursor_idx
  ON public.reference_curated_forks(
    user_id, updated_at, curated_measurement_set_id, bundle_revision, id
  );

ALTER TABLE public.reference_curated_forks ENABLE ROW LEVEL SECURITY;
CREATE POLICY reference_curated_forks_owner_select
  ON public.reference_curated_forks FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.reference_curated_forks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.reference_curated_forks TO authenticated;

CREATE FUNCTION public.sync_reference_curated_fork(
  p_payload jsonb,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_curated_set_id uuid;
  v_bundle_revision integer;
  v_taxon_id integer;
  v_work_id uuid;
  v_treatment_id uuid;
  v_set_id uuid;
  v_source_sha256 text;
  v_source_envelope_text text;
  v_source_envelope jsonb;
  v_expected_envelope jsonb;
  v_source_status text;
  v_source_successor_id uuid;
  v_current_successor_id uuid;
  v_source_canonical_name text;
  v_current public.reference_curated_forks%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0
     OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
     OR private.reference_payload_has_unknown_keys(p_payload, ARRAY[
       'curated_measurement_set_id','bundle_revision','sporely_taxon_id',
       'reference_work_id','taxon_treatment_id','reference_measurement_set_id',
       'source_sha256','source_envelope_json'
     ])
  THEN
    RETURN private.reference_result('invalid_payload');
  END IF;

  BEGIN
    v_curated_set_id := (p_payload->>'curated_measurement_set_id')::uuid;
    v_bundle_revision := (p_payload->>'bundle_revision')::integer;
    v_taxon_id := (p_payload->>'sporely_taxon_id')::integer;
    v_work_id := (p_payload->>'reference_work_id')::uuid;
    v_treatment_id := (p_payload->>'taxon_treatment_id')::uuid;
    v_set_id := (p_payload->>'reference_measurement_set_id')::uuid;
    v_source_sha256 := p_payload->>'source_sha256';
    v_source_envelope_text := p_payload->>'source_envelope_json';
  EXCEPTION WHEN OTHERS THEN
    RETURN private.reference_result('invalid_payload');
  END;
  IF v_bundle_revision < 1 OR v_taxon_id < 1
     OR v_source_sha256 IS NULL OR v_source_sha256 !~ '^[0-9a-f]{64}$'
     OR v_source_envelope_text IS NULL
     OR pg_catalog.octet_length(v_source_envelope_text) NOT BETWEEN 2 AND 1048576
  THEN
    RETURN private.reference_result('invalid_payload');
  END IF;
  IF pg_catalog.encode(extensions.digest(
       pg_catalog.convert_to(v_source_envelope_text,'UTF8'),'sha256'
     ),'hex') IS DISTINCT FROM v_source_sha256 THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  BEGIN
    v_source_envelope := v_source_envelope_text::jsonb;
    IF pg_catalog.jsonb_typeof(v_source_envelope) <> 'object' THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    v_source_status := v_source_envelope->>'status';
    v_source_successor_id := nullif(v_source_envelope->>'superseded_by_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN private.reference_result('invalid_source');
  END;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id = v_owner) THEN
    RETURN private.reference_result('account_deleting');
  END IF;

  SELECT * INTO v_current
    FROM public.reference_curated_forks
   WHERE user_id = v_owner
     AND curated_measurement_set_id = v_curated_set_id
     AND bundle_revision = v_bundle_revision
   FOR UPDATE;
  IF FOUND THEN
    IF v_current.sporely_taxon_id = v_taxon_id
       AND v_current.reference_work_id = v_work_id
       AND v_current.taxon_treatment_id = v_treatment_id
       AND v_current.reference_measurement_set_id = v_set_id
       AND v_current.source_sha256 = v_source_sha256
       AND v_current.source_envelope_json = v_source_envelope_text
    THEN
      RETURN private.reference_result('no_change', pg_catalog.to_jsonb(v_current));
    END IF;
    RETURN private.reference_result('conflict', pg_catalog.to_jsonb(v_current));
  END IF;
  IF p_expected_row_version <> 0 THEN
    RETURN private.reference_result('conflict');
  END IF;

  SELECT pt.canonical_name
    INTO v_source_canonical_name
    FROM private.curated_reference_publications p
    JOIN private.curated_reference_publication_taxa pt
      ON pt.curated_measurement_set_id = p.curated_measurement_set_id
     AND pt.bundle_revision = p.bundle_revision
   WHERE p.curated_measurement_set_id = v_curated_set_id
     AND p.bundle_revision = v_bundle_revision
     AND pt.sporely_taxon_id = v_taxon_id;
  IF NOT FOUND THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  SELECT successor.id INTO v_current_successor_id
    FROM private.curated_reference_measurement_sets successor
   WHERE successor.supersedes_id = v_curated_set_id
     AND successor.catalogue_status IN ('published','deprecated')
     AND EXISTS (
       SELECT 1 FROM private.curated_reference_publications successor_publication
        WHERE successor_publication.curated_measurement_set_id = successor.id
          AND successor_publication.bundle_revision = successor.latest_bundle_revision
     )
   ORDER BY successor.id
   LIMIT 1;
  IF v_source_status NOT IN ('published','deprecated')
     OR (v_source_status = 'published' AND v_source_successor_id IS NOT NULL)
     OR (v_source_status = 'deprecated' AND NOT EXISTS (
       SELECT 1 FROM private.curated_reference_measurement_sets source_set
        WHERE source_set.id = v_curated_set_id AND source_set.deprecated_at IS NOT NULL
     ))
     OR (v_source_status = 'deprecated'
         AND v_source_successor_id IS DISTINCT FROM v_current_successor_id)
  THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  v_expected_envelope := private.reference_curated_public_envelope(
    v_curated_set_id,v_bundle_revision,v_source_status,v_source_successor_id
  );
  IF v_expected_envelope IS NULL THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  v_expected_envelope := v_expected_envelope || pg_catalog.jsonb_build_object(
    'sporely_taxon_id',v_taxon_id,
    'canonical_scientific_name',v_source_canonical_name
  );
  IF v_source_envelope IS DISTINCT FROM v_expected_envelope THEN
    RETURN private.reference_result('invalid_source');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.reference_measurement_sets m
      JOIN public.reference_taxon_treatments t
        ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
      JOIN public.reference_works w
        ON w.user_id = t.user_id AND w.id = t.reference_work_id
     WHERE m.user_id = v_owner AND m.id = v_set_id
       AND m.taxon_treatment_id = v_treatment_id
       AND t.reference_work_id = v_work_id
       AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
  ) THEN
    RETURN private.reference_result('invalid_parent');
  END IF;

  BEGIN
    INSERT INTO public.reference_curated_forks(
      user_id,curated_measurement_set_id,bundle_revision,sporely_taxon_id,
      reference_work_id,taxon_treatment_id,reference_measurement_set_id,source_sha256
      ,source_envelope_json
    ) VALUES (
      v_owner,v_curated_set_id,v_bundle_revision,v_taxon_id,
      v_work_id,v_treatment_id,v_set_id,v_source_sha256,v_source_envelope_text
    ) RETURNING * INTO v_current;
  EXCEPTION
    WHEN unique_violation THEN RETURN private.reference_result('conflict');
    WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
      RETURN private.reference_result('invalid_payload');
  END;
  RETURN private.reference_result('created', pg_catalog.to_jsonb(v_current));
END
$$;

-- The current public wrapper ultimately deletes the owner graph in its private
-- predecessor. Remove provenance first so the graph's restrictive identity
-- relationships remain explicit and account deletion stays retry-safe.
CREATE OR REPLACE FUNCTION public.delete_reference_library_for_account(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_submission record;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,7301));
  UPDATE private.reference_curation_submissions SET
    accepted_by=NULL,row_version=row_version+1
   WHERE accepted_by=p_user_id;
  FOR v_submission IN
    SELECT s.id,s.current_content_hash
      FROM private.reference_curation_submissions s
     WHERE s.claimed_by=p_user_id AND s.status='in_review'
     FOR UPDATE
  LOOP
    INSERT INTO private.reference_curation_events(
      actor_user_id,action,target_type,target_id,outcome,reason,
      before_content_hash,after_content_hash
    ) VALUES(p_user_id,'release_claim','submission',v_submission.id,'succeeded',
      'curator_account_deleted',v_submission.current_content_hash,v_submission.current_content_hash);
    UPDATE private.reference_curation_submissions SET
      status='submitted',claimed_by=NULL,claimed_at=NULL,row_version=row_version+1
     WHERE id=v_submission.id;
  END LOOP;
  DELETE FROM public.reference_curated_forks WHERE user_id = p_user_id;
  PERFORM private.delete_reference_library_for_account_stage6b(p_user_id);
END
$$;

ALTER FUNCTION public.sync_reference_curated_fork(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.delete_reference_library_for_account(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_reference_curated_fork(jsonb,bigint)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sync_reference_curated_fork(jsonb,bigint)
  TO authenticated;
REVOKE ALL ON FUNCTION public.delete_reference_library_for_account(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_reference_library_for_account(uuid)
  TO service_role;

COMMIT;
