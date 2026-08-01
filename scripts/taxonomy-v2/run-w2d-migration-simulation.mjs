#!/usr/bin/env node
// W2D migration-simulation runner. Applies the desktop reconciliation manifest
// against an isolated disposable schema and reports the outcome. Never touches
// production Supabase; never creates production migrations. See
// scripts/taxonomy-v2/experiments/w2d-migration-simulation.sql for the schema
// this driver consumes and
// /Users/sigmundas/Documents/Code/sporely/sporely-py/database/taxonomy/docs/w2d-reconciliation-contract.md
// for the authoritative contract.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverLocalTarget, query } from './lib/docker-psql.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
export const SCHEMA_SQL_PATH = path.join(HERE, 'experiments', 'w2d-migration-simulation.sql');
export const SCHEMA = 'w2d_migration_simulation';
export const DEFAULT_MANIFEST = path.resolve(
  REPO_ROOT,
  '..',
  'sporely-py',
  'database',
  'taxonomy',
  'evidence',
  'historical-reconciliation',
  'reconciliation-manifest.json',
);
export const SEMANTIC_HASH_EXCLUDES = Object.freeze(new Set([
  'generated_at',
  'resolution_timestamp',
  'run_host',
]));
export const ROLLBACK_MARKER_ID = '__rollback_forced__';

// Contract §6 result-record field set. Ordering is documented as "semantic set",
// while contract §9 requires lexicographic key order in the manifest body.
export const RESULT_FIELD_ORDER = Object.freeze([
  'observation_id',
  'reconciliation_state',
  'resolved_sporely_taxon_id',
  'resolved_canonical_name',
  'resolved_rank',
  'resolved_scope_state',
  'resolution_method',
  'resolution_evidence',
  'original_legacy_taxon_id',
  'original_scientific_name',
  'original_vernacular_name',
  'original_source_system',
  'original_source_namespace',
  'original_external_id',
  'signals_all',
  'unmapped_signals',
  'candidate_concepts',
  'conflicting_concepts',
  'missing_source_records',
  'review_reason',
  'migration_action',
]);

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
  return sorted;
}

export function removeExcludedKeys(value, excludes) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => removeExcludedKeys(v, excludes));
  const out = {};
  for (const key of Object.keys(value)) {
    if (excludes.has(key)) continue;
    out[key] = removeExcludedKeys(value[key], excludes);
  }
  return out;
}

export function computeSemanticSha256(manifestObj, excludes = SEMANTIC_HASH_EXCLUDES) {
  const stripped = removeExcludedKeys(manifestObj, excludes);
  const canonical = canonicalize(stripped);
  const body = `${JSON.stringify(canonical, null, 2)}\n`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function stableStringify(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sqlLiteral(value) {
  if (value == null) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

// Namespace-derivation helper for the RawSignal → external_mapping insertion
// step (contract §3 + §5). The desktop engine already normalises namespaces
// upstream, so this helper only accepts an already-normalised signal and either
// emits a single mapping row or (for text-only / invalid / incomplete signals)
// returns an empty array. Kept as pure JS so the non-integration test can
// exercise every branch without a database.
export function externalMappingsFromSignal(signal, resolvedSporelyTaxonId, releaseId) {
  if (!signal || typeof signal !== 'object') return [];
  if (signal.kind !== 'exact') return [];
  if (resolvedSporelyTaxonId == null) return [];
  const source_system = signal.source_system == null ? '' : String(signal.source_system).trim();
  const namespace = signal.namespace == null ? '' : String(signal.namespace).trim();
  const external_id = signal.external_id == null ? '' : String(signal.external_id).trim();
  if (!source_system || !namespace || !external_id) return [];
  return [{ source_system, namespace, external_id, sporely_taxon_id: resolvedSporelyTaxonId, release_id: releaseId }];
}

function shaSiblingPath(manifestPath) {
  const dir = path.dirname(manifestPath);
  const stem = path.basename(manifestPath, path.extname(manifestPath));
  return path.join(dir, `${stem}.sha256.txt`);
}

export async function loadManifest(manifestPath) {
  const manifestText = await readFile(manifestPath, 'utf8');
  const shaText = await readFile(shaSiblingPath(manifestPath), 'utf8');
  const manifest = JSON.parse(manifestText);
  const expected = shaText.trim();
  const computed = computeSemanticSha256(manifest);
  if (computed !== expected) {
    throw new Error(`semantic SHA-256 mismatch for ${manifestPath}: expected ${expected} computed ${computed}`);
  }
  return { manifest, semanticSha: computed };
}

export async function readSchemaSql() {
  return await readFile(SCHEMA_SQL_PATH, 'utf8');
}

export async function applySchema(target) {
  const sql = await readSchemaSql();
  await query(target, sql);
}

async function callApply(target, manifest, semanticSha) {
  const manifestLiteral = sqlLiteral(JSON.stringify(manifest));
  const shaLiteral = sqlLiteral(semanticSha);
  const raw = await query(target, `select ${SCHEMA}.apply_reconciliation_manifest(${manifestLiteral}::jsonb, ${shaLiteral})::text`);
  return JSON.parse(raw);
}

async function callSimulate(target, manifest, semanticSha) {
  const manifestLiteral = sqlLiteral(JSON.stringify(manifest));
  const shaLiteral = sqlLiteral(semanticSha);
  const raw = await query(target, `select ${SCHEMA}.simulate_migration(${manifestLiteral}::jsonb, ${shaLiteral})::text`);
  return JSON.parse(raw);
}

async function tableCounts(target) {
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

async function out_of_cache_verdict(target) {
  const raw = await query(target, `select json_build_object(
    'materialised_concept_sporely_taxon_id',931,
    'observed_scope_state',(select scope_state from ${SCHEMA}.registry_concept where sporely_taxon_id=931),
    'observed_canonical_name',(select canonical_name from ${SCHEMA}.registry_concept where sporely_taxon_id=931),
    'observed_rank',(select rank from ${SCHEMA}.registry_concept where sporely_taxon_id=931)
  )::text`);
  return JSON.parse(raw);
}

async function snapshotPreservationVerdict(target) {
  // Compare fingerprint before/after a synthetic later-resolution attempt.
  const before = await snapshotFingerprint(target);
  const affectedObservationId = await query(target, `select observation_id from ${SCHEMA}.identification_snapshot order by observation_id limit 1`);
  let noop = 'no_snapshots';
  if (affectedObservationId) {
    // Attempt a benign update that keeps original_* identical; the trigger
    // should permit this because no original_* changes.
    await query(target, `update ${SCHEMA}.identification_snapshot set snapshot_written_at=snapshot_written_at where observation_id=${sqlLiteral(affectedObservationId)}`);
    noop = 'benign_update_allowed';
  }
  const after = await snapshotFingerprint(target);
  return {
    fingerprint_before: before,
    fingerprint_after_benign_update: after,
    fingerprint_matches: before === after,
    benign_update_probe: noop,
  };
}

function parseArgs(argv) {
  const flag = name => argv.includes(name);
  const value = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  return {
    manifest: value('--manifest') || DEFAULT_MANIFEST,
    output: value('--output'),
    twice: flag('--twice'),
    rollbackSimulate: flag('--rollback-simulate'),
    help: flag('--help') || flag('-h'),
  };
}

const HELP = [
  'usage: run-w2d-migration-simulation.mjs [options]',
  '',
  'options:',
  `  --manifest <path>       reconciliation manifest JSON (default: ${DEFAULT_MANIFEST})`,
  '  --twice                 apply manifest twice; verify idempotency',
  '  --rollback-simulate     inject __rollback_forced__ record; verify zero orphan rows',
  '  --output <path>         write deterministic JSON summary to file (in addition to stdout)',
  '  --help                  print this message',
].join('\n');

async function run(args) {
  const { manifest, semanticSha } = await loadManifest(args.manifest);
  const target = await discoverLocalTarget(REPO_ROOT);
  await applySchema(target);

  const runtime = {
    docker_context: target.context,
    docker_engine_version: target.engineVersion,
    node_version: process.version,
    postgres_version: target.postgresVersion,
  };

  const provenance = {
    manifest_path: path.basename(args.manifest),
    manifest_semantic_sha256: semanticSha,
    manifest_version: manifest.manifest_version,
    policy_sha256: manifest.policy_sha256,
    policy_version: manifest.policy_version,
    taxonomy_release_id: manifest.taxonomy_release_id,
    taxonomy_scope_manifest_sha256: manifest.taxonomy_scope_manifest_sha256,
  };

  if (args.rollbackSimulate) {
    const injected = { ...manifest, records: [...manifest.records, { observation_id: ROLLBACK_MARKER_ID }] };
    const result = await callSimulate(target, injected, semanticSha);
    const counts = await tableCounts(target);
    return {
      aggregate_counts_from_manifest: manifest.aggregate_counts,
      mode: 'rollback-simulate',
      provenance,
      real_data_available: false,
      real_data_reason: 'synthetic fixtures; 337-observation real audit blocked pending anonymised export per w2d-input-snapshot-contract.md',
      rollback: {
        counts_after_failure: counts,
        error: result.error || null,
        ok: result.ok,
        sqlstate: result.sqlstate || null,
        zero_orphan_rows:
          counts.registry_concept === 0 &&
          counts.external_mapping === 0 &&
          counts.identification_snapshot === 0 &&
          counts.resolution_link === 0 &&
          counts.reconciliation_result === 0,
      },
      runtime,
    };
  }

  const firstSummary = await callApply(target, manifest, semanticSha);
  const firstCounts = await tableCounts(target);
  const firstFingerprint = await snapshotFingerprint(target);
  const outOfCache = await out_of_cache_verdict(target);
  const preservation = await snapshotPreservationVerdict(target);
  const finalFingerprint = await snapshotFingerprint(target);

  const summary = {
    aggregate_counts_from_manifest: manifest.aggregate_counts,
    first_apply: firstSummary,
    first_apply_counts: firstCounts,
    first_apply_snapshot_fingerprint: firstFingerprint,
    mode: args.twice ? 'apply-twice' : 'apply',
    out_of_cache_verdict: {
      concept_materialised: firstCounts.registry_concept > 0 && outOfCache.observed_scope_state === 'required_ancestor',
      details: outOfCache,
    },
    provenance,
    real_data_available: false,
    real_data_reason: 'synthetic fixtures; 337-observation real audit blocked pending anonymised export per w2d-input-snapshot-contract.md',
    runtime,
    snapshot_preservation_verdict: {
      fingerprint_stable_across_benign_update: preservation.fingerprint_matches,
      fingerprint_stable_across_run: finalFingerprint === firstFingerprint,
      details: preservation,
    },
    w3_readiness_verdict: 'legacy-source recovery required',
  };

  if (args.twice) {
    const secondSummary = await callApply(target, manifest, semanticSha);
    const secondCounts = await tableCounts(target);
    const secondFingerprint = await snapshotFingerprint(target);
    const idempotent =
      firstFingerprint === secondFingerprint &&
      firstCounts.registry_concept === secondCounts.registry_concept &&
      firstCounts.external_mapping === secondCounts.external_mapping &&
      firstCounts.identification_snapshot === secondCounts.identification_snapshot &&
      firstCounts.resolution_link === secondCounts.resolution_link &&
      firstCounts.reconciliation_result === secondCounts.reconciliation_result;
    summary.idempotency_verdict = {
      counts_match: idempotent,
      first_counts: firstCounts,
      first_snapshot_fingerprint: firstFingerprint,
      idempotent,
      second_apply: secondSummary,
      second_counts: secondCounts,
      second_snapshot_fingerprint: secondFingerprint,
    };
  }

  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return { ok: true };
  }
  const summary = await run(args);
  const rendered = stableStringify(summary);
  if (args.output) await writeFile(args.output, rendered);
  process.stdout.write(rendered);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`W2D migration simulation failed: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
