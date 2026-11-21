-- Validates 20261119120000_harden_legacy_search_taxa.sql.
--
-- The legacy search_taxa RPC pins its search_path and clamps `lim` to 1..50
-- (NULL falls back to 20),
-- matching search_taxa_v2, while still returning ordinary results to anon.
--
-- Run after local migrations (rolls back its seed data):
--   supabase db query --local -f supabase/tests/search_taxa_hardening_test.sql

BEGIN;

DO $$
DECLARE
  v_count integer;
  v_config text[];
  v_first text;
BEGIN
  INSERT INTO public.taxa (taxon_id, genus, specific_epithet, canonical_scientific_name, family)
  SELECT 990000000 + g, 'Zzsearchtestus', 'species' || lpad(g::text, 3, '0'),
         'Zzsearchtestus species' || lpad(g::text, 3, '0'), 'Zztestaceae'
  FROM generate_series(1, 60) g;

  SELECT p.proconfig INTO v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.oid = 'public.search_taxa(text,text,integer)'::regprocedure;
  IF v_config IS NULL OR NOT ('search_path=public, pg_catalog' = ANY (v_config)) THEN
    RAISE EXCEPTION 'S1: search_taxa must pin search_path, got %', v_config;
  END IF;

  SET LOCAL ROLE anon;

  SELECT count(*) INTO v_count FROM public.search_taxa('Zzsearchtestus', 'no', NULL);
  IF v_count <> 20 THEN RAISE EXCEPTION 'S2: NULL lim must fall back to 20 (not LIMIT ALL), got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM public.search_taxa('Zzsearchtestus', 'no', 100000);
  IF v_count <> 50 THEN RAISE EXCEPTION 'S3: huge lim must clamp to 50, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM public.search_taxa('Zzsearchtestus', 'no', 0);
  IF v_count <> 1 THEN RAISE EXCEPTION 'S4: zero lim must clamp to 1, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM public.search_taxa('Zzsearchtestus', 'no', -5);
  IF v_count <> 1 THEN RAISE EXCEPTION 'S5: negative lim must clamp to 1, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM public.search_taxa('Zzsearchtestus');
  IF v_count <> 20 THEN RAISE EXCEPTION 'S6: default lim must stay 20, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM public.search_taxa('Zzsearchtestus', 'no', 7);
  IF v_count <> 7 THEN RAISE EXCEPTION 'S7: an in-range lim must be honoured, got %', v_count; END IF;

  SELECT canonical_scientific_name INTO v_first
  FROM public.search_taxa('Zzsearchtestus species00', 'no', 3) LIMIT 1;
  IF v_first IS DISTINCT FROM 'Zzsearchtestus species001' THEN
    RAISE EXCEPTION 'S8: ordering must be unchanged, first was %', v_first;
  END IF;

  RESET ROLE;
  RAISE NOTICE 'search_taxa_hardening_test: all checks passed';
END
$$;

ROLLBACK;
