-- Taxonomy v3 Stage 4W: Stage 4P Dyntaxa namespace in the cloud resolver and
-- Swedish display. Fixture mirrors the sporely-py Stage 4P approved build
-- evidence: 83668 (canonical Conocybe rugosa) bridged to
-- urn:lsid:dyntaxa.se:Taxon:3423 with sv "Pholiotina rugosa"; 617026
-- (canonical Conocybe vexans) has no Dyntaxa bridge and no sv name.
begin;

do $$
declare
  v_errors jsonb;
begin
  insert into public.taxonomy_v2_releases (
    release_id, taxonomy_schema_version, export_schema_version, manifest_schema_version,
    exporter_version, scope_predicate_id, source_gz_sha256, source_sqlite_sha256,
    whole_export_sha256, manifest_sha256, generated_at, status, row_counts,
    authoritative_namespace_counts, legacy_source_counts, dangling_parent_count,
    dangling_parent_report, source_manifest, loaded_at
  ) values (
    'tax-2026.09.30-01', 2, 1, 1, '1.1.0', 'fungi_closure_union_nortaxa_v1', repeat('a',64), repeat('b',64),
    repeat('c',64), repeat('d',64), now(), 'ready', '{}', '{}', '{}', 0, '{}', '{}', now()
  );
  insert into public.taxonomy_v2_concepts(sporely_taxon_id, first_seen_release_id)
  values (83668, 'tax-2026.09.30-01'), (617026, 'tax-2026.09.30-01')
  on conflict (sporely_taxon_id) do nothing;

  insert into public.taxonomy_v2_taxa(
    release_id, sporely_taxon_id, genus, specific_epithet, family, canonical_scientific_name,
    taxon_rank, canonical_source_system, canonical_external_id,
    preferred_scientific_name_sv, preferred_scientific_name_sv_source_system,
    preferred_scientific_name_sv_namespace, preferred_scientific_name_sv_external_id
  ) values
    ('tax-2026.09.30-01', 83668, 'Conocybe', 'rugosa', 'Bolbitiaceae', 'Conocybe rugosa',
     'species', 'col_xr', 'COL-83668', 'Pholiotina rugosa', 'dyntaxa', 'dyntaxa_taxon_id',
     'urn:lsid:dyntaxa.se:Taxon:3423'),
    ('tax-2026.09.30-01', 617026, 'Conocybe', 'vexans', 'Bolbitiaceae', 'Conocybe vexans',
     'species', 'col_xr', 'COL-617026', null, null, null, null);

  insert into public.taxonomy_v2_scientific_names(
    release_id, sporely_taxon_id, language_code, scientific_name, is_preferred_name, source, alias_reason
  ) values
    ('tax-2026.09.30-01', 83668, 'sci', 'Conocybe rugosa', true, 'col_xr', null),
    ('tax-2026.09.30-01', 83668, 'sci', 'Pholiotina rugosa', false, 'dyntaxa', 'manual_approved_exact'),
    ('tax-2026.09.30-01', 617026, 'sci', 'Conocybe vexans', true, 'col_xr', null);

  insert into public.taxonomy_v2_external_ids(
    release_id, sporely_taxon_id, source_system, namespace, external_id, id_role, is_preferred, external_name, note
  ) values
    ('tax-2026.09.30-01', 83668, 'col_xr', 'col_usage_id', 'COL-83668', 'accepted', true, 'Conocybe rugosa', null),
    ('tax-2026.09.30-01', 83668, 'dyntaxa', 'dyntaxa_taxon_id', 'urn:lsid:dyntaxa.se:Taxon:3423', 'accepted', false,
     'Pholiotina rugosa', 'authoritative_bridge:manual_approved_exact'),
    ('tax-2026.09.30-01', 617026, 'col_xr', 'col_usage_id', 'COL-617026', 'accepted', true, 'Conocybe vexans', null);

  v_errors := public.taxonomy_v2_national_name_errors('tax-2026.09.30-01');
  if v_errors <> '[]'::jsonb then
    raise exception 'Dyntaxa-provenance sv name reported errors: %', v_errors;
  end if;

  update public.taxonomy_v2_releases set status = 'retired' where status = 'active';
  update public.taxonomy_v2_releases set status = 'active' where release_id = 'tax-2026.09.30-01';

  -- A reviewed Dyntaxa LSID resolves to exactly its concept.
  if (select count(*) from public.resolve_taxon_external_id_v2('dyntaxa', 'dyntaxa_taxon_id', 'urn:lsid:dyntaxa.se:Taxon:3423')) <> 1
     or not exists (select 1 from public.resolve_taxon_external_id_v2('dyntaxa', 'dyntaxa_taxon_id', ' urn:lsid:dyntaxa.se:Taxon:3423 ') where taxon_id = 83668) then
    raise exception 'reviewed Dyntaxa LSID did not resolve to 83668';
  end if;

  -- Unknown LSID, bare number, synonym LSID, other namespace, name text: nothing.
  if exists (select 1 from public.resolve_taxon_external_id_v2('dyntaxa', 'dyntaxa_taxon_id', 'urn:lsid:dyntaxa.se:Taxon:999999999'))
     or exists (select 1 from public.resolve_taxon_external_id_v2('dyntaxa', 'dyntaxa_taxon_id', '3423'))
     or exists (select 1 from public.resolve_taxon_external_id_v2('dyntaxa', 'dyntaxa_taxon_id', 'urn:lsid:dyntaxa.se:TaxonName:3423'))
     or exists (select 1 from public.resolve_taxon_external_id_v2('artportalen', 'artportalen_taxon_id', '3423'))
     or exists (select 1 from public.resolve_taxon_external_id_v2('dyntaxa', 'dyntaxa_taxon_id', 'Pholiotina rugosa')) then
    raise exception 'an unreviewed or non-LSID Dyntaxa value resolved';
  end if;

  -- COL resolution unchanged.
  if not exists (select 1 from public.resolve_taxon_external_id_v2('col_xr', 'col_usage_id', 'COL-83668') where taxon_id = 83668 and is_preferred) then
    raise exception 'COL resolution changed';
  end if;

  -- Swedish UI shows the Dyntaxa name; other languages and 617026 fall back.
  if not exists (
    select 1 from public.search_taxa_v2('Conocybe rugosa', 'sv', 20) s
    where s.taxon_id = 83668 and s.display_scientific_name = 'Pholiotina rugosa'
      and s.canonical_scientific_name = 'Conocybe rugosa'
  ) or not exists (
    select 1 from public.search_taxa_v2('Pholiotina rugosa', 'sv', 20) s
    where s.taxon_id = 83668 and s.display_scientific_name = 'Pholiotina rugosa'
  ) then
    raise exception 'Swedish search did not show the Dyntaxa preferred name for 83668';
  end if;
  if not exists (
    select 1 from public.search_taxa_v2('Conocybe rugosa', 'no', 20) s
    where s.taxon_id = 83668 and s.display_scientific_name = 'Conocybe rugosa'
  ) then
    raise exception 'Norwegian display used the Swedish name';
  end if;
  if not exists (
    select 1 from public.search_taxa_v2('Conocybe vexans', 'sv', 20) s
    where s.taxon_id = 617026 and s.display_scientific_name = 'Conocybe vexans'
  ) then
    raise exception 'concept without a Swedish name did not fall back to canonical';
  end if;

  -- An ambiguous LSID returns both rows (the client then leaves it unresolved);
  -- the importer refuses such an export before it can be loaded.
  insert into public.taxonomy_v2_external_ids(
    release_id, sporely_taxon_id, source_system, namespace, external_id, id_role, is_preferred, external_name, note
  ) values ('tax-2026.09.30-01', 617026, 'dyntaxa', 'dyntaxa_taxon_id', 'urn:lsid:dyntaxa.se:Taxon:3423', 'accepted', false,
     'Pholiotina rugosa', 'authoritative_bridge:manual_approved_exact');
  if (select count(distinct taxon_id) from public.resolve_taxon_external_id_v2('dyntaxa', 'dyntaxa_taxon_id', 'urn:lsid:dyntaxa.se:Taxon:3423')) <> 2 then
    raise exception 'ambiguous Dyntaxa LSID was collapsed by the resolver';
  end if;

  raise notice 'taxonomy_v2_dyntaxa_test passed';
end $$;

rollback;
