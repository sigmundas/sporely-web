-- User-selected taxonomy-v2 identity is distinct from the immutable W3
-- historical resolution in resolved_sporely_taxon_id.
alter table public.observations
  add column if not exists selected_sporely_taxon_id bigint
    references public.taxonomy_v2_concepts(sporely_taxon_id)
    on delete set null;

comment on column public.observations.selected_sporely_taxon_id is
  'Stable Sporely concept explicitly selected by the observation owner through set_observation_selected_taxon_v2. Additive to the submitted name/provider snapshot and separate from trusted taxonomy-v3 historical resolution.';

create or replace function public._guard_selected_sporely_taxon_id_v2()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and ((tg_op = 'INSERT' and new.selected_sporely_taxon_id is not null)
       or (tg_op = 'UPDATE' and new.selected_sporely_taxon_id is distinct from old.selected_sporely_taxon_id)) then
    raise exception 'public.observations.selected_sporely_taxon_id must be changed through set_observation_selected_taxon_v2'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_selected_sporely_taxon_id_v2_trg on public.observations;
create trigger guard_selected_sporely_taxon_id_v2_trg
before insert or update of selected_sporely_taxon_id on public.observations
for each row execute function public._guard_selected_sporely_taxon_id_v2();

create or replace function public.set_observation_selected_taxon_v2(
  p_observation_id bigint,
  p_sporely_taxon_id bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.observations o
    where o.id = p_observation_id and o.user_id = auth.uid()
  ) then
    raise exception 'observation not found or caller does not own it' using errcode = '42501';
  end if;

  if p_sporely_taxon_id is not null and not exists (
    select 1
    from public.taxonomy_v2_releases r
    join public.taxonomy_v2_taxa t on t.release_id = r.release_id
    where r.status = 'active' and t.sporely_taxon_id = p_sporely_taxon_id
  ) then
    raise exception 'sporely_taxon_id % is missing from the active taxonomy-v2 release', p_sporely_taxon_id
      using errcode = '22023';
  end if;

  update public.observations
     set selected_sporely_taxon_id = p_sporely_taxon_id
   where id = p_observation_id;
end;
$$;

alter function public._guard_selected_sporely_taxon_id_v2() owner to postgres;
alter function public.set_observation_selected_taxon_v2(bigint, bigint) owner to postgres;
revoke all on function public._guard_selected_sporely_taxon_id_v2() from public, anon, authenticated;
revoke all on function public.set_observation_selected_taxon_v2(bigint, bigint) from public, anon;
grant execute on function public.set_observation_selected_taxon_v2(bigint, bigint) to authenticated, service_role;
