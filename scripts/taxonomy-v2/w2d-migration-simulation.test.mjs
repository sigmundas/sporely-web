import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalize,
  computeSemanticSha256,
  externalMappingsFromSignal,
  loadManifest,
  removeExcludedKeys,
  RESULT_FIELD_ORDER,
  SCHEMA_SQL_PATH,
  sqlLiteral,
  stableStringify,
} from './run-w2d-migration-simulation.mjs';
import { discoverLocalTarget, query } from './lib/docker-psql.mjs';

const integration = process.env.W2D_INTEGRATION === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MANIFEST_PATH = path.resolve(
  REPO_ROOT,
  '..',
  'sporely-py',
  'database',
  'taxonomy',
  'evidence',
  'historical-reconciliation',
  'reconciliation-manifest.json',
);
const SHA_PATH = MANIFEST_PATH.replace(/\.json$/, '.sha256.txt');
const SCHEMA = 'w2d_migration_simulation';

// ---------- non-integration -----------------------------------------------

test('canonicalize sorts object keys recursively', () => {
  const input = { b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }, null, 'raw'] };
  const output = canonicalize(input);
  assert.deepEqual(Object.keys(output), ['a', 'b']);
  assert.deepEqual(Object.keys(output.b), ['c', 'd']);
  assert.deepEqual(Object.keys(output.a[0]), ['y', 'z']);
  assert.equal(output.a[1], null);
  assert.equal(output.a[2], 'raw');
});

test('stableStringify emits sorted keys with trailing newline', () => {
  const rendered = stableStringify({ b: 2, a: 1 });
  assert.equal(rendered, '{\n  "a": 1,\n  "b": 2\n}\n');
});

test('removeExcludedKeys strips documented non-semantic fields recursively', () => {
  const input = {
    a: 1,
    generated_at: 'now',
    run_host: 'x',
    nested: { resolution_timestamp: 't', b: 2 },
    array: [{ generated_at: 'z', kept: true }],
  };
  const output = removeExcludedKeys(input, new Set(['generated_at', 'resolution_timestamp', 'run_host']));
  assert.deepEqual(output, {
    a: 1,
    nested: { b: 2 },
    array: [{ kept: true }],
  });
});

test('semantic SHA-256 helper matches the desktop-published hash', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const expected = (await readFile(SHA_PATH, 'utf8')).trim();
  const computed = computeSemanticSha256(manifest);
  assert.equal(computed, expected);
});

test('loadManifest verifies the sibling .sha256.txt file', async () => {
  const { manifest, semanticSha } = await loadManifest(MANIFEST_PATH);
  const expected = (await readFile(SHA_PATH, 'utf8')).trim();
  assert.equal(semanticSha, expected);
  assert.equal(manifest.record_count, manifest.records.length);
});

test('every manifest record carries the contract §6 field set', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  assert.ok(manifest.records.length > 0, 'manifest is expected to have records');
  for (const record of manifest.records) {
    for (const field of RESULT_FIELD_ORDER) {
      assert.ok(field in record, `record ${record.observation_id} missing ${field}`);
    }
  }
});

test('external-mapping derivation emits at most one tuple per exact signal', () => {
  const releaseId = 'tax-2026.08.01-01';
  const exact = { kind: 'exact', source_system: 'col_xr', namespace: 'col_usage_id', external_id: '323XQ' };
  assert.deepEqual(externalMappingsFromSignal(exact, 167, releaseId), [{
    source_system: 'col_xr', namespace: 'col_usage_id', external_id: '323XQ',
    sporely_taxon_id: 167, release_id: releaseId,
  }]);
});

test('external-mapping derivation refuses non-exact / incomplete / unresolved signals', () => {
  const text = { kind: 'text-only', source_system: null, namespace: null, external_id: null };
  const invalid = { kind: 'invalid', source_system: 'unknownservice', namespace: null, external_id: '12345' };
  const partial = { kind: 'exact', source_system: 'nortaxa', namespace: '', external_id: '1' };
  const withoutResolution = { kind: 'exact', source_system: 'col_xr', namespace: 'col_usage_id', external_id: '323XQ' };
  assert.deepEqual(externalMappingsFromSignal(text, 167, 'r1'), []);
  assert.deepEqual(externalMappingsFromSignal(invalid, 167, 'r1'), []);
  assert.deepEqual(externalMappingsFromSignal(partial, 167, 'r1'), []);
  assert.deepEqual(externalMappingsFromSignal(withoutResolution, null, 'r1'), []);
  assert.deepEqual(externalMappingsFromSignal(null, 167, 'r1'), []);
});

test('sqlLiteral escapes single quotes and coerces null/undefined to SQL null', () => {
  assert.equal(sqlLiteral(null), 'null');
  assert.equal(sqlLiteral(undefined), 'null');
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral(42), "'42'");
});

test('SQL schema is isolated, immutable-snapshot-enforcing, and never targets public', async () => {
  const sql = await readFile(SCHEMA_SQL_PATH, 'utf8');
  assert.match(sql, /drop schema if exists w2d_migration_simulation cascade/);
  assert.match(sql, /create schema w2d_migration_simulation/);
  assert.match(sql, /identification_snapshot_immutability_trg/);
  assert.match(sql, /raise exception 'identification_snapshot original_\* fields are immutable/);
  assert.match(sql, /apply_reconciliation_manifest/);
  assert.match(sql, /simulate_migration/);
  assert.match(sql, /on conflict \(source_system, namespace, external_id\) do nothing/);
  assert.doesNotMatch(sql, /create table public\./i);
  assert.doesNotMatch(sql, /alter table public\./i);
  assert.doesNotMatch(sql, /supabase_migrations/i);
});

// ---------- integration ---------------------------------------------------

async function loadReferenceManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const semanticSha = computeSemanticSha256(manifest);
  return { manifest, semanticSha };
}

async function ensureFreshSchema(target) {
  const sql = await readFile(SCHEMA_SQL_PATH, 'utf8');
  await query(target, sql);
}

async function applyManifest(target, manifest, semanticSha) {
  const raw = await query(target, `select ${SCHEMA}.apply_reconciliation_manifest(${sqlLiteral(JSON.stringify(manifest))}::jsonb, ${sqlLiteral(semanticSha)})::text`);
  return JSON.parse(raw);
}

async function simulateManifest(target, manifest, semanticSha) {
  const raw = await query(target, `select ${SCHEMA}.simulate_migration(${sqlLiteral(JSON.stringify(manifest))}::jsonb, ${sqlLiteral(semanticSha)})::text`);
  return JSON.parse(raw);
}

async function counts(target) {
  const raw = await query(target, `select json_build_object(
    'registry_concept',(select count(*) from ${SCHEMA}.registry_concept),
    'external_mapping',(select count(*) from ${SCHEMA}.external_mapping),
    'identification_snapshot',(select count(*) from ${SCHEMA}.identification_snapshot),
    'resolution_link',(select count(*) from ${SCHEMA}.resolution_link),
    'reconciliation_result',(select count(*) from ${SCHEMA}.reconciliation_result))::text`);
  return JSON.parse(raw);
}

async function snapshotFingerprint(target) {
  return await query(target, `select coalesce(md5(string_agg(row_to_json(t)::text, '|' order by t.observation_id)), '') from (
    select observation_id, original_scientific_name, original_vernacular_name,
           original_rank, original_legacy_taxon_id, original_source_system,
           original_source_namespace, original_external_id,
           original_signals::text as original_signals_text
      from ${SCHEMA}.identification_snapshot) t`);
}

test('integration: applying the fixture manifest yields the expected aggregate counts', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  const summary = await applyManifest(target, manifest, semanticSha);
  assert.equal(summary.records_applied, 13);
  assert.equal(summary.identification_snapshots_after, 13);
  assert.equal(summary.reconciliation_results_after, 13);
  assert.equal(summary.resolution_links_after, 13);
  assert.equal(summary.registry_concepts_after, 2);
  assert.equal(summary.external_mappings_after, 3);
});

test('integration: exact resolved observation materialises concept + mapping with scope_state preserved', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  await applyManifest(target, manifest, semanticSha);
  const concept = JSON.parse(await query(target, `select row_to_json(t)::text from (select sporely_taxon_id, canonical_name, rank, scope_state, first_materialized_from_release from ${SCHEMA}.registry_concept where sporely_taxon_id=167) t`));
  assert.deepEqual(concept, {
    sporely_taxon_id: 167,
    canonical_name: 'Crystallocystidium albescens',
    rank: 'species',
    scope_state: 'include',
    first_materialized_from_release: 'tax-2026.08.01-01',
  });
  assert.equal(await query(target, `select count(*) from ${SCHEMA}.external_mapping where source_system='col_xr' and namespace='col_usage_id' and external_id='323XQ' and sporely_taxon_id=167`), '1');
  assert.equal(await query(target, `select count(*) from ${SCHEMA}.external_mapping where source_system='sporely' and namespace='sporely_taxon_id' and external_id='167' and sporely_taxon_id=167`), '1');
});

test('integration: legacy-mapped resolution preserves the chain in resolution_evidence', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  await applyManifest(target, manifest, semanticSha);
  const link = JSON.parse(await query(target, `select row_to_json(t)::text from (select resolution_state, resolved_sporely_taxon_id, resolution_method, resolution_evidence from ${SCHEMA}.resolution_link where observation_id='fixture-resolved-legacy-01') t`));
  assert.equal(link.resolution_state, 'resolved_exact_via_legacy_mapping');
  assert.equal(link.resolved_sporely_taxon_id, 167);
  assert.equal(link.resolution_method, 'legacy_lookup_chain');
  assert.equal(link.resolution_evidence.length, 1);
  assert.equal(link.resolution_evidence[0].method, 'legacy_lookup_chain');
  assert.equal(link.resolution_evidence[0].namespace, 'sporely_taxon_id');
});

test('integration: synonym-relationship fixture is intentionally skipped and lands as manual_unresolved', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  const synonymRecord = manifest.records.find(r => r.observation_id === 'fixture-resolved-synonym-01-SKIPPED');
  if (!synonymRecord) {
    // The manifest may drop the fixture in future releases; skip cleanly.
    return;
  }
  await applyManifest(target, manifest, semanticSha);
  const state = await query(target, `select resolution_state from ${SCHEMA}.resolution_link where observation_id='fixture-resolved-synonym-01-SKIPPED'`);
  assert.equal(state, 'manual_unresolved');
  assert.equal(await query(target, `select resolved_sporely_taxon_id from ${SCHEMA}.resolution_link where observation_id='fixture-resolved-synonym-01-SKIPPED'`), '');
});

test('integration: out-of-cache concept materialises with scope_state=required_ancestor', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  await applyManifest(target, manifest, semanticSha);
  const concept = JSON.parse(await query(target, `select row_to_json(t)::text from (select sporely_taxon_id, canonical_name, rank, scope_state from ${SCHEMA}.registry_concept where sporely_taxon_id=931) t`));
  assert.deepEqual(concept, {
    sporely_taxon_id: 931,
    canonical_name: 'Cyttariales',
    rank: 'order',
    scope_state: 'required_ancestor',
  });
});

test('integration: every unresolved state writes snapshot + resolution_link without registry_concept', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  await applyManifest(target, manifest, semanticSha);
  const unresolvedCases = [
    ['fixture-unresolved-external-01', 'unresolved_external_identifier'],
    ['fixture-unresolved-legacy-01', 'unresolved_legacy_identifier'],
    ['fixture-manual-unresolved-01', 'manual_unresolved'],
    ['fixture-no-evidence-01', 'no_identity_evidence'],
    ['fixture-ambiguous-01', 'ambiguous_multiple_candidates'],
    ['fixture-invalid-identifier-01', 'invalid_or_unnamespaced_identifier'],
    ['fixture-source-record-missing-01', 'source_record_missing'],
    ['fixture-resolved-synonym-01-SKIPPED', 'manual_unresolved'],
  ];
  for (const [obsId, state] of unresolvedCases) {
    assert.equal(await query(target, `select count(*) from ${SCHEMA}.identification_snapshot where observation_id=${sqlLiteral(obsId)}`), '1', obsId);
    assert.equal(await query(target, `select resolution_state from ${SCHEMA}.resolution_link where observation_id=${sqlLiteral(obsId)}`), state, obsId);
    assert.equal(await query(target, `select resolved_sporely_taxon_id from ${SCHEMA}.resolution_link where observation_id=${sqlLiteral(obsId)}`), '', obsId);
  }
});

test('integration: conflicting exact evidence writes resolution_link=conflicting and creates no registry row for the ambiguous concept', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  await applyManifest(target, manifest, semanticSha);
  assert.equal(await query(target, `select resolution_state from ${SCHEMA}.resolution_link where observation_id='fixture-conflict-01'`), 'conflicting_exact_evidence');
  assert.equal(await query(target, `select resolved_sporely_taxon_id from ${SCHEMA}.resolution_link where observation_id='fixture-conflict-01'`), '');
  // Concept 168 appears only in conflicting_concepts and MUST NOT be materialised.
  assert.equal(await query(target, `select count(*) from ${SCHEMA}.registry_concept where sporely_taxon_id=168`), '0');
});

test('integration: later exact resolution preserves the original snapshot verbatim', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const releaseId = 'tax-2026.08.01-01';
  const observationId = 'later-resolve-01';
  const baseRecord = {
    observation_id: observationId,
    candidate_concepts: [],
    conflicting_concepts: [],
    migration_action: 'retain_unresolved_without_registry_concept',
    missing_source_records: [],
    original_external_id: '42',
    original_legacy_taxon_id: 'legacy-42',
    original_scientific_name: 'Original snapshot name',
    original_source_namespace: 'nortaxa_taxon_id',
    original_source_system: 'nortaxa',
    original_vernacular_name: 'original common',
    reconciliation_state: 'unresolved_external_identifier',
    resolution_evidence: [],
    resolution_method: null,
    resolved_canonical_name: null,
    resolved_rank: null,
    resolved_scope_state: null,
    resolved_sporely_taxon_id: null,
    review_reason: 'test',
    signals_all: [{ external_id: '42', kind: 'exact', namespace: 'nortaxa_taxon_id', notes: null, origin_field: 'observations.artsdata_id', raw_value: '42', rule_id: 'artsdata_id_v1', source_system: 'nortaxa' }],
    unmapped_signals: [],
  };
  const unresolvedManifest = { manifest_version: 'reconciliation-manifest-v1', taxonomy_release_id: releaseId, record_count: 1, records: [baseRecord] };
  const sha = 'test-sha-later-resolution';
  await applyManifest(target, unresolvedManifest, sha);
  const beforeSnap = JSON.parse(await query(target, `select row_to_json(t)::text from (select original_scientific_name, original_vernacular_name, original_legacy_taxon_id, original_external_id, original_source_system, original_source_namespace, original_signals::text as sig from ${SCHEMA}.identification_snapshot where observation_id=${sqlLiteral(observationId)}) t`));
  const beforeLink = JSON.parse(await query(target, `select row_to_json(t)::text from (select resolution_state, resolved_sporely_taxon_id, resolution_method from ${SCHEMA}.resolution_link where observation_id=${sqlLiteral(observationId)}) t`));
  assert.equal(beforeLink.resolution_state, 'unresolved_external_identifier');
  assert.equal(beforeLink.resolved_sporely_taxon_id, null);
  assert.equal(await query(target, `select count(*) from ${SCHEMA}.registry_concept where sporely_taxon_id=501`), '0');
  const resolvedRecord = {
    ...baseRecord,
    reconciliation_state: 'resolved_exact',
    migration_action: 'materialize_existing_taxonomy_v2_concept',
    resolution_method: 'direct_taxonomy_v2_mapping',
    resolved_canonical_name: 'Later resolved name',
    resolved_rank: 'species',
    resolved_scope_state: 'include',
    resolved_sporely_taxon_id: 501,
    original_scientific_name: 'ATTEMPTED-CHANGE — MUST BE REJECTED',
    original_vernacular_name: 'ATTEMPTED-CHANGE',
    resolution_evidence: [{
      action: 'match_taxon_external_id', external_id: '42', level: 1,
      method: 'direct_taxonomy_v2_mapping', namespace: 'nortaxa_taxon_id',
      note: 'later resolution', resolved_taxon_id: 501, source_system: 'nortaxa',
    }],
  };
  const resolvedManifest = { ...unresolvedManifest, records: [resolvedRecord] };
  await applyManifest(target, resolvedManifest, sha);
  const afterSnap = JSON.parse(await query(target, `select row_to_json(t)::text from (select original_scientific_name, original_vernacular_name, original_legacy_taxon_id, original_external_id, original_source_system, original_source_namespace, original_signals::text as sig from ${SCHEMA}.identification_snapshot where observation_id=${sqlLiteral(observationId)}) t`));
  const afterLink = JSON.parse(await query(target, `select row_to_json(t)::text from (select resolution_state, resolved_sporely_taxon_id, resolution_method from ${SCHEMA}.resolution_link where observation_id=${sqlLiteral(observationId)}) t`));
  assert.deepEqual(afterSnap, beforeSnap);
  assert.equal(afterLink.resolution_state, 'resolved_exact');
  assert.equal(afterLink.resolved_sporely_taxon_id, 501);
  assert.equal(afterLink.resolution_method, 'direct_taxonomy_v2_mapping');
  assert.equal(await query(target, `select count(*) from ${SCHEMA}.registry_concept where sporely_taxon_id=501`), '1');
});

test('integration: idempotency — applying the fixture manifest twice yields identical row counts and snapshot fingerprint', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  await applyManifest(target, manifest, semanticSha);
  const firstCounts = await counts(target);
  const firstFingerprint = await snapshotFingerprint(target);
  await applyManifest(target, manifest, semanticSha);
  const secondCounts = await counts(target);
  const secondFingerprint = await snapshotFingerprint(target);
  assert.deepEqual(firstCounts, secondCounts);
  assert.equal(firstFingerprint, secondFingerprint);
});

test('integration: rollback simulation leaves zero orphan rows', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  const injected = { ...manifest, records: [...manifest.records, { observation_id: '__rollback_forced__' }] };
  const result = await simulateManifest(target, injected, semanticSha);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /rollback failure marker/);
  const observed = await counts(target);
  assert.deepEqual(observed, {
    registry_concept: 0,
    external_mapping: 0,
    identification_snapshot: 0,
    resolution_link: 0,
    reconciliation_result: 0,
  });
});

test('integration: snapshot immutability trigger rejects direct UPDATE to original_*', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureFreshSchema(target);
  const { manifest, semanticSha } = await loadReferenceManifest();
  await applyManifest(target, manifest, semanticSha);
  await assert.rejects(
    query(target, `update ${SCHEMA}.identification_snapshot set original_scientific_name='X' where observation_id='fixture-resolved-exact-01'`),
    /immutable/,
  );
  // Sanity check: benign UPDATE that changes no original_* is allowed.
  await query(target, `update ${SCHEMA}.identification_snapshot set snapshot_written_at=snapshot_written_at where observation_id='fixture-resolved-exact-01'`);
});
