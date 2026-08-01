\set ON_ERROR_STOP on
\timing on

drop schema if exists taxonomy_v2_experiment_b cascade;
create schema taxonomy_v2_experiment_b;
create table taxonomy_v2_experiment_b.taxa as
select 1::smallint slot, sporely_taxon_id, parent_sporely_taxon_id, genus,
       specific_epithet, family, canonical_scientific_name, taxon_rank,
       taxonomic_status, source_system, canonical_source_system, canonical_external_id
from public.taxonomy_v2_taxa;
alter table taxonomy_v2_experiment_b.taxa add primary key(slot,sporely_taxon_id);
create index b_taxa_name on taxonomy_v2_experiment_b.taxa(slot,lower(canonical_scientific_name) text_pattern_ops);
create table taxonomy_v2_experiment_b.scientific_names as
select 1::smallint slot, sporely_taxon_id, language_code, scientific_name,
       is_preferred_name, source, alias_reason from public.taxonomy_v2_scientific_names;
create unique index b_scientific_unique on taxonomy_v2_experiment_b.scientific_names(slot,sporely_taxon_id,language_code,scientific_name);
create index b_scientific_name on taxonomy_v2_experiment_b.scientific_names(slot,lower(scientific_name) text_pattern_ops);
create table taxonomy_v2_experiment_b.vernacular_names as
select 1::smallint slot, sporely_taxon_id, language_code, vernacular_name,is_preferred_name,source
from public.taxonomy_v2_vernacular_names;
create unique index b_vernacular_unique on taxonomy_v2_experiment_b.vernacular_names(slot,sporely_taxon_id,language_code,vernacular_name);
create index b_vernacular_name on taxonomy_v2_experiment_b.vernacular_names(slot,language_code,lower(vernacular_name) text_pattern_ops);
create table taxonomy_v2_experiment_b.external_ids as
select 1::smallint slot, sporely_taxon_id, source_system,namespace,external_id,id_role,is_preferred,external_name,note
from public.taxonomy_v2_external_ids;
create unique index b_external_unique on taxonomy_v2_experiment_b.external_ids(slot,source_system,namespace,external_id,sporely_taxon_id);
create index b_external_lookup on taxonomy_v2_experiment_b.external_ids(slot,source_system,namespace,external_id);
create table taxonomy_v2_experiment_b.redlist as select 1::smallint slot,r.* from public.taxonomy_v2_redlist r;
alter table taxonomy_v2_experiment_b.redlist drop column release_id;
create unique index b_redlist_unique on taxonomy_v2_experiment_b.redlist(slot,source_system,source_release,assessment_id);
create index b_redlist_taxon on taxonomy_v2_experiment_b.redlist(slot,sporely_taxon_id,assessment_area);
create table taxonomy_v2_experiment_b.concepts as select sporely_taxon_id from public.taxonomy_v2_concepts;
alter table taxonomy_v2_experiment_b.concepts add primary key(sporely_taxon_id);
analyze taxonomy_v2_experiment_b.taxa;
analyze taxonomy_v2_experiment_b.scientific_names;
analyze taxonomy_v2_experiment_b.vernacular_names;
analyze taxonomy_v2_experiment_b.external_ids;
analyze taxonomy_v2_experiment_b.redlist;

drop schema if exists taxonomy_v2_experiment_c cascade;
create schema taxonomy_v2_experiment_c;
create table taxonomy_v2_experiment_c.rank_dictionary as select row_number() over(order by taxon_rank)::smallint code,taxon_rank from (select distinct taxon_rank from public.taxonomy_v2_taxa) s;
create table taxonomy_v2_experiment_c.source_dictionary as select row_number() over(order by value)::smallint code,value from (select distinct canonical_source_system value from public.taxonomy_v2_taxa) s;
create table taxonomy_v2_experiment_c.language_dictionary as select row_number() over(order by language_code)::smallint code,language_code from (select distinct language_code from public.taxonomy_v2_vernacular_names) s;
create table taxonomy_v2_experiment_c.family_dictionary as select row_number() over(order by family)::integer code,family from (select distinct family from public.taxonomy_v2_taxa where family is not null) s;
create table taxonomy_v2_experiment_c.genus_dictionary as select row_number() over(order by genus)::integer code,genus from (select distinct genus from public.taxonomy_v2_taxa) s;
create table taxonomy_v2_experiment_c.taxa as
select 1::smallint slot,t.sporely_taxon_id::integer,t.parent_sporely_taxon_id::integer,
       g.code genus_code,t.specific_epithet,f.code family_code,t.canonical_scientific_name,
       r.code rank_code,s.code source_code,t.canonical_external_id
from public.taxonomy_v2_taxa t
join taxonomy_v2_experiment_c.rank_dictionary r using(taxon_rank)
join taxonomy_v2_experiment_c.source_dictionary s on s.value=t.canonical_source_system
join taxonomy_v2_experiment_c.genus_dictionary g using(genus)
left join taxonomy_v2_experiment_c.family_dictionary f using(family);
alter table taxonomy_v2_experiment_c.taxa add primary key(slot,sporely_taxon_id);
create index c_taxa_name on taxonomy_v2_experiment_c.taxa(slot,lower(canonical_scientific_name) text_pattern_ops);
create index c_taxa_resolver on taxonomy_v2_experiment_c.taxa(slot,source_code,canonical_external_id);
create table taxonomy_v2_experiment_c.scientific_aliases as
select 1::smallint slot,n.sporely_taxon_id::integer,n.scientific_name,n.is_preferred_name
from public.taxonomy_v2_scientific_names n join public.taxonomy_v2_taxa t using(release_id,sporely_taxon_id)
where n.scientific_name is distinct from t.canonical_scientific_name;
create unique index c_alias_unique on taxonomy_v2_experiment_c.scientific_aliases(slot,sporely_taxon_id,scientific_name);
create index c_alias_name on taxonomy_v2_experiment_c.scientific_aliases(slot,lower(scientific_name) text_pattern_ops);
create table taxonomy_v2_experiment_c.vernacular_names as
select 1::smallint slot,v.sporely_taxon_id::integer,l.code language_code,
       v.vernacular_name,v.is_preferred_name from public.taxonomy_v2_vernacular_names v
join taxonomy_v2_experiment_c.language_dictionary l using(language_code);
create unique index c_vernacular_unique on taxonomy_v2_experiment_c.vernacular_names(slot,sporely_taxon_id,language_code,vernacular_name);
create index c_vernacular_name on taxonomy_v2_experiment_c.vernacular_names(slot,language_code,lower(vernacular_name) text_pattern_ops);
create table taxonomy_v2_experiment_c.external_id_exceptions as
select 1::smallint slot,e.sporely_taxon_id::integer,s.code source_code,e.namespace,e.external_id,e.id_role,e.is_preferred
from public.taxonomy_v2_external_ids e join public.taxonomy_v2_taxa t using(release_id,sporely_taxon_id)
join taxonomy_v2_experiment_c.source_dictionary s on s.value=e.source_system
where (e.source_system,e.external_id) is distinct from (t.canonical_source_system,t.canonical_external_id);
create unique index c_external_unique on taxonomy_v2_experiment_c.external_id_exceptions(slot,source_code,namespace,external_id,sporely_taxon_id);
create index c_external_lookup on taxonomy_v2_experiment_c.external_id_exceptions(slot,source_code,namespace,external_id);
create table taxonomy_v2_experiment_c.redlist as
select 1::smallint slot,sporely_taxon_id::integer,
       case assessment_area when 'Norway' then 1 when 'Svalbard' then 2 else 127 end::smallint area_code,
       assessment_id,category_code,category_is_downgraded,criteria,assessment_url
from public.taxonomy_v2_redlist;
create unique index c_redlist_unique on taxonomy_v2_experiment_c.redlist(slot,assessment_id);
create index c_redlist_taxon on taxonomy_v2_experiment_c.redlist(slot,sporely_taxon_id,area_code);
analyze taxonomy_v2_experiment_c.taxa;
analyze taxonomy_v2_experiment_c.scientific_aliases;
analyze taxonomy_v2_experiment_c.vernacular_names;
analyze taxonomy_v2_experiment_c.external_id_exceptions;
analyze taxonomy_v2_experiment_c.redlist;

create table taxonomy_v2_experiment_c.publication(slot smallint primary key,release_id text unique not null,whole_export_sha256 text not null,status text not null);
insert into taxonomy_v2_experiment_c.publication values(1,'tax-2026.07.30-02','c3c770dca660b7995b3be253ba201bccd438e23a8aee3a7e06ed22659bf4a285','active');
create table taxonomy_v2_experiment_c.active_publication(singleton boolean primary key default true check(singleton),slot smallint not null references taxonomy_v2_experiment_c.publication(slot));
insert into taxonomy_v2_experiment_c.active_publication values(true,1);

create function taxonomy_v2_experiment_c.search(p_query text,p_languages smallint[] default array[1,2,3,4,5,6]::smallint[],p_limit integer default 20)
returns table(sporely_taxon_id integer,canonical_scientific_name text,matched_name text,ranking_class integer)
language sql stable set search_path='' as $$
with active as (select slot from taxonomy_v2_experiment_c.active_publication where singleton), q as (
 select lower(btrim(p_query)) raw,
        replace(replace(replace(lower(btrim(p_query)),E'\\',E'\\\\'),'%','\%'),'_','\_') escaped
), candidates as (
 select t.sporely_taxon_id,t.canonical_scientific_name,t.canonical_scientific_name matched_name,
        case when lower(t.canonical_scientific_name)=q.raw then 1 else 5 end ranking_class
 from taxonomy_v2_experiment_c.taxa t cross join q cross join active
 where t.slot=active.slot and char_length(q.raw)>=2 and lower(t.canonical_scientific_name) like q.escaped||'%' escape '\'
 union all
 select t.sporely_taxon_id,t.canonical_scientific_name,a.scientific_name,
        case when lower(a.scientific_name)=q.raw then 2 else 6 end
 from taxonomy_v2_experiment_c.scientific_aliases a join taxonomy_v2_experiment_c.taxa t using(slot,sporely_taxon_id) cross join q cross join active
 where a.slot=active.slot and char_length(q.raw)>=2 and lower(a.scientific_name) like q.escaped||'%' escape '\'
 union all
 select t.sporely_taxon_id,t.canonical_scientific_name,v.vernacular_name,
        case when lower(v.vernacular_name)=q.raw then case when v.is_preferred_name then 3 else 4 end
             else case when v.is_preferred_name then 7 else 8 end end
 from taxonomy_v2_experiment_c.vernacular_names v join taxonomy_v2_experiment_c.taxa t using(slot,sporely_taxon_id) cross join q cross join active
 where v.slot=active.slot and v.language_code=any(p_languages) and char_length(q.raw)>=2 and lower(v.vernacular_name) like q.escaped||'%' escape '\'
), best as (
 select *,row_number() over(partition by sporely_taxon_id order by ranking_class,matched_name,sporely_taxon_id) rn from candidates
)
select sporely_taxon_id,canonical_scientific_name,matched_name,ranking_class
from best where rn=1 order by ranking_class,canonical_scientific_name,sporely_taxon_id limit greatest(1,least(coalesce(p_limit,20),50));
$$;
