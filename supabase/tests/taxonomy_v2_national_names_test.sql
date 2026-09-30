-- Taxonomy v3 Stage 3W: national preferred scientific names in search_taxa_v2.
-- Fixture mirrors the regression species: 83668 (canonical Conocybe rugosa,
-- NorTaxa bridge 52369 with accepted name Pholiotina rugosa, nb slank
-- ringkjeglesopp) and 7821 (Entoloma conferendum, no national name).
begin;

do $$
declare
  r record;
  v_errors jsonb;
begin
  insert into public.taxonomy_v2_releases (
    release_id, taxonomy_schema_version, export_schema_version, manifest_schema_version,
    exporter_version, scope_predicate_id, source_gz_sha256, source_sqlite_sha256,
    whole_export_sha256, manifest_sha256, generated_at, status, row_counts,
    authoritative_namespace_counts, legacy_source_counts, dangling_parent_count,
    dangling_parent_report, source_manifest, loaded_at
  ) values (
    'tax-2026.09.29-01', 2, 1, 1, '1.1.0', 'fungi_closure_union_nortaxa_v1', repeat('a',64), repeat('b',64),
    repeat('c',64), repeat('d',64), now(), 'ready', '{}', '{}', '{}', 0, '{}', '{}', now()
  );
  insert into public.taxonomy_v2_concepts(sporely_taxon_id, first_seen_release_id)
  values (83668, 'tax-2026.09.29-01'), (7821, 'tax-2026.09.29-01')
  on conflict (sporely_taxon_id) do nothing;

  insert into public.taxonomy_v2_taxa(
    release_id, sporely_taxon_id, genus, specific_epithet, family, canonical_scientific_name,
    taxon_rank, canonical_source_system, canonical_external_id,
    preferred_scientific_name_no, preferred_scientific_name_no_source_system,
    preferred_scientific_name_no_namespace, preferred_scientific_name_no_external_id
  ) values
    ('tax-2026.09.29-01', 83668, 'Conocybe', 'rugosa', 'Bolbitiaceae', 'Conocybe rugosa',
     'species', 'col_xr', 'COL-83668', 'Pholiotina rugosa', 'nortaxa', 'nortaxa_taxon_id', '52369'),
    ('tax-2026.09.29-01', 7821, 'Entoloma', 'conferendum', 'Entolomataceae', 'Entoloma conferendum',
     'species', 'col_xr', 'COL-7821', null, null, null, null);

  insert into public.taxonomy_v2_scientific_names(
    release_id, sporely_taxon_id, language_code, scientific_name, is_preferred_name, source, alias_reason
  ) values
    ('tax-2026.09.29-01', 83668, 'sci', 'Conocybe rugosa', true, 'col_xr', null),
    ('tax-2026.09.29-01', 83668, 'sci', 'Pholiotina rugosa', false, 'nortaxa', 'manual_approved_exact'),
    ('tax-2026.09.29-01', 7821, 'sci', 'Entoloma conferendum', true, 'col_xr', null);

  insert into public.taxonomy_v2_vernacular_names(
    release_id, sporely_taxon_id, language_code, vernacular_name, is_preferred_name, source
  ) values
    ('tax-2026.09.29-01', 83668, 'nb', 'slank ringkjeglesopp', true, 'nortaxa'),
    ('tax-2026.09.29-01', 7821, 'sv', 'Stjärnrödhätting', true, 'dyntaxa');

  insert into public.taxonomy_v2_external_ids(
    release_id, sporely_taxon_id, source_system, namespace, external_id, id_role, is_preferred, external_name, note
  ) values
    ('tax-2026.09.29-01', 83668, 'nortaxa', 'nortaxa_taxon_id', '52369', 'accepted', false,
     'Pholiotina rugosa', 'authoritative_bridge:manual_mapping');

  v_errors := public.taxonomy_v2_national_name_errors('tax-2026.09.29-01');
  if v_errors <> '[]'::jsonb then
    raise exception 'clean fixture reported national-name errors: %', v_errors;
  end if;

  update public.taxonomy_v2_releases set status = 'retired' where status = 'active';
  update public.taxonomy_v2_releases set status = 'active' where release_id = 'tax-2026.09.29-01';

  -- Norwegian UI: national name is displayed; either name finds 83668.
  for r in select * from (values ('Pholiotina rugosa'), ('Conocybe rugosa'), ('slank ringkjeglesopp')) q(query) loop
    if not exists (
      select 1 from public.search_taxa_v2(r.query, 'no', 20) s
      where s.taxon_id = 83668
        and s.display_scientific_name = 'Pholiotina rugosa'
        and s.canonical_scientific_name = 'Conocybe rugosa'
        and s.genus = 'Conocybe' and s.specific_epithet = 'rugosa'
        and s.vernacular_name = 'slank ringkjeglesopp'
        and s.preferred_scientific_name_no = 'Pholiotina rugosa'
    ) then
      raise exception 'Norwegian search % did not return 83668 with the national display name', r.query;
    end if;
  end loop;

  -- Swedish and other UI languages: canonical name; both names still find 83668.
  for r in select * from (values ('sv'), ('en'), ('de')) l(lang) loop
    if not exists (
      select 1 from public.search_taxa_v2('Pholiotina rugosa', r.lang, 20) s
      where s.taxon_id = 83668 and s.display_scientific_name = 'Conocybe rugosa' and s.vernacular_name is null
    ) or not exists (
      select 1 from public.search_taxa_v2('Conocybe rugosa', r.lang, 20) s
      where s.taxon_id = 83668 and s.display_scientific_name = 'Conocybe rugosa'
    ) then
      raise exception '% search did not return 83668 with the canonical display name', r.lang;
    end if;
  end loop;

  -- A concept without an approved national identity shows the COL name.
  if not exists (
    select 1 from public.search_taxa_v2('Entoloma conferendum', 'no', 20) s
    where s.taxon_id = 7821 and s.display_scientific_name = 'Entoloma conferendum'
      and s.preferred_scientific_name_no is null
  ) then
    raise exception 'concept without a national name did not fall back to canonical';
  end if;

  -- Traceability: a name whose bridge row is missing is reported.
  delete from public.taxonomy_v2_external_ids where release_id = 'tax-2026.09.29-01';
  v_errors := public.taxonomy_v2_national_name_errors('tax-2026.09.29-01');
  if v_errors <> '["preferred_scientific_name_no of 83668 has no authoritative bridge row"]'::jsonb then
    raise exception 'missing bridge row not reported: %', v_errors;
  end if;

  -- A name that is not one of the concept's scientific names is reported.
  delete from public.taxonomy_v2_scientific_names
    where release_id = 'tax-2026.09.29-01' and scientific_name = 'Pholiotina rugosa';
  v_errors := public.taxonomy_v2_national_name_errors('tax-2026.09.29-01');
  if not v_errors ? 'preferred_scientific_name_no of 83668 is not a scientific name of the concept' then
    raise exception 'missing scientific-name row not reported: %', v_errors;
  end if;

  -- Partial provenance is rejected by the table itself.
  begin
    update public.taxonomy_v2_taxa set preferred_scientific_name_no_external_id = null
      where release_id = 'tax-2026.09.29-01' and sporely_taxon_id = 83668;
    raise exception 'partial provenance was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.taxonomy_v2_taxa set preferred_scientific_name_sv = 'Conocybe rugosa'
      where release_id = 'tax-2026.09.29-01' and sporely_taxon_id = 7821;
    raise exception 'name without provenance was accepted';
  exception when check_violation then null;
  end;

  -- The traceability helper is not callable by clients.
  if has_function_privilege('anon', 'public.taxonomy_v2_national_name_errors(text)', 'execute')
     or has_function_privilege('authenticated', 'public.taxonomy_v2_national_name_errors(text)', 'execute') then
    raise exception 'national-name validation helper is exposed to clients';
  end if;
  if not has_function_privilege('anon', 'public.search_taxa_v2(text,text,integer)', 'execute') then
    raise exception 'search_taxa_v2 lost its anon grant';
  end if;
  raise notice 'taxonomy_v2_national_names_test passed';
end $$;

rollback;
