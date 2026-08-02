-- Taxonomy-v3 additive observation integration. Existing observation names,
-- provider identifiers, constraints, and client read/write paths are retained.
--
-- The production rollout is additive:
--   * public.observations gets ONE nullable column (or a foreign-key link
--     to taxonomy_v3.resolution_link — see options below).
--   * every existing taxonomy/name column on public.observations remains
--     the authoritative historical snapshot — no rewrites, no drops, no
--     defaults changed.
--   * unresolved / manual / no-evidence observations carry NULL in the new
--     column and remain fully readable by legacy clients.
--   * later resolution updates only the resolution_link row (or the
--     link-column value); the observation's original fields never move.
--
-- Two options were considered:
--
--   Option A (chosen for rehearsal): a nullable column on public.observations
--     resolved_sporely_taxon_id  integer references taxonomy_v3.registry_concept(sporely_taxon_id)
--       on delete set null
--   * pro: single-row read gets the canonical link for free; no joins;
--     matches how legacy clients read the row.
--   * con: adds one column to a wide table.
--
--   Option B: no column on public.observations; taxonomy_v3.resolution_link
--     is the sole source, joined at read time (already exists as
--     resolution_link.observation_id → public.observations.id).
--   * pro: zero write pressure on public.observations.
--   * con: every canonical-name read requires a join; harder for legacy
--     dual-read paths.
--
-- Option A is applied here. Option B remains a fallback the operator can
-- select at production authorisation time.
--
-- No RLS policy changes on public.observations. The new column inherits
-- the existing per-row visibility rules. Clients cannot self-assign the
-- new column (see below).

-- --- observations link ---

alter table public.observations
  add column if not exists resolved_sporely_taxon_id integer
    references taxonomy_v3.registry_concept(sporely_taxon_id)
    on delete set null;

comment on column public.observations.resolved_sporely_taxon_id is
  'W3-A additive canonical link to the sparse taxonomy_v3 registry. NULL until historical reconciliation attaches identity, and NULL for observations that remain unresolved / manual / no-evidence. NEVER rewritten by the resolver — only updated by service_role via taxonomy_v3.install_release_chain(). Legacy taxonomy/name columns on this row remain the authoritative historical snapshot.';

-- Prevent clients from self-assigning the canonical link. A single trigger
-- on the observations table rejects any UPDATE that touches this column
-- from a non-service role. INSERT is allowed (must be NULL by RLS +
-- application default; enforced by a check below).

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'w3a_new_column_nullable'
       and conrelid = 'public.observations'::regclass
  ) then
    alter table public.observations
      add constraint w3a_new_column_nullable check (
        resolved_sporely_taxon_id is null
        or resolved_sporely_taxon_id > 0
      );
  end if;
end $$;

-- W3-A2 hardening: guard covers INSERT and UPDATE, and identifies
-- privileged callers by DATABASE ROLE, not by an inspectable JWT claim.
-- Any role NOT in ('service_role', session_user='postgres', 'supabase_admin')
-- may not set resolved_sporely_taxon_id to a non-null value on INSERT or
-- change it on UPDATE.

create or replace function _w3a_guard_resolved_sporely_taxon_id() returns trigger
  language plpgsql as $$
declare
  v_role text := current_user;
  v_allowed boolean := v_role in ('service_role', 'postgres', 'supabase_admin');
begin
  if TG_OP = 'INSERT' then
    if new.resolved_sporely_taxon_id is not null and not v_allowed then
      raise exception 'public.observations.resolved_sporely_taxon_id can only be set by service_role (attempted by %)', v_role
        using errcode = 'insufficient_privilege';
    end if;
  elsif TG_OP = 'UPDATE' then
    if new.resolved_sporely_taxon_id is distinct from old.resolved_sporely_taxon_id then
      if not v_allowed then
        raise exception 'public.observations.resolved_sporely_taxon_id can only be updated by service_role (attempted by %)', v_role
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;
  return new;
end $$;

do $$ begin if not exists (select 1 from pg_trigger where tgname='w3a_guard_resolved_sporely_taxon_id_ins_trg') then
  create trigger w3a_guard_resolved_sporely_taxon_id_ins_trg
  before insert on public.observations
  for each row execute function _w3a_guard_resolved_sporely_taxon_id();
end if; end $$;
do $$ begin if not exists (select 1 from pg_trigger where tgname='w3a_guard_resolved_sporely_taxon_id_trg') then
  create trigger w3a_guard_resolved_sporely_taxon_id_trg
  before update of resolved_sporely_taxon_id on public.observations
  for each row execute function _w3a_guard_resolved_sporely_taxon_id();
end if; end $$;

-- The installer function reads taxonomy_v3.resolution_link and writes to
-- public.observations.resolved_sporely_taxon_id in one atomic UPDATE.
-- It never modifies any other observation field.

create or replace function taxonomy_v3.link_observations_to_resolution() returns integer
  language plpgsql
  security definer
  set search_path = taxonomy_v3, pg_catalog, public as $$
declare v_updated integer;
begin
  update public.observations o
     set resolved_sporely_taxon_id = rl.resolved_sporely_taxon_id
    from taxonomy_v3.resolution_link rl
   where rl.observation_id = o.id::text
     and rl.resolved_sporely_taxon_id is not null
     and o.resolved_sporely_taxon_id is distinct from rl.resolved_sporely_taxon_id;
  get diagnostics v_updated = row_count;
  return v_updated;
end $$;

revoke all on function taxonomy_v3.link_observations_to_resolution() from public, anon, authenticated;
grant execute on function taxonomy_v3.link_observations_to_resolution() to service_role;
