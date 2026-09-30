-- Taxonomy v3 Stage 3W: national preferred scientific names (cloud + web).
--
-- Consumes the sporely-py Stage 3P `taxon.jsonl` contract
-- (database/taxonomy/docs/cloud-export-contract.md, "National preferred
-- scientific names"): optional `preferred_scientific_name_<no|sv>` display and
-- search metadata beside `canonical_scientific_name`, each with the
-- (source_system, namespace, external_id) of the reviewed bridge row it came
-- from. It is never identity: sporely_taxon_id, canonical_scientific_name and
-- the external-id tables are unchanged, and no resolver reads these columns.
--
-- Additive only: nullable columns, a new validation helper, and
-- search_taxa_v2 re-created with three extra trailing output columns (same
-- arguments, same existing columns, same order and ranking). Existing rows and
-- releases carry no national name and behave exactly as before.

alter table public.taxonomy_v2_taxa
  add column preferred_scientific_name_no text,
  add column preferred_scientific_name_no_source_system text,
  add column preferred_scientific_name_no_namespace text,
  add column preferred_scientific_name_no_external_id text,
  add column preferred_scientific_name_sv text,
  add column preferred_scientific_name_sv_source_system text,
  add column preferred_scientific_name_sv_namespace text,
  add column preferred_scientific_name_sv_external_id text;

-- A name and its three provenance fields are all null or all non-blank.
alter table public.taxonomy_v2_taxa
  add constraint taxonomy_v2_taxa_national_name_no_provenance check (
    (preferred_scientific_name_no is null
      and preferred_scientific_name_no_source_system is null
      and preferred_scientific_name_no_namespace is null
      and preferred_scientific_name_no_external_id is null)
    or (coalesce(btrim(preferred_scientific_name_no), '') <> ''
      and coalesce(btrim(preferred_scientific_name_no_source_system), '') <> ''
      and coalesce(btrim(preferred_scientific_name_no_namespace), '') <> ''
      and coalesce(btrim(preferred_scientific_name_no_external_id), '') <> '')
  ),
  add constraint taxonomy_v2_taxa_national_name_sv_provenance check (
    (preferred_scientific_name_sv is null
      and preferred_scientific_name_sv_source_system is null
      and preferred_scientific_name_sv_namespace is null
      and preferred_scientific_name_sv_external_id is null)
    or (coalesce(btrim(preferred_scientific_name_sv), '') <> ''
      and coalesce(btrim(preferred_scientific_name_sv_source_system), '') <> ''
      and coalesce(btrim(preferred_scientific_name_sv_namespace), '') <> ''
      and coalesce(btrim(preferred_scientific_name_sv_external_id), '') <> '')
  );

comment on column public.taxonomy_v2_taxa.preferred_scientific_name_no is
  'Norwegian preferred scientific name (NorTaxa accepted name of an approved reviewed bridge). Display/search metadata only, never identity. Provenance in the _source_system/_namespace/_external_id columns names an accepted authoritative_bridge row of taxonomy_v2_external_ids.';
comment on column public.taxonomy_v2_taxa.preferred_scientific_name_sv is
  'Swedish preferred scientific name (Dyntaxa, from taxonomy-v3 Stage 4). Same rules as preferred_scientific_name_no.';

-- Cross-table traceability the check constraints cannot express. Called by the
-- importer before a release becomes ready; returns an empty array when clean.
create function public.taxonomy_v2_national_name_errors(p_release_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with names as (
    select t.sporely_taxon_id, 'no'::text as country, t.preferred_scientific_name_no as name,
           t.preferred_scientific_name_no_source_system as source_system,
           t.preferred_scientific_name_no_namespace as namespace,
           t.preferred_scientific_name_no_external_id as external_id
    from public.taxonomy_v2_taxa t
    where t.release_id = p_release_id and t.preferred_scientific_name_no is not null
    union all
    select t.sporely_taxon_id, 'sv', t.preferred_scientific_name_sv,
           t.preferred_scientific_name_sv_source_system,
           t.preferred_scientific_name_sv_namespace,
           t.preferred_scientific_name_sv_external_id
    from public.taxonomy_v2_taxa t
    where t.release_id = p_release_id and t.preferred_scientific_name_sv is not null
  ), problems as (
    select pg_catalog.format('preferred_scientific_name_%s of %s has no authoritative bridge row',
                             n.country, n.sporely_taxon_id) as error
    from names n
    where not exists (
      select 1 from public.taxonomy_v2_external_ids e
      where e.release_id = p_release_id
        and e.sporely_taxon_id = n.sporely_taxon_id
        and e.source_system = n.source_system
        and e.namespace = n.namespace
        and e.external_id = n.external_id
        and e.external_name = n.name
        and e.id_role = 'accepted'
        and e.note like 'authoritative_bridge:%'
    )
    union all
    select pg_catalog.format('preferred_scientific_name_%s of %s is not a scientific name of the concept',
                             n.country, n.sporely_taxon_id)
    from names n
    where not exists (
      select 1 from public.taxonomy_v2_scientific_names s
      where s.release_id = p_release_id
        and s.sporely_taxon_id = n.sporely_taxon_id
        and s.scientific_name = n.name
    )
  )
  select coalesce(pg_catalog.jsonb_agg(error order by error), '[]'::jsonb) from problems;
$$;

alter function public.taxonomy_v2_national_name_errors(text) owner to postgres;
revoke all on function public.taxonomy_v2_national_name_errors(text) from public, anon, authenticated;
grant execute on function public.taxonomy_v2_national_name_errors(text) to service_role;

-- search_taxa_v2 gains trailing output columns, which requires drop + create.
-- Body is the 20260724130000 definition with national-name output added; the
-- national name is always a taxonomy_v2_scientific_names row of the concept
-- (enforced above), so the existing alias branch already matches it.
drop function public.search_taxa_v2(text, text, integer);

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
  match_type text,
  preferred_scientific_name_no text,
  preferred_scientific_name_sv text,
  display_scientific_name text
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
         b.candidate_match_type,
         t.preferred_scientific_name_no,
         t.preferred_scientific_name_sv,
         -- `lang` is the caller's UI language (the web normalizes nb/nn/no to
         -- 'no'); any other language, or a null field, shows the canonical name.
         coalesce(
           case i.requested_lang
             when 'no' then t.preferred_scientific_name_no
             when 'sv' then t.preferred_scientific_name_sv
           end,
           t.canonical_scientific_name
         )
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

alter function public.search_taxa_v2(text, text, integer) owner to postgres;
revoke all on function public.search_taxa_v2(text, text, integer) from public;
grant execute on function public.search_taxa_v2(text, text, integer) to anon, authenticated, service_role;
