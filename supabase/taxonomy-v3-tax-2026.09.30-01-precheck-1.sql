-- Runbook "Read-only pre-checks" step 1 for tax-2026.09.30-01. READ ONLY,
-- ends in ROLLBACK, raises on the first failure, prints a NOTICE on success.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE
  v_active text[];
  v_applied text[];
BEGIN
  SELECT array_agg(release_id ORDER BY release_id) INTO v_active
    FROM public.taxonomy_v2_releases WHERE status = 'active';
  IF v_active IS DISTINCT FROM ARRAY['tax-2026.09.26-02'] THEN
    RAISE EXCEPTION 'STOP: active releases are %, expected only tax-2026.09.26-02', v_active;
  END IF;
  IF EXISTS (SELECT 1 FROM public.taxonomy_v2_releases WHERE release_id = 'tax-2026.09.30-01') THEN
    RAISE EXCEPTION 'STOP: a tax-2026.09.30-01 release row already exists';
  END IF;

  SELECT array_agg(version ORDER BY version) INTO v_applied
    FROM supabase_migrations.schema_migrations
   WHERE version IN ('20260914090000', '20260930193000', '20260930193100');
  IF v_applied IS DISTINCT FROM ARRAY['20260930193000', '20260930193100'] THEN
    RAISE EXCEPTION 'STOP: of 20260914090000/20260930193000/20260930193100 applied: %, expected only the last two', v_applied;
  END IF;

  IF EXISTS (SELECT 1 FROM public.resolve_taxon_external_id_v2('nortaxa', 'nortaxa_taxon_id', '58766')) THEN
    RAISE EXCEPTION 'STOP: nortaxa/58766 already resolves';
  END IF;

  RAISE NOTICE 'pre-check 1 passed: only tax-2026.09.26-02 active; 20260930193000 and 20260930193100 applied, 20260914090000 not; nortaxa/58766 unresolved';
END $$;
ROLLBACK;
