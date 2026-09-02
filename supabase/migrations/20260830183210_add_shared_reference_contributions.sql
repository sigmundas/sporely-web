-- Owner-authored shared reference contributions.
--
-- This additive compatibility layer deliberately reuses the Stage 6 frozen
-- snapshot/citation/export validators without using its scientific curation
-- workflow.  A contribution becomes shared only when its owner has synced an
-- active use on an observation carrying the same exact taxonomy-v3 species.

BEGIN;

CREATE TABLE private.shared_reference_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  source_measurement_set_id uuid,
  sporely_taxon_id integer NOT NULL
    REFERENCES taxonomy_v3.registry_concept(sporely_taxon_id) ON DELETE RESTRICT
    CHECK (sporely_taxon_id > 0),
  status text NOT NULL DEFAULT 'shared' CHECK (status IN ('shared', 'withdrawn')),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  shared_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  hidden_at timestamptz,
  hidden_reason text CHECK (hidden_reason IN ('abuse', 'privacy', 'legal')),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK ((hidden_at IS NULL) = (hidden_reason IS NULL)),
  CHECK ((owner_id IS NULL) = (source_measurement_set_id IS NULL))
);

CREATE TABLE private.shared_reference_contribution_revisions (
  contribution_id uuid NOT NULL
    REFERENCES private.shared_reference_contributions(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 1),
  source_work_revision integer NOT NULL CHECK (source_work_revision >= 1),
  source_treatment_revision integer NOT NULL CHECK (source_treatment_revision >= 1),
  source_measurement_set_revision integer NOT NULL CHECK (source_measurement_set_revision >= 1),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  envelope_json jsonb NOT NULL CHECK (
    jsonb_typeof(envelope_json) = 'object'
    AND octet_length(envelope_json::text) <= 1048576
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contribution_id, revision)
);

ALTER TABLE private.shared_reference_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.shared_reference_contribution_revisions ENABLE ROW LEVEL SECURITY;

CREATE INDEX shared_reference_contributions_taxon_page_idx
  ON private.shared_reference_contributions(
    sporely_taxon_id, shared_at DESC, id ASC
  ) WHERE status = 'shared' AND hidden_at IS NULL;

CREATE UNIQUE INDEX shared_reference_contributions_owner_source_taxon_key
  ON private.shared_reference_contributions(
    owner_id, source_measurement_set_id, sporely_taxon_id
  ) WHERE owner_id IS NOT NULL AND source_measurement_set_id IS NOT NULL;

CREATE FUNCTION private.shared_reference_contribution_result(
  p_status text,
  p_row jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object('status', p_status, 'row', p_row)
$$;

CREATE FUNCTION private.shared_reference_project_raw_points(p_points jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_point jsonb;
  v_value jsonb;
BEGIN
  IF p_points IS NULL OR pg_catalog.jsonb_typeof(p_points) = 'null' THEN
    RETURN p_points;
  END IF;
  IF pg_catalog.jsonb_typeof(p_points) <> 'array'
     OR pg_catalog.jsonb_array_length(p_points) NOT BETWEEN 1 AND 10000 THEN
    RETURN NULL;
  END IF;
  FOR v_point IN SELECT value FROM pg_catalog.jsonb_array_elements(p_points) LOOP
    IF pg_catalog.jsonb_typeof(v_point) IN ('number','boolean') THEN
      CONTINUE;
    END IF;
    IF pg_catalog.jsonb_typeof(v_point) <> 'object'
       OR NOT (v_point ?| ARRAY['length','width','l','w'])
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_object_keys(v_point) AS key_name
          WHERE key_name NOT IN ('length','width','l','w','q')
       ) THEN
      RETURN NULL;
    END IF;
    FOR v_value IN SELECT value FROM pg_catalog.jsonb_each(v_point) LOOP
      IF pg_catalog.jsonb_typeof(v_value) NOT IN ('number','boolean') THEN
        RETURN NULL;
      END IF;
    END LOOP;
  END LOOP;
  RETURN p_points;
END
$$;

CREATE FUNCTION private.shared_reference_contribution_envelope(
  p_contribution_id uuid,
  p_revision integer,
  p_taxon_id integer,
  p_canonical_name text,
  p_owner_id uuid,
  p_snapshot jsonb,
  p_candidate jsonb,
  p_shared_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_work jsonb := p_candidate->'work';
  v_citation jsonb;
  v_exports jsonb;
  v_label text;
  v_citation_key text := 'sporely-contribution-' || pg_catalog.replace(p_contribution_id::text, '-', '');
BEGIN
  IF p_contribution_id IS NULL OR p_revision < 1 OR p_taxon_id < 1
     OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
     OR pg_catalog.jsonb_typeof(v_work) <> 'object' THEN
    RETURN NULL;
  END IF;
  SELECT CASE
           WHEN nullif(pg_catalog.btrim(p.username), '') IS NULL THEN 'Sporely user'
           WHEN p.username LIKE '%@%' THEN 'Sporely user'
           ELSE p.username
         END
    INTO v_label
    FROM public.profiles p
   WHERE p.id=p_owner_id;
  p_snapshot := p_snapshot || pg_catalog.jsonb_build_object(
    'reference_work_id', extensions.uuid_generate_v5(
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid,
      p_contribution_id::text || ':work'
    ),
    'reference_treatment_id', extensions.uuid_generate_v5(
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid,
      p_contribution_id::text || ':treatment'
    ),
    'reference_measurement_set_id', p_contribution_id,
    'reference_revision', p_revision
  );
  v_citation := v_work || pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'citation_key', v_citation_key,
    'short_citation', p_snapshot->'short_label',
    'full_citation', p_snapshot->'full_citation'
  );
  v_exports := private.reference_curated_build_citation_exports(
    v_citation, p_contribution_id
  );
  RETURN pg_catalog.jsonb_build_object(
    'contribution_id', p_contribution_id,
    'revision', p_revision,
    'status', 'shared',
    'shared_at', p_shared_at,
    'sporely_taxon_id', p_taxon_id,
    'canonical_scientific_name', p_canonical_name,
    'contributor', pg_catalog.jsonb_build_object(
      'id', p_owner_id,
      'label', coalesce(nullif(pg_catalog.btrim(v_label), ''), 'Sporely user')
    ),
    'snapshot', p_snapshot,
    'citation', v_citation,
    'exports', pg_catalog.jsonb_build_object(
      'plain_text', v_exports->>'plain_text',
      'bibtex', v_exports->>'bibtex',
      'csl_json', (v_exports->>'csl_json')::jsonb
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

CREATE FUNCTION private.share_reference_contribution_for_owner(
  p_owner uuid,
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := p_owner;
  v_contribution private.shared_reference_contributions%ROWTYPE;
  v_candidate jsonb;
  v_snapshot jsonb;
  v_envelope jsonb;
  v_hash text;
  v_revision integer;
  v_canonical_name text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_work public.reference_works%ROWTYPE;
  v_treatment public.reference_taxon_treatments%ROWTYPE;
  v_set public.reference_measurement_sets%ROWTYPE;
  v_authors jsonb;
  v_editors jsonb;
  v_raw_points jsonb;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_source_measurement_set_id IS NULL OR p_sporely_taxon_id IS NULL
     OR p_sporely_taxon_id <= 0 OR p_expected_work_revision < 1
     OR p_expected_treatment_revision < 1
     OR p_expected_measurement_set_revision < 1 THEN
    RETURN private.shared_reference_contribution_result('invalid_payload');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text || ':' || p_source_measurement_set_id::text
      || ':' || p_sporely_taxon_id::text, 7301)
  );
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = v_owner)
     OR NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.id = v_owner AND p.is_banned IS FALSE
     ) THEN
    RETURN private.shared_reference_contribution_result('account_unavailable');
  END IF;
  SELECT c.canonical_name INTO v_canonical_name
    FROM taxonomy_v3.registry_concept c
   WHERE c.sporely_taxon_id = p_sporely_taxon_id
     AND c.rank = 'species'
     AND nullif(pg_catalog.btrim(c.canonical_name), '') IS NOT NULL
     AND pg_catalog.char_length(c.canonical_name) <= 1024;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('invalid_taxon');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.observation_reference_uses u
      JOIN public.observations o
        ON o.user_id = u.user_id AND o.id = u.observation_id
     WHERE u.user_id = v_owner
       AND u.reference_measurement_set_id = p_source_measurement_set_id
       AND u.deleted_at IS NULL
       AND coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
           = p_sporely_taxon_id
  ) THEN
    RETURN private.shared_reference_contribution_result('exact_taxon_use_required');
  END IF;
  v_snapshot := private.reference_canonical_snapshot(v_owner, p_source_measurement_set_id);
  IF v_snapshot IS NULL THEN
    RETURN private.shared_reference_contribution_result('source_not_found_or_stale');
  END IF;
  SELECT * INTO v_set FROM public.reference_measurement_sets m
   WHERE m.user_id=v_owner AND m.id=p_source_measurement_set_id
     AND m.deleted_at IS NULL AND m.revision=p_expected_measurement_set_revision
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('source_not_found_or_stale');
  END IF;
  SELECT * INTO v_treatment FROM public.reference_taxon_treatments t
   WHERE t.user_id=v_owner AND t.id=v_set.taxon_treatment_id
     AND t.deleted_at IS NULL AND t.revision=p_expected_treatment_revision
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('source_not_found_or_stale');
  END IF;
  SELECT * INTO v_work FROM public.reference_works w
   WHERE w.user_id=v_owner AND w.id=v_treatment.reference_work_id
     AND w.deleted_at IS NULL AND w.revision=p_expected_work_revision
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('source_not_found_or_stale');
  END IF;
  v_authors := private.reference_curation_project_agents(v_work.authors_json);
  v_editors := private.reference_curation_project_agents(v_work.editors_json);
  v_raw_points := private.shared_reference_project_raw_points(v_set.raw_points_json);
  IF v_authors IS NULL OR v_editors IS NULL
     OR pg_catalog.octet_length(v_snapshot::text) > 65536
     OR pg_catalog.char_length(v_snapshot->>'short_label') > 512
     OR (v_set.raw_points_json IS NOT NULL AND v_raw_points IS NULL)
     OR nullif(pg_catalog.btrim(v_work.title),'') IS NULL
     OR pg_catalog.char_length(v_work.title) > 2048
     OR pg_catalog.char_length(v_work.container_title) > 2048
     OR (v_work.year IS NOT NULL AND (v_work.year < 1 OR v_work.year > 9999))
     OR pg_catalog.char_length(v_work.edition) > 256
     OR pg_catalog.char_length(v_work.publisher) > 1024
     OR pg_catalog.char_length(v_work.place) > 1024
     OR pg_catalog.char_length(v_work.volume) > 128
     OR pg_catalog.char_length(v_work.issue) > 128
     OR pg_catalog.char_length(v_work.pages) > 256
     OR pg_catalog.char_length(v_work.doi) > 255
     OR (v_work.doi IS NOT NULL AND v_work.doi !~* '^10\.[0-9]{4,9}/[-._;()/:a-z0-9]+$')
     OR pg_catalog.char_length(v_work.isbn) > 64
     OR pg_catalog.char_length(v_work.url) > 2048
     OR (v_work.url IS NOT NULL AND v_work.url !~* '^https?://')
     OR pg_catalog.char_length(v_work.language) > 64
     OR pg_catalog.char_length(v_work.citation_override) > 8192
     OR pg_catalog.char_length(v_set.mount_medium) > 4096
     OR pg_catalog.char_length(v_set.stain) > 4096
     OR pg_catalog.char_length(v_set.preparation) > 4096
     OR pg_catalog.char_length(v_set.measurement_method) > 4096
     OR v_set.length_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.length_core_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.length_core_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.length_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_core_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_core_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.q_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.q_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.q_mean::text IN ('NaN','Infinity','-Infinity')
     OR v_set.length_mean::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_mean::text IN ('NaN','Infinity','-Infinity') THEN
    RETURN private.shared_reference_contribution_result('source_out_of_bounds');
  END IF;
  v_snapshot := pg_catalog.jsonb_set(
    v_snapshot,'{raw_points}',coalesce(v_raw_points,'null'::jsonb),false
  );
  v_candidate := pg_catalog.jsonb_build_object(
    'work', pg_catalog.jsonb_build_object(
      'type',v_work.type,'authors',v_authors,'editors',v_editors,
      'title',v_work.title,'container_title',v_work.container_title,
      'year',v_work.year,'edition',v_work.edition,'publisher',v_work.publisher,
      'place',v_work.place,'volume',v_work.volume,'issue',v_work.issue,
      'pages',v_work.pages,'doi',v_work.doi,'isbn',v_work.isbn,
      'url',v_work.url,'language',v_work.language,
      'short_label',v_snapshot->>'short_label',
      'citation_override',v_work.citation_override
    )
  );
  v_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'taxon_id', p_sporely_taxon_id,
      'candidate', v_candidate,
      'snapshot', v_snapshot
    )::text, 'UTF8'
  ), 'sha256'), 'hex');

  SELECT * INTO v_contribution
    FROM private.shared_reference_contributions c
   WHERE c.owner_id = v_owner
     AND c.source_measurement_set_id = p_source_measurement_set_id
     AND c.sporely_taxon_id = p_sporely_taxon_id
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO private.shared_reference_contributions(
      owner_id, source_measurement_set_id, sporely_taxon_id,
      status, current_revision, shared_at, updated_at
    ) VALUES (
      v_owner, p_source_measurement_set_id, p_sporely_taxon_id,
      'shared', 1, v_now, v_now
    ) RETURNING * INTO v_contribution;
    v_revision := 1;
  ELSE
    IF v_contribution.status = 'shared' AND EXISTS (
      SELECT 1 FROM private.shared_reference_contribution_revisions r
       WHERE r.contribution_id = v_contribution.id
         AND r.revision = v_contribution.current_revision
         AND r.content_hash = v_hash
    ) THEN
      SELECT r.envelope_json INTO v_envelope
        FROM private.shared_reference_contribution_revisions r
       WHERE r.contribution_id = v_contribution.id
         AND r.revision = v_contribution.current_revision;
      RETURN private.shared_reference_contribution_result('no_change', v_envelope);
    END IF;
    v_revision := v_contribution.current_revision + 1;
    UPDATE private.shared_reference_contributions
       SET status = 'shared', current_revision = v_revision,
           shared_at = v_now, updated_at = v_now,
           withdrawn_at = NULL
     WHERE id = v_contribution.id
     RETURNING * INTO v_contribution;
  END IF;

  v_envelope := private.shared_reference_contribution_envelope(
    v_contribution.id, v_revision, p_sporely_taxon_id, v_canonical_name,
    v_owner, v_snapshot, v_candidate, v_now
  );
  IF v_envelope IS NULL OR pg_catalog.octet_length(v_envelope::text) > 1048576 THEN
    RAISE EXCEPTION 'shared reference contribution could not be projected'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO private.shared_reference_contribution_revisions(
    contribution_id, revision, source_work_revision,
    source_treatment_revision, source_measurement_set_revision,
    content_hash, envelope_json, created_at
  ) VALUES (
    v_contribution.id, v_revision, p_expected_work_revision,
    p_expected_treatment_revision, p_expected_measurement_set_revision,
    v_hash, v_envelope, v_now
  );
  RETURN private.shared_reference_contribution_result(
    CASE WHEN v_revision = 1 THEN 'created' ELSE 'updated' END, v_envelope
  );
END
$$;

CREATE FUNCTION public.share_reference_contribution(
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN private.share_reference_contribution_for_owner(
    auth.uid(),p_source_measurement_set_id,p_sporely_taxon_id,
    p_expected_work_revision,p_expected_treatment_revision,
    p_expected_measurement_set_revision
  );
END
$$;

CREATE FUNCTION public.withdraw_reference_contribution(p_contribution_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_row private.shared_reference_contributions%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM private.shared_reference_contributions c
   WHERE c.id = p_contribution_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('not_found');
  END IF;
  IF v_row.owner_id IS DISTINCT FROM v_owner THEN
    RETURN private.shared_reference_contribution_result('forbidden');
  END IF;
  IF v_row.status = 'withdrawn' THEN
    RETURN private.shared_reference_contribution_result('no_change');
  END IF;
  UPDATE private.shared_reference_contributions
     SET status = 'withdrawn', withdrawn_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = p_contribution_id;
  RETURN private.shared_reference_contribution_result('updated');
END
$$;

CREATE FUNCTION public.moderate_shared_reference_contribution(
  p_contribution_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row private.shared_reference_contributions%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_contribution_id IS NULL OR p_action NOT IN ('hide', 'restore')
     OR (p_action = 'hide' AND p_reason NOT IN ('abuse', 'privacy', 'legal'))
     OR (p_action = 'restore' AND p_reason IS NOT NULL) THEN
    RETURN private.shared_reference_contribution_result('invalid_payload');
  END IF;
  SELECT * INTO v_row FROM private.shared_reference_contributions c
   WHERE c.id=p_contribution_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('not_found');
  END IF;
  IF p_action = 'hide' THEN
    IF v_row.hidden_at IS NOT NULL AND v_row.hidden_reason = p_reason THEN
      RETURN private.shared_reference_contribution_result('no_change');
    END IF;
    UPDATE private.shared_reference_contributions
       SET hidden_at=pg_catalog.clock_timestamp(), hidden_reason=p_reason,
           updated_at=pg_catalog.clock_timestamp()
     WHERE id=p_contribution_id;
  ELSE
    IF v_row.hidden_at IS NULL THEN
      RETURN private.shared_reference_contribution_result('no_change');
    END IF;
    UPDATE private.shared_reference_contributions
       SET hidden_at=NULL, hidden_reason=NULL,
           updated_at=pg_catalog.clock_timestamp()
     WHERE id=p_contribution_id;
  END IF;
  RETURN private.shared_reference_contribution_result('updated');
END
$$;

CREATE FUNCTION private.anonymize_shared_reference_contributions_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE private.shared_reference_contribution_revisions r
     SET envelope_json = pg_catalog.jsonb_set(
       pg_catalog.jsonb_set(
         r.envelope_json, '{contributor,id}', 'null'::jsonb, false
       ),
       '{contributor,label}', pg_catalog.to_jsonb('Deleted user'::text), false
     )
    FROM private.shared_reference_contributions c
   WHERE c.id=r.contribution_id AND c.owner_id=OLD.id;
  UPDATE private.shared_reference_contributions
     SET owner_id=NULL, source_measurement_set_id=NULL, status='withdrawn',
         withdrawn_at=coalesce(withdrawn_at,pg_catalog.clock_timestamp()),
         hidden_at=NULL, hidden_reason=NULL,
         updated_at=pg_catalog.clock_timestamp()
   WHERE owner_id=OLD.id;
  RETURN OLD;
END
$$;

CREATE FUNCTION public.search_public_reference_contributions(
  p_sporely_taxon_id integer,
  p_limit integer,
  p_after_shared_at timestamptz,
  p_after_id uuid
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_sporely_taxon_id IS NULL OR p_sporely_taxon_id <= 0 THEN
    RAISE EXCEPTION 'positive sporely_taxon_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'limit must be between 1 and 50' USING ERRCODE = '22023';
  END IF;
  IF (p_after_shared_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'both cursor components are required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT c.id, c.shared_at, r.envelope_json
      FROM private.shared_reference_contributions c
      JOIN private.shared_reference_contribution_revisions r
        ON r.contribution_id = c.id AND r.revision = c.current_revision
      JOIN public.profiles p ON p.id = c.owner_id AND p.is_banned IS FALSE
     WHERE c.sporely_taxon_id = p_sporely_taxon_id
       AND c.status = 'shared'
       AND c.hidden_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = c.owner_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), c.owner_id) IS NOT TRUE)
       AND (p_after_shared_at IS NULL OR c.shared_at < p_after_shared_at
         OR (c.shared_at = p_after_shared_at AND c.id > p_after_id))
     ORDER BY c.shared_at DESC, c.id ASC
     LIMIT p_limit
  ), bounded AS (
    SELECT candidates.*,
           pg_catalog.sum(pg_catalog.octet_length(envelope_json::text)) OVER (
             ORDER BY shared_at DESC, id ASC
           ) AS cumulative_bytes
      FROM candidates
  )
  SELECT envelope_json FROM bounded
   WHERE cumulative_bytes <= 1048576
   ORDER BY shared_at DESC, id ASC;
END
$$;

CREATE FUNCTION public.get_public_reference_contribution(
  p_contribution_id uuid,
  p_revision integer DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contribution private.shared_reference_contributions%ROWTYPE;
  v_revision integer;
BEGIN
  IF p_contribution_id IS NULL OR (p_revision IS NOT NULL AND p_revision < 1) THEN
    RAISE EXCEPTION 'valid contribution and revision are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_contribution FROM private.shared_reference_contributions c
   WHERE c.id = p_contribution_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_contribution.hidden_at IS NOT NULL
     OR (v_contribution.owner_id IS NOT NULL AND (NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.id=v_contribution.owner_id AND p.is_banned IS FALSE
     ) OR EXISTS (
       SELECT 1 FROM private.reference_account_deletions d
        WHERE d.user_id=v_contribution.owner_id
     ) OR (auth.uid() IS NOT NULL
       AND public.is_blocked_between(auth.uid(),v_contribution.owner_id) IS TRUE))) THEN
    RETURN;
  END IF;
  v_revision := coalesce(p_revision, v_contribution.current_revision);
  IF v_contribution.status = 'withdrawn' THEN
    IF p_revision IS NULL OR NOT EXISTS (
      SELECT 1 FROM private.shared_reference_contribution_revisions r
       WHERE r.contribution_id = p_contribution_id AND r.revision = p_revision
    ) THEN RETURN; END IF;
    RETURN NEXT pg_catalog.jsonb_build_object(
      'contribution_id', v_contribution.id,
      'revision', v_revision,
      'status', 'withdrawn',
      'withdrawn_at', v_contribution.withdrawn_at
    );
    RETURN;
  END IF;
  RETURN QUERY
  SELECT r.envelope_json
    FROM private.shared_reference_contribution_revisions r
    JOIN public.profiles p ON p.id = v_contribution.owner_id AND p.is_banned IS FALSE
   WHERE r.contribution_id = p_contribution_id AND r.revision = v_revision
     AND NOT EXISTS (
       SELECT 1 FROM private.reference_account_deletions d
        WHERE d.user_id = v_contribution.owner_id
     )
     AND (auth.uid() IS NULL
       OR public.is_blocked_between(auth.uid(), v_contribution.owner_id) IS NOT TRUE)
     AND pg_catalog.octet_length(r.envelope_json::text) <= 1048576;
END
$$;

CREATE FUNCTION private.refresh_shared_reference_for_use()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_taxon_id integer;
  v_work_revision integer;
  v_treatment_revision integer;
  v_set_revision integer;
  v_result jsonb;
  v_contribution_id uuid;
BEGIN
  -- Service-owned imports and account cleanup do not implicitly publish.
  IF v_owner IS NULL OR v_owner IS DISTINCT FROM NEW.user_id THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer
    INTO v_taxon_id
    FROM public.observations o
   WHERE o.user_id = NEW.user_id AND o.id = NEW.observation_id;
  IF v_taxon_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.observation_reference_uses u
        JOIN public.observations o ON o.user_id=u.user_id AND o.id=u.observation_id
       WHERE u.user_id=NEW.user_id
         AND u.reference_measurement_set_id=NEW.reference_measurement_set_id
         AND u.deleted_at IS NULL
         AND coalesce(o.selected_sporely_taxon_id,o.resolved_sporely_taxon_id)=v_taxon_id
    ) THEN
      SELECT c.id INTO v_contribution_id
        FROM private.shared_reference_contributions c
       WHERE c.owner_id=NEW.user_id
         AND c.source_measurement_set_id=NEW.reference_measurement_set_id
         AND c.sporely_taxon_id=v_taxon_id;
      IF FOUND THEN
        UPDATE private.shared_reference_contributions
           SET status='withdrawn',
               withdrawn_at=coalesce(withdrawn_at,pg_catalog.clock_timestamp()),
               updated_at=pg_catalog.clock_timestamp()
         WHERE id=v_contribution_id AND status='shared';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  SELECT w.revision,t.revision,m.revision
    INTO v_work_revision,v_treatment_revision,v_set_revision
    FROM public.reference_measurement_sets m
    JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id
   WHERE m.user_id=NEW.user_id AND m.id=NEW.reference_measurement_set_id
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_result := private.share_reference_contribution_for_owner(
    NEW.user_id,NEW.reference_measurement_set_id,v_taxon_id,
    v_work_revision,v_treatment_revision,v_set_revision
  );
  -- Sharing is derived best-effort from a successful owner sync. A source
  -- that cannot be projected safely remains private and must not roll back
  -- the owner's otherwise valid sync mutation.
  IF v_result->>'status' NOT IN ('created','updated','no_change') THEN RETURN NEW; END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.refresh_shared_references_for_measurement_set()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_use public.observation_reference_uses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM NEW.user_id
     OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  FOR v_use IN
    SELECT u.* FROM public.observation_reference_uses u
     WHERE u.user_id=NEW.user_id
       AND u.reference_measurement_set_id=NEW.id
       AND u.deleted_at IS NULL
  LOOP
    PERFORM private.refresh_shared_reference_for_use_row(v_use);
  END LOOP;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.refresh_shared_references_for_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_use public.observation_reference_uses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM NEW.user_id
     OR NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  FOR v_use IN
    SELECT u.*
      FROM public.observation_reference_uses u
      JOIN public.reference_measurement_sets m
        ON m.user_id=u.user_id AND m.id=u.reference_measurement_set_id
      JOIN public.reference_taxon_treatments t
        ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
     WHERE u.user_id=NEW.user_id AND u.deleted_at IS NULL
       AND (
         (TG_TABLE_NAME='reference_taxon_treatments' AND t.id=NEW.id)
         OR (TG_TABLE_NAME='reference_works' AND t.reference_work_id=NEW.id)
       )
  LOOP
    PERFORM private.refresh_shared_reference_for_use_row(v_use);
  END LOOP;
  RETURN NEW;
END
$$;

-- A row-taking helper keeps both triggers on the same policy path.
CREATE FUNCTION private.refresh_shared_reference_for_use_row(
  p_use public.observation_reference_uses
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_taxon_id integer;
  v_revisions record;
  v_result jsonb;
BEGIN
  IF ((auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_use.user_id)
      AND auth.role() <> 'service_role') OR p_use.deleted_at IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(o.selected_sporely_taxon_id,o.resolved_sporely_taxon_id)::integer
    INTO v_taxon_id FROM public.observations o
   WHERE o.user_id=p_use.user_id AND o.id=p_use.observation_id;
  IF v_taxon_id IS NULL THEN RETURN; END IF;
  SELECT w.revision AS work_revision,t.revision AS treatment_revision,m.revision AS set_revision
    INTO v_revisions
    FROM public.reference_measurement_sets m
    JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id
   WHERE m.user_id=p_use.user_id AND m.id=p_use.reference_measurement_set_id
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  BEGIN
    v_result := private.share_reference_contribution_for_owner(
      p_use.user_id,p_use.reference_measurement_set_id,v_taxon_id,
      v_revisions.work_revision,v_revisions.treatment_revision,v_revisions.set_revision
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  IF v_result->>'status' NOT IN ('created','updated','no_change') THEN
    RETURN;
  END IF;
END
$$;

CREATE FUNCTION private.refresh_shared_references_for_observation_taxon()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_taxon_id integer := coalesce(
    OLD.selected_sporely_taxon_id, OLD.resolved_sporely_taxon_id
  )::integer;
  v_new_taxon_id integer := coalesce(
    NEW.selected_sporely_taxon_id, NEW.resolved_sporely_taxon_id
  )::integer;
  v_use public.observation_reference_uses%ROWTYPE;
  v_contribution_id uuid;
BEGIN
  IF (((auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM NEW.user_id)
       AND auth.role() <> 'service_role')
      OR v_old_taxon_id IS NOT DISTINCT FROM v_new_taxon_id) THEN
    RETURN NEW;
  END IF;
  FOR v_use IN
    SELECT DISTINCT ON (u.reference_measurement_set_id) u.*
      FROM public.observation_reference_uses u
     WHERE u.user_id=NEW.user_id AND u.observation_id=NEW.id
       AND u.deleted_at IS NULL
     ORDER BY u.reference_measurement_set_id,u.id
  LOOP
    IF v_old_taxon_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM public.observation_reference_uses other_use
        JOIN public.observations other_observation
          ON other_observation.user_id=other_use.user_id
         AND other_observation.id=other_use.observation_id
       WHERE other_use.user_id=NEW.user_id
         AND other_use.reference_measurement_set_id=v_use.reference_measurement_set_id
         AND other_use.deleted_at IS NULL
         AND coalesce(
           other_observation.selected_sporely_taxon_id,
           other_observation.resolved_sporely_taxon_id
         )=v_old_taxon_id
    ) THEN
      SELECT c.id INTO v_contribution_id
        FROM private.shared_reference_contributions c
       WHERE c.owner_id=NEW.user_id
         AND c.source_measurement_set_id=v_use.reference_measurement_set_id
         AND c.sporely_taxon_id=v_old_taxon_id;
      IF FOUND THEN
        UPDATE private.shared_reference_contributions
           SET status='withdrawn',
               withdrawn_at=coalesce(withdrawn_at,pg_catalog.clock_timestamp()),
               updated_at=pg_catalog.clock_timestamp()
         WHERE id=v_contribution_id AND status='shared';
      END IF;
    END IF;
    IF v_new_taxon_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM taxonomy_v3.registry_concept c
       WHERE c.sporely_taxon_id=v_new_taxon_id AND c.rank='species'
    ) THEN
      PERFORM private.refresh_shared_reference_for_use_row(v_use);
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- Replace the use trigger body with the shared helper now that it exists.
CREATE OR REPLACE FUNCTION private.refresh_shared_reference_for_use()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_source_measurement_set_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_source_measurement_set_id := OLD.reference_measurement_set_id;
  ELSE
    v_user_id := NEW.user_id;
    v_source_measurement_set_id := NEW.reference_measurement_set_id;
  END IF;
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM v_user_id THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.deleted_at IS NULL THEN
    PERFORM private.refresh_shared_reference_for_use_row(NEW);
  END IF;
  UPDATE private.shared_reference_contributions c
     SET status='withdrawn',
         withdrawn_at=coalesce(c.withdrawn_at,pg_catalog.clock_timestamp()),
         updated_at=pg_catalog.clock_timestamp()
   WHERE c.owner_id=v_user_id
     AND c.source_measurement_set_id IN (
       v_source_measurement_set_id,
       CASE WHEN TG_OP='UPDATE' THEN OLD.reference_measurement_set_id ELSE NULL END
     )
     AND c.status='shared'
     AND NOT EXISTS (
       SELECT 1 FROM public.observation_reference_uses u
       JOIN public.observations o ON o.user_id=u.user_id AND o.id=u.observation_id
       WHERE u.user_id=c.owner_id
         AND u.reference_measurement_set_id=c.source_measurement_set_id
         AND u.deleted_at IS NULL
         AND coalesce(o.selected_sporely_taxon_id,o.resolved_sporely_taxon_id)=c.sporely_taxon_id
     );
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$$;

CREATE TRIGGER observation_reference_use_shared_contribution_trg
AFTER INSERT OR UPDATE OF deleted_at,reference_measurement_set_id,snapshot_json,reference_revision OR DELETE
ON public.observation_reference_uses
FOR EACH ROW EXECUTE FUNCTION private.refresh_shared_reference_for_use();

CREATE TRIGGER reference_measurement_set_shared_contribution_trg
AFTER UPDATE OF revision ON public.reference_measurement_sets
FOR EACH ROW EXECUTE FUNCTION private.refresh_shared_references_for_measurement_set();

CREATE TRIGGER reference_treatment_shared_contribution_trg
AFTER UPDATE OF revision ON public.reference_taxon_treatments
FOR EACH ROW EXECUTE FUNCTION private.refresh_shared_references_for_parent();

CREATE TRIGGER reference_work_shared_contribution_trg
AFTER UPDATE OF revision ON public.reference_works
FOR EACH ROW EXECUTE FUNCTION private.refresh_shared_references_for_parent();

CREATE TRIGGER observation_taxon_shared_contribution_trg
AFTER UPDATE OF selected_sporely_taxon_id,resolved_sporely_taxon_id
ON public.observations
FOR EACH ROW EXECUTE FUNCTION private.refresh_shared_references_for_observation_taxon();

CREATE TRIGGER profile_shared_contribution_anonymize_trg
BEFORE DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.anonymize_shared_reference_contributions_for_profile();

ALTER FUNCTION private.shared_reference_contribution_result(text,jsonb) OWNER TO postgres;
ALTER FUNCTION private.shared_reference_project_raw_points(jsonb) OWNER TO postgres;
ALTER FUNCTION private.shared_reference_contribution_envelope(uuid,integer,integer,text,uuid,jsonb,jsonb,timestamptz) OWNER TO postgres;
ALTER FUNCTION private.share_reference_contribution_for_owner(uuid,uuid,integer,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.share_reference_contribution(uuid,integer,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.withdraw_reference_contribution(uuid) OWNER TO postgres;
ALTER FUNCTION public.moderate_shared_reference_contribution(uuid,text,text) OWNER TO postgres;
ALTER FUNCTION public.search_public_reference_contributions(integer,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_public_reference_contribution(uuid,integer) OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_reference_for_use_row(public.observation_reference_uses) OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_reference_for_use() OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_references_for_measurement_set() OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_references_for_parent() OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_references_for_observation_taxon() OWNER TO postgres;
ALTER FUNCTION private.anonymize_shared_reference_contributions_for_profile() OWNER TO postgres;

REVOKE ALL ON TABLE private.shared_reference_contributions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.shared_reference_contribution_revisions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.shared_reference_contribution_result(text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.shared_reference_project_raw_points(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.shared_reference_contribution_envelope(uuid,integer,integer,text,uuid,jsonb,jsonb,timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.share_reference_contribution_for_owner(uuid,uuid,integer,integer,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.share_reference_contribution(uuid,integer,integer,integer,integer) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.withdraw_reference_contribution(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.moderate_shared_reference_contribution(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_public_reference_contributions(integer,integer,timestamptz,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_reference_contribution(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refresh_shared_reference_for_use_row(public.observation_reference_uses) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_reference_for_use() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_references_for_measurement_set() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_references_for_parent() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_references_for_observation_taxon() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.anonymize_shared_reference_contributions_for_profile() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.share_reference_contribution(uuid,integer,integer,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_reference_contribution(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_shared_reference_contribution(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_public_reference_contributions(integer,integer,timestamptz,uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_reference_contribution(uuid,integer) TO anon, authenticated, service_role;

COMMIT;
