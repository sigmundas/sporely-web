-- W2C disposable local-only prototype. This file is not a production migration.
drop schema if exists w2c_sparse_experiment cascade;
create schema w2c_sparse_experiment;
set search_path = w2c_sparse_experiment, pg_catalog;

create sequence sporely_taxon_id_allocator minvalue 1000000000 start 1000000000;

create table source_release (
  source_key smallint generated always as identity primary key,
  source_system text not null,
  namespace text not null,
  release_or_response text not null,
  unique (source_system, namespace, release_or_response)
);

create table registry_concept (
  sporely_taxon_id bigint primary key check (sporely_taxon_id > 0),
  canonical_scientific_name text not null,
  rank text,
  canonical_source_system text not null,
  canonical_namespace text not null,
  canonical_external_id text not null,
  parent_sporely_taxon_id bigint references registry_concept,
  first_registration_reason text not null check (first_registration_reason in (
    'existing_observation_migration','historical_identity','artsorakel_selection',
    'inaturalist_selection','desktop_sync','manual_scientific_entry',
    'administrator_curated','macrofungi_cache_seed')),
  scope_state text not null check (scope_state in ('include','exclude','review','not_evaluated')),
  review_state text not null check (review_state in ('approved','needs_review','unreviewed')),
  created_at timestamptz not null default now()
);

create table external_mapping (
  sporely_taxon_id bigint not null references registry_concept on delete restrict,
  source_key smallint not null references source_release,
  source_system text not null,
  namespace text not null,
  external_id text not null,
  mapping_status text not null check (mapping_status in ('exact','provisional','historical','rejected')),
  mapping_provenance text not null,
  primary key (source_system, namespace, external_id),
  unique (sporely_taxon_id, source_system, namespace, external_id)
);
create index external_mapping_taxon_idx on external_mapping (sporely_taxon_id);

create table registered_name (
  sporely_taxon_id bigint not null references registry_concept on delete cascade,
  name text not null,
  name_kind text not null check (name_kind in ('canonical','scientific_alias','vernacular','selected_snapshot')),
  language text not null default '',
  preferred boolean not null default false,
  source_key smallint references source_release,
  source text not null,
  primary key (sporely_taxon_id, name_kind, language, name)
);
create index registered_name_prefix_idx on registered_name ((lower(name) collate "C") text_pattern_ops);

create table identification_snapshot (
  snapshot_id bigint generated always as identity primary key,
  sporely_taxon_id bigint references registry_concept on delete set null,
  selected_scientific_name text,
  selected_vernacular_name text,
  selected_rank text,
  source_system text,
  source_namespace text,
  raw_external_id text,
  source_release_or_response text,
  selection_timestamp timestamptz,
  resolution_state text not null check (resolution_state in (
    'resolved','unresolved_external','manual_unresolved','historical_unresolved','no_identity_evidence')),
  original_selected_result jsonb,
  resolution_note text,
  created_at timestamptz not null default now()
);
create index identification_snapshot_taxon_idx on identification_snapshot (sporely_taxon_id) where sporely_taxon_id is not null;
create index identification_snapshot_external_idx on identification_snapshot (source_system, source_namespace, raw_external_id) where raw_external_id is not null;

create table cache_release (
  release_id text primary key,
  phase_a_manifest_sha256 text not null,
  status text not null check (status in ('loading','ready','active','retired')),
  created_at timestamptz not null default now()
);
create unique index cache_one_active_idx on cache_release ((status)) where status='active';

create table cache_concept (
  release_id text not null references cache_release on delete cascade,
  sporely_taxon_id bigint not null,
  canonical_scientific_name text not null,
  rank text,
  family text,
  scope_reason text not null,
  canonical_source_system text not null,
  canonical_namespace text not null,
  canonical_external_id text not null,
  primary key (release_id, sporely_taxon_id)
);
create index cache_concept_prefix_idx on cache_concept (release_id, (lower(canonical_scientific_name) collate "C") text_pattern_ops);
create index cache_concept_external_idx on cache_concept (release_id, canonical_source_system, canonical_namespace, canonical_external_id);

create table cache_search_name (
  release_id text not null,
  sporely_taxon_id bigint not null,
  name text not null,
  name_kind text not null check (name_kind in ('scientific_alias','vernacular')),
  language text not null default '',
  preferred boolean not null default false,
  primary key (release_id, sporely_taxon_id, name_kind, language, name),
  foreign key (release_id, sporely_taxon_id) references cache_concept on delete cascade
);
create index cache_search_name_prefix_idx on cache_search_name (release_id, (lower(name) collate "C") text_pattern_ops);

create or replace function register_external_selection(
  p_source_system text,
  p_namespace text,
  p_external_id text,
  p_scientific_name text,
  p_vernacular_name text,
  p_rank text,
  p_release_or_response text,
  p_selection_timestamp timestamptz,
  p_reason text,
  p_scope_state text,
  p_exact_sporely_taxon_id bigint,
  p_mapping_provenance text,
  p_original_result jsonb
) returns jsonb language plpgsql set search_path=w2c_sparse_experiment,pg_catalog as $$
declare
  v_taxon_id bigint;
  v_snapshot_id bigint;
  v_reused boolean := false;
  v_source_key smallint;
begin
  if nullif(trim(p_source_system),'') is null or nullif(trim(p_namespace),'') is null or nullif(trim(p_external_id),'') is null then
    raise exception 'complete namespaced external identity is required';
  end if;
  select sporely_taxon_id into v_taxon_id from external_mapping
   where source_system=p_source_system and namespace=p_namespace and external_id=p_external_id;
  if v_taxon_id is not null then
    v_reused := true;
  elsif p_exact_sporely_taxon_id is not null then
    v_taxon_id := p_exact_sporely_taxon_id;
    insert into source_release(source_system,namespace,release_or_response)
      values(p_source_system,p_namespace,coalesce(p_release_or_response,''))
      on conflict do nothing;
    select source_key into v_source_key from source_release
     where source_system=p_source_system and namespace=p_namespace and release_or_response=coalesce(p_release_or_response,'');
    insert into registry_concept(sporely_taxon_id,canonical_scientific_name,rank,canonical_source_system,canonical_namespace,canonical_external_id,first_registration_reason,scope_state,review_state)
      values(v_taxon_id,p_scientific_name,p_rank,p_source_system,p_namespace,p_external_id,p_reason,p_scope_state,case when p_scope_state='include' then 'approved' else 'needs_review' end)
      on conflict (sporely_taxon_id) do nothing;
    insert into external_mapping values(v_taxon_id,v_source_key,p_source_system,p_namespace,p_external_id,'exact',p_mapping_provenance);
    insert into registered_name(sporely_taxon_id,name,name_kind,language,preferred,source_key,source)
      values(v_taxon_id,p_scientific_name,'selected_snapshot','',true,v_source_key,p_source_system)
      on conflict do nothing;
    if nullif(trim(p_vernacular_name),'') is not null then
      insert into registered_name(sporely_taxon_id,name,name_kind,language,preferred,source_key,source)
        values(v_taxon_id,p_vernacular_name,'vernacular','',true,v_source_key,p_source_system)
        on conflict do nothing;
    end if;
  end if;
  insert into identification_snapshot(sporely_taxon_id,selected_scientific_name,selected_vernacular_name,selected_rank,source_system,source_namespace,raw_external_id,source_release_or_response,selection_timestamp,resolution_state,original_selected_result)
    values(v_taxon_id,p_scientific_name,p_vernacular_name,p_rank,p_source_system,p_namespace,p_external_id,p_release_or_response,p_selection_timestamp,case when v_taxon_id is null then 'unresolved_external' else 'resolved' end,p_original_result)
    returning snapshot_id into v_snapshot_id;
  return jsonb_build_object('snapshot_id',v_snapshot_id,'sporely_taxon_id',v_taxon_id,'resolution_state',case when v_taxon_id is null then 'unresolved_external' else 'resolved' end,'reused_existing_mapping',v_reused);
end $$;

create or replace function attach_exact_resolution(p_snapshot_id bigint, p_sporely_taxon_id bigint, p_note text)
returns jsonb language plpgsql set search_path=w2c_sparse_experiment,pg_catalog as $$
declare v_before jsonb; v_after jsonb;
begin
  if not exists(select 1 from registry_concept where sporely_taxon_id=p_sporely_taxon_id) then
    raise exception 'target registry concept does not exist';
  end if;
  select to_jsonb(s) into v_before from identification_snapshot s where snapshot_id=p_snapshot_id for update;
  if v_before is null then raise exception 'snapshot does not exist'; end if;
  update identification_snapshot set sporely_taxon_id=p_sporely_taxon_id,resolution_state='resolved',resolution_note=p_note where snapshot_id=p_snapshot_id;
  select to_jsonb(s) into v_after from identification_snapshot s where snapshot_id=p_snapshot_id;
  return jsonb_build_object('before',v_before,'after',v_after);
end $$;

create or replace function search_taxa(p_query text, p_language text default 'no', p_limit integer default 20, p_include_cache boolean default true)
returns table(sporely_taxon_id bigint,canonical_scientific_name text,rank text,matched_name text,match_kind text,origin text)
language sql stable as $$
with candidates as (
  select r.sporely_taxon_id,r.canonical_scientific_name,r.rank,r.canonical_scientific_name matched_name,'canonical'::text match_kind,'registry'::text origin,
         case when lower(r.canonical_scientific_name)=lower(trim(coalesce(p_query,''))) then 1 else 4 end priority
    from w2c_sparse_experiment.registry_concept r
   where length(trim(coalesce(p_query,'')))>=2
     and lower(r.canonical_scientific_name) collate "C" >= lower(trim(coalesce(p_query,''))) collate "C"
     and lower(r.canonical_scientific_name) collate "C" < (lower(trim(coalesce(p_query,'')))||U&'\FFFF') collate "C"
     and lower(r.canonical_scientific_name) like replace(replace(replace(lower(trim(coalesce(p_query,''))),'\','\\'),'%','\%'),'_','\_')||'%' escape '\'
  union all
  select r.sporely_taxon_id,r.canonical_scientific_name,r.rank,n.name,n.name_kind,'registry',
         case when lower(n.name)=lower(trim(coalesce(p_query,''))) then case when n.name_kind='scientific_alias' then 2 else 3 end else case when n.name_kind='scientific_alias' then 5 else 6 end end
    from w2c_sparse_experiment.registered_name n join w2c_sparse_experiment.registry_concept r using(sporely_taxon_id)
   where length(trim(coalesce(p_query,'')))>=2 and n.name_kind in ('scientific_alias','vernacular')
     and (n.name_kind!='vernacular' or n.language in (case when trim(coalesce(p_language,''))='' then 'no' else trim(p_language) end,case when trim(coalesce(p_language,'')) in ('','no') then 'nb' else trim(p_language) end,case when trim(coalesce(p_language,'')) in ('','no') then 'nn' else trim(p_language) end,''))
     and lower(n.name) collate "C" >= lower(trim(coalesce(p_query,''))) collate "C"
     and lower(n.name) collate "C" < (lower(trim(coalesce(p_query,'')))||U&'\FFFF') collate "C"
     and lower(n.name) like replace(replace(replace(lower(trim(coalesce(p_query,''))),'\','\\'),'%','\%'),'_','\_')||'%' escape '\'
  union all
  select c.sporely_taxon_id,c.canonical_scientific_name,c.rank,c.canonical_scientific_name,'canonical','cache',case when lower(c.canonical_scientific_name)=lower(trim(coalesce(p_query,''))) then 1 else 4 end
    from w2c_sparse_experiment.cache_concept c join w2c_sparse_experiment.cache_release cr using(release_id)
   where p_include_cache and cr.status='active' and length(trim(coalesce(p_query,'')))>=2
     and lower(c.canonical_scientific_name) collate "C" >= lower(trim(coalesce(p_query,''))) collate "C"
     and lower(c.canonical_scientific_name) collate "C" < (lower(trim(coalesce(p_query,'')))||U&'\FFFF') collate "C"
     and lower(c.canonical_scientific_name) like replace(replace(replace(lower(trim(coalesce(p_query,''))),'\','\\'),'%','\%'),'_','\_')||'%' escape '\'
  union all
  select c.sporely_taxon_id,c.canonical_scientific_name,c.rank,n.name,n.name_kind,'cache',
         case when lower(n.name)=lower(trim(coalesce(p_query,''))) then case when n.name_kind='scientific_alias' then 2 else 3 end else case when n.name_kind='scientific_alias' then 5 else 6 end end
    from w2c_sparse_experiment.cache_search_name n join w2c_sparse_experiment.cache_concept c using(release_id,sporely_taxon_id) join w2c_sparse_experiment.cache_release cr using(release_id)
   where p_include_cache and cr.status='active' and length(trim(coalesce(p_query,'')))>=2
     and (n.name_kind!='vernacular' or n.language in (case when trim(coalesce(p_language,''))='' then 'no' else trim(p_language) end,case when trim(coalesce(p_language,'')) in ('','no') then 'nb' else trim(p_language) end,case when trim(coalesce(p_language,'')) in ('','no') then 'nn' else trim(p_language) end,''))
     and lower(n.name) collate "C" >= lower(trim(coalesce(p_query,''))) collate "C"
     and lower(n.name) collate "C" < (lower(trim(coalesce(p_query,'')))||U&'\FFFF') collate "C"
     and lower(n.name) like replace(replace(replace(lower(trim(coalesce(p_query,''))),'\','\\'),'%','\%'),'_','\_')||'%' escape '\'
), best as (
 select distinct on (sporely_taxon_id) * from candidates order by sporely_taxon_id,priority,matched_name
)
select sporely_taxon_id,canonical_scientific_name,rank,matched_name,match_kind,origin
from best order by priority,canonical_scientific_name,sporely_taxon_id limit greatest(1,least(coalesce(p_limit,20),50))
$$;

revoke all on schema w2c_sparse_experiment from public;
revoke all on all tables in schema w2c_sparse_experiment from public, anon, authenticated;
revoke all on all functions in schema w2c_sparse_experiment from public, anon, authenticated;
