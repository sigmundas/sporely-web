begin;

do $$
declare
  v_release text;
  v_result jsonb;
  v_failed boolean;
begin
  foreach v_release in array array['tax-2026.07.02-01', 'tax-2026.07.03-01', 'tax-2026.07.04-01'] loop
    insert into public.taxonomy_v2_releases (
      release_id, taxonomy_schema_version, export_schema_version, manifest_schema_version,
      exporter_version, scope_predicate_id, source_gz_sha256, source_sqlite_sha256,
      whole_export_sha256, manifest_sha256, generated_at, status, row_counts,
      authoritative_namespace_counts, legacy_source_counts, dangling_parent_count,
      dangling_parent_report, source_manifest, loaded_at
    ) values (
      v_release, 2, 1, 1, 'fixture', 'fixture',
      repeat(substr(md5(v_release || 'a'),1,1),64), repeat(substr(md5(v_release || 'b'),1,1),64),
      md5(v_release || 'c') || md5(v_release || 'd'), md5(v_release || 'e') || md5(v_release || 'f'),
      now(), 'ready',
      '{"taxon.jsonl":1,"scientific_name.jsonl":1,"vernacular.jsonl":1,"taxon_external_id.jsonl":1,"taxon_external_id_legacy_integer.jsonl":1,"taxon_redlist.jsonl":1}',
      '{"col_xr/col_usage_id":1}', '{"legacy_source":1}', 1,
      '{"count":1}', '{}', now()
    );
  end loop;

  insert into public.taxonomy_v2_concepts(sporely_taxon_id, first_seen_release_id)
    values (201, 'tax-2026.07.02-01'), (301, 'tax-2026.07.03-01'), (401, 'tax-2026.07.04-01');

  foreach v_release in array array['tax-2026.07.02-01', 'tax-2026.07.03-01'] loop
    insert into public.taxonomy_v2_taxa(
      release_id, sporely_taxon_id, parent_sporely_taxon_id, genus, specific_epithet,
      canonical_scientific_name, taxon_rank, canonical_source_system, canonical_external_id
    ) values (
      v_release, case when v_release like '%02-01' then 201 else 301 end, 999999,
      'Fixture', 'validus', 'Fixture validus', 'species', 'col_xr', v_release
    );
    insert into public.taxonomy_v2_scientific_names values
      (v_release, case when v_release like '%02-01' then 201 else 301 end, 'sci', 'Fixture validus', true, 'fixture', null);
    insert into public.taxonomy_v2_vernacular_names values
      (v_release, case when v_release like '%02-01' then 201 else 301 end, 'nb', 'fikstursopp', true, 'fixture');
    insert into public.taxonomy_v2_external_ids values
      (v_release, case when v_release like '%02-01' then 201 else 301 end, 'col_xr', 'col_usage_id', v_release, 'accepted', true, null, null);
    insert into public.taxonomy_v2_legacy_external_ids values
      (v_release, case when v_release like '%02-01' then 201 else 301 end, 'legacy_source', '123', 'legacy', false, null, null);
    insert into public.taxonomy_v2_redlist values
      (v_release, case when v_release like '%02-01' then 201 else 301 end, 'redlist', '2021', v_release, 'Norge',
       'artsdatabanken', 'artsnavnebase_scientific_name_id', '1', 'Fixture validus', null, 'species',
       'LC', 'LC', false, null, null, null);
  end loop;

  v_result := public.taxonomy_v2_validate_release('tax-2026.07.02-01');
  if not (v_result->>'ok')::boolean or v_result->'actual_counts' <> v_result->'expected_counts' then
    raise exception 'valid fixture did not validate: %', v_result;
  end if;
  perform public.taxonomy_v2_activate_release('tax-2026.07.02-01');
  if (select status from public.taxonomy_v2_releases where release_id = 'tax-2026.07.02-01') <> 'active' then
    raise exception 'first release did not activate';
  end if;

  perform public.taxonomy_v2_activate_release('tax-2026.07.03-01');
  if (select status from public.taxonomy_v2_releases where release_id = 'tax-2026.07.02-01') <> 'retired'
     or (select status from public.taxonomy_v2_releases where release_id = 'tax-2026.07.03-01') <> 'active' then
    raise exception 'second activation did not retire first';
  end if;

  v_failed := false;
  begin
    perform public.taxonomy_v2_activate_release('tax-2026.07.04-01');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'incomplete release activated'; end if;
  if (select status from public.taxonomy_v2_releases where release_id = 'tax-2026.07.03-01') <> 'active' then
    raise exception 'failed activation changed prior active release';
  end if;

  update public.taxonomy_v2_releases set dangling_parent_count = 0 where release_id = 'tax-2026.07.03-01';
  v_result := public.taxonomy_v2_validate_release('tax-2026.07.03-01');
  if (v_result->>'ok')::boolean or not (v_result->'errors' ? 'dangling parent count does not match metadata') then
    raise exception 'dangling-parent mismatch not reported: %', v_result;
  end if;

  raise notice 'taxonomy_v2_activation_test passed';
end $$;

rollback;
