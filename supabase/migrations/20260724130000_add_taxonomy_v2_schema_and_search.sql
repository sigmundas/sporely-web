-- W2A: additive taxonomy-v2 Model B schema, release activation and read RPCs.
-- The legacy public.taxa, public.taxa_vernacular and public.search_taxa objects
-- are intentionally untouched.

create function public.taxonomy_v2_jsonb_nonnegative_integer_counts(p_value jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_catalog
as $$
  select pg_catalog.jsonb_typeof(p_value) = 'object'
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_value) as e(key, value)
      where pg_catalog.jsonb_typeof(e.value) <> 'number'
         or (e.value #>> '{}') !~ '^[0-9]+$'
    );
$$;

revoke all on function public.taxonomy_v2_jsonb_nonnegative_integer_counts(jsonb)
  from public, anon, authenticated;
grant execute on function public.taxonomy_v2_jsonb_nonnegative_integer_counts(jsonb)
  to service_role;

create table public.taxonomy_v2_releases (
  release_id text primary key
    check (release_id ~ '^tax-[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9]{2}$'),
  taxonomy_schema_version integer not null check (taxonomy_schema_version = 2),
  export_schema_version integer not null check (export_schema_version >= 0),
  manifest_schema_version integer not null check (manifest_schema_version >= 0),
  exporter_version text not null,
  scope_predicate_id text not null,
  source_gz_sha256 text not null check (source_gz_sha256 ~ '^[0-9a-f]{64}$'),
  source_sqlite_sha256 text not null check (source_sqlite_sha256 ~ '^[0-9a-f]{64}$'),
  whole_export_sha256 text not null unique check (whole_export_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null,
  status text not null check (status in ('loading', 'ready', 'active', 'retired', 'failed')),
  row_counts jsonb not null
    check (public.taxonomy_v2_jsonb_nonnegative_integer_counts(row_counts)),
  authoritative_namespace_counts jsonb not null
    check (public.taxonomy_v2_jsonb_nonnegative_integer_counts(authoritative_namespace_counts)),
  legacy_source_counts jsonb not null
    check (public.taxonomy_v2_jsonb_nonnegative_integer_counts(legacy_source_counts)),
  dangling_parent_count bigint not null check (dangling_parent_count >= 0),
  dangling_parent_report jsonb not null check (pg_catalog.jsonb_typeof(dangling_parent_report) = 'object'),
  source_manifest jsonb not null check (pg_catalog.jsonb_typeof(source_manifest) = 'object'),
  created_at timestamptz not null default now(),
  loaded_at timestamptz,
  activated_at timestamptz,
  failed_at timestamptz,
  failure_message text
);

create unique index taxonomy_v2_releases_one_active_idx
  on public.taxonomy_v2_releases ((status)) where status = 'active';

create table public.taxonomy_v2_concepts (
  sporely_taxon_id bigint primary key check (sporely_taxon_id > 0),
  first_seen_release_id text not null references public.taxonomy_v2_releases(release_id),
  created_at timestamptz not null default now()
);

create table public.taxonomy_v2_taxa (
  release_id text not null references public.taxonomy_v2_releases(release_id) on delete cascade,
  sporely_taxon_id bigint not null references public.taxonomy_v2_concepts(sporely_taxon_id),
  parent_sporely_taxon_id bigint,
  genus text not null default '',
  specific_epithet text not null default '',
  family text,
  canonical_scientific_name text,
  taxon_rank text,
  taxonomic_status text,
  source_system text,
  canonical_source_system text not null,
  canonical_external_id text not null,
  primary key (release_id, sporely_taxon_id)
);

comment on column public.taxonomy_v2_taxa.parent_sporely_taxon_id is
  'Source parent is preserved even when outside the release scope. W1 tax-2026.07.30-02 deliberately exports Fungi 152331 with dangling parent 150361, so this column intentionally has no self-FK.';

create index taxonomy_v2_taxa_parent_idx
  on public.taxonomy_v2_taxa (release_id, parent_sporely_taxon_id);
create index taxonomy_v2_taxa_rank_idx
  on public.taxonomy_v2_taxa (release_id, taxon_rank);
create index taxonomy_v2_taxa_canonical_source_idx
  on public.taxonomy_v2_taxa (release_id, canonical_source_system);
create index taxonomy_v2_taxa_canonical_name_prefix_idx
  on public.taxonomy_v2_taxa (release_id, lower(canonical_scientific_name) text_pattern_ops);

create table public.taxonomy_v2_scientific_names (
  release_id text not null,
  sporely_taxon_id bigint not null,
  language_code text not null,
  scientific_name text not null,
  is_preferred_name boolean not null,
  source text,
  alias_reason text,
  unique (release_id, sporely_taxon_id, language_code, scientific_name),
  foreign key (release_id, sporely_taxon_id)
    references public.taxonomy_v2_taxa(release_id, sporely_taxon_id) on delete cascade
);

create index taxonomy_v2_scientific_names_prefix_idx
  on public.taxonomy_v2_scientific_names (release_id, lower(scientific_name) text_pattern_ops);
create index taxonomy_v2_scientific_names_taxon_idx
  on public.taxonomy_v2_scientific_names (release_id, sporely_taxon_id);

create table public.taxonomy_v2_vernacular_names (
  release_id text not null,
  sporely_taxon_id bigint not null,
  language_code text not null,
  vernacular_name text not null,
  is_preferred_name boolean not null,
  source text,
  unique (release_id, sporely_taxon_id, language_code, vernacular_name),
  foreign key (release_id, sporely_taxon_id)
    references public.taxonomy_v2_taxa(release_id, sporely_taxon_id) on delete cascade
);

create index taxonomy_v2_vernacular_names_language_prefix_idx
  on public.taxonomy_v2_vernacular_names
    (release_id, language_code, lower(vernacular_name) text_pattern_ops);
create index taxonomy_v2_vernacular_names_taxon_language_idx
  on public.taxonomy_v2_vernacular_names (release_id, sporely_taxon_id, language_code);

create table public.taxonomy_v2_external_ids (
  release_id text not null,
  sporely_taxon_id bigint not null,
  source_system text not null check (btrim(source_system) <> ''),
  namespace text not null check (btrim(namespace) <> ''),
  external_id text not null check (btrim(external_id) <> ''),
  id_role text not null,
  is_preferred boolean not null,
  external_name text,
  note text,
  unique (release_id, source_system, namespace, external_id, sporely_taxon_id),
  foreign key (release_id, sporely_taxon_id)
    references public.taxonomy_v2_taxa(release_id, sporely_taxon_id) on delete cascade
);

create index taxonomy_v2_external_ids_lookup_idx
  on public.taxonomy_v2_external_ids (release_id, source_system, namespace, external_id);
create index taxonomy_v2_external_ids_taxon_source_idx
  on public.taxonomy_v2_external_ids (release_id, sporely_taxon_id, source_system, namespace);

create table public.taxonomy_v2_legacy_external_ids (
  release_id text not null,
  sporely_taxon_id bigint not null,
  source_system text not null,
  external_id text not null,
  id_role text not null,
  is_preferred boolean not null,
  external_name text,
  note text,
  foreign key (release_id, sporely_taxon_id)
    references public.taxonomy_v2_taxa(release_id, sporely_taxon_id) on delete cascade
);

comment on table public.taxonomy_v2_legacy_external_ids is
  'Namespace-lost audit and compatibility data only. Automatic identity resolution is prohibited. Numeric equality does not establish identity. This table is never consulted by search_taxa_v2 or resolve_taxon_external_id_v2.';
create index taxonomy_v2_legacy_external_ids_taxon_idx
  on public.taxonomy_v2_legacy_external_ids (release_id, sporely_taxon_id);

create table public.taxonomy_v2_redlist (
  release_id text not null,
  sporely_taxon_id bigint not null,
  source_system text not null,
  source_release text not null,
  assessment_id text not null,
  assessment_area text not null,
  assessed_name_source text not null,
  assessed_name_namespace text not null,
  assessed_name_id text not null,
  scientific_name_snapshot text not null,
  authorship_snapshot text,
  taxon_rank_snapshot text,
  category_raw text not null,
  category_code text not null,
  category_is_downgraded boolean not null,
  criteria text,
  expert_group text,
  assessment_url text,
  unique (release_id, source_system, source_release, assessment_id),
  foreign key (release_id, sporely_taxon_id)
    references public.taxonomy_v2_taxa(release_id, sporely_taxon_id) on delete cascade
);

comment on table public.taxonomy_v2_redlist is
  'Release-scoped assessment enrichment. Red List rows never establish concept identity.';
create index taxonomy_v2_redlist_taxon_area_idx
  on public.taxonomy_v2_redlist (release_id, sporely_taxon_id, assessment_area);

create table public.taxonomy_v2_import_runs (
  id bigint generated by default as identity primary key,
  release_id text references public.taxonomy_v2_releases(release_id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  importer_version text,
  source_directory text,
  whole_export_sha256 text,
  counts jsonb,
  relation_sizes jsonb,
  error_message text
);

alter table public.taxonomy_v2_releases enable row level security;
alter table public.taxonomy_v2_concepts enable row level security;
alter table public.taxonomy_v2_taxa enable row level security;
alter table public.taxonomy_v2_scientific_names enable row level security;
alter table public.taxonomy_v2_vernacular_names enable row level security;
alter table public.taxonomy_v2_external_ids enable row level security;
alter table public.taxonomy_v2_legacy_external_ids enable row level security;
alter table public.taxonomy_v2_redlist enable row level security;
alter table public.taxonomy_v2_import_runs enable row level security;

revoke all on table public.taxonomy_v2_releases from public, anon, authenticated;
revoke all on table public.taxonomy_v2_concepts from public, anon, authenticated;
revoke all on table public.taxonomy_v2_taxa from public, anon, authenticated;
revoke all on table public.taxonomy_v2_scientific_names from public, anon, authenticated;
revoke all on table public.taxonomy_v2_vernacular_names from public, anon, authenticated;
revoke all on table public.taxonomy_v2_external_ids from public, anon, authenticated;
revoke all on table public.taxonomy_v2_legacy_external_ids from public, anon, authenticated;
revoke all on table public.taxonomy_v2_redlist from public, anon, authenticated;
revoke all on table public.taxonomy_v2_import_runs from public, anon, authenticated;
revoke all on sequence public.taxonomy_v2_import_runs_id_seq from public, anon, authenticated;

grant all on table public.taxonomy_v2_releases to service_role;
grant all on table public.taxonomy_v2_concepts to service_role;
grant all on table public.taxonomy_v2_taxa to service_role;
grant all on table public.taxonomy_v2_scientific_names to service_role;
grant all on table public.taxonomy_v2_vernacular_names to service_role;
grant all on table public.taxonomy_v2_external_ids to service_role;
grant all on table public.taxonomy_v2_legacy_external_ids to service_role;
grant all on table public.taxonomy_v2_redlist to service_role;
grant all on table public.taxonomy_v2_import_runs to service_role;
grant usage, select on sequence public.taxonomy_v2_import_runs_id_seq to service_role;

create function public.taxonomy_v2_validate_release(p_release_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_release public.taxonomy_v2_releases%rowtype;
  v_actual_counts jsonb;
  v_authoritative_counts jsonb;
  v_legacy_counts jsonb;
  v_dangling bigint;
  v_errors jsonb := '[]'::jsonb;
  v_search_definition text;
  v_resolver_definition text;
begin
  select * into v_release
  from public.taxonomy_v2_releases
  where release_id = p_release_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'release_id', p_release_id, 'status', null,
      'expected_counts', null, 'actual_counts', null,
      'errors', pg_catalog.jsonb_build_array('release does not exist'));
  end if;

  if v_release.status not in ('ready', 'active') then
    v_errors := v_errors || pg_catalog.jsonb_build_array(
      pg_catalog.format('release status must be ready or active, got %s', v_release.status));
  end if;
  if v_release.taxonomy_schema_version <> 2 then
    v_errors := v_errors || ' ["taxonomy_schema_version must equal 2"]'::jsonb;
  end if;

  select pg_catalog.jsonb_build_object(
    'taxon.jsonl', (select count(*) from public.taxonomy_v2_taxa where release_id = p_release_id),
    'scientific_name.jsonl', (select count(*) from public.taxonomy_v2_scientific_names where release_id = p_release_id),
    'vernacular.jsonl', (select count(*) from public.taxonomy_v2_vernacular_names where release_id = p_release_id),
    'taxon_external_id.jsonl', (select count(*) from public.taxonomy_v2_external_ids where release_id = p_release_id),
    'taxon_external_id_legacy_integer.jsonl', (select count(*) from public.taxonomy_v2_legacy_external_ids where release_id = p_release_id),
    'taxon_redlist.jsonl', (select count(*) from public.taxonomy_v2_redlist where release_id = p_release_id)
  ) into v_actual_counts;

  if v_actual_counts <> v_release.row_counts then
    v_errors := v_errors || pg_catalog.jsonb_build_array('actual row counts do not match row_counts metadata');
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}'::jsonb)
  into v_authoritative_counts
  from (
    select source_system || '/' || namespace as k, count(*) as n
    from public.taxonomy_v2_external_ids
    where release_id = p_release_id
    group by source_system, namespace
  ) s;
  if v_authoritative_counts <> v_release.authoritative_namespace_counts then
    v_errors := v_errors || pg_catalog.jsonb_build_array('authoritative namespace counts do not match metadata');
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(k, n), '{}'::jsonb)
  into v_legacy_counts
  from (
    select source_system as k, count(*) as n
    from public.taxonomy_v2_legacy_external_ids
    where release_id = p_release_id
    group by source_system
  ) s;
  if v_legacy_counts <> v_release.legacy_source_counts then
    v_errors := v_errors || pg_catalog.jsonb_build_array('legacy source counts do not match metadata');
  end if;

  select count(*) into v_dangling
  from public.taxonomy_v2_taxa t
  where t.release_id = p_release_id
    and t.parent_sporely_taxon_id is not null
    and not exists (
      select 1 from public.taxonomy_v2_taxa p
      where p.release_id = t.release_id
        and p.sporely_taxon_id = t.parent_sporely_taxon_id
    );
  if v_dangling <> v_release.dangling_parent_count then
    v_errors := v_errors || pg_catalog.jsonb_build_array('dangling parent count does not match metadata');
  end if;

  if exists (
    select 1 from public.taxonomy_v2_taxa t
    left join public.taxonomy_v2_concepts c using (sporely_taxon_id)
    where t.release_id = p_release_id and c.sporely_taxon_id is null
  ) then
    v_errors := v_errors || pg_catalog.jsonb_build_array('release-scoped taxon without stable concept');
  end if;

  if exists (
    select 1
    from (
      select release_id, sporely_taxon_id from public.taxonomy_v2_scientific_names where release_id = p_release_id
      union all
      select release_id, sporely_taxon_id from public.taxonomy_v2_vernacular_names where release_id = p_release_id
      union all
      select release_id, sporely_taxon_id from public.taxonomy_v2_external_ids where release_id = p_release_id
      union all
      select release_id, sporely_taxon_id from public.taxonomy_v2_legacy_external_ids where release_id = p_release_id
      union all
      select release_id, sporely_taxon_id from public.taxonomy_v2_redlist where release_id = p_release_id
    ) child
    left join public.taxonomy_v2_taxa t using (release_id, sporely_taxon_id)
    where t.sporely_taxon_id is null
  ) then
    v_errors := v_errors || pg_catalog.jsonb_build_array('release child row without release-scoped taxon');
  end if;

  if exists (
    select 1 from public.taxonomy_v2_external_ids
    where release_id = p_release_id
      and (source_system is null or btrim(source_system) = ''
        or namespace is null or btrim(namespace) = ''
        or external_id is null or btrim(external_id) = '')
  ) then
    v_errors := v_errors || pg_catalog.jsonb_build_array('blank authoritative identifier component');
  end if;

  if exists (
    select 1 from public.taxonomy_v2_external_ids
    where release_id = p_release_id
    group by source_system, namespace, external_id, sporely_taxon_id
    having count(*) > 1
  ) then
    v_errors := v_errors || pg_catalog.jsonb_build_array('duplicate authoritative semantic key');
  end if;

  select pg_catalog.pg_get_functiondef('public.search_taxa_v2(text,text,integer)'::regprocedure)
    into v_search_definition;
  select pg_catalog.pg_get_functiondef('public.resolve_taxon_external_id_v2(text,text,text)'::regprocedure)
    into v_resolver_definition;
  if pg_catalog.strpos(v_search_definition, 'taxonomy_v2_legacy_external_ids') > 0
     or pg_catalog.strpos(v_resolver_definition, 'taxonomy_v2_legacy_external_ids') > 0 then
    v_errors := v_errors || pg_catalog.jsonb_build_array('active RPC definition references legacy external IDs');
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', pg_catalog.jsonb_array_length(v_errors) = 0,
    'release_id', v_release.release_id,
    'status', v_release.status,
    'expected_counts', v_release.row_counts,
    'actual_counts', v_actual_counts,
    'errors', v_errors
  );
exception
  when undefined_function then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'release_id', v_release.release_id, 'status', v_release.status,
      'expected_counts', v_release.row_counts, 'actual_counts', v_actual_counts,
      'errors', v_errors || pg_catalog.jsonb_build_array('required taxonomy-v2 RPC is missing'));
end;
$$;

create function public.taxonomy_v2_activate_release(p_release_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_status text;
  v_validation jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(846920026072413002::bigint);
  perform 1 from public.taxonomy_v2_releases
    where release_id = p_release_id or status = 'active'
    for update;

  select status into v_status
  from public.taxonomy_v2_releases
  where release_id = p_release_id;
  if not found then
    raise exception 'taxonomy release % does not exist', p_release_id;
  end if;
  if v_status <> 'ready' then
    raise exception 'taxonomy release % must be ready, got %', p_release_id, v_status;
  end if;

  v_validation := public.taxonomy_v2_validate_release(p_release_id);
  if not coalesce((v_validation ->> 'ok')::boolean, false) then
    raise exception 'taxonomy release % failed validation: %', p_release_id, v_validation -> 'errors';
  end if;

  update public.taxonomy_v2_releases
    set status = 'retired'
    where status = 'active';
  update public.taxonomy_v2_releases
    set status = 'active', activated_at = now()
    where release_id = p_release_id;

  return public.taxonomy_v2_validate_release(p_release_id);
end;
$$;

create function public.search_taxa_v2(
  q text,
  lang text default 'no',
  lim integer default 20
)
returns table (
  taxon_id bigint,
  parent_taxon_id bigint,
  taxon_rank text,
  genus text,
  specific_epithet text,
  canonical_scientific_name text,
  family text,
  vernacular_name text,
  vernacular_language text,
  canonical_source_system text,
  canonical_external_id text,
  col_usage_id text,
  nortaxa_taxon_id text,
  matched_name text,
  matched_language text,
  match_type text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with input as (
    select btrim(coalesce(q, '')) as query,
           btrim(coalesce(nullif(btrim(lang), ''), 'no')) as requested_lang,
           greatest(1, least(coalesce(lim, 20), 50)) as result_limit
  ), active_release as (
    select release_id from public.taxonomy_v2_releases where status = 'active'
  ), selected_languages as (
    select selected.language_code
    from input i
    cross join lateral unnest(
      case when i.requested_lang = 'no'
        then array['nb', 'nn', 'no']::text[]
        else array[i.requested_lang]::text[]
      end
    ) as selected(language_code)
  ), candidates as (
    select t.sporely_taxon_id, t.canonical_scientific_name as candidate_name,
           'sci'::text as candidate_language,
           case when lower(t.canonical_scientific_name) = lower(i.query) then 1 else 5 end as match_rank,
           case when lower(t.canonical_scientific_name) = lower(i.query)
             then 'canonical_exact' else 'canonical_prefix' end as candidate_match_type,
           null::text as matching_vernacular, null::text as matching_vernacular_language
    from public.taxonomy_v2_taxa t
    join active_release ar using (release_id)
    cross join input i
    where pg_catalog.char_length(i.query) >= 2
      and left(lower(t.canonical_scientific_name), pg_catalog.char_length(lower(i.query))) = lower(i.query)

    union all

    select n.sporely_taxon_id, n.scientific_name, n.language_code,
           case when lower(n.scientific_name) = lower(i.query) then 2 else 6 end,
           case when lower(n.scientific_name) = lower(i.query)
             then 'scientific_alias_exact' else 'scientific_alias_prefix' end,
           null::text, null::text
    from public.taxonomy_v2_scientific_names n
    join active_release ar using (release_id)
    cross join input i
    where pg_catalog.char_length(i.query) >= 2
      and left(lower(n.scientific_name), pg_catalog.char_length(lower(i.query))) = lower(i.query)

    union all

    select v.sporely_taxon_id, v.vernacular_name, v.language_code,
           case
             when lower(v.vernacular_name) = lower(i.query) and v.is_preferred_name then 3
             when lower(v.vernacular_name) = lower(i.query) then 4
             when v.is_preferred_name then 7 else 8
           end,
           case when lower(v.vernacular_name) = lower(i.query)
             then 'vernacular_exact' else 'vernacular_prefix' end,
           v.vernacular_name, v.language_code
    from public.taxonomy_v2_vernacular_names v
    join active_release ar using (release_id)
    cross join input i
    where pg_catalog.char_length(i.query) >= 2
      and v.language_code in (select language_code from selected_languages)
      and left(lower(v.vernacular_name), pg_catalog.char_length(lower(i.query))) = lower(i.query)
  ), best as (
    select c.*,
           row_number() over (
             partition by c.sporely_taxon_id
             order by c.match_rank, lower(c.candidate_name), c.candidate_language, c.candidate_match_type
           ) as concept_match_number
    from candidates c
  )
  select t.sporely_taxon_id,
         t.parent_sporely_taxon_id,
         t.taxon_rank,
         t.genus,
         t.specific_epithet,
         t.canonical_scientific_name,
         t.family,
         coalesce(b.matching_vernacular, display_v.vernacular_name),
         coalesce(b.matching_vernacular_language, display_v.language_code),
         t.canonical_source_system,
         t.canonical_external_id,
         convenience.col_usage_id,
         convenience.nortaxa_taxon_id,
         b.candidate_name,
         b.candidate_language,
         b.candidate_match_type
  from best b
  join active_release ar on true
  join public.taxonomy_v2_taxa t
    on t.release_id = ar.release_id and t.sporely_taxon_id = b.sporely_taxon_id
  cross join input i
  left join lateral (
    select v.vernacular_name, v.language_code
    from public.taxonomy_v2_vernacular_names v
    where v.release_id = ar.release_id
      and v.sporely_taxon_id = t.sporely_taxon_id
      and v.language_code in (select language_code from selected_languages)
    order by
      case
        when v.is_preferred_name and i.requested_lang <> 'no' and v.language_code = i.requested_lang then 1
        when v.is_preferred_name and i.requested_lang = 'no' and v.language_code = 'nb' then 1
        when v.is_preferred_name and i.requested_lang = 'no' and v.language_code = 'nn' then 2
        when v.is_preferred_name and i.requested_lang = 'no' and v.language_code = 'no' then 3
        else 5
      end,
      v.is_preferred_name desc, v.language_code, v.vernacular_name
    limit 1
  ) display_v on true
  left join lateral (
    select
      min(e.external_id) filter (
        where e.source_system = 'col_xr' and e.namespace = 'col_usage_id'
      ) as col_usage_id,
      min(e.external_id) filter (
        where e.source_system = 'nortaxa' and e.namespace = 'nortaxa_taxon_id'
      ) as nortaxa_taxon_id
    from public.taxonomy_v2_external_ids e
    where e.release_id = ar.release_id and e.sporely_taxon_id = t.sporely_taxon_id
  ) convenience on true
  where b.concept_match_number = 1
  order by b.match_rank,
           case when t.canonical_source_system = 'col_xr' then 0 else 1 end,
           lower(t.canonical_scientific_name) nulls last,
           t.taxon_rank nulls last,
           t.sporely_taxon_id
  limit (select result_limit from input);
$$;

create function public.resolve_taxon_external_id_v2(
  p_source_system text,
  p_namespace text,
  p_external_id text
)
returns table (
  taxon_id bigint,
  taxon_rank text,
  genus text,
  specific_epithet text,
  canonical_scientific_name text,
  family text,
  canonical_source_system text,
  canonical_external_id text,
  id_role text,
  is_preferred boolean
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select t.sporely_taxon_id,
         t.taxon_rank,
         t.genus,
         t.specific_epithet,
         t.canonical_scientific_name,
         t.family,
         t.canonical_source_system,
         t.canonical_external_id,
         e.id_role,
         e.is_preferred
  from public.taxonomy_v2_releases r
  join public.taxonomy_v2_external_ids e on e.release_id = r.release_id
  join public.taxonomy_v2_taxa t
    on t.release_id = e.release_id and t.sporely_taxon_id = e.sporely_taxon_id
  where r.status = 'active'
    and nullif(btrim(p_source_system), '') is not null
    and nullif(btrim(p_namespace), '') is not null
    and nullif(btrim(p_external_id), '') is not null
    and e.source_system = btrim(p_source_system)
    and e.namespace = btrim(p_namespace)
    and e.external_id = btrim(p_external_id)
  order by e.is_preferred desc, t.sporely_taxon_id;
$$;

alter function public.taxonomy_v2_jsonb_nonnegative_integer_counts(jsonb) owner to postgres;
alter function public.taxonomy_v2_validate_release(text) owner to postgres;
alter function public.taxonomy_v2_activate_release(text) owner to postgres;
alter function public.search_taxa_v2(text, text, integer) owner to postgres;
alter function public.resolve_taxon_external_id_v2(text, text, text) owner to postgres;

revoke all on function public.taxonomy_v2_validate_release(text) from public, anon, authenticated;
revoke all on function public.taxonomy_v2_activate_release(text) from public, anon, authenticated;
revoke all on function public.search_taxa_v2(text, text, integer) from public;
revoke all on function public.resolve_taxon_external_id_v2(text, text, text) from public;

grant execute on function public.taxonomy_v2_validate_release(text) to service_role;
grant execute on function public.taxonomy_v2_activate_release(text) to service_role;
grant execute on function public.search_taxa_v2(text, text, integer) to anon, authenticated, service_role;
grant execute on function public.resolve_taxon_external_id_v2(text, text, text) to anon, authenticated, service_role;
