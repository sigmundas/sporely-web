-- Stage 2c, candidate 1 (server) of
-- docs/plans/active/2026-10-01-reference-sharing-roles-and-publish-notice.md.
--
--   * private.reference_contribution_is_served: the one "is served" check for
--     a shared contribution (status, consent, hidden, owner, current revision
--     in the consent period, 1 MiB envelope cap);
--   * private.reference_contribution_public_roles: the sorted distinct roles
--     of the owner's uses that search_public_observation_references serves
--     for the contribution (same qualifying-use predicate, same content
--     proof), [] when none;
--   * public.search_public_reference_contributions_v2 and
--     public.get_public_reference_contribution_v2: today's reads plus
--     relationship_roles on served shared rows (never on tombstones), as
--     rate-limited wrappers over REVOKEd _unthrottled bodies;
--   * today's search returns no shared rows and today's get returns only the
--     withdrawn tombstone stub, so clients without labels list nothing;
--   * list_my_shared_reference_contributions gains source_measurement_set_id;
--   * consent text version 1 (never active) is edited in place, guarded.
--
-- Does not redefine the six functions the deferred 20260914090000 redefines.

BEGIN;

-- Text row first, then the contributions, as a grant takes them. EXCLUSIVE
-- blocks writes and row locks, not plain reads.
LOCK TABLE private.reference_share_consent_texts,
           private.shared_reference_contributions,
           private.shared_reference_consent_events
  IN EXCLUSIVE MODE;

-- 1. The "is served" check ----------------------------------------------------
-- p_enforce_envelope_cap = false leaves the 1 MiB cap to the caller: search
-- applies it across the whole page, get to the revision it serves.
CREATE FUNCTION private.reference_contribution_is_served(
  p_contribution_id uuid,
  p_enforce_envelope_cap boolean DEFAULT true
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM private.shared_reference_contributions c
      JOIN private.shared_reference_contribution_revisions r
        ON r.contribution_id = c.id AND r.revision = c.current_revision
      JOIN public.profiles p ON p.id = c.owner_id AND p.is_banned IS FALSE
     WHERE c.id = p_contribution_id
       AND c.status = 'shared' AND c.hidden_at IS NULL
       AND c.consented_at IS NOT NULL
       AND r.revision >= c.consent_first_revision
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = c.owner_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), c.owner_id) IS NOT TRUE)
       AND (p_enforce_envelope_cap IS FALSE
            OR pg_catalog.octet_length(r.envelope_json::text) <= 1048576)
  )
$$;

-- 2. Public roles ---------------------------------------------------------------
-- Exactly the uses search_public_observation_references serves for this
-- contribution: the observation is eligible there, the use qualifies, its
-- public snapshot exists and equals the snapshot of a consented revision
-- once the four rewritten identity keys are stripped.
CREATE FUNCTION private.reference_contribution_public_roles(p_contribution_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT pg_catalog.array_agg(DISTINCT u.role::text ORDER BY u.role::text)
      FROM private.shared_reference_contributions c
      JOIN public.profiles p ON p.id = c.owner_id AND p.is_banned IS FALSE
      JOIN public.observation_reference_uses u
        ON u.user_id = c.owner_id
       AND u.reference_measurement_set_id = c.source_measurement_set_id
       AND u.deleted_at IS NULL
      JOIN public.observations o ON o.id = u.observation_id AND o.user_id = u.user_id
      CROSS JOIN LATERAL (
        SELECT private.public_reference_snapshot(
          u.snapshot_json, u.reference_measurement_set_id, u.reference_revision
        ) AS snapshot
      ) sanitized
     WHERE c.id = p_contribution_id
       AND c.status = 'shared'
       AND c.consented_at IS NOT NULL
       AND c.hidden_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = c.owner_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), c.owner_id) IS NOT TRUE)
       AND o.visibility = 'public'::text
       AND NOT coalesce(o.is_draft, false)
       AND coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer = c.sporely_taxon_id
       AND sanitized.snapshot IS NOT NULL
       AND u.id IN (
         SELECT q.id FROM private.reference_qualifying_use_ids(
           c.owner_id, c.source_measurement_set_id, c.sporely_taxon_id
         ) AS q(id)
       )
       AND EXISTS (
         SELECT 1 FROM private.shared_reference_contribution_revisions r
          WHERE r.contribution_id = c.id
            AND r.revision >= c.consent_first_revision
            AND (r.envelope_json->'snapshot')
                  - ARRAY['reference_work_id','reference_treatment_id',
                          'reference_measurement_set_id','reference_revision']
                = sanitized.snapshot
                  - ARRAY['reference_work_id','reference_treatment_id',
                          'reference_measurement_set_id','reference_revision']
       )
  ), '{}'::text[])
$$;

-- 3. The _v2 reads ----------------------------------------------------------------
-- Same arguments, filters, limits and page cap as today's search; the cap is
-- measured on the stored envelopes, as today.
CREATE FUNCTION private.search_public_reference_contributions_v2_unthrottled(
  p_sporely_taxon_id integer,
  p_limit integer,
  p_after_shared_at timestamptz,
  p_after_id uuid
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_sporely_taxon_id IS NULL OR p_sporely_taxon_id <= 0 THEN
    RAISE EXCEPTION 'positive sporely_taxon_id is required' USING ERRCODE='22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;
  IF (p_after_shared_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'both cursor components are required' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT c.id,c.shared_at,r.envelope_json
      FROM private.shared_reference_contributions c
      JOIN private.shared_reference_contribution_revisions r
        ON r.contribution_id=c.id AND r.revision=c.current_revision
     WHERE c.sporely_taxon_id=p_sporely_taxon_id
       AND private.reference_contribution_is_served(c.id, false)
       AND (p_after_shared_at IS NULL OR c.shared_at < p_after_shared_at
         OR (c.shared_at=p_after_shared_at AND c.id > p_after_id))
     ORDER BY c.shared_at DESC,c.id ASC
     LIMIT p_limit
  ), bounded AS (
    SELECT candidates.*,
           pg_catalog.sum(pg_catalog.octet_length(envelope_json::text)) OVER (
             ORDER BY shared_at DESC,id ASC
           ) AS cumulative_bytes
      FROM candidates
  )
  SELECT envelope_json || pg_catalog.jsonb_build_object(
           'relationship_roles',
           pg_catalog.to_jsonb(private.reference_contribution_public_roles(id)))
    FROM bounded WHERE cumulative_bytes <= 1048576
   ORDER BY shared_at DESC,id ASC;
END
$$;

-- Tombstone and revision rules exactly as today's get; the shared-row path is
-- gated by the served check, and every served shared envelope carries
-- relationship_roles. The tombstone stub carries none.
CREATE FUNCTION private.get_public_reference_contribution_v2_unthrottled(
  p_contribution_id uuid,
  p_revision integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
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
  IF NOT private.reference_contribution_is_served(p_contribution_id, false)
     OR v_revision < v_contribution.consent_first_revision THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT r.envelope_json || pg_catalog.jsonb_build_object(
           'relationship_roles',
           pg_catalog.to_jsonb(private.reference_contribution_public_roles(p_contribution_id)))
    FROM private.shared_reference_contribution_revisions r
   WHERE r.contribution_id = p_contribution_id AND r.revision = v_revision
     AND pg_catalog.octet_length(r.envelope_json::text) <= 1048576;
END
$$;

CREATE FUNCTION public.search_public_reference_contributions_v2(
  p_sporely_taxon_id integer,
  p_limit integer DEFAULT NULL,
  p_after_shared_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_policy private.shared_reference_production_policy%ROWTYPE;
  v_retry_after integer;
BEGIN
  SELECT * INTO STRICT v_policy
    FROM private.shared_reference_production_policy WHERE singleton;
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > v_policy.catalogue_max_page_size) THEN
    RAISE EXCEPTION 'limit must be between 1 and %',v_policy.catalogue_max_page_size
      USING ERRCODE='22023';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    PERFORM pg_catalog.set_config('response.status','429',true);
    PERFORM pg_catalog.set_config(
      'response.headers',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'Retry-After',v_retry_after::text
      ))::text,true
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM private.search_public_reference_contributions_v2_unthrottled(
    p_sporely_taxon_id,coalesce(p_limit,v_policy.catalogue_default_page_size),
    p_after_shared_at,p_after_id
  );
END
$$;

CREATE FUNCTION public.get_public_reference_contribution_v2(
  p_contribution_id uuid,
  p_revision integer DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    PERFORM pg_catalog.set_config('response.status','429',true);
    PERFORM pg_catalog.set_config(
      'response.headers',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'Retry-After',v_retry_after::text
      ))::text,true
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM private.get_public_reference_contribution_v2_unthrottled(
    p_contribution_id,p_revision
  );
END
$$;

-- 4. Today's reads: no shared rows -------------------------------------------------
-- Arguments are still validated; the wrappers (rate limit, page policy) are
-- unchanged.
CREATE OR REPLACE FUNCTION public.search_public_reference_contributions_unthrottled(
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
    RAISE EXCEPTION 'positive sporely_taxon_id is required' USING ERRCODE='22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;
  IF (p_after_shared_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'both cursor components are required' USING ERRCODE='22023';
  END IF;
  -- Shared contributions are listed only by search_public_reference_contributions_v2.
  RETURN;
END
$$;

CREATE OR REPLACE FUNCTION public.get_public_reference_contribution_unthrottled(
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
    -- Unchanged tombstone stub; it carries no account data.
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
  -- Shared envelopes and their revisions are served only by
  -- get_public_reference_contribution_v2.
  RETURN;
END
$$;

-- 5. The owner list gains source_measurement_set_id (the owner's own data) --------
CREATE OR REPLACE FUNCTION private.list_my_shared_reference_contributions_unthrottled()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'contributions', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'contribution_id', c.id,
               'status', c.status,
               'sporely_taxon_id', c.sporely_taxon_id,
               'canonical_scientific_name', rc.canonical_name,
               'current_revision', c.current_revision,
               'shared_at', c.shared_at,
               'withdrawn_at', c.withdrawn_at,
               'hidden_at', c.hidden_at,
               'withdrawal_reason', CASE WHEN c.status = 'withdrawn' THEN (
                 SELECT e.reason FROM private.shared_reference_consent_events e
                  WHERE e.contribution_id = c.id AND e.event <> 'granted'
                  ORDER BY e.id DESC LIMIT 1) END,
               'source_measurement_set_id', c.source_measurement_set_id,
               -- The owner's own source labels, so several sets for one
               -- species can be told apart.
               'source_short_label', src.short_label,
               'source_raw_text', src.raw_text
             ) ORDER BY c.shared_at DESC, c.id)
        FROM private.shared_reference_contributions c
        LEFT JOIN taxonomy_v3.registry_concept rc ON rc.sporely_taxon_id = c.sporely_taxon_id
        LEFT JOIN LATERAL (
          SELECT coalesce(nullif(pg_catalog.btrim(w.short_label), ''), pg_catalog.left(w.title, 200)) AS short_label,
                 pg_catalog.left(m.raw_text, 200) AS raw_text
            FROM public.reference_measurement_sets m
            JOIN public.reference_taxon_treatments t
              ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
            JOIN public.reference_works w
              ON w.user_id = t.user_id AND w.id = t.reference_work_id
           WHERE m.user_id = v_owner AND m.id = c.source_measurement_set_id
        ) src ON true
       WHERE c.owner_id = v_owner
    ), '[]'::jsonb)
  );
END
$$;

-- 6. Consent text version 1, edited in place (it has never been active) ------------
-- Adds, after the paragraph on observations, how a shared reference is
-- labelled wherever it is listed publicly. Everything else is unchanged.
DO $$
DECLARE
  v_anchor_en constant text := 'The reference also appears on your public observations that use it, with how you used it (compared, supports or contradicts the identification).';
  v_added_en constant text := 'Wherever your shared reference is listed publicly, it is marked with how you use it on your public observations of this species (compared, supports or contradicts the identification). The label combines all of them and updates when you change how you use the reference.';
  v_anchor_nb constant text := 'Referansen vises også på de offentlige observasjonene dine som bruker den, med hvordan du brukte den (sammenlignet, støtter eller motsier bestemmelsen).';
  v_added_nb constant text := 'Overalt der den delte referansen din er oppført offentlig, er den merket med hvordan du bruker den på de offentlige observasjonene dine av denne arten (sammenlignet, støtter eller motsier bestemmelsen). Merkingen samler alle bruksmåtene og oppdateres når du endrer hvordan du bruker referansen.';
  v_count integer;
BEGIN
  IF (SELECT pg_catalog.count(*) FROM private.reference_share_consent_texts
       WHERE version = 1 AND locale IN ('en', 'nb') AND NOT active AND NOT revoked) <> 2 THEN
    RAISE EXCEPTION 'consent text v1 must be inactive and unrevoked in en and nb'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions WHERE consent_version = 1)
     OR EXISTS (SELECT 1 FROM private.shared_reference_consent_events WHERE consent_version = 1) THEN
    RAISE EXCEPTION 'consent text v1 is referenced by a contribution or consent event'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM private.reference_share_consent_texts ct
     WHERE ct.version = 1
       AND ((ct.locale = 'en' AND (pg_catalog.strpos(ct.text, v_anchor_en) = 0
                                   OR pg_catalog.strpos(ct.text, v_added_en) > 0))
         OR (ct.locale = 'nb' AND (pg_catalog.strpos(ct.text, v_anchor_nb) = 0
                                   OR pg_catalog.strpos(ct.text, v_added_nb) > 0)))
  ) THEN
    RAISE EXCEPTION 'consent text v1 is not the shipped wording' USING ERRCODE = '55000';
  END IF;
  WITH edited AS (
    SELECT ct.version, ct.locale,
           CASE ct.locale
             WHEN 'en' THEN pg_catalog.replace(ct.text, v_anchor_en, v_anchor_en || E'\n\n' || v_added_en)
             ELSE pg_catalog.replace(ct.text, v_anchor_nb, v_anchor_nb || E'\n\n' || v_added_nb)
           END AS body
      FROM private.reference_share_consent_texts ct
     WHERE ct.version = 1 AND ct.locale IN ('en', 'nb')
  )
  UPDATE private.reference_share_consent_texts ct
     SET text = e.body,
         text_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(e.body, 'UTF8')), 'hex')
    FROM edited e
   WHERE ct.version = e.version AND ct.locale = e.locale
     AND NOT ct.active AND NOT ct.revoked;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'consent text v1 edit changed % rows, expected 2', v_count
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- 7. Ownership and execution surface ----------------------------------------------

ALTER FUNCTION private.reference_contribution_is_served(uuid,boolean) OWNER TO postgres;
ALTER FUNCTION private.reference_contribution_public_roles(uuid) OWNER TO postgres;
ALTER FUNCTION private.search_public_reference_contributions_v2_unthrottled(integer,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION private.get_public_reference_contribution_v2_unthrottled(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_public_reference_contribution_v2(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.search_public_reference_contributions_unthrottled(integer,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_public_reference_contribution_unthrottled(uuid,integer) OWNER TO postgres;
ALTER FUNCTION private.list_my_shared_reference_contributions_unthrottled() OWNER TO postgres;

REVOKE ALL ON FUNCTION private.reference_contribution_is_served(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_contribution_public_roles(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.search_public_reference_contributions_v2_unthrottled(integer,integer,timestamptz,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.get_public_reference_contribution_v2_unthrottled(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_public_reference_contributions_unthrottled(integer,integer,timestamptz,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_public_reference_contribution_unthrottled(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.list_my_shared_reference_contributions_unthrottled() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_public_reference_contribution_v2(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_reference_contribution_v2(uuid,integer) TO anon, authenticated;

COMMIT;
