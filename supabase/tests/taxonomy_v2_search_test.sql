begin;

do $$
declare
  r record;
  v_ids bigint[];
  v_types text[];
  v_count integer;
begin
  if exists (select 1 from public.search_taxa_v2('Cantharellus', 'no', 20)) then
    raise exception 'search returned rows without an active release';
  end if;

  insert into public.taxonomy_v2_releases (
    release_id, taxonomy_schema_version, export_schema_version, manifest_schema_version,
    exporter_version, scope_predicate_id, source_gz_sha256, source_sqlite_sha256,
    whole_export_sha256, manifest_sha256, generated_at, status, row_counts,
    authoritative_namespace_counts, legacy_source_counts, dangling_parent_count,
    dangling_parent_report, source_manifest, loaded_at
  ) values (
    'tax-2026.07.05-01', 2, 1, 1, 'fixture', 'fixture', repeat('a',64), repeat('b',64),
    repeat('c',64), repeat('d',64), now(), 'ready', '{}', '{}', '{}', 0, '{}', '{}', now()
  );

  insert into public.taxonomy_v2_concepts(sporely_taxon_id, first_seen_release_id)
  select id, 'tax-2026.07.05-01'
  from unnest(array[
    1001,1002,1003,1004,1005,1006,1007,
    2001,2002,2003,2004,2005,2006,2007,2008
  ]::bigint[]) id;

  insert into public.taxonomy_v2_taxa(
    release_id, sporely_taxon_id, genus, specific_epithet, family,
    canonical_scientific_name, taxon_rank, canonical_source_system, canonical_external_id
  ) values
    ('tax-2026.07.05-01',1001,'Cantharellus','cibarius','Cantharellaceae','Cantharellus cibarius','species','col_xr','COL-CANTH'),
    ('tax-2026.07.05-01',1002,'Cantharellus','cibarius','Cantharellaceae','Cantharellus cibarius','species','nortaxa','NO-CANTH'),
    ('tax-2026.07.05-01',1003,'Inocybe','','Inocybaceae','Inocybe','genus','col_xr','COL-INOCYBE'),
    ('tax-2026.07.05-01',1004,'Inocybe','','Inocybaceae','Inocybe','genus','nortaxa','NO-INOCYBE'),
    ('tax-2026.07.05-01',1005,'Candolleomyces','candolleanus','Psathyrellaceae','Candolleomyces candolleanus','species','col_xr','COL-CAND'),
    ('tax-2026.07.05-01',1006,'Aureonarius','limonius','Cortinariaceae','Aureonarius limonius','species','col_xr','COL-AUREO'),
    ('tax-2026.07.05-01',1007,'Cortinarius','limonius','Cortinariaceae','Cortinarius limonius','species','nortaxa','NO-CORT'),
    ('tax-2026.07.05-01',2001,'Test','','Fixtureaceae','Test','species','col_xr','R1'),
    ('tax-2026.07.05-01',2002,'Alias','','Fixtureaceae','Alias exact concept','species','col_xr','R2'),
    ('tax-2026.07.05-01',2003,'Preferred','','Fixtureaceae','Preferred vernacular concept','species','col_xr','R3'),
    ('tax-2026.07.05-01',2004,'Ordinary','','Fixtureaceae','Ordinary vernacular concept','species','col_xr','R4'),
    ('tax-2026.07.05-01',2005,'Testament','','Fixtureaceae','Testament fungus','species','col_xr','R5'),
    ('tax-2026.07.05-01',2006,'AliasPrefix','','Fixtureaceae','Alias prefix concept','species','col_xr','R6'),
    ('tax-2026.07.05-01',2007,'PreferredPrefix','','Fixtureaceae','Preferred prefix concept','species','col_xr','R7'),
    ('tax-2026.07.05-01',2008,'OrdinaryPrefix','','Fixtureaceae','Ordinary prefix concept','species','col_xr','R8');

  insert into public.taxonomy_v2_scientific_names(
    release_id, sporely_taxon_id, language_code, scientific_name, is_preferred_name, source, alias_reason
  )
  select 'tax-2026.07.05-01', sporely_taxon_id, 'sci', canonical_scientific_name, true, 'fixture', null
  from public.taxonomy_v2_taxa where release_id = 'tax-2026.07.05-01';
  insert into public.taxonomy_v2_scientific_names values
    ('tax-2026.07.05-01',1005,'sci','Psathyrella candolleana',false,'fixture','synonym_of_accepted'),
    ('tax-2026.07.05-01',2002,'sci','Test',false,'fixture','synonym_of_accepted'),
    ('tax-2026.07.05-01',2006,'sci','Testing alias',false,'fixture','synonym_of_accepted');

  insert into public.taxonomy_v2_vernacular_names values
    ('tax-2026.07.05-01',1001,'nb','bokmaalsopp',true,'fixture'),
    ('tax-2026.07.05-01',1001,'nn','nynorsksopp',true,'fixture'),
    ('tax-2026.07.05-01',1001,'se','samisopp',true,'fixture'),
    ('tax-2026.07.05-01',1002,'nb','kantarell',true,'fixture'),
    ('tax-2026.07.05-01',2003,'nb','Test',true,'fixture'),
    ('tax-2026.07.05-01',2004,'nb','Test',false,'fixture'),
    ('tax-2026.07.05-01',2007,'nb','Testing preferred',true,'fixture'),
    ('tax-2026.07.05-01',2008,'nb','Tester ordinary',false,'fixture');

  insert into public.taxonomy_v2_external_ids(
    release_id, sporely_taxon_id, source_system, namespace, external_id, id_role, is_preferred, external_name, note
  )
  select 'tax-2026.07.05-01', sporely_taxon_id,
         case when canonical_source_system = 'nortaxa' then 'nortaxa' else 'col_xr' end,
         case when canonical_source_system = 'nortaxa' then 'nortaxa_taxon_id' else 'col_usage_id' end,
         canonical_external_id, 'accepted', true, canonical_scientific_name, null
  from public.taxonomy_v2_taxa where release_id = 'tax-2026.07.05-01';
  insert into public.taxonomy_v2_external_ids values
    ('tax-2026.07.05-01',1001,'bridge','fixture_id','SHARED','accepted',true,null,null),
    ('tax-2026.07.05-01',1002,'bridge','fixture_id','SHARED','historical',false,null,null),
    ('tax-2026.07.05-01',1001,'bridge','other_namespace','SHARED','accepted',true,null,null);

  insert into public.taxonomy_v2_legacy_external_ids values
    ('tax-2026.07.05-01',1007,'nortaxa','MISLEADING-123','legacy',true,'Cortinarius limonius','namespace lost');
  insert into public.taxonomy_v2_redlist values
    ('tax-2026.07.05-01',1001,'artsdatabanken_redlist','2021','RL-1','Norge',
     'artsdatabanken','artsnavnebase_scientific_name_id','1','Cantharellus cibarius',null,'species',
     'LC','LC',false,null,null,null);

  update public.taxonomy_v2_releases rel set
    row_counts = jsonb_build_object(
      'taxon.jsonl',(select count(*) from public.taxonomy_v2_taxa where release_id=rel.release_id),
      'scientific_name.jsonl',(select count(*) from public.taxonomy_v2_scientific_names where release_id=rel.release_id),
      'vernacular.jsonl',(select count(*) from public.taxonomy_v2_vernacular_names where release_id=rel.release_id),
      'taxon_external_id.jsonl',(select count(*) from public.taxonomy_v2_external_ids where release_id=rel.release_id),
      'taxon_external_id_legacy_integer.jsonl',(select count(*) from public.taxonomy_v2_legacy_external_ids where release_id=rel.release_id),
      'taxon_redlist.jsonl',(select count(*) from public.taxonomy_v2_redlist where release_id=rel.release_id)
    ),
    authoritative_namespace_counts = (
      select jsonb_object_agg(k,n) from (
        select source_system||'/'||namespace k,count(*) n from public.taxonomy_v2_external_ids
        where release_id=rel.release_id group by source_system,namespace
      ) s
    ),
    legacy_source_counts = '{"nortaxa":1}'
  where rel.release_id='tax-2026.07.05-01';

  perform public.taxonomy_v2_activate_release('tax-2026.07.05-01');

  if exists (select 1 from public.search_taxa_v2('C', 'no', 20)) then
    raise exception 'one-character query returned results';
  end if;

  select array_agg(taxon_id), array_agg(match_type)
    into v_ids, v_types from public.search_taxa_v2('Test', 'nb', 50);
  if v_ids <> array[2001,2002,2003,2004,2005,2006,2007,2008]::bigint[] then
    raise exception 'exact/prefix ranking or deterministic ordering wrong: %', v_ids;
  end if;
  if v_types <> array['canonical_exact','scientific_alias_exact','vernacular_exact','vernacular_exact',
                      'canonical_prefix','scientific_alias_prefix','vernacular_prefix','vernacular_prefix']::text[] then
    raise exception 'match types wrong: %', v_types;
  end if;

  select array_agg(taxon_id) into v_ids from public.search_taxa_v2('Cantharellus cibarius','no',20);
  if v_ids <> array[1001,1002]::bigint[] then
    raise exception 'same-name concepts collapsed or COL tie-break wrong: %', v_ids;
  end if;
  select count(*) into v_count from public.search_taxa_v2('Inocybe','no',20) where taxon_rank='genus';
  if v_count <> 2 then raise exception 'same-name genus concepts not preserved: %', v_count; end if;

  select * into r from public.search_taxa_v2('Psathyrella candolleana','no',20) limit 1;
  if r.taxon_id <> 1005 or r.match_type <> 'scientific_alias_exact' then
    raise exception 'alias did not resolve accepted concept: %', row_to_json(r);
  end if;

  if (select count(*) from public.search_taxa_v2('nynorsk','no',20)) <> 1
     or exists (select 1 from public.search_taxa_v2('nynorsk','nb',20))
     or (select count(*) from public.search_taxa_v2('nynorsk','nn',20)) <> 1
     or exists (select 1 from public.search_taxa_v2('bokmaal','nn',20))
     or (select count(*) from public.search_taxa_v2('sami','se',20)) <> 1
     or exists (select 1 from public.search_taxa_v2('sami','no',20)) then
    raise exception 'literal language or no-umbrella behavior failed';
  end if;
  if (select matched_language from public.search_taxa_v2('nynorsk','no',20) limit 1) <> 'nn' then
    raise exception 'stored language code was rewritten';
  end if;

  select array_agg(taxon_id) into v_ids
  from public.resolve_taxon_external_id_v2('bridge','fixture_id','SHARED');
  if v_ids <> array[1001,1002]::bigint[] then raise exception 'resolver collapsed multiple matches: %',v_ids; end if;
  if (select count(*) from public.resolve_taxon_external_id_v2('bridge','other_namespace','SHARED')) <> 1
     or exists (select 1 from public.resolve_taxon_external_id_v2('bridge','wrong','SHARED'))
     or exists (select 1 from public.resolve_taxon_external_id_v2('nortaxa','nortaxa_taxon_id','MISLEADING-123'))
     or exists (select 1 from public.resolve_taxon_external_id_v2(null,'fixture_id','SHARED'))
     or exists (select 1 from public.resolve_taxon_external_id_v2(' ','fixture_id','SHARED'))
     or exists (select 1 from public.resolve_taxon_external_id_v2('bridge','fixture_id','Cantharellus cibarius')) then
    raise exception 'resolver namespace/blank/legacy/name-fallback contract failed';
  end if;

  if (select col_usage_id from public.search_taxa_v2('Cantharellus cibarius','no',20) where taxon_id=1001) <> 'COL-CANTH'
     or (select nortaxa_taxon_id from public.search_taxa_v2('Cantharellus cibarius','no',20) where taxon_id=1002) <> 'NO-CANTH' then
    raise exception 'authoritative convenience IDs incorrect';
  end if;

  if (select count(*) from public.search_taxa_v2('Aureonarius', 'no', 20)) <> 1
     or (select count(*) from public.search_taxa_v2('Cortinarius', 'no', 20)) <> 1 then
    raise exception 'deliberately separate limonius concepts were merged';
  end if;

  raise notice 'taxonomy_v2_search_test passed';
end $$;

rollback;
