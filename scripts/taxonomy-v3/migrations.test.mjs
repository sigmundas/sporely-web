import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverLocalTarget, query, queryStdin } from '../taxonomy-v2/lib/docker-psql.mjs';
import {
  counts,
  installChain,
  loadBase,
  loadSupplementDir,
  verifyManifest,
} from './install-release-chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SPORELY_PY = path.resolve(REPO_ROOT, '..', 'sporely-py');
const MIGRATIONS = [
  '20260802120000_add_taxonomy_v3_core.sql',
  '20260802121000_integrate_taxonomy_v3_observations.sql',
  '20260802122000_secure_taxonomy_v3.sql',
].map(name => path.join(REPO_ROOT, 'supabase/migrations', name));
const BASE_RELEASE = path.join(SPORELY_PY, 'database/reference_data/generated/taxonomy_v2/global_macrofungi_tax-2026.08.01-01');
const SUPPLEMENTS = ['/tmp/w2ea2v2-supp-a', '/tmp/w2ebv2-supp-a'];
const FINAL_MANIFEST = '/tmp/w3b-final/reconciliation-manifest.json';
const integration = process.env.TAXONOMY_V3_MIGRATION_INTEGRATION === '1';

function stripComments(sql) {
  return sql.replace(/--[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

async function finalPayload() {
  const raw = await readFile(FINAL_MANIFEST, 'utf8');
  const declared = (await readFile(FINAL_MANIFEST.replace(/\.json$/, '.sha256.txt'), 'utf8')).trim();
  const { doc, computedSha } = verifyManifest(raw, declared);
  return {
    semantic_sha256: computedSha,
    input_file_sha256: createHash('sha256').update(raw).digest('hex'),
    record_count: doc.record_count,
    aggregate_counts: doc.aggregate_counts,
    records: doc.records,
  };
}

test('timestamped taxonomy-v3 migrations are ordered and additive', async () => {
  const sql = await Promise.all(MIGRATIONS.map(file => readFile(file, 'utf8')));
  assert.equal(stripComments(sql.join('\n')).match(/\bdrop\s+(schema|table|column)\b/gi), null);
  assert.match(sql[0], /create table if not exists registry_concept/);
  assert.match(sql[0], /incompatible taxonomy_v3 object/);
  assert.match(sql[1], /add column if not exists resolved_sporely_taxon_id integer/);
  assert.match(sql[1], /before insert on public\.observations/);
  assert.match(sql[1], /before update of resolved_sporely_taxon_id/);
  assert.match(sql[2], /taxonomy_v3_read_resolution_anon/);
  assert.match(sql[2], /taxonomy_v3_read_resolution_authenticated/);
});

test('integration: migrated schema installs the frozen release chain and final reconciliation', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  assert.equal((await query(target, "select to_regclass('taxonomy_v3.registry_concept') is not null")).trim(), 't');
  assert.equal(Number((await query(target, `select count(*) from information_schema.columns
    where table_schema='public' and table_name='observations'
      and column_name in ('genus','species','common_name','artsdata_id','artportalen_id','inaturalist_id',
                          'mushroomobserver_id','desktop_id','ai_selected_taxon_id','ai_selected_scientific_name')`)).trim()), 10);
  assert.equal(Number((await query(target, `select count(*) from pg_constraint
    where conrelid='public.observations'::regclass
      and conname in ('observations_pkey','observations_desktop_id_user_unique')`)).trim()), 2);

  const searchCacheRows = (await readFile(path.join(BASE_RELEASE, 'taxon_external_id.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).length;
  assert.equal(searchCacheRows, 52881, 'frozen base search-cache membership must remain unchanged');

  const base = await loadBase(BASE_RELEASE);
  const supplements = await Promise.all(SUPPLEMENTS.map(loadSupplementDir));
  const manifest = await finalPayload();
  assert.deepEqual(supplements.map(s => s.release_id), ['tax-2026.08.02-02', 'tax-2026.08.03-02']);
  assert.deepEqual(supplements[1].depends_on, ['tax-2026.08.02-02']);
  assert.equal(manifest.record_count, 369);
  assert.deepEqual(manifest.aggregate_counts, {
    manual_unresolved: 7,
    no_identity_evidence: 30,
    resolved_exact: 311,
    unresolved_external_identifier: 21,
  });

  await installChain(target, base, supplements, manifest);
  const first = await counts(target);
  assert.deepEqual(first, {
    registry_concept: 194,
    // The complete release-chain installer retains the otherwise-unused
    // 189757 supplement anchor, so its union is one row larger than the
    // reconciliation-only W3-B simulation's 144 mappings.
    external_mapping: 145,
    identification_snapshot: 369,
    resolution_link: 369,
    release_installation: 3,
    supplement_installation: 1,
    reconciliation_manifest_audit: 1,
  });
  assert.equal(Number((await query(target, 'select count(*) from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is not null')).trim()), 311);
  assert.equal(Number((await query(target, 'select count(*) from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is null')).trim()), 58);
  assert.equal((await query(target, "select cache_state || '/' || scope_state || ':' || count(*) from taxonomy_v3.registry_concept group by cache_state, scope_state order by cache_state")).trim(), 'in_cache/include:39\nout_of_cache/not_evaluated:155');

  await installChain(target, base, supplements, manifest);
  assert.deepEqual(await counts(target), first, 'same release bytes and manifest must be idempotent');

  await assert.rejects(
    installChain(target, base, [], { ...manifest, input_file_sha256: '00'.repeat(32) }),
    /manifest sha reuse with different bytes/,
  );
  assert.deepEqual(await counts(target), first, 'manifest tampering must roll back');

  const known = manifest.records.find(record => record.resolved_canonical_name && record.resolved_sporely_taxon_id);
  const identityClash = {
    release_id: 'tax-migration-identity-clash',
    base_release_id: base.release_id,
    supplement_contract_version: 'supplement-contract-1.0.0',
    supplement_shard_sha256: '11'.repeat(32),
    supplement_registry_manifest_sha256: '22'.repeat(32),
    depends_on: [],
    external_mappings: [{
      source_system: 'migration_probe', namespace: 'identity_probe', external_id: 'identity-clash',
      sporely_taxon_id: known.resolved_sporely_taxon_id,
      canonical_name: `${known.resolved_canonical_name} conflict`, rank: known.resolved_rank,
      scope_state: known.resolved_scope_state, cache_state: known.resolved_cache_state,
    }],
  };
  await assert.rejects(
    installChain(target, base, [identityClash], { semantic_sha256: 'identity-clash', input_file_sha256: 'identity-clash', record_count: 0, aggregate_counts: {}, records: [] }),
    /registry_concept identity conflict/,
  );
  assert.deepEqual(await counts(target), first, 'registry identity conflict must roll back the transaction');

  const mappingClash = {
    ...identityClash,
    release_id: 'tax-migration-mapping-clash',
    supplement_shard_sha256: '33'.repeat(32),
    supplement_registry_manifest_sha256: '44'.repeat(32),
    external_mappings: [{ ...supplements[0].external_mappings[0], sporely_taxon_id: 999999998 }],
  };
  await assert.rejects(
    installChain(target, base, [mappingClash], { semantic_sha256: 'mapping-clash', input_file_sha256: 'mapping-clash', record_count: 0, aggregate_counts: {}, records: [] }),
    /external_mapping conflict/,
  );
  assert.deepEqual(await counts(target), first, 'namespaced mapping conflict must roll back the transaction');

  const missingDependency = {
    ...identityClash,
    release_id: 'tax-migration-missing-dependency',
    supplement_shard_sha256: '55'.repeat(32),
    supplement_registry_manifest_sha256: '66'.repeat(32),
    depends_on: ['tax-not-installed'], external_mappings: [],
  };
  await assert.rejects(
    installChain(target, base, [missingDependency], { semantic_sha256: 'missing-dependency', input_file_sha256: 'missing-dependency', record_count: 0, aggregate_counts: {}, records: [] }),
    /depends on tax-not-installed which is not installed/,
  );
  assert.deepEqual(await counts(target), first, 'missing dependency must roll back the transaction');

  const observationId = (await query(target, 'select observation_id from taxonomy_v3.identification_snapshot order by observation_id limit 1')).trim();
  await assert.rejects(
    query(target, `update taxonomy_v3.identification_snapshot set original_scientific_name = 'tampered' where observation_id = '${observationId.replaceAll("'", "''")}'`),
    /immutable/,
  );
});

test('integration: real anon/authenticated/service roles enforce link guards and observation-aware RLS', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  const owner = '00000000-0000-0000-0000-000000000031';
  const other = '00000000-0000-0000-0000-000000000032';
  await queryStdin(target, `
    insert into taxonomy_v3.registry_concept
      (sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release)
      values (999999999, 'Migration role probe', 'species', 'not_evaluated', 'out_of_cache', 'migration-role-probe')
      on conflict (sporely_taxon_id) do nothing;
    insert into auth.users (id, aud, role, instance_id, email) values
      ('${owner}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', 'migration-owner@example.local'),
      ('${other}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', 'migration-other@example.local')
      on conflict (id) do nothing;
    insert into public.profiles (id) values ('${owner}'), ('${other}') on conflict (id) do nothing;
    insert into public.observations (id, user_id, date, genus, species, common_name, visibility, is_draft)
      overriding system value values
      (901031, '${owner}', '2026-08-02', 'LegacyGenus', 'legacy-species', 'Legacy common', 'public', false),
      (901032, '${owner}', '2026-08-02', 'LegacyPrivate', 'legacy-private', 'Private common', 'private', false)
      on conflict (id) do update set user_id=excluded.user_id, visibility=excluded.visibility, is_draft=false;
    insert into taxonomy_v3.identification_snapshot (observation_id) values ('901031'), ('901032') on conflict do nothing;
    insert into taxonomy_v3.resolution_link (observation_id, resolution_state, resolved_sporely_taxon_id) values
      ('901031', 'resolved_exact', 999999999), ('901032', 'resolved_exact', 999999999)
      on conflict (observation_id) do update set resolution_state=excluded.resolution_state, resolved_sporely_taxon_id=excluded.resolved_sporely_taxon_id;
  `);

  const legacyBefore = (await query(target, "select concat_ws('|', genus, species, common_name, visibility) from public.observations where id=901031")).trim();
  await queryStdin(target, "begin; set local role anon; update public.observations set resolved_sporely_taxon_id=999999999 where id=901031; commit;");
  assert.equal((await query(target, "select resolved_sporely_taxon_id is null from public.observations where id=901031")).trim(), 't');
  await assert.rejects(
    queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); insert into public.observations (id,user_id,date,genus,species,resolved_sporely_taxon_id) overriding system value values (901033,'${owner}','2026-08-02','Guard','insert',999999999); commit;`),
    /can only be set by service_role/,
  );
  await assert.rejects(
    queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); update public.observations set resolved_sporely_taxon_id=999999999 where id=901031; commit;`),
    /can only be updated by service_role/,
  );
  await queryStdin(target, "begin; set local role service_role; update public.observations set resolved_sporely_taxon_id=999999999 where id=901031; commit;");
  assert.equal((await query(target, "select concat_ws('|', genus, species, common_name, visibility) from public.observations where id=901031")).trim(), legacyBefore);

  assert.equal((await queryStdin(target, "begin; set local role anon; select string_agg(observation_id,',' order by observation_id) from taxonomy_v3.resolution_link where observation_id in ('901031','901032'); commit;")).trim(), '901031');
  assert.match((await queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); select string_agg(observation_id,',' order by observation_id) from taxonomy_v3.resolution_link where observation_id in ('901031','901032'); commit;`)).trim(), /901031,901032$/);
  assert.match((await queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${other}',true); select count(*) from taxonomy_v3.resolution_link where observation_id='901032'; commit;`)).trim(), /\n0$/);
});
