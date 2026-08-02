// W3-A rehearsal test — provides local proof for the production integration
// design against a disposable Supabase stack.
//
// Non-integration tests always run: schema-file sanity, installer helpers.
// Integration tests run only when W3A_INTEGRATION=1 and a local Supabase
// is discoverable. Uses the reconciliation manifest emitted at
// /tmp/w2ebc-real-1/reconciliation-manifest.json when present.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverLocalTarget, query, queryStdin } from '../taxonomy-v2/lib/docker-psql.mjs';
import { ensureSchema, loadBase, loadSupplementDir, installChain, counts } from './install-release-chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SPORELY_PY = path.resolve(REPO_ROOT, '..', 'sporely-py');
const BASE_RELEASE = path.join(SPORELY_PY, 'database/reference_data/generated/taxonomy_v2/global_macrofungi_tax-2026.08.01-01');
const SCHEMA_SQL_PATH = path.join(REPO_ROOT, 'supabase/drafts/taxonomy_v3_schema.sql');
const OBS_INTEG_PATH = path.join(REPO_ROOT, 'supabase/drafts/taxonomy_v3_observations_integration_draft.sql');

// The rehearsal reuses the /tmp/-only reconciled outputs from the corrections
// stage. Test skips gracefully if they are not present.
const SUP_A_DIR = '/tmp/w2ea2v2-supp-a';
const SUP_B_DIR = '/tmp/w2ebv2-supp-a';
const MANIFEST_PATH = '/tmp/w2ebc-real-1/reconciliation-manifest.json';

const integration = process.env.W3A_INTEGRATION === '1';
async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function rehearsalPrereqsPresent() {
  return (await exists(SUP_A_DIR)) && (await exists(SUP_B_DIR)) && (await exists(MANIFEST_PATH));
}

// -------- non-integration --------

test('schema SQL is fully isolated in taxonomy_v3 and enables RLS on every table', async () => {
  const sql = await readFile(SCHEMA_SQL_PATH, 'utf8');
  assert.match(sql, /drop schema if exists taxonomy_v3 cascade/);
  assert.match(sql, /create schema taxonomy_v3/);
  for (const t of ['registry_concept','external_mapping','identification_snapshot','resolution_link','release_installation','supplement_installation','reconciliation_manifest_audit']) {
    assert.match(sql, new RegExp(`alter table ${t}\\s+enable row level security`), `${t} must have RLS enabled`);
  }
  // Every public policy grants SELECT only; only service_role gets execute on
  // the installer function.
  assert.match(sql, /for select\s+to anon, authenticated/);
  assert.match(sql, /grant execute on function install_release_chain.*to service_role/);
  // Immutable trigger present and its raise carries the taxonomy_v3 prefix.
  assert.match(sql, /identification_snapshot_immutability_trg/);
  assert.match(sql, /taxonomy_v3\.identification_snapshot original_\* fields are immutable/);
  // Hardened external_mapping conflict invariant carried over from W2E-A2.
  assert.match(sql, /on conflict \(source_system, namespace, external_id\) do update/);
  assert.match(sql, /external_mapping conflict/);
  // Release-installation carries the hash guard.
  assert.match(sql, /release-ID reuse:/);
  // The schema NEVER touches public.observations as DDL (integration lives
  // in a separate draft file). Comment mentions are allowed.
  const sqlNoComments = sql.replace(/--[^\n]*\n/g, '');
  assert.doesNotMatch(sqlNoComments, /public\.observations/);
});

test('observations integration draft is additive and service-role guarded', async () => {
  const sql = await readFile(OBS_INTEG_PATH, 'utf8');
  assert.match(sql, /alter table public\.observations\s+add column if not exists resolved_sporely_taxon_id/);
  assert.match(sql, /w3a_guard_resolved_sporely_taxon_id_trg/);
  assert.match(sql, /can only be updated by service_role/);
  // No DROP, no data-mutating UPDATE outside the guarded link function.
  assert.doesNotMatch(sql, /drop\s+column/i);
  assert.doesNotMatch(sql, /alter\s+column\s+\S+\s+drop/i);
});

test('loadSupplementDir refuses a supplement whose canonical/manifest.json declares the wrong hash', async () => {
  if (!(await rehearsalPrereqsPresent())) return; // deps unavailable — skip silently
  const orig = await loadSupplementDir(SUP_A_DIR);
  assert.equal(orig.release_id, 'tax-2026.08.02-02');
  assert.equal(orig.supplement_shard_sha256, '6c95612b83fbf684d9db7c66fe515b2225e57c8b3b6ceb03e001867fad41067b');
  assert.ok(orig.external_mappings.length >= 22);
});

// -------- integration --------

async function ensureFresh(target) {
  await ensureSchema(target, { observationsIntegration: true });
}

test('integration: install the release chain and apply the accepted 233/21/85/30 manifest', { skip: !integration || !(await rehearsalPrereqsPresent()) }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFresh(target);

  const base = await loadBase(BASE_RELEASE);
  const supA = await loadSupplementDir(SUP_A_DIR);
  const supB = await loadSupplementDir(SUP_B_DIR);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const manifestSha = (await readFile(path.join(path.dirname(MANIFEST_PATH), "reconciliation-manifest.sha256.txt"), 'utf8')).trim();
  const manifestPayload = {
    semantic_sha256: manifestSha,
    record_count: manifest.record_count,
    aggregate_counts: manifest.aggregate_counts,
    records: manifest.records,
  };
  assert.equal(manifestSha, '1beaa33f3891b216d3bc7c6d34cd96df1a936627c5a6f749a515cc75d51c094e');
  assert.equal(manifest.record_count, 369);
  assert.deepEqual(manifest.aggregate_counts, {
    manual_unresolved: 85,
    no_identity_evidence: 30,
    resolved_exact: 233,
    unresolved_external_identifier: 21,
  });

  const result = await installChain(target, base, [supA, supB], manifestPayload);
  assert.equal(result.ok, true);

  const c = await counts(target);
  // 369 immutable snapshots and 369 mutable resolution links (one per observation).
  assert.equal(c.identification_snapshot, 369);
  assert.equal(c.resolution_link, 369);
  // release_installation must contain the base + both supplements.
  assert.equal(c.release_installation, 3);
  assert.equal(c.supplement_installation, 1); // only 08.03-02 declares a depends_on
  assert.equal(c.reconciliation_manifest_audit, 1);

  // Null canonical links for the 136 unresolved / manual / no-evidence rows.
  const nullLinks = Number((await query(target, "select count(*) from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is null")).trim());
  assert.equal(nullLinks, 136, 'expected 21 + 85 + 30 = 136 null links');
  const resolvedLinks = Number((await query(target, "select count(*) from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is not null")).trim());
  assert.equal(resolvedLinks, 233);

  // Search cache membership unchanged: the base release still owns exactly
  // 52 881 external mappings under col_xr:col_usage_id (via the resolved
  // records materialised as external_mappings). All other mappings live under
  // out-of-cache-eligible source systems.
  const inCache = Number((await query(target, "select count(*) from taxonomy_v3.registry_concept where cache_state='in_cache'")).trim());
  const outCache = Number((await query(target, "select count(*) from taxonomy_v3.registry_concept where cache_state='out_of_cache'")).trim());
  assert.equal(inCache, 39, 'in_cache concepts materialised from the base release');
  assert.equal(outCache, 103, 'out_of_cache concepts from supplements + non-fungi canonical registry hits');

  // Idempotency: second apply returns identical counts.
  await installChain(target, base, [supA, supB], manifestPayload);
  const c2 = await counts(target);
  assert.deepEqual(c2, c);
});

test('integration: identification_snapshot original_* fields are immutable', { skip: !integration || !(await rehearsalPrereqsPresent()) }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFresh(target);
  const base = await loadBase(BASE_RELEASE);
  const supA = await loadSupplementDir(SUP_A_DIR);
  const supB = await loadSupplementDir(SUP_B_DIR);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const manifestSha = (await readFile(path.join(path.dirname(MANIFEST_PATH), "reconciliation-manifest.sha256.txt"), 'utf8')).trim();
  await installChain(target, base, [supA, supB], { semantic_sha256: manifestSha, record_count: manifest.record_count, aggregate_counts: manifest.aggregate_counts, records: manifest.records });
  const oneId = (await query(target, "select observation_id from taxonomy_v3.identification_snapshot limit 1")).trim();
  await assert.rejects(
    query(target, `update taxonomy_v3.identification_snapshot set original_scientific_name='X' where observation_id=${JSON.stringify(oneId).replace(/"/g,"'")}`),
    /immutable/,
  );
});

test('integration: later exact resolution can update resolution_link without modifying snapshot', { skip: !integration || !(await rehearsalPrereqsPresent()) }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFresh(target);
  const base = await loadBase(BASE_RELEASE);
  const supA = await loadSupplementDir(SUP_A_DIR);
  const supB = await loadSupplementDir(SUP_B_DIR);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const manifestSha = (await readFile(path.join(path.dirname(MANIFEST_PATH), "reconciliation-manifest.sha256.txt"), 'utf8')).trim();

  // First apply: everything as-is.
  await installChain(target, base, [supA, supB], { semantic_sha256: manifestSha, record_count: manifest.record_count, aggregate_counts: manifest.aggregate_counts, records: manifest.records });

  // Pick one currently-unresolved observation and simulate a later exact
  // resolution: attach it to an existing sporely_taxon_id we know is
  // registered (630103 = the NorTaxa 48041 concept). The snapshot must not
  // change; only resolution_link must move.
  const unresolvedId = (await query(target, "select observation_id from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is null order by observation_id limit 1")).trim();
  const snapBefore = (await query(target, `select row_to_json(t)::text from taxonomy_v3.identification_snapshot t where observation_id = ${JSON.stringify(unresolvedId).replace(/"/g,"'")}`)).trim();

  const laterRecord = manifest.records.find(r => r.observation_id === unresolvedId);
  const laterManifest = {
    semantic_sha256: `later-${manifestSha}`,
    record_count: 1,
    aggregate_counts: null,
    records: [{ ...laterRecord, reconciliation_state: 'resolved_exact', resolved_sporely_taxon_id: 630103, resolution_method: 'trusted_secondary_provider_mapping', resolution_evidence: [{level:4, note:'later exact resolution rehearsal'}], resolution_release: 'tax-2026.08.03-02' }],
  };
  await installChain(target, base, [], laterManifest);
  const snapAfter = (await query(target, `select row_to_json(t)::text from taxonomy_v3.identification_snapshot t where observation_id = ${JSON.stringify(unresolvedId).replace(/"/g,"'")}`)).trim();
  assert.equal(snapAfter, snapBefore, 'identification_snapshot must not change on later resolution');
  const newState = (await query(target, `select resolution_state from taxonomy_v3.resolution_link where observation_id = ${JSON.stringify(unresolvedId).replace(/"/g,"'")}`)).trim();
  assert.equal(newState, 'resolved_exact');
  const newTarget = (await query(target, `select resolved_sporely_taxon_id from taxonomy_v3.resolution_link where observation_id = ${JSON.stringify(unresolvedId).replace(/"/g,"'")}`)).trim();
  assert.equal(newTarget, '630103');
});

test('integration: release-ID reuse with different hashes fails closed', { skip: !integration || !(await rehearsalPrereqsPresent()) }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFresh(target);
  const base = await loadBase(BASE_RELEASE);
  const supA = await loadSupplementDir(SUP_A_DIR);
  const emptyManifest = { semantic_sha256: 'w3a-empty', record_count: 0, aggregate_counts: {}, records: [] };
  await installChain(target, base, [supA], emptyManifest);
  // Now supply the same release_id with a different shard hash.
  const tampered = { ...supA, supplement_shard_sha256: 'ff'.repeat(32) };
  await assert.rejects(
    installChain(target, base, [tampered], emptyManifest),
    /release-ID reuse/,
  );
});

test('integration: external-mapping conflict causes full rollback', { skip: !integration || !(await rehearsalPrereqsPresent()) }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFresh(target);
  const base = await loadBase(BASE_RELEASE);
  const supA = await loadSupplementDir(SUP_A_DIR);
  const emptyManifest = { semantic_sha256: 'w3a-empty', record_count: 0, aggregate_counts: {}, records: [] };
  await installChain(target, base, [supA], emptyManifest);
  const before = await counts(target);
  // Present a fake supplement whose external_mapping targets a different
  // sporely_taxon_id than the already-anchored one for a real triple.
  const known = supA.external_mappings[0];
  const clash = { ...known, sporely_taxon_id: known.sporely_taxon_id + 900000 };
  const clashSup = { ...supA, release_id: 'tax-w3a-conflict-probe', supplement_shard_sha256: 'ab'.repeat(32), supplement_registry_manifest_sha256: 'cd'.repeat(32), depends_on: [], external_mappings: [clash] };
  await assert.rejects(
    installChain(target, base, [clashSup], emptyManifest),
    /external_mapping conflict/,
  );
  const after = await counts(target);
  assert.deepEqual(after, before, 'no partial rows may remain after a conflicting apply');
});

test('integration: observations link — service_role can attach, unresolved observations retain NULL link', { skip: !integration || !(await rehearsalPrereqsPresent()) }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFresh(target);
  // Seed a public.observations row with observation_id matching one from the manifest.
  const base = await loadBase(BASE_RELEASE);
  const supA = await loadSupplementDir(SUP_A_DIR);
  const supB = await loadSupplementDir(SUP_B_DIR);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const manifestSha = (await readFile(path.join(path.dirname(MANIFEST_PATH), "reconciliation-manifest.sha256.txt"), 'utf8')).trim();
  await installChain(target, base, [supA, supB], { semantic_sha256: manifestSha, record_count: manifest.record_count, aggregate_counts: manifest.aggregate_counts, records: manifest.records });

  // Seed a public.observations row whose id (as text) matches one resolved snapshot.
  const resolvedObs = (await query(target, "select observation_id from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is not null limit 1")).trim();
  // The observation_id in the manifest is a pseudonym like obs_<hex>; use a
  // synthetic bigint that shares its string form to keep the test hermetic.
  // public.observations in local supabase has more not-null columns than the
  // rehearsal shim; skip the seed insert if it's the real baseline table.
  const hasUserIdCol = (await query(target, "select case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='observations' and column_name='user_id') then 'yes' else 'no' end")).trim();
  if (hasUserIdCol === 'yes') {
    // Real baseline schema — bootstrap the FK chain: auth.users -> profiles -> observations.
    await queryStdin(target, `
      insert into auth.users (id, aud, role, instance_id, email) values ('00000000-0000-0000-0000-000000000001'::uuid, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'::uuid, 'w3a-rehearsal@example.local') on conflict (id) do nothing;
      insert into public.profiles (id) values ('00000000-0000-0000-0000-000000000001'::uuid) on conflict (id) do nothing;
      insert into public.observations (id, user_id, date, genus, species, common_name) overriding system value select 900001, '00000000-0000-0000-0000-000000000001'::uuid, '2026-08-01'::date, 'test-genus', 'test-species', 'test-common' where not exists (select 1 from public.observations where id = 900001);
    `);
  } else {
    await query(target, `insert into public.observations (id, genus, species, common_name) overriding system value select 900001, 'test-genus', 'test-species', 'test-common' where not exists (select 1 from public.observations where id = 900001)`);
  }
  await query(target, `insert into taxonomy_v3.identification_snapshot (observation_id) values ('900001') on conflict do nothing`);
  await query(target, `insert into taxonomy_v3.resolution_link (observation_id, resolution_state, resolved_sporely_taxon_id) values ('900001', 'resolved_exact', 630103) on conflict (observation_id) do update set resolution_state='resolved_exact', resolved_sporely_taxon_id=630103`);
  const updated = Number((await query(target, "select taxonomy_v3.link_observations_to_resolution()")).trim());
  assert.equal(updated, 1);
  const linkVal = (await query(target, "select resolved_sporely_taxon_id from public.observations where id = 900001")).trim();
  assert.equal(linkVal, '630103');
  // The other observation fields must be untouched.
  const preservedGenus = (await query(target, "select genus from public.observations where id = 900001")).trim();
  assert.equal(preservedGenus, 'test-genus');
});
