#!/usr/bin/env node
// W3-A local rehearsal installer.
//
// Reads:
//   * a base release directory (validated: export_manifest.json,
//     scope_manifest_sha256, taxon_external_id.jsonl)
//   * an ORDERED list of supplement directories (each contains
//     release/*.json, canonical/manifest.json, canonical/part-*.jsonl)
//   * a reconciliation manifest JSON
//
// Refuses to run against a hosted / production target. Uses only the
// docker-psql discoverLocalTarget helper. All installations run through a
// single call to taxonomy_v3.install_release_chain(jsonb, jsonb, jsonb).
//
// The installer is idempotent for the same bytes and raises on:
//   * an already-installed release_id with different hashes;
//   * a supplement whose depends_on is not already installed;
//   * an external-mapping tuple whose target sporely_taxon_id conflicts.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { discoverLocalTarget, query, queryStdin } from '../taxonomy-v2/lib/docker-psql.mjs';
import { computeSemanticSha256 } from '../taxonomy-v2/run-w2d-migration-simulation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCHEMA_SQL = path.join(REPO_ROOT, 'supabase/drafts/taxonomy_v3_schema.sql');
const OBS_INTEGRATION_SQL = path.join(REPO_ROOT, 'supabase/drafts/taxonomy_v3_observations_integration_draft.sql');

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function fileSha256(p) {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

// W3-A2: loadBase verifies every artefact listed in taxonomy_export_manifest.json,
// not just the manifest file itself. Every file's on-disk sha256 must match
// the sha recorded in the manifest, and the scope_manifest.json file's sha
// must match manifest.scope_manifest_sha256.
export async function loadBase(baseDir) {
  const mfPath = path.join(baseDir, 'taxonomy_export_manifest.json');
  const mf = JSON.parse(await readFile(mfPath, 'utf8'));
  const perFileVerifications = [];
  for (const entry of mf.files || []) {
    const filePath = path.join(baseDir, entry.name);
    const observed = await fileSha256(filePath);
    if (observed !== entry.sha256) {
      throw new Error(`W3-A2 base release file ${entry.name} sha256 mismatch (disk=${observed}, manifest=${entry.sha256})`);
    }
    perFileVerifications.push({ name: entry.name, sha256: entry.sha256 });
  }
  // Scope-manifest cross-check.
  const scopePath = path.join(baseDir, 'scope-manifest.json');
  const scopeSha = await fileSha256(scopePath);
  if (mf.scope_manifest_sha256 && mf.scope_manifest_sha256 !== scopeSha) {
    throw new Error(`W3-A2 base scope_manifest_sha256 mismatch: manifest=${mf.scope_manifest_sha256}, disk=${scopeSha}`);
  }
  return {
    release_id: mf.release_id,
    export_manifest_sha256: await fileSha256(mfPath),
    scope_manifest_sha256: mf.scope_manifest_sha256 || scopeSha,
    per_file_verifications: perFileVerifications,
  };
}

export async function loadSupplementDir(supDir) {
  const releaseDir = path.join(supDir, 'release');
  const canonicalDir = path.join(supDir, 'canonical');
  // Prefer a release JSON that exists.
  const fs = await import('node:fs/promises');
  const releaseFiles = (await fs.readdir(releaseDir)).filter(n => n.endsWith('.json')).sort();
  if (releaseFiles.length === 0) throw new Error(`no release JSON in ${releaseDir}`);
  const releaseDoc = JSON.parse(await readFile(path.join(releaseDir, releaseFiles[0]), 'utf8'));
  if (releaseDoc.artifact_kind !== 'registry_supplement') {
    throw new Error(`${releaseFiles[0]}: artifact_kind must be registry_supplement`);
  }
  const manifestPath = path.join(canonicalDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const observedManifestSha = await fileSha256(manifestPath);
  if (releaseDoc.supplement_registry_manifest_sha256 !== observedManifestSha) {
    throw new Error(`supplement_registry_manifest_sha256 mismatch for ${releaseDoc.supplement_release_id}`);
  }

  // Read every shard, produce external_mappings the schema can consume.
  const external_mappings = [];
  for (const shard of manifest.shards) {
    const shardPath = path.join(canonicalDir, shard.name);
    const observedShardSha = await fileSha256(shardPath);
    if (observedShardSha !== shard.sha256) {
      throw new Error(`shard ${shard.name} sha256 mismatch (disk=${observedShardSha}, manifest=${shard.sha256})`);
    }
    const text = await readFile(shardPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const doc = JSON.parse(trimmed);
      if (doc.__registry_header__) continue;
      external_mappings.push({
        source_system: doc.source,
        namespace: doc.namespace,
        external_id: doc.identifier,
        sporely_taxon_id: doc.sporely_taxon_id,
        canonical_name: null, // supplements don't ship canonical names
        rank: null,
        scope_state: 'not_evaluated',
        cache_state: 'out_of_cache',
      });
    }
  }
  return {
    release_id: releaseDoc.supplement_release_id,
    base_release_id: releaseDoc.base_release_id,
    supplement_contract_version: releaseDoc.supplement_contract_version,
    supplement_shard_sha256: releaseDoc.supplement_shard_sha256,
    supplement_registry_manifest_sha256: releaseDoc.supplement_registry_manifest_sha256,
    depends_on: (releaseDoc.depends_on || []).map(d => d.supplement_release_id),
    external_mappings,
  };
}

// W3-A2: verifyManifest recomputes the semantic SHA-256 from the manifest
// body and enforces every structural invariant BEFORE the SQL is prepared.
// Fails closed on: SHA mismatch, count mismatch, duplicate observation_id,
// aggregate-state totals disagreeing with actual record states, resolved
// records with null target, unresolved records with non-null target.
export function verifyManifest(rawText, expectedSha) {
  const doc = JSON.parse(rawText);
  const computedSha = computeSemanticSha256(doc);
  if (expectedSha && computedSha !== expectedSha) {
    throw new Error(`W3-A2 manifest sha mismatch: declared=${expectedSha}, recomputed=${computedSha}`);
  }
  const records = doc.records || [];
  if (typeof doc.record_count !== 'number' || doc.record_count !== records.length) {
    throw new Error(`W3-A2 manifest record_count=${doc.record_count} but records.length=${records.length}`);
  }
  const seen = new Set();
  const stateCounts = {};
  for (const r of records) {
    if (typeof r.observation_id !== 'string' || !r.observation_id) {
      throw new Error('W3-A2 manifest record missing observation_id');
    }
    if (seen.has(r.observation_id)) {
      throw new Error(`W3-A2 manifest has duplicate observation_id=${r.observation_id}`);
    }
    seen.add(r.observation_id);
    stateCounts[r.reconciliation_state] = (stateCounts[r.reconciliation_state] || 0) + 1;
    const resolvedTarget = r.resolved_sporely_taxon_id;
    if (r.reconciliation_state === 'resolved_exact' || r.reconciliation_state === 'resolved_exact_via_legacy_mapping' || r.reconciliation_state === 'resolved_exact_via_synonym_relationship') {
      if (resolvedTarget == null || !Number.isFinite(Number(resolvedTarget))) {
        throw new Error(`W3-A2 resolved record ${r.observation_id} missing valid target id`);
      }
    } else {
      if (resolvedTarget != null) {
        throw new Error(`W3-A2 unresolved record ${r.observation_id} has non-null target id (${resolvedTarget})`);
      }
    }
  }
  const aggregate = doc.aggregate_counts || {};
  for (const [state, expected] of Object.entries(aggregate)) {
    const actual = stateCounts[state] || 0;
    if (actual !== expected) {
      throw new Error(`W3-A2 aggregate_counts.${state} declared=${expected}, actual=${actual}`);
    }
  }
  return { doc, computedSha };
}

async function loadManifest(mfPath) {
  const rawText = await readFile(mfPath, 'utf8');
  const inputSha = createHash('sha256').update(rawText, 'utf8').digest('hex');
  const declaredSha = (await readFile(`${mfPath}.sha256.txt`, 'utf8').catch(() => '')).trim();
  const { doc, computedSha } = verifyManifest(rawText, declaredSha || undefined);
  return {
    semantic_sha256: computedSha,
    input_file_sha256: inputSha,
    record_count: doc.record_count,
    aggregate_counts: doc.aggregate_counts || null,
    records: doc.records || [],
  };
}

export async function ensureSchema(target, { observationsIntegration } = {}) {
  const sql = await readFile(SCHEMA_SQL, 'utf8');
  await queryStdin(target, sql);
  if (observationsIntegration) {
    // If public.observations doesn't exist in the local stack, we materialise
    // a minimal shim table for rehearsal purposes.
    const hasObs = (await query(target, "select case when to_regclass('public.observations') is null then 'no' else 'yes' end")).trim();
    if (hasObs !== 'yes') {
      await query(target, 'create table public.observations (id bigint primary key, genus text, species text, common_name text, artsdata_id integer, artportalen_id integer, inaturalist_id integer)');
    }
    const obsSql = await readFile(OBS_INTEGRATION_SQL, 'utf8');
    await queryStdin(target, obsSql);
  }
}

export async function installChain(target, base, supplements, manifest) {
  const sql = `select taxonomy_v3.install_release_chain(${sqlLiteral(JSON.stringify(base))}::jsonb, ${sqlLiteral(JSON.stringify(supplements))}::jsonb, ${sqlLiteral(JSON.stringify(manifest))}::jsonb)::text`;
  const raw = sql.length > 100_000
    ? await queryStdin(target, sql)
    : await query(target, sql);
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const out = { supplements: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--supplement') out.supplements.push(argv[++i]);
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--observations-integration') out.observationsIntegration = true;
    else if (a === '--production') out.production = true;
    else if (a === '--twice') out.twice = true;
    else if (a === '--rollback-simulate') out.rollbackSimulate = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: install-release-chain.mjs --base <dir> [--supplement <dir> ...] --manifest <path> [--observations-integration] [--twice] [--rollback-simulate]');
    process.exit(0);
  }
  if (args.production) {
    console.error('refuse: --production is not honoured; local disposable rehearsal only');
    process.exit(3);
  }
  if (!args.base || !args.manifest) {
    console.error('missing --base or --manifest');
    process.exit(2);
  }
  const target = await discoverLocalTarget(REPO_ROOT);
  await ensureSchema(target, { observationsIntegration: args.observationsIntegration });

  const base = await loadBase(args.base);
  const supplements = [];
  for (const s of args.supplements) supplements.push(await loadSupplementDir(s));
  let manifest = await loadManifest(args.manifest);

  if (args.rollbackSimulate) {
    manifest = { ...manifest, records: [...manifest.records, { observation_id: '__rollback_forced__', reconciliation_state: 'invalid_or_unnamespaced_identifier' }] };
    // The schema's installer doesn't have an explicit rollback hook — a
    // constraint violation from an invented external_mapping conflict is
    // used instead. Inject a clashing tuple.
    const firstSup = supplements[0];
    if (firstSup?.external_mappings?.[0]) {
      const clash = { ...firstSup.external_mappings[0], sporely_taxon_id: firstSup.external_mappings[0].sporely_taxon_id + 99999 };
      supplements.push({
        release_id: 'rollback-forced-supp',
        base_release_id: base.release_id,
        supplement_contract_version: 'supplement-contract-1.0.0',
        supplement_shard_sha256: 'de'.repeat(32),
        supplement_registry_manifest_sha256: 'ad'.repeat(32),
        depends_on: [],
        external_mappings: [clash],
      });
    }
    try {
      const beforeCounts = await counts(target);
      await installChain(target, base, supplements, manifest);
      console.error('rollback-simulate: expected failure did not occur');
      process.exit(1);
    } catch (e) {
      const after = await counts(target);
      console.log(JSON.stringify({ ok: false, error: String(e.message), zero_orphan_rows: after.every === 0, counts_after: after }, null, 2));
    }
    return;
  }

  const first = await installChain(target, base, supplements, manifest);
  if (args.twice) {
    const second = await installChain(target, base, supplements, manifest);
    console.log(JSON.stringify({ first, second, idempotent: JSON.stringify(first) === JSON.stringify(second) }, null, 2));
  } else {
    console.log(JSON.stringify(first, null, 2));
  }
}

export async function counts(target) {
  const raw = await query(target, `select json_build_object(
    'registry_concept',(select count(*) from taxonomy_v3.registry_concept),
    'external_mapping',(select count(*) from taxonomy_v3.external_mapping),
    'identification_snapshot',(select count(*) from taxonomy_v3.identification_snapshot),
    'resolution_link',(select count(*) from taxonomy_v3.resolution_link),
    'release_installation',(select count(*) from taxonomy_v3.release_installation),
    'supplement_installation',(select count(*) from taxonomy_v3.supplement_installation),
    'reconciliation_manifest_audit',(select count(*) from taxonomy_v3.reconciliation_manifest_audit))::text`);
  return JSON.parse(raw);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err.stack || err); process.exit(1); });
}
