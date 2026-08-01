begin;

do $$
declare
  v_tables text[] := array[
    'taxonomy_v2_releases', 'taxonomy_v2_concepts', 'taxonomy_v2_taxa',
    'taxonomy_v2_scientific_names', 'taxonomy_v2_vernacular_names',
    'taxonomy_v2_external_ids', 'taxonomy_v2_legacy_external_ids',
    'taxonomy_v2_redlist', 'taxonomy_v2_import_runs'
  ];
  v_table text;
  v_error boolean;
begin
  foreach v_table in array v_tables loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'missing table %', v_table;
    end if;
    if not (select relrowsecurity from pg_class where oid = to_regclass('public.' || v_table)) then
      raise exception 'RLS is not enabled on %', v_table;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.taxonomy_v2_taxa'::regclass and contype = 'p'
  ) then raise exception 'taxonomy_v2_taxa primary key missing'; end if;

  if (select count(*) from pg_constraint
      where conrelid = 'public.taxonomy_v2_taxa'::regclass and contype = 'f') <> 2 then
    raise exception 'taxonomy_v2_taxa must have release and concept FKs only';
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.taxonomy_v2_taxa'::regclass
      and contype = 'f' and pg_get_constraintdef(oid) like '%parent_sporely_taxon_id%'
  ) then raise exception 'parent must intentionally have no self-FK'; end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'taxonomy_v2_releases_one_active_idx'
      and indexdef like '%WHERE (status = ''active''::text)%'
  ) then raise exception 'one-active partial unique index missing'; end if;

  insert into public.taxonomy_v2_releases (
      release_id, taxonomy_schema_version, export_schema_version, manifest_schema_version,
      exporter_version, scope_predicate_id, source_gz_sha256, source_sqlite_sha256,
      whole_export_sha256, manifest_sha256, generated_at, status, row_counts,
      authoritative_namespace_counts, legacy_source_counts, dangling_parent_count,
      dangling_parent_report, source_manifest
  ) values (
      'tax-2026.07.01-01', 2, 1, 1, 'fixture', 'fixture', repeat('a',64), repeat('b',64),
      repeat('c',64), repeat('d',64), now(), 'loading', '{}', '{}', '{}', 0, '{}', '{}'
  );
  v_error := false;
  begin
    insert into public.taxonomy_v2_concepts(sporely_taxon_id, first_seen_release_id)
      values (0, 'tax-2026.07.01-01');
  exception when check_violation then v_error := true;
  end;
  if not v_error then raise exception 'non-positive Sporely ID was accepted'; end if;

  insert into public.taxonomy_v2_concepts(sporely_taxon_id, first_seen_release_id)
    values (1, 'tax-2026.07.01-01');
  insert into public.taxonomy_v2_taxa(
    release_id, sporely_taxon_id, canonical_source_system, canonical_external_id
  ) values ('tax-2026.07.01-01', 1, 'col_xr', 'one');
  v_error := false;
  begin
    insert into public.taxonomy_v2_external_ids(
      release_id, sporely_taxon_id, source_system, namespace, external_id, id_role, is_preferred
    ) values ('tax-2026.07.01-01', 1, 'col_xr', ' ', 'one', 'accepted', true);
  exception when check_violation then v_error := true;
  end;
  if not v_error then raise exception 'blank authoritative namespace was accepted'; end if;

  if to_regclass('public.taxa') is null or to_regclass('public.taxa_vernacular') is null then
    raise exception 'legacy taxonomy tables missing';
  end if;
  if to_regprocedure('public.search_taxa(text,text,integer)') is null then
    raise exception 'legacy search_taxa signature missing';
  end if;

  raise notice 'taxonomy_v2_schema_test passed';
end $$;

rollback;
