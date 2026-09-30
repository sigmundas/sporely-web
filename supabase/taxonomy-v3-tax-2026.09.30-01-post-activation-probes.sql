-- Taxonomy v3 Stage 6W: read-only post-activation probes for tax-2026.09.30-01.
--
-- Run by the operator after the import payload has committed (runbook
-- `supabase/taxonomy-v2-production-import-runbook.md`, "Release transition:
-- tax-2026.09.30-01"). The whole script runs in a READ ONLY transaction that
-- ends in ROLLBACK, so it cannot change anything. Every probe RAISEs on
-- failure; the final NOTICE lists what passed. Resolver and search probes run
-- as `anon`, the role the clients reach them through.
--
-- The probes cover the taxonomy-v3 regression table (plan
-- `docs/plans/active/2026-09-27-taxonomy-v3.md` in sporely-py), with the
-- values the accepted Stage 6P export carries
-- (`database/taxonomy/evidence/taxonomy-v3/stage6p/release-candidate.json`).

\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

-- Release state, counts and identity continuity (as postgres: these read
-- tables that anon cannot).
DO $release$
BEGIN
  IF (SELECT count(*) FROM public.taxonomy_v2_releases WHERE status = 'active') <> 1
     OR NOT EXISTS (SELECT 1 FROM public.taxonomy_v2_releases WHERE release_id = 'tax-2026.09.30-01' AND status = 'active')
     OR NOT EXISTS (SELECT 1 FROM public.taxonomy_v2_releases WHERE release_id = 'tax-2026.09.26-02' AND status = 'retired') THEN
    RAISE EXCEPTION 'expected tax-2026.09.30-01 active, tax-2026.09.26-02 retired, exactly one active';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.taxonomy_v2_releases
     WHERE release_id = 'tax-2026.09.30-01'
       AND whole_export_sha256 = 'c7bb4b98e8312096a4468e739bd4d13c52418804b821cf2ea5fa2b979f2cfc79'
       AND manifest_sha256 = 'ee55d0d38be12acc7cec94c402952a95d1b92b5c7f335ec34f0fb68b72a7e8ac'
       AND source_gz_sha256 = '593cd5379bffd53a81a54735ab0ad99b97e7ef890060d6483bed42e4150e907f'
       AND source_sqlite_sha256 = '1a5758d39c90071095ce5c0f44063761693667c2970afe4ecec7c726c85356a2'
  ) THEN
    RAISE EXCEPTION 'active release hashes are not those of the Stage 6P export';
  END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_taxa WHERE release_id = 'tax-2026.09.30-01') <> 52917
     OR (SELECT count(*) FROM public.taxonomy_v2_scientific_names WHERE release_id = 'tax-2026.09.30-01') <> 60697
     OR (SELECT count(*) FROM public.taxonomy_v2_vernacular_names WHERE release_id = 'tax-2026.09.30-01') <> 13760
     OR (SELECT count(*) FROM public.taxonomy_v2_external_ids WHERE release_id = 'tax-2026.09.30-01') <> 56959
     OR (SELECT count(*) FROM public.taxonomy_v2_legacy_external_ids WHERE release_id = 'tax-2026.09.30-01') <> 0
     OR (SELECT count(*) FROM public.taxonomy_v2_redlist WHERE release_id = 'tax-2026.09.30-01') <> 2600 THEN
    RAISE EXCEPTION 'tax-2026.09.30-01 row counts differ from the Stage 6P export';
  END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_taxa WHERE release_id = 'tax-2026.09.30-01' AND preferred_scientific_name_no IS NOT NULL) <> 1992
     OR (SELECT count(*) FROM public.taxonomy_v2_taxa WHERE release_id = 'tax-2026.09.30-01' AND preferred_scientific_name_sv IS NOT NULL) <> 822 THEN
    RAISE EXCEPTION 'national preferred scientific-name counts differ from the Stage 6P export (no 1992, sv 822)';
  END IF;
  -- The concept set and every canonical name are those of tax-2026.09.26-02:
  -- no observation loses its concept, now or after a rollback.
  IF EXISTS (
    SELECT sporely_taxon_id, canonical_scientific_name FROM public.taxonomy_v2_taxa WHERE release_id = 'tax-2026.09.26-02'
    EXCEPT
    SELECT sporely_taxon_id, canonical_scientific_name FROM public.taxonomy_v2_taxa WHERE release_id = 'tax-2026.09.30-01'
  ) OR EXISTS (
    SELECT sporely_taxon_id, canonical_scientific_name FROM public.taxonomy_v2_taxa WHERE release_id = 'tax-2026.09.30-01'
    EXCEPT
    SELECT sporely_taxon_id, canonical_scientific_name FROM public.taxonomy_v2_taxa WHERE release_id = 'tax-2026.09.26-02'
  ) THEN
    RAISE EXCEPTION 'concept set or canonical scientific names differ between tax-2026.09.26-02 and tax-2026.09.30-01';
  END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_import_runs WHERE release_id = 'tax-2026.09.30-01' AND status = 'succeeded') <> 1 THEN
    RAISE EXCEPTION 'expected one succeeded import run for tax-2026.09.30-01';
  END IF;
END
$release$;

SET LOCAL ROLE anon;

DO $regressions$
DECLARE
  resolves_to_one CONSTANT text := 'SELECT count(DISTINCT taxon_id) = 1 AND bool_and(taxon_id = $4) FROM public.resolve_taxon_external_id_v2($1, $2, $3)';
  ok boolean;
  probe record;
BEGIN
  -- Bridges that must resolve to exactly their concept.
  FOR probe IN SELECT * FROM (VALUES
    ('nortaxa', 'nortaxa_taxon_id', '53482', 7821::bigint),                    -- Entoloma conferendum, unchanged
    ('dyntaxa', 'dyntaxa_taxon_id', 'urn:lsid:dyntaxa.se:Taxon:3957', 7821),   -- Stage 4P
    ('nortaxa', 'nortaxa_taxon_id', '52369', 83668),                           -- Pholiotina rugosa, unchanged
    ('nortaxa', 'nortaxa_taxon_id', '58722', 83668),                           -- its synonym, unchanged
    ('dyntaxa', 'dyntaxa_taxon_id', 'urn:lsid:dyntaxa.se:Taxon:3423', 83668),  -- Stage 4P
    ('nortaxa', 'nortaxa_taxon_id', '58766', 617026),                          -- Stage 2 supersession 627000 -> 617026
    ('nortaxa', 'nortaxa_taxon_id', '56210', 168873),                          -- Stage 2 supersession, Cantharellus cibarius
    ('nortaxa', 'nortaxa_taxon_id', '56449', 11307)                            -- Stage 2 reconciled Gloeophyllum odoratum
  ) v(source_system, namespace, external_id, taxon_id) LOOP
    EXECUTE resolves_to_one INTO ok USING probe.source_system, probe.namespace, probe.external_id, probe.taxon_id;
    IF ok IS NOT TRUE THEN
      RAISE EXCEPTION 'resolver probe failed: %/%/% should resolve only to %', probe.source_system, probe.namespace, probe.external_id, probe.taxon_id;
    END IF;
  END LOOP;

  -- Ids that must stay unresolved: an unapproved association, a Sporely id
  -- passed as a NorTaxa id, and a bare Dyntaxa number without its LSID prefix.
  FOR probe IN SELECT * FROM (VALUES
    ('nortaxa', 'nortaxa_taxon_id', '56227'),   -- Craterellus tubaeformis, single_shared_synonym_low_overlap, not approved
    ('nortaxa', 'nortaxa_taxon_id', '7821'),
    ('dyntaxa', 'dyntaxa_taxon_id', '3957')
  ) v(source_system, namespace, external_id) LOOP
    IF EXISTS (SELECT 1 FROM public.resolve_taxon_external_id_v2(probe.source_system, probe.namespace, probe.external_id)) THEN
      RAISE EXCEPTION 'resolver probe failed: %/%/% must not resolve', probe.source_system, probe.namespace, probe.external_id;
    END IF;
  END LOOP;

  -- Search and display: (query, UI language, concept, expected display name).
  FOR probe IN SELECT * FROM (VALUES
    ('Entoloma conferendum',   'no', 7821::bigint, 'Entoloma conferendum'),
    ('stjernesporet rødspore', 'no', 7821,         'Entoloma conferendum'),
    ('Stjärnrödhätting',       'sv', 7821,         'Entoloma conferendum'),
    ('Pholiotina rugosa',      'no', 83668,        'Pholiotina rugosa'),
    ('Conocybe rugosa',        'no', 83668,        'Pholiotina rugosa'),
    ('slank ringkjeglesopp',   'no', 83668,        'Pholiotina rugosa'),
    ('Conocybe rugosa',        'sv', 83668,        'Pholiotina rugosa'),    -- Dyntaxa 3423 (owner decision ec231125b0c84fbea345900eba5f3c4f)
    ('Pholiotina rugosa',      'en', 83668,        'Conocybe rugosa'),      -- no national name for English: canonical COL
    ('Craterellus tubaeformis','no', 620306,       'Craterellus tubaeformis'),
    ('traktkantarell',         'no', 620306,       'Craterellus tubaeformis'),
    ('Trattkantarell',         'sv', 620306,       'Craterellus tubaeformis'),
    ('Conocybe vexans',        'no', 617026,       'Pholiotina vexans'),
    ('Pholiotina vexans',      'no', 617026,       'Pholiotina vexans'),
    ('vrang ringerlehatt',     'no', 617026,       'Pholiotina vexans'),
    ('Conocybe vexans',        'sv', 617026,       'Conocybe vexans'),      -- no Swedish national name: canonical COL
    ('kantarell',              'no', 168873,       'Cantharellus cibarius'),
    ('Cantharellus cibarius',  'no', 168873,       'Cantharellus cibarius')
  ) v(query, lang, taxon_id, display_name) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.search_taxa_v2(probe.query, probe.lang, 50) s
       WHERE s.taxon_id = probe.taxon_id AND s.display_scientific_name = probe.display_name
    ) THEN
      RAISE EXCEPTION 'search probe failed: % (%) should find % displayed as %', probe.query, probe.lang, probe.taxon_id, probe.display_name;
    END IF;
  END LOOP;

  -- National names on the regression concepts, and none on 620306.
  IF NOT EXISTS (SELECT 1 FROM public.search_taxa_v2('Conocybe rugosa', 'no', 50) s
                  WHERE s.taxon_id = 83668 AND s.preferred_scientific_name_no = 'Pholiotina rugosa' AND s.preferred_scientific_name_sv = 'Pholiotina rugosa' AND s.canonical_scientific_name = 'Conocybe rugosa')
     OR NOT EXISTS (SELECT 1 FROM public.search_taxa_v2('Conocybe vexans', 'no', 50) s
                  WHERE s.taxon_id = 617026 AND s.preferred_scientific_name_no = 'Pholiotina vexans' AND s.preferred_scientific_name_sv IS NULL AND s.canonical_scientific_name = 'Conocybe vexans')
     OR NOT EXISTS (SELECT 1 FROM public.search_taxa_v2('Craterellus tubaeformis', 'no', 50) s
                  WHERE s.taxon_id = 620306 AND s.preferred_scientific_name_no IS NULL AND s.preferred_scientific_name_sv IS NULL) THEN
    RAISE EXCEPTION 'national preferred scientific-name probe failed';
  END IF;

  RAISE NOTICE 'tax-2026.09.30-01 post-activation probes passed: release state, counts, identity continuity, 8 resolving and 3 unresolved ids, 17 search/display probes, national names';
END
$regressions$;

ROLLBACK;
