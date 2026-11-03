-- Taxonomy name associations (sporely-py tax-2026.10.31-01 candidate).
--
-- A taxonomy release may now attach a NorTaxa or Dyntaxa usage to the concept
-- of the same canonical scientific name and rank by the owner's name-association
-- policy (sporely-py database/taxonomy/policies/name_association_policy.json),
-- not only by a reviewed bridge. Those rows carry the note
-- 'name_association:<rule>' and are imported into taxonomy_v2_external_ids like
-- any other namespaced id. A national preferred scientific name taken from such
-- an association names that row as its provenance, so the importer's
-- traceability check accepts it alongside 'authoritative_bridge:%'.
--
-- Additive and backward compatible: the active release has no such rows, and
-- every name an earlier release could carry is still accepted. No other
-- function, table, policy or grant changes.

create or replace function public.taxonomy_v2_national_name_errors(p_release_id text)
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
        and (e.note like 'authoritative_bridge:%' or e.note like 'name_association:%')
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

comment on column public.taxonomy_v2_taxa.preferred_scientific_name_no is
  'Norwegian preferred scientific name (NorTaxa accepted name of a reviewed bridge or a release name association). Display/search metadata only, never identity. Provenance in the _source_system/_namespace/_external_id columns names an accepted authoritative_bridge or name_association row of taxonomy_v2_external_ids.';
