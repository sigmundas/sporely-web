-- W3-A local rehearsal — production-shaped taxonomy_v3 schema DRAFT.
--
-- NOT A SUPABASE MIGRATION. NOT PRODUCTION.
-- Lives under supabase/drafts/ so it can NEVER be reached by `supabase db reset`
-- or `supabase migration up`. Applied only by
-- scripts/taxonomy-v3/install-release-chain.mjs against a disposable local
-- Supabase stack.
--
-- Design principles carried over from W2E-B:
--   * identity registry, scope state, cache membership, historical
--     identification snapshot, and current canonical resolution are five
--     SEPARATE artefacts;
--   * identification snapshots are immutable (trigger);
--   * (source_system, namespace, external_id) is a hard UNIQUE
--     invariant on external mappings; conflicting reassign raises;
--   * cache_state is stored on registry_concept; the base release's
--     taxon_external_id.jsonl is the sole population of the search cache.
--     Supplements never broaden the cache.
--
-- Schema layout:
--   taxonomy_v3.registry_concept
--   taxonomy_v3.external_mapping
--   taxonomy_v3.identification_snapshot        (immutable)
--   taxonomy_v3.resolution_link                (mutable)
--   taxonomy_v3.release_installation           (audit)
--   taxonomy_v3.supplement_installation        (audit — dependency graph)
--   taxonomy_v3.reconciliation_manifest_audit  (audit — semantic SHA)
--
-- The `public.observations` link is designed but NOT applied here — see
-- taxonomy_v3_observations_integration_draft.sql for the additive column
-- and the compatibility rules.

drop schema if exists taxonomy_v3 cascade;
create schema taxonomy_v3;
set search_path = taxonomy_v3, pg_catalog;

-- ---------------------------------------------------------------------------
-- registry_concept: sparse canonical registry. Cache membership and scope
-- state are stored INDEPENDENTLY per the W2E-A2 architectural decision.

create table registry_concept (
  sporely_taxon_id           integer primary key,
  canonical_name             text,
  rank                       text,
  scope_state                text
    check (scope_state is null or scope_state in ('include','review','exclude','not_evaluated','required_ancestor')),
  cache_state                text not null default 'in_cache'
    check (cache_state in ('in_cache','out_of_cache')),
  first_materialized_from_release text not null
);
comment on column registry_concept.cache_state is
  'Whether this concept is currently a member of the searchable release cache. Only concepts materialised from the base release start life in_cache. Supplement anchors materialise out_of_cache and stay there unless a future scope-widening release explicitly promotes them.';
comment on column registry_concept.scope_state is
  'The originating release''s scope predicate verdict, preserved verbatim. NULL when the release did not evaluate this concept.';

-- ---------------------------------------------------------------------------
-- external_mapping: (source_system, namespace, external_id) -> sporely_taxon_id.
-- The UNIQUE constraint is the hardened conflict invariant from W2E-A2:
-- reassigning an existing tuple to a different sporely_taxon_id raises inside
-- the installer transaction and rolls the whole chain back.

create table external_mapping (
  source_system     text not null,
  namespace         text not null,
  external_id       text not null,
  sporely_taxon_id  integer not null references registry_concept(sporely_taxon_id)
    on delete restrict,
  release_id        text not null,
  unique (source_system, namespace, external_id)
);
create index external_mapping_taxon_idx on external_mapping (sporely_taxon_id);

-- ---------------------------------------------------------------------------
-- identification_snapshot: immutable historical snapshot per observation.

create table identification_snapshot (
  observation_id              text primary key,
  original_scientific_name    text,
  original_vernacular_name    text,
  original_rank               text,
  original_legacy_taxon_id    text,
  original_source_system      text,
  original_source_namespace   text,
  original_external_id        text,
  original_signals            jsonb not null default '[]'::jsonb,
  snapshot_locked             boolean not null default true,
  snapshot_written_at         timestamptz not null default now()
);

create or replace function _guard_snapshot_immutability() returns trigger
  language plpgsql as $$
begin
  if old.snapshot_locked is true then
    if old.original_scientific_name  is distinct from new.original_scientific_name
       or old.original_vernacular_name  is distinct from new.original_vernacular_name
       or old.original_rank             is distinct from new.original_rank
       or old.original_legacy_taxon_id  is distinct from new.original_legacy_taxon_id
       or old.original_source_system    is distinct from new.original_source_system
       or old.original_source_namespace is distinct from new.original_source_namespace
       or old.original_external_id      is distinct from new.original_external_id
       or old.original_signals          is distinct from new.original_signals
    then
      raise exception 'taxonomy_v3.identification_snapshot original_* fields are immutable (observation_id=%)', old.observation_id;
    end if;
  end if;
  return new;
end $$;

create trigger identification_snapshot_immutability_trg
  before update on identification_snapshot
  for each row execute function _guard_snapshot_immutability();

-- ---------------------------------------------------------------------------
-- resolution_link: mutable current-canonical-resolution pointer.
-- One row per observation; later resolution overwrites this row but never the
-- snapshot. reconciliation_state carries the manifest verdict verbatim so
-- callers can distinguish resolved / manual / no-evidence / conflicting etc.

create table resolution_link (
  observation_id              text primary key
    references identification_snapshot(observation_id) on delete cascade,
  resolution_state            text not null,
  resolved_sporely_taxon_id   integer references registry_concept(sporely_taxon_id)
    on delete set null,
  resolution_method           text,
  resolution_evidence         jsonb not null default '[]'::jsonb,
  resolution_release          text,
  manifest_semantic_sha256    text,
  attached_at                 timestamptz not null default now()
);
create index resolution_link_taxon_idx on resolution_link (resolved_sporely_taxon_id);
create index resolution_link_state_idx on resolution_link (resolution_state);

-- ---------------------------------------------------------------------------
-- Release-installation audit. Every install of a base release or supplement
-- writes one row here. The installer refuses to install any release_id whose
-- shard_sha256 differs from a row that already exists.

create table release_installation (
  release_id                        text primary key,
  artifact_kind                     text not null
    check (artifact_kind in ('release','registry_supplement')),
  base_release_id                   text,
  supplement_contract_version       text,
  base_release_export_manifest_sha256 text,
  base_release_scope_manifest_sha256  text,
  supplement_shard_sha256           text,
  supplement_registry_manifest_sha256 text,
  installed_at                      timestamptz not null default now()
);

create table supplement_installation (
  supplement_release_id text not null references release_installation(release_id),
  depends_on_release_id text not null references release_installation(release_id),
  primary key (supplement_release_id, depends_on_release_id)
);

create table reconciliation_manifest_audit (
  manifest_semantic_sha256 text primary key,
  record_count             integer not null,
  state_counts             jsonb not null,
  applied_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Installer function.  Accepts the whole chain + reconciliation manifest as
-- jsonb literals (see scripts/taxonomy-v3/install-release-chain.mjs).

create or replace function install_release_chain(
  p_base                    jsonb,   -- {release_id, export_manifest_sha256, scope_manifest_sha256}
  p_supplements             jsonb,   -- [{release_id, base_release_id, depends_on:[], supplement_shard_sha256, supplement_registry_manifest_sha256, external_mappings:[]}, ...]
  p_reconciliation_manifest jsonb    -- {semantic_sha256, record_count, records:[...], state_counts, aggregate_counts}
) returns jsonb language plpgsql
  set search_path = taxonomy_v3, pg_catalog as $$
declare
  v_supp   jsonb;
  v_map    jsonb;
  v_record jsonb;
  v_signal jsonb;
  v_resolved integer;
  v_row_count integer;
  v_manifest_sha text;
  v_record_count integer;
  v_snap_added integer := 0;
  v_link_added integer := 0;
  v_reg_added  integer := 0;
  v_map_added  integer := 0;
begin
  -- Base-release row is idempotent on hashes; reused if already installed.
  insert into release_installation (
    release_id, artifact_kind, base_release_id, supplement_contract_version,
    base_release_export_manifest_sha256, base_release_scope_manifest_sha256
  ) values (
    p_base->>'release_id', 'release', null, null,
    p_base->>'export_manifest_sha256', p_base->>'scope_manifest_sha256'
  ) on conflict (release_id) do update
    set installed_at = excluded.installed_at
    where release_installation.base_release_export_manifest_sha256
              = excluded.base_release_export_manifest_sha256
      and release_installation.base_release_scope_manifest_sha256
              = excluded.base_release_scope_manifest_sha256;
  get diagnostics v_row_count = row_count;
  if v_row_count = 0 then
    raise exception 'release-ID reuse: base release % already installed with different hashes',
      p_base->>'release_id'
      using errcode = 'unique_violation';
  end if;

  -- Supplements.
  for v_supp in select e.value from jsonb_array_elements(coalesce(p_supplements,'[]'::jsonb)) e(value) loop
    insert into release_installation (
      release_id, artifact_kind, base_release_id, supplement_contract_version,
      supplement_shard_sha256, supplement_registry_manifest_sha256
    ) values (
      v_supp->>'release_id', 'registry_supplement', v_supp->>'base_release_id', v_supp->>'supplement_contract_version',
      v_supp->>'supplement_shard_sha256', v_supp->>'supplement_registry_manifest_sha256'
    ) on conflict (release_id) do update
      set installed_at = excluded.installed_at
      where release_installation.supplement_shard_sha256
                = excluded.supplement_shard_sha256
        and release_installation.supplement_registry_manifest_sha256
                = excluded.supplement_registry_manifest_sha256;
    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      raise exception 'release-ID reuse: supplement % already installed with different hashes',
        v_supp->>'release_id'
        using errcode = 'unique_violation';
    end if;

    -- depends_on edges + strict validation.
    for v_map in select e.value from jsonb_array_elements(coalesce(v_supp->'depends_on','[]'::jsonb)) e(value) loop
      if not exists (select 1 from release_installation where release_id = v_map#>>'{}') then
        raise exception 'supplement % depends on % which is not installed', v_supp->>'release_id', v_map#>>'{}';
      end if;
      insert into supplement_installation values (v_supp->>'release_id', v_map#>>'{}')
        on conflict do nothing;
    end loop;

    -- Materialise the supplement's external_mappings AS registry_concept +
    -- external_mapping. Conflict handling matches the W2E-A2 invariant.
    for v_map in select e.value from jsonb_array_elements(coalesce(v_supp->'external_mappings','[]'::jsonb)) e(value) loop
      insert into registry_concept (
        sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release
      ) values (
        (v_map->>'sporely_taxon_id')::integer,
        v_map->>'canonical_name',
        v_map->>'rank',
        coalesce(v_map->>'scope_state', 'not_evaluated'),
        coalesce(v_map->>'cache_state', 'out_of_cache'),
        v_supp->>'release_id'
      ) on conflict (sporely_taxon_id) do nothing;
      get diagnostics v_row_count = row_count;
      v_reg_added := v_reg_added + v_row_count;

      insert into external_mapping (
        source_system, namespace, external_id, sporely_taxon_id, release_id
      ) values (
        v_map->>'source_system',
        v_map->>'namespace',
        v_map->>'external_id',
        (v_map->>'sporely_taxon_id')::integer,
        v_supp->>'release_id'
      ) on conflict (source_system, namespace, external_id) do update
        set sporely_taxon_id = external_mapping.sporely_taxon_id
        where external_mapping.sporely_taxon_id = excluded.sporely_taxon_id;
      get diagnostics v_row_count = row_count;
      if v_row_count = 0 then
        raise exception 'external_mapping conflict: (%, %, %) is already anchored to a different sporely_taxon_id (attempted %)',
          v_map->>'source_system', v_map->>'namespace', v_map->>'external_id',
          v_map->>'sporely_taxon_id'
          using errcode = 'unique_violation';
      end if;
      v_map_added := v_map_added + 1;
    end loop;
  end loop;

  -- Reconciliation manifest audit.
  v_manifest_sha := p_reconciliation_manifest->>'semantic_sha256';
  v_record_count := (p_reconciliation_manifest->>'record_count')::integer;
  insert into reconciliation_manifest_audit (
    manifest_semantic_sha256, record_count, state_counts
  ) values (
    v_manifest_sha, v_record_count,
    coalesce(p_reconciliation_manifest->'aggregate_counts', p_reconciliation_manifest->'state_counts', '{}'::jsonb)
  ) on conflict (manifest_semantic_sha256) do nothing;

  -- Apply the manifest: identification_snapshot (immutable) + resolution_link.
  for v_record in select e.value from jsonb_array_elements(coalesce(p_reconciliation_manifest->'records','[]'::jsonb)) e(value) loop
    insert into identification_snapshot (
      observation_id, original_scientific_name, original_vernacular_name,
      original_rank, original_legacy_taxon_id, original_source_system,
      original_source_namespace, original_external_id, original_signals
    ) values (
      v_record->>'observation_id',
      v_record->>'original_scientific_name',
      v_record->>'original_vernacular_name',
      v_record->>'original_rank',
      v_record->>'original_legacy_taxon_id',
      v_record->>'original_source_system',
      v_record->>'original_source_namespace',
      v_record->>'original_external_id',
      coalesce(v_record->'signals_all','[]'::jsonb)
    ) on conflict (observation_id) do nothing;
    get diagnostics v_row_count = row_count;
    v_snap_added := v_snap_added + v_row_count;

    v_resolved := nullif(v_record->>'resolved_sporely_taxon_id','')::integer;

    -- Manifest-driven registry materialisation for resolved records.
    if v_resolved is not null then
      insert into registry_concept (
        sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release
      ) values (
        v_resolved,
        v_record->>'resolved_canonical_name',
        v_record->>'resolved_rank',
        v_record->>'resolved_scope_state',
        coalesce(v_record->>'resolved_cache_state','in_cache'),
        coalesce(v_record->>'resolution_release', p_base->>'release_id')
      ) on conflict (sporely_taxon_id) do nothing;
      get diagnostics v_row_count = row_count;
      v_reg_added := v_reg_added + v_row_count;

      -- Materialise every exact signal as an external_mapping. Same
      -- conflict-invariant guard as the supplement path above.
      for v_signal in select e.value from jsonb_array_elements(coalesce(v_record->'signals_all','[]'::jsonb)) e(value)
         where e.value->>'kind' = 'exact'
           and coalesce(nullif(trim(e.value->>'source_system'),''),'') <> ''
           and coalesce(nullif(trim(e.value->>'namespace'),''),'') <> ''
           and coalesce(nullif(trim(e.value->>'external_id'),''),'') <> ''
      loop
        insert into external_mapping (
          source_system, namespace, external_id, sporely_taxon_id, release_id
        ) values (
          v_signal->>'source_system', v_signal->>'namespace', v_signal->>'external_id',
          v_resolved, coalesce(v_record->>'resolution_release', p_base->>'release_id')
        ) on conflict (source_system, namespace, external_id) do update
          set sporely_taxon_id = external_mapping.sporely_taxon_id
          where external_mapping.sporely_taxon_id = excluded.sporely_taxon_id;
        get diagnostics v_row_count = row_count;
        if v_row_count = 0 then
          raise exception 'external_mapping conflict in reconciliation apply: (%, %, %) is anchored to a different sporely_taxon_id (attempted %)',
            v_signal->>'source_system', v_signal->>'namespace', v_signal->>'external_id',
            v_resolved using errcode = 'unique_violation';
        end if;
      end loop;
    end if;

    insert into resolution_link (
      observation_id, resolution_state, resolved_sporely_taxon_id,
      resolution_method, resolution_evidence, resolution_release, manifest_semantic_sha256
    ) values (
      v_record->>'observation_id',
      v_record->>'reconciliation_state',
      v_resolved,
      v_record->>'resolution_method',
      coalesce(v_record->'resolution_evidence','[]'::jsonb),
      v_record->>'resolution_release',
      v_manifest_sha
    ) on conflict (observation_id) do update
      set resolution_state          = excluded.resolution_state,
          resolved_sporely_taxon_id = excluded.resolved_sporely_taxon_id,
          resolution_method         = excluded.resolution_method,
          resolution_evidence       = excluded.resolution_evidence,
          resolution_release        = excluded.resolution_release,
          manifest_semantic_sha256  = excluded.manifest_semantic_sha256,
          attached_at               = now();
    get diagnostics v_row_count = row_count;
    v_link_added := v_link_added + v_row_count;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'reg_added', v_reg_added,
    'map_added', v_map_added,
    'snap_added', v_snap_added,
    'link_added', v_link_added,
    'manifest_semantic_sha256', v_manifest_sha
  );
end $$;

-- ---------------------------------------------------------------------------
-- RLS.
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

create policy taxonomy_v3_public_read_registry
  on registry_concept for select
  to anon, authenticated using (true);
create policy taxonomy_v3_public_read_mapping
  on external_mapping for select
  to anon, authenticated using (true);
create policy taxonomy_v3_public_read_resolution
  on resolution_link for select
  to anon, authenticated using (true);
-- No public policy on identification_snapshot, release_installation,
-- supplement_installation, or reconciliation_manifest_audit → default-deny
-- for anon/authenticated. service_role bypasses RLS.

revoke all on all tables in schema taxonomy_v3 from public, anon, authenticated;
grant select on registry_concept, external_mapping, resolution_link to anon, authenticated;
revoke all on all functions in schema taxonomy_v3 from public, anon, authenticated;
grant execute on function install_release_chain(jsonb, jsonb, jsonb) to service_role;
