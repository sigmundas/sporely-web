-- W2D disposable local-only migration simulation. This file is not a production migration.
--
-- Purpose: consume the reconciliation manifest produced by sporely-py
-- (see database/taxonomy/docs/w2d-reconciliation-contract.md) and materialise
-- its outcomes in an isolated schema that mirrors the sparse-registry semantics
-- from W2C (see scripts/taxonomy-v2/experiments/sparse-registry-prototype.sql).
--
-- Contract references throughout: §6 result record, §7 migration actions,
-- §8 snapshot preservation, §9 determinism, §11 cross-repo ownership.

drop schema if exists w2d_migration_simulation cascade;
create schema w2d_migration_simulation;
set search_path = w2d_migration_simulation, pg_catalog;

-- reconciliation_result mirrors the manifest result-record shape verbatim
-- (contract §6). jsonb columns keep the payload semantically opaque; the
-- desktop engine authors it, this schema consumes it.
create table reconciliation_result (
  observation_id text primary key,
  reconciliation_state text not null,
  resolved_sporely_taxon_id integer,
  resolved_canonical_name text,
  resolved_rank text,
  resolved_scope_state text,
  resolution_method text,
  resolution_evidence jsonb not null default '[]'::jsonb,
  original_legacy_taxon_id text,
  original_scientific_name text,
  original_vernacular_name text,
  original_source_system text,
  original_source_namespace text,
  original_external_id text,
  signals_all jsonb not null default '[]'::jsonb,
  unmapped_signals jsonb not null default '[]'::jsonb,
  candidate_concepts jsonb not null default '[]'::jsonb,
  conflicting_concepts jsonb not null default '[]'::jsonb,
  missing_source_records jsonb not null default '[]'::jsonb,
  review_reason text,
  migration_action text not null,
  manifest_semantic_sha256 text
);

-- registry_concept is the sparse cloud registry (contract §7). scope_state
-- mirrors the pinned release's judgement verbatim (contract §6.1); a resolved
-- concept outside the macrofungi cache is still materialised — the cache is
-- never broadened silently.
create table registry_concept (
  sporely_taxon_id integer primary key,
  canonical_name text,
  rank text,
  scope_state text,
  cache_state text not null default 'in_cache' check (cache_state in ('in_cache','out_of_cache')),
  first_materialized_from_release text
);

-- external_mapping enforces the (source_system, namespace, external_id) UNIQUE
-- invariant from contract §5; the tuple resolves to at most one sporely id.
create table external_mapping (
  source_system text not null,
  namespace text not null,
  external_id text not null,
  sporely_taxon_id integer not null references registry_concept(sporely_taxon_id) on delete restrict,
  release_id text not null,
  unique (source_system, namespace, external_id)
);
create index external_mapping_taxon_idx on external_mapping (sporely_taxon_id);

-- identification_snapshot preserves the ORIGINAL identification per contract §8.
-- The snapshot is immutable while snapshot_locked=true (enforced by trigger).
-- Every reconciliation state — resolved or not — writes a snapshot exactly
-- once.
create table identification_snapshot (
  observation_id text primary key,
  original_scientific_name text,
  original_vernacular_name text,
  original_rank text,
  original_legacy_taxon_id text,
  original_source_system text,
  original_source_namespace text,
  original_external_id text,
  original_signals jsonb not null default '[]'::jsonb,
  snapshot_locked boolean not null default true,
  snapshot_written_at timestamptz not null default now()
);

-- Contract §8 immutability guard: raise on any UPDATE to an original_* field
-- while snapshot_locked=true. This blocks rewrite of the historical display
-- fields at resolution time.
create or replace function _guard_snapshot_immutability() returns trigger
  language plpgsql as $$
begin
  if old.snapshot_locked is true then
    if old.original_scientific_name is distinct from new.original_scientific_name
       or old.original_vernacular_name is distinct from new.original_vernacular_name
       or old.original_rank is distinct from new.original_rank
       or old.original_legacy_taxon_id is distinct from new.original_legacy_taxon_id
       or old.original_source_system is distinct from new.original_source_system
       or old.original_source_namespace is distinct from new.original_source_namespace
       or old.original_external_id is distinct from new.original_external_id
       or old.original_signals is distinct from new.original_signals
    then
      raise exception 'identification_snapshot original_* fields are immutable while snapshot_locked=true (observation_id=%)', old.observation_id;
    end if;
  end if;
  return new;
end $$;

create trigger identification_snapshot_immutability_trg
  before update on identification_snapshot
  for each row execute function _guard_snapshot_immutability();

-- resolution_link is the mutable side of the snapshot/resolution split from
-- contract §8: later resolution overwrites this row but never the snapshot.
create table resolution_link (
  observation_id text primary key references identification_snapshot(observation_id) on delete cascade,
  resolution_state text not null,
  resolved_sporely_taxon_id integer references registry_concept(sporely_taxon_id) on delete set null,
  resolution_method text,
  resolution_evidence jsonb not null default '[]'::jsonb,
  resolution_release text,
  attached_at timestamptz not null default now()
);
create index resolution_link_taxon_idx on resolution_link (resolved_sporely_taxon_id);

-- apply_reconciliation_manifest is idempotent under contract §9. All inserts
-- use ON CONFLICT DO NOTHING except resolution_link and reconciliation_result,
-- which upsert on the mutable side (contract §8 explicitly permits later
-- resolution to overwrite the resolution_link).
create or replace function apply_reconciliation_manifest(
  p_manifest jsonb,
  p_manifest_semantic_sha256 text default null
) returns jsonb language plpgsql
  set search_path = w2d_migration_simulation, pg_catalog as $$
declare
  v_record jsonb;
  v_signal jsonb;
  v_release_id text := p_manifest->>'taxonomy_release_id';
  v_resolved integer;
  v_records_applied integer := 0;
  v_row_count integer;
  v_reg_before integer;
  v_map_before integer;
  v_snap_before integer;
  v_link_before integer;
  v_res_before integer;
  v_reg_after integer;
  v_map_after integer;
  v_snap_after integer;
  v_link_after integer;
  v_res_after integer;
begin
  select count(*) into v_reg_before from registry_concept;
  select count(*) into v_map_before from external_mapping;
  select count(*) into v_snap_before from identification_snapshot;
  select count(*) into v_link_before from resolution_link;
  select count(*) into v_res_before from reconciliation_result;

  for v_record in
    select e.value from jsonb_array_elements(coalesce(p_manifest->'records', '[]'::jsonb)) as e(value)
  loop
    -- Rollback-simulation hook: an intentionally injected record with
    -- observation_id='__rollback_forced__' aborts the run so the caller can
    -- prove that simulate_migration wraps the failure in a subtransaction and
    -- leaves no orphan rows.
    if v_record->>'observation_id' = '__rollback_forced__' then
      raise exception 'synthetic rollback failure marker present in manifest (observation_id=__rollback_forced__)';
    end if;

    -- Contract §8: snapshot is written exactly once and never overwritten.
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
      coalesce(v_record->'signals_all', '[]'::jsonb)
    ) on conflict (observation_id) do nothing;

    v_resolved := nullif(v_record->>'resolved_sporely_taxon_id', '')::integer;

    if v_resolved is not null then
      -- Contract §7: materialise the concept (or reuse existing).
      insert into registry_concept (
        sporely_taxon_id, canonical_name, rank, scope_state, cache_state,
        first_materialized_from_release
      ) values (
        v_resolved,
        v_record->>'resolved_canonical_name',
        v_record->>'resolved_rank',
        v_record->>'resolved_scope_state',
        coalesce(v_record->>'resolved_cache_state', 'in_cache'),
        v_release_id
      ) on conflict (sporely_taxon_id) do nothing;

      -- Contract §5: one external_mapping per exact signal in signals_all.
      -- Text-only and invalid signals are preserved on the snapshot only.
      for v_signal in
        select e.value
          from jsonb_array_elements(coalesce(v_record->'signals_all', '[]'::jsonb)) as e(value)
         where e.value->>'kind' = 'exact'
           and coalesce(nullif(trim(e.value->>'source_system'), ''), '') <> ''
           and coalesce(nullif(trim(e.value->>'namespace'), ''), '') <> ''
           and coalesce(nullif(trim(e.value->>'external_id'), ''), '') <> ''
      loop
        -- Contract §5 hardened conflict invariant: (source_system, namespace,
        -- external_id) resolves to exactly one sporely_taxon_id. Idempotent
        -- reapply with the same target is a no-op; a DIFFERENT target must
        -- raise so the enclosing simulate_migration transaction rolls back
        -- with zero partial changes.
        insert into external_mapping (
          source_system, namespace, external_id, sporely_taxon_id, release_id
        ) values (
          v_signal->>'source_system',
          v_signal->>'namespace',
          v_signal->>'external_id',
          v_resolved,
          v_release_id
        ) on conflict (source_system, namespace, external_id) do update
          set sporely_taxon_id = external_mapping.sporely_taxon_id
          where external_mapping.sporely_taxon_id = excluded.sporely_taxon_id;
        get diagnostics v_row_count = row_count;
        if v_row_count = 0 then
          raise exception 'W2E-A2 external_mapping conflict: (%s, %s, %s) already anchored to a different sporely_taxon_id (attempted %s)',
            v_signal->>'source_system',
            v_signal->>'namespace',
            v_signal->>'external_id',
            v_resolved
            using errcode = 'unique_violation';
        end if;
      end loop;
    end if;

    -- Contract §8: resolution_link is the mutable pointer. Later resolution
    -- overwrites the state / resolved id / method / evidence, but the snapshot
    -- above is preserved verbatim.
    insert into resolution_link (
      observation_id, resolution_state, resolved_sporely_taxon_id,
      resolution_method, resolution_evidence, resolution_release
    ) values (
      v_record->>'observation_id',
      v_record->>'reconciliation_state',
      v_resolved,
      v_record->>'resolution_method',
      coalesce(v_record->'resolution_evidence', '[]'::jsonb),
      v_release_id
    ) on conflict (observation_id) do update set
      resolution_state = excluded.resolution_state,
      resolved_sporely_taxon_id = excluded.resolved_sporely_taxon_id,
      resolution_method = excluded.resolution_method,
      resolution_evidence = excluded.resolution_evidence,
      resolution_release = excluded.resolution_release,
      attached_at = now();

    -- Contract §6: record the full result row verbatim, plus the manifest
    -- semantic hash for provenance. Upsert on later re-application.
    insert into reconciliation_result (
      observation_id, reconciliation_state, resolved_sporely_taxon_id,
      resolved_canonical_name, resolved_rank, resolved_scope_state,
      resolution_method, resolution_evidence,
      original_legacy_taxon_id, original_scientific_name, original_vernacular_name,
      original_source_system, original_source_namespace, original_external_id,
      signals_all, unmapped_signals, candidate_concepts, conflicting_concepts,
      missing_source_records, review_reason, migration_action,
      manifest_semantic_sha256
    ) values (
      v_record->>'observation_id',
      v_record->>'reconciliation_state',
      v_resolved,
      v_record->>'resolved_canonical_name',
      v_record->>'resolved_rank',
      v_record->>'resolved_scope_state',
      v_record->>'resolution_method',
      coalesce(v_record->'resolution_evidence', '[]'::jsonb),
      v_record->>'original_legacy_taxon_id',
      v_record->>'original_scientific_name',
      v_record->>'original_vernacular_name',
      v_record->>'original_source_system',
      v_record->>'original_source_namespace',
      v_record->>'original_external_id',
      coalesce(v_record->'signals_all', '[]'::jsonb),
      coalesce(v_record->'unmapped_signals', '[]'::jsonb),
      coalesce(v_record->'candidate_concepts', '[]'::jsonb),
      coalesce(v_record->'conflicting_concepts', '[]'::jsonb),
      coalesce(v_record->'missing_source_records', '[]'::jsonb),
      v_record->>'review_reason',
      v_record->>'migration_action',
      p_manifest_semantic_sha256
    ) on conflict (observation_id) do update set
      reconciliation_state = excluded.reconciliation_state,
      resolved_sporely_taxon_id = excluded.resolved_sporely_taxon_id,
      resolved_canonical_name = excluded.resolved_canonical_name,
      resolved_rank = excluded.resolved_rank,
      resolved_scope_state = excluded.resolved_scope_state,
      resolution_method = excluded.resolution_method,
      resolution_evidence = excluded.resolution_evidence,
      original_legacy_taxon_id = excluded.original_legacy_taxon_id,
      original_scientific_name = excluded.original_scientific_name,
      original_vernacular_name = excluded.original_vernacular_name,
      original_source_system = excluded.original_source_system,
      original_source_namespace = excluded.original_source_namespace,
      original_external_id = excluded.original_external_id,
      signals_all = excluded.signals_all,
      unmapped_signals = excluded.unmapped_signals,
      candidate_concepts = excluded.candidate_concepts,
      conflicting_concepts = excluded.conflicting_concepts,
      missing_source_records = excluded.missing_source_records,
      review_reason = excluded.review_reason,
      migration_action = excluded.migration_action,
      manifest_semantic_sha256 = excluded.manifest_semantic_sha256;

    v_records_applied := v_records_applied + 1;
  end loop;

  select count(*) into v_reg_after from registry_concept;
  select count(*) into v_map_after from external_mapping;
  select count(*) into v_snap_after from identification_snapshot;
  select count(*) into v_link_after from resolution_link;
  select count(*) into v_res_after from reconciliation_result;

  return jsonb_build_object(
    'records_applied', v_records_applied,
    'registry_concepts_before', v_reg_before,
    'registry_concepts_after', v_reg_after,
    'registry_concepts_added', v_reg_after - v_reg_before,
    'external_mappings_before', v_map_before,
    'external_mappings_after', v_map_after,
    'external_mappings_added', v_map_after - v_map_before,
    'identification_snapshots_before', v_snap_before,
    'identification_snapshots_after', v_snap_after,
    'identification_snapshots_added', v_snap_after - v_snap_before,
    'resolution_links_before', v_link_before,
    'resolution_links_after', v_link_after,
    'resolution_links_added', v_link_after - v_link_before,
    'reconciliation_results_before', v_res_before,
    'reconciliation_results_after', v_res_after,
    'reconciliation_results_added', v_res_after - v_res_before
  );
end $$;

-- simulate_migration wraps apply_reconciliation_manifest in a subtransaction:
-- any exception is caught, the subtransaction rolls back, and the caller
-- observes zero partial writes. This is the disposable-schema equivalent of
-- the production migration's transactional apply semantics.
create or replace function simulate_migration(
  p_manifest jsonb,
  p_manifest_semantic_sha256 text default null
) returns jsonb language plpgsql
  set search_path = w2d_migration_simulation, pg_catalog as $$
declare
  v_result jsonb;
begin
  begin
    v_result := apply_reconciliation_manifest(p_manifest, p_manifest_semantic_sha256);
    return jsonb_build_object('ok', true, 'summary', v_result);
  exception when others then
    return jsonb_build_object(
      'ok', false,
      'error', sqlerrm,
      'sqlstate', sqlstate
    );
  end;
end $$;

revoke all on schema w2d_migration_simulation from public;
revoke all on all tables in schema w2d_migration_simulation from public, anon, authenticated;
revoke all on all functions in schema w2d_migration_simulation from public, anon, authenticated;
