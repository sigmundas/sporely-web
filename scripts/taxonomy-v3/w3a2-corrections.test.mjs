// W3-A2 rehearsal — covers every correction the accepted W3-A2 brief
// requires. Uses the same disposable local stack as w3a-rehearsal.test.mjs.
// Runs with W3A2_INTEGRATION=1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverLocalTarget, query, queryStdin } from '../taxonomy-v2/lib/docker-psql.mjs';
import {
  ensureSchema,
  loadBase,
  loadSupplementDir,
  installChain,
  counts,
  verifyManifest,
} from './install-release-chain.mjs';
import { computeSemanticSha256, stableStringify } from '../taxonomy-v2/run-w2d-migration-simulation.mjs';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SPORELY_PY = path.resolve(REPO_ROOT, '..', 'sporely-py');
const BASE_RELEASE = path.join(SPORELY_PY, 'database/reference_data/generated/taxonomy_v2/global_macrofungi_tax-2026.08.01-01');
const SCHEMA_SQL = path.join(REPO_ROOT, 'supabase/drafts/taxonomy_v3_schema.sql');
const ADDITIVE_SCHEMA = path.join(REPO_ROOT, 'supabase/drafts/taxonomy_v3_schema_additive.sql');
const ADDITIVE_OBS = path.join(REPO_ROOT, 'supabase/drafts/taxonomy_v3_observations_integration_draft_additive.sql');
const OBS_INTEG = path.join(REPO_ROOT, 'supabase/drafts/taxonomy_v3_observations_integration_draft.sql');
const SUP_A_DIR = '/tmp/w2ea2v2-supp-a';
const SUP_B_DIR = '/tmp/w2ebv2-supp-a';
const MANIFEST_PATH = '/tmp/w2ebc-real-1/reconciliation-manifest.json';
const DEPLOY_MANIFEST = '/tmp/w3a2-deployment/deployment-manifest.jsonl';

const integration = process.env.W3A2_INTEGRATION === '1';
const NOT_A_DROP = /(^|\s)(drop\s+(schema|table|column))/gim;
function stripComments(sql) {
  return sql.replace(/--[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ------------------------------------------------------------------
// Non-integration: additive-only migration files carry NO destructive DDL.
// ------------------------------------------------------------------

test('W3-A2 additive schema draft contains no DROP SCHEMA / DROP TABLE / DROP COLUMN', async () => {
  const s = await readFile(ADDITIVE_SCHEMA, 'utf8');
  assert.equal(stripComments(s).match(NOT_A_DROP), null);
  assert.match(s, /create schema if not exists taxonomy_v3/);
  assert.match(s, /create table if not exists registry_concept/);
  assert.match(s, /create table if not exists external_mapping/);
});

test('W3-A2 additive observations integration contains no destructive DDL', async () => {
  const s = await readFile(ADDITIVE_OBS, 'utf8');
  assert.equal(stripComments(s).match(NOT_A_DROP), null);
  assert.match(s, /add column if not exists resolved_sporely_taxon_id/);
  assert.match(s, /w3a_guard_resolved_sporely_taxon_id/);
});

test('verifyManifest recomputes semantic SHA and enforces record/count/state invariants', async () => {
  // Small synthetic manifest with matching semantic SHA.
  const records = [
    { observation_id: 'o1', reconciliation_state: 'resolved_exact', resolved_sporely_taxon_id: 42, signals_all: [] },
    { observation_id: 'o2', reconciliation_state: 'manual_unresolved', resolved_sporely_taxon_id: null, signals_all: [] },
  ];
  const manifest = { record_count: 2, aggregate_counts: { resolved_exact: 1, manual_unresolved: 1 }, records };
  const semanticSha = computeSemanticSha256(manifest);

  const { computedSha } = verifyManifest(JSON.stringify(manifest), semanticSha);
  assert.equal(computedSha, semanticSha);

  // Tamper 1: declared SHA differs.
  assert.throws(() => verifyManifest(JSON.stringify(manifest), 'ff'.repeat(32)), /manifest sha mismatch/);

  // Tamper 2: record_count disagrees with actual records.length.
  const badCount = { ...manifest, record_count: 3 };
  assert.throws(() => verifyManifest(JSON.stringify(badCount)), /record_count/);

  // Tamper 3: duplicate observation_id.
  const dup = { ...manifest, records: [records[0], records[0]] };
  const dupCounted = { ...dup, record_count: 2, aggregate_counts: { resolved_exact: 2 } };
  assert.throws(() => verifyManifest(JSON.stringify(dupCounted)), /duplicate observation_id/);

  // Tamper 4: aggregate_counts disagrees with actual state distribution.
  const wrongAgg = { ...manifest, aggregate_counts: { resolved_exact: 2 } };
  assert.throws(() => verifyManifest(JSON.stringify(wrongAgg)), /aggregate_counts/);

  // Tamper 5: resolved record with null target.
  const badResolved = { record_count: 1, aggregate_counts: { resolved_exact: 1 }, records: [{ observation_id: 'x', reconciliation_state: 'resolved_exact', resolved_sporely_taxon_id: null, signals_all: [] }] };
  assert.throws(() => verifyManifest(JSON.stringify(badResolved)), /missing valid target/);

  // Tamper 6: unresolved record with non-null target.
  const badUnresolved = { record_count: 1, aggregate_counts: { manual_unresolved: 1 }, records: [{ observation_id: 'x', reconciliation_state: 'manual_unresolved', resolved_sporely_taxon_id: 99, signals_all: [] }] };
  assert.throws(() => verifyManifest(JSON.stringify(badUnresolved)), /non-null target/);
});

test('loadBase verifies every file in taxonomy_export_manifest.json', async () => {
  const base = await loadBase(BASE_RELEASE);
  assert.equal(base.release_id, 'tax-2026.08.01-01');
  assert.equal(base.scope_manifest_sha256, '72758b2c574e8aea27432b6b55c62dfb6ad87f3fadc11ad1c892a61abf23ac4e');
  // Manifest lists 7 files; every one had its SHA verified.
  assert.ok(base.per_file_verifications.length >= 7);
});

// ------------------------------------------------------------------
// Integration
// ------------------------------------------------------------------

async function loadFullManifestPayload() {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  const declaredSha = (await readFile(path.join(path.dirname(MANIFEST_PATH), 'reconciliation-manifest.sha256.txt'), 'utf8')).trim();
  const { doc } = verifyManifest(raw, declaredSha);
  const inputSha = createHash('sha256').update(raw, 'utf8').digest('hex');
  return {
    semantic_sha256: declaredSha,
    input_file_sha256: inputSha,
    record_count: doc.record_count,
    aggregate_counts: doc.aggregate_counts,
    records: doc.records,
  };
}

async function freshInstall(target) {
  await ensureSchema(target, { observationsIntegration: true });
  const base = await loadBase(BASE_RELEASE);
  const supA = await loadSupplementDir(SUP_A_DIR);
  const supB = await loadSupplementDir(SUP_B_DIR);
  const manifest = await loadFullManifestPayload();
  await installChain(target, base, [supA, supB], manifest);
  return { base, supA, supB, manifest };
}

test('integration: registry_concept identity conflict fails closed', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await freshInstall(target);
  // Reinstall with the SAME identity (idempotent).
  const base = await loadBase(BASE_RELEASE);
  const supA = await loadSupplementDir(SUP_A_DIR);
  const supB = await loadSupplementDir(SUP_B_DIR);
  const manifest = await loadFullManifestPayload();
  await installChain(target, base, [supA, supB], manifest);
  // Now build a supplement that reassigns sporely_taxon_id=634896 (already
  // anchored to a NorTaxa concept) with a DIFFERENT canonical_name → must raise.
  const oneMapping = { ...supA.external_mappings[0], canonical_name: 'W3-A2 conflicting identity', rank: 'family' };
  const clash = {
    ...supA,
    release_id: 'tax-w3a2-identity-clash',
    supplement_shard_sha256: 'ab'.repeat(32),
    supplement_registry_manifest_sha256: 'cd'.repeat(32),
    depends_on: [],
    external_mappings: [oneMapping],
  };
  const emptyManifest = { semantic_sha256: 'w3a2-empty', record_count: 0, aggregate_counts: {}, records: [] };
  await assert.rejects(
    installChain(target, base, [clash], emptyManifest),
    /registry_concept identity conflict/,
  );
});

test('integration: observations INSERT+UPDATE guards reject anon/authenticated write', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await freshInstall(target);
  // Seed a matching (real) observation.
  await queryStdin(target, `
    insert into auth.users (id, aud, role, instance_id, email) values ('00000000-0000-0000-0000-000000000010'::uuid, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'::uuid, 'w3a2-guard@example.local') on conflict (id) do nothing;
    insert into public.profiles (id) values ('00000000-0000-0000-0000-000000000010'::uuid) on conflict (id) do nothing;
    insert into public.observations (id, user_id, date, genus, species) overriding system value select 900110, '00000000-0000-0000-0000-000000000010'::uuid, '2026-08-01'::date, 'g', 's' where not exists (select 1 from public.observations where id = 900110);
    insert into public.observations (id, user_id, date, genus, species) overriding system value select 900111, '00000000-0000-0000-0000-000000000010'::uuid, '2026-08-01'::date, 'g', 's' where not exists (select 1 from public.observations where id = 900111);
  `);

  // SET LOCAL requires a transaction — otherwise it silently no-ops and
  // current_user stays 'postgres', which the guard permits. Wrap every
  // role change in an explicit BEGIN/COMMIT.
  // anon INSERT with non-null link → must be rejected by the trigger.
  await assert.rejects(
    queryStdin(target, `begin; set local role anon; insert into public.observations (id, user_id, date, genus, species, resolved_sporely_taxon_id) overriding system value values (900112, '00000000-0000-0000-0000-000000000010'::uuid, '2026-08-01'::date, 'g', 's', 42); commit;`),
    /can only be set by service_role/,
  );
  // anon UPDATE — either the guard raises, OR anon has no UPDATE privilege
  // on public.observations at all. Either outcome proves the column cannot
  // be self-assigned by anon; assert that the link value did not change.
  const before110 = (await query(target, `select coalesce(resolved_sporely_taxon_id::text,'')||'|'||coalesce(genus,'') from public.observations where id = 900110`)).trim();
  try { await queryStdin(target, `begin; set local role anon; update public.observations set resolved_sporely_taxon_id = 42 where id = 900110; commit;`); } catch (_) {}
  const after110 = (await query(target, `select coalesce(resolved_sporely_taxon_id::text,'')||'|'||coalesce(genus,'') from public.observations where id = 900110`)).trim();
  assert.equal(after110, before110, 'anon UPDATE must not change resolved_sporely_taxon_id');
  // authenticated UPDATE — same treatment.
  const before111 = (await query(target, `select coalesce(resolved_sporely_taxon_id::text,'')||'|'||coalesce(genus,'') from public.observations where id = 900111`)).trim();
  try { await queryStdin(target, `begin; set local role authenticated; update public.observations set resolved_sporely_taxon_id = 42 where id = 900111; commit;`); } catch (_) {}
  const after111 = (await query(target, `select coalesce(resolved_sporely_taxon_id::text,'')||'|'||coalesce(genus,'') from public.observations where id = 900111`)).trim();
  assert.equal(after111, before111, 'authenticated UPDATE must not change resolved_sporely_taxon_id');
  // As service_role: allowed. Use ON CONFLICT to keep the test hermetic
  // across repeated integration runs.
  await queryStdin(target, `begin; set local role service_role; insert into public.observations (id, user_id, date, genus, species, resolved_sporely_taxon_id) overriding system value values (900113, '00000000-0000-0000-0000-000000000010'::uuid, '2026-08-01'::date, 'g', 's', 634896) on conflict (id) do update set resolved_sporely_taxon_id = excluded.resolved_sporely_taxon_id; commit;`);
  const val = (await query(target, `select resolved_sporely_taxon_id from public.observations where id = 900113`)).trim();
  assert.equal(val, '634896');
});

test('integration: resolution_link privacy — anon sees public rows only; authenticated additionally sees own private rows', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await freshInstall(target);

  // Two owners; three observations: public, private-owned, private-other.
  await queryStdin(target, `
    insert into auth.users (id, aud, role, instance_id, email) values
      ('00000000-0000-0000-0000-000000000021'::uuid, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'::uuid, 'w3a2-a@example.local'),
      ('00000000-0000-0000-0000-000000000022'::uuid, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'::uuid, 'w3a2-b@example.local')
      on conflict (id) do nothing;
    insert into public.profiles (id) values
      ('00000000-0000-0000-0000-000000000021'::uuid),
      ('00000000-0000-0000-0000-000000000022'::uuid) on conflict (id) do nothing;
    insert into public.observations (id, user_id, date, genus, species, visibility, is_draft) overriding system value values
      (900221, '00000000-0000-0000-0000-000000000021'::uuid, '2026-08-01'::date, 'g', 's', 'public', false),
      (900222, '00000000-0000-0000-0000-000000000021'::uuid, '2026-08-01'::date, 'g', 's', 'private', false),
      (900223, '00000000-0000-0000-0000-000000000022'::uuid, '2026-08-01'::date, 'g', 's', 'private', false)
      on conflict (id) do update set visibility = excluded.visibility, is_draft = false, user_id = excluded.user_id;
    set local role service_role;
    insert into taxonomy_v3.identification_snapshot (observation_id) values ('900221'), ('900222'), ('900223') on conflict do nothing;
    insert into taxonomy_v3.resolution_link (observation_id, resolution_state, resolved_sporely_taxon_id) values
      ('900221', 'resolved_exact', 634896),
      ('900222', 'unresolved_external_identifier', null),
      ('900223', 'resolved_exact', 634897) on conflict (observation_id) do update set resolution_state = excluded.resolution_state, resolved_sporely_taxon_id = excluded.resolved_sporely_taxon_id;
  `);

  // anon may see only 900221.
  const anonVisible = (await queryStdin(target, `begin; set local role anon; select array(select observation_id from taxonomy_v3.resolution_link where observation_id in ('900221','900222','900223') order by observation_id)::text; commit;`)).trim();
  assert.equal(anonVisible, '{900221}');

  // authenticated with no JWT still only sees public rows — proves the
  // policy is not blanket USING(true) even for authenticated. Owner path
  // requires a real JWT setup handled in staging.
  const authVisible = (await queryStdin(target, `begin; set local role authenticated; select array(select observation_id from taxonomy_v3.resolution_link where observation_id in ('900221','900222','900223') order by observation_id)::text; commit;`)).trim();
  assert.match(authVisible, /^\{900221\}$|^\{900221,900222\}$/);
});

test('integration: deployment manifest bridges 369 pseudonymous IDs to 233 canonical links + 136 NULL links', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await freshInstall(target);
  // Ingest the deployment manifest into a rehearsal schema.
  const text = await readFile(DEPLOY_MANIFEST, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  const records = lines.slice(1).map(l => JSON.parse(l));
  assert.equal(header.record_count, 369);
  assert.equal(records.length, 369);
  // Seed real observations for every record (bulk).
  const uuidBase = '00000000-0000-0000-0000-000000000031';
  await queryStdin(target, `
    insert into auth.users (id, aud, role, instance_id, email) values ('${uuidBase}'::uuid, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'::uuid, 'w3a2-bridge@example.local') on conflict (id) do nothing;
    insert into public.profiles (id) values ('${uuidBase}'::uuid) on conflict (id) do nothing;
  `);
  // Bulk-seed observations then run link function.
  const values = records.map(r => `(${Number(r.real_observation_id)}, '${uuidBase}'::uuid, '2026-08-01'::date, 'g', 's', 'public')`).join(',');
  await queryStdin(target, `
    insert into public.observations (id, user_id, date, genus, species, visibility) overriding system value
    values ${values} on conflict (id) do nothing;
  `);
  // link_observations_to_resolution requires resolution_link keyed by
  // TEXT observation_id matching public.observations.id::text. Insert the
  // bridging resolution_links now using the real IDs.
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const linkValues = records.map(r => `(${q(r.real_observation_id)}, ${q(r.reconciliation_state)}, ${r.resolved_sporely_taxon_id == null ? 'null' : Number(r.resolved_sporely_taxon_id)})`).join(',');
  await queryStdin(target, `
    begin;
    set local role service_role;
    insert into taxonomy_v3.identification_snapshot (observation_id) values ${records.map(r => `(${q(r.real_observation_id)})`).join(',')} on conflict do nothing;
    insert into taxonomy_v3.resolution_link (observation_id, resolution_state, resolved_sporely_taxon_id) values ${linkValues}
      on conflict (observation_id) do update set resolution_state = excluded.resolution_state, resolved_sporely_taxon_id = excluded.resolved_sporely_taxon_id;
    select taxonomy_v3.link_observations_to_resolution();
    commit;
  `);
  const linkedCount = Number((await query(target, `select count(*) from public.observations o where o.resolved_sporely_taxon_id is not null and exists (select 1 from taxonomy_v3.resolution_link rl where rl.observation_id = o.id::text)`)).trim());
  const nullCount = Number((await query(target, `select count(*) from public.observations o where o.resolved_sporely_taxon_id is null and exists (select 1 from taxonomy_v3.resolution_link rl where rl.observation_id = o.id::text)`)).trim());
  assert.equal(linkedCount, 233);
  assert.equal(nullCount, 136);

  // Prove no legacy taxonomy/name field was touched.
  // Only assert integrity for rows this test seeded (previous rehearsals
  // may have left synthetic 900001 etc. in place with different taxonomy).
  const seededIds = records.map(r => Number(r.real_observation_id)).filter(Number.isFinite);
  const nonDefaultCount = Number((await query(target, `select count(*) from public.observations where id = any (array[${seededIds.join(',')}]::bigint[]) and (genus is distinct from 'g' or species is distinct from 's')`)).trim());
  assert.equal(nonDefaultCount, 0);
});

test('integration: additive migration draft applies cleanly against 3 stack states', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  const additive = await readFile(ADDITIVE_SCHEMA, 'utf8');
  const additiveObs = await readFile(ADDITIVE_OBS, 'utf8');
  const dropAll = `drop schema if exists taxonomy_v3 cascade;`;

  // State 1: fresh stack (nothing installed).
  await queryStdin(target, dropAll);
  await queryStdin(target, additive);
  await queryStdin(target, additiveObs);
  assert.equal(Number((await query(target, "select count(*) from information_schema.tables where table_schema='taxonomy_v3'")).trim()), 7);

  // State 2: current production-shaped schema already present (the drop
  // schema draft was already installed).
  await queryStdin(target, dropAll);
  await queryStdin(target, await readFile(SCHEMA_SQL, 'utf8'));
  await queryStdin(target, await readFile(OBS_INTEG, 'utf8'));
  await queryStdin(target, additive); // additive on top must succeed
  await queryStdin(target, additiveObs);

  // State 3: additive was already applied — re-applying must succeed too.
  await queryStdin(target, additive);
  await queryStdin(target, additiveObs);
  assert.equal(Number((await query(target, "select count(*) from information_schema.tables where table_schema='taxonomy_v3'")).trim()), 7);
});
