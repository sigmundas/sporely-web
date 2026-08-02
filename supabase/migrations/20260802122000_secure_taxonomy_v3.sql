-- Taxonomy-v3 RLS, grants, and final security setup.
set search_path = taxonomy_v3, pg_catalog;
--
-- Reads: anon + authenticated may SELECT registry_concept, external_mapping,
-- resolution_link (they are the client-facing lookup tables — no PII).
-- Writes: only service_role. Clients CANNOT insert or update anything under
-- taxonomy_v3. This aligns with the accepted rule "no user should be able to
-- self-assign an arbitrary canonical mapping through direct table writes."
-- identification_snapshot is service_role-only for reads too — original text
-- may carry unstructured data the observation owner has separate policies on
-- in public.observations.

alter table registry_concept              enable row level security;
alter table external_mapping              enable row level security;
alter table identification_snapshot       enable row level security;
alter table resolution_link               enable row level security;
alter table release_installation          enable row level security;
alter table supplement_installation       enable row level security;
alter table reconciliation_manifest_audit enable row level security;

-- Registry + external_mapping are pure reference data (no PII, no owner):
-- world-readable by design.
do $$ begin if not exists (select 1 from pg_policies where policyname='taxonomy_v3_public_read_registry') then
  create policy taxonomy_v3_public_read_registry
  on registry_concept for select
  to anon, authenticated using (true);
end if; end $$;
do $$ begin if not exists (select 1 from pg_policies where policyname='taxonomy_v3_public_read_mapping') then
  create policy taxonomy_v3_public_read_mapping
  on external_mapping for select
  to anon, authenticated using (true);
end if; end $$;

-- W3-A2 privacy fix: resolution_link inherits per-observation visibility
-- from public.observations. anon may see rows only when the observation is
-- publicly visible; authenticated may additionally see rows the caller
-- owns (matching the baseline visibility model in
-- supabase/migrations/*_baseline_live_public_schema.sql).
do $$ begin if not exists (select 1 from pg_policies where policyname='taxonomy_v3_read_resolution_anon') then
  create policy taxonomy_v3_read_resolution_anon
  on resolution_link for select
  to anon
  using (
    exists (
      select 1 from public.observations o
       where o.id::text = resolution_link.observation_id
         and o.visibility = 'public'
    )
  );
end if; end $$;
do $$ begin if not exists (select 1 from pg_policies where policyname='taxonomy_v3_read_resolution_authenticated') then
  create policy taxonomy_v3_read_resolution_authenticated
  on resolution_link for select
  to authenticated
  using (
    exists (
      select 1 from public.observations o
       where o.id::text = resolution_link.observation_id
         and (o.visibility = 'public' or o.user_id = auth.uid())
    )
  );
end if; end $$;
-- No public policy on identification_snapshot, release_installation,
-- supplement_installation, or reconciliation_manifest_audit → default-deny
-- for anon/authenticated. service_role bypasses RLS.

revoke all on all tables in schema taxonomy_v3 from public, anon, authenticated;
grant usage on schema taxonomy_v3 to anon, authenticated, service_role;
grant select on registry_concept, external_mapping, resolution_link to anon, authenticated;
grant all on all tables in schema taxonomy_v3 to service_role;
revoke all on all functions in schema taxonomy_v3 from public, anon, authenticated;
grant execute on function install_release_chain(jsonb, jsonb, jsonb) to service_role;
