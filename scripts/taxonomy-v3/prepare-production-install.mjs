#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBase, loadSupplementDir, verifyManifest } from './install-release-chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PROJECT_REF = 'zkpjklzfwzefhjluvhfw';
const RELEASE_ORDER = ['tax-2026.08.01-01', 'tax-2026.08.02-02', 'tax-2026.08.03-02'];
const EXPECTED_DRIFT = { no_drift: 367, approved_drift: 2, unapproved_drift: 0, observation_missing: 0 };
const EXPECTED_STATES = { manual_unresolved: 7, no_identity_evidence: 30, resolved_exact: 311, unresolved_external_identifier: 21 };
const FROZEN_PRIVATE_HASHES = {
  reconciliation_raw_sha256: '97bd7b19c346e1348e7b9a30a5641bc95760d77a8679d5b14fdaf83ffc4abe58',
  reconciliation_source_semantic_sha256: '9eb322c83e644d5ed72391f19c1abbf728c4afed6fcfeb426f7e993fc6b44d0b',
  deployment_manifest_raw_sha256: '871dd507f3bfa201d721170f0363960f1472b45b149aa2c5d9ab9259ff62acf9',
  deployment_raw_export_sha256: '8efbedfaedb3fea94c6d5ebcc4b80eb65c04e535f8b27649dfdcf353e40b17e4',
  approved_drift_raw_sha256: '2d2eda657ce6e3b0df94478be10adfb29a773c0f89d511f270dc824e42ea91ef',
  current_observations_raw_sha256: '8df0aacf274c161f2ec057a02e7b616e1f9876f2c6891a6955ae168c2e20df37',
};
const TAXONOMY_FIELDS = [
  'artsdata_id', 'artportalen_id', 'inaturalist_id', 'mushroomobserver_id', 'desktop_id',
  'ai_selected_service', 'ai_selected_taxon_id', 'ai_selected_scientific_name',
  'genus', 'species', 'common_name', 'species_guess',
];

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function fileSha256(file) {
  return sha256(await readFile(file));
}

function assert(condition, message) {
  if (!condition) throw new Error(`refuse: ${message}`);
}

function equalObjects(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  assert(!quoted, 'current-observations CSV has an unterminated quoted field');
  const header = rows.shift() || [];
  assert(header.length > 0, 'current-observations CSV has no header');
  return rows.filter(r => r.some(v => v !== '')).map(values => Object.fromEntries(header.map((key, i) => [key, values[i] ?? ''])));
}

function normalise(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' || text.toUpperCase() === 'NULL' ? null : text;
}

function taxonomyFingerprint(row) {
  const canonical = `{${[...TAXONOMY_FIELDS].sort()
    .map(key => `${JSON.stringify(key)}: ${JSON.stringify(row[key] || '')}`)
    .join(', ')}}`;
  return sha256(canonical);
}

function sqlJson(value, tag) {
  const json = JSON.stringify(value);
  assert(!json.includes(`$${tag}$`), `payload unexpectedly contains SQL dollar-quote tag ${tag}`);
  return `$${tag}$${json}$${tag}$::jsonb`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function verifySupplement(directory) {
  const supplement = await loadSupplementDir(directory);
  const releaseDir = path.join(directory, 'release');
  const releaseFiles = (await readdir(releaseDir)).filter(name => name.endsWith('.json')).sort();
  assert(releaseFiles.length === 1, `${directory} must contain exactly one release JSON`);
  const releasePath = path.join(releaseDir, releaseFiles[0]);
  const releaseRaw = await readFile(releasePath);
  const release = JSON.parse(releaseRaw);
  const externalPath = path.join(releaseDir, 'taxon_external_id_supplement.jsonl');
  const sidecarPath = `${externalPath.replace(/\.jsonl$/, '')}.sha256.txt`;
  const externalSha = await fileSha256(externalPath);
  const sidecarSha = (await readFile(sidecarPath, 'utf8')).trim();
  assert(externalSha === sidecarSha, `${directory} external-ID sidecar hash mismatch`);
  assert(externalSha === release.supplement_external_id_sha256, `${directory} release external-ID hash mismatch`);
  const canonicalManifestPath = path.join(directory, 'canonical', 'manifest.json');
  const canonicalManifestSha = await fileSha256(canonicalManifestPath);
  assert(canonicalManifestSha === release.supplement_registry_manifest_sha256, `${directory} canonical manifest hash mismatch`);
  return {
    supplement,
    release,
    hashes: {
      release_json_raw_sha256: sha256(releaseRaw),
      supplement_external_id_sha256: externalSha,
      supplement_registry_manifest_raw_sha256: canonicalManifestSha,
      supplement_shard_sha256: release.supplement_shard_sha256,
    },
  };
}

async function validateInputs(options) {
  const base = await loadBase(options.baseRelease);
  assert(base.release_id === RELEASE_ORDER[0], `base release must be ${RELEASE_ORDER[0]}`);
  const supplementsVerified = [];
  for (const directory of options.supplements) supplementsVerified.push(await verifySupplement(directory));
  const supplements = supplementsVerified.map(value => value.supplement);
  assert(supplements.length === 2, 'exactly two supplements are required');
  equalObjects([base.release_id, ...supplements.map(value => value.release_id)], RELEASE_ORDER, 'release order');
  equalObjects(supplements[0].depends_on, [], 'first supplement dependencies');
  equalObjects(supplements[1].depends_on, [supplements[0].release_id], 'second supplement dependencies');
  for (const verified of supplementsVerified) {
    assert(verified.release.base_release_dependency?.base_release_id === base.release_id, `${verified.supplement.release_id} base-release dependency ID mismatch`);
    assert(verified.release.base_release_dependency.base_release_export_manifest_sha256 === base.export_manifest_sha256, `${verified.supplement.release_id} base export-manifest hash mismatch`);
    assert(verified.release.base_release_dependency.base_release_scope_manifest_sha256 === base.scope_manifest_sha256, `${verified.supplement.release_id} base scope-manifest hash mismatch`);
  }
  const dependency = supplementsVerified[1].release.depends_on?.[0];
  assert(dependency?.supplement_release_id === supplements[0].release_id, 'second supplement dependency release mismatch');
  assert(dependency.supplement_shard_sha256 === supplements[0].supplement_shard_sha256, 'second supplement dependency shard hash mismatch');
  assert(dependency.supplement_registry_manifest_sha256 === supplements[0].supplement_registry_manifest_sha256, 'second supplement dependency registry hash mismatch');
  assert(dependency.supplement_external_id_sha256 === supplementsVerified[0].hashes.supplement_external_id_sha256, 'second supplement dependency external-ID hash mismatch');

  const reconciliationRaw = await readFile(options.reconciliation);
  const reconciliationRawSha = sha256(reconciliationRaw);
  assert(reconciliationRawSha === FROZEN_PRIVATE_HASHES.reconciliation_raw_sha256, 'reconciliation raw file SHA-256 is not the frozen W3-B input');
  const reconciliationSidecar = options.reconciliation.replace(/\.json$/, '.sha256.txt');
  const declaredReconciliationSha = (await readFile(reconciliationSidecar, 'utf8')).trim();
  assert(reconciliationRawSha === declaredReconciliationSha, 'reconciliation raw file SHA-256 does not match sidecar');
  const { doc: reconciliation, computedSha } = verifyManifest(reconciliationRaw.toString('utf8'), declaredReconciliationSha);
  assert(computedSha === reconciliationRawSha, 'reconciliation semantic-content verification mismatch');
  assert(reconciliation.record_count === 369, 'reconciliation must contain 369 records');
  equalObjects(reconciliation.aggregate_counts, EXPECTED_STATES, 'reconciliation state counts');

  const deploymentRaw = await readFile(options.deploymentManifest);
  const deploymentRawSha = sha256(deploymentRaw);
  assert(deploymentRawSha === FROZEN_PRIVATE_HASHES.deployment_manifest_raw_sha256, 'deployment manifest raw SHA-256 is not the frozen drift-checked input');
  const deploymentLines = deploymentRaw.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`refuse: deployment manifest line ${index + 1} is invalid JSON: ${error.message}`); }
  });
  assert(deploymentLines.length === 370, 'deployment manifest must contain one header plus 369 records');
  const [deploymentHeader, ...deployment] = deploymentLines;
  assert(deploymentHeader.__deployment_manifest_header__ === true, 'deployment manifest header is missing');
  assert(deploymentHeader.record_count === 369, 'deployment manifest header record_count must be 369');
  assert(deploymentHeader.manifest_input_file_sha256 === reconciliationRawSha, 'deployment header reconciliation input-file hash mismatch');
  assert(deploymentHeader.manifest_semantic_sha256 === reconciliation.input_source_hash, 'deployment header reconciliation source semantic hash mismatch');
  assert(deploymentHeader.manifest_semantic_sha256 === FROZEN_PRIVATE_HASHES.reconciliation_source_semantic_sha256, 'reconciliation source semantic SHA-256 is not frozen');
  assert(deploymentHeader.raw_export_sha256 === FROZEN_PRIVATE_HASHES.deployment_raw_export_sha256, 'deployment raw-export SHA-256 is not frozen');

  const pseudonyms = reconciliation.records.map(record => record.observation_id);
  const deploymentPseudonyms = deployment.map(record => record.pseudonymous_observation_id);
  const realIds = deployment.map(record => String(record.real_observation_id));
  assert(new Set(pseudonyms).size === 369, 'duplicate reconciliation pseudonyms detected');
  assert(new Set(deploymentPseudonyms).size === 369, 'duplicate deployment pseudonyms detected');
  assert(new Set(realIds).size === 369, 'duplicate real observation IDs detected');
  for (const id of realIds) assert(/^[1-9][0-9]*$/.test(id) && BigInt(id) <= 9223372036854775807n, 'real observation ID is not a positive bigint');
  const bridge = new Map(deployment.map(record => [record.pseudonymous_observation_id, record]));
  assert(pseudonyms.every(id => bridge.has(id)), 'deployment manifest has unmatched reconciliation pseudonyms');
  assert(deploymentPseudonyms.every(id => pseudonyms.includes(id)), 'deployment manifest has unmatched deployment pseudonyms');

  const reconciliationByPseudonym = new Map(reconciliation.records.map(record => [record.observation_id, record]));
  for (const deploymentRecord of deployment) {
    const record = reconciliationByPseudonym.get(deploymentRecord.pseudonymous_observation_id);
    for (const key of ['reconciliation_state', 'resolved_sporely_taxon_id', 'resolution_method', 'resolution_release']) {
      assert((record[key] ?? null) === (deploymentRecord[key] ?? null), `deployment bridge disagrees with reconciliation field ${key}`);
    }
  }

  const currentRaw = await readFile(options.currentObservations);
  assert(sha256(currentRaw) === FROZEN_PRIVATE_HASHES.current_observations_raw_sha256, 'current-observations raw SHA-256 is not frozen');
  const currentRows = parseCsv(currentRaw.toString('utf8'));
  const currentById = new Map();
  for (const row of currentRows) {
    const id = String(row.id).trim();
    assert(id && !currentById.has(id), 'current-observations CSV contains a duplicate or empty ID');
    currentById.set(id, row);
  }
  const approvalsRaw = await readFile(options.approvedDrift);
  assert(sha256(approvalsRaw) === FROZEN_PRIVATE_HASHES.approved_drift_raw_sha256, 'approved-drift raw SHA-256 is not frozen');
  const approvals = JSON.parse(approvalsRaw);
  assert(Array.isArray(approvals) && approvals.length === 2, 'approved-drift file must contain exactly two approvals');
  const approvalsById = new Map();
  for (const approval of approvals) {
    const id = String(approval.real_observation_id);
    assert(approval.decision === 'approved_non_identity_drift', 'approved-drift decision is invalid');
    assert(TAXONOMY_FIELDS.includes(approval.field), 'approved-drift field is not a legacy taxonomy field');
    assert(!approvalsById.has(id), 'multiple approvals for one observation are not expected');
    approvalsById.set(id, approval);
  }

  const driftCounts = { no_drift: 0, approved_drift: 0, unapproved_drift: 0, observation_missing: 0 };
  for (const deploymentRecord of deployment) {
    const id = String(deploymentRecord.real_observation_id);
    const current = currentById.get(id);
    let computedStatus;
    if (!current) computedStatus = 'observation_missing';
    else if (taxonomyFingerprint(current) === deploymentRecord.taxonomy_field_fingerprint_at_export) computedStatus = 'no_drift';
    else {
      const approval = approvalsById.get(id);
      if (!approval || normalise(current[approval.field]) !== normalise(approval.current_value)) computedStatus = 'unapproved_drift';
      else computedStatus = 'approved_drift';
    }
    assert(computedStatus === deploymentRecord.drift_status, `deployment drift status mismatch for a bridged observation`);
    driftCounts[computedStatus]++;
  }
  equalObjects(driftCounts, EXPECTED_DRIFT, 'drift counts');
  assert([...approvalsById.keys()].every(id => deployment.some(record => String(record.real_observation_id) === id && record.drift_status === 'approved_drift')), 'an approved-drift entry was unused');

  const records = reconciliation.records.map(record => {
    const deploymentRecord = bridge.get(record.observation_id);
    return {
      observation_id: String(deploymentRecord.real_observation_id),
      original_scientific_name: record.original_scientific_name ?? null,
      original_vernacular_name: record.original_vernacular_name ?? null,
      original_rank: record.original_rank ?? null,
      original_legacy_taxon_id: record.original_legacy_taxon_id ?? null,
      original_source_system: record.original_source_system ?? null,
      original_source_namespace: record.original_source_namespace ?? null,
      original_external_id: record.original_external_id ?? null,
      signals_all: record.signals_all ?? [],
      resolved_sporely_taxon_id: record.resolved_sporely_taxon_id ?? null,
      resolved_canonical_name: record.resolved_canonical_name ?? null,
      resolved_rank: record.resolved_rank ?? null,
      resolved_scope_state: record.resolved_scope_state ?? null,
      resolved_cache_state: record.resolved_cache_state ?? null,
      reconciliation_state: record.reconciliation_state,
      resolution_method: record.resolution_method ?? null,
      resolution_evidence: record.resolution_evidence ?? [],
      resolution_release: record.resolution_release ?? null,
    };
  });
  assert(records.every(record => !record.observation_id.startsWith('obs_')), 'pseudonym remained as a database observation_id');
  const realReconciliation = {
    semantic_sha256: reconciliationRawSha,
    input_file_sha256: reconciliationRawSha,
    record_count: 369,
    aggregate_counts: reconciliation.aggregate_counts,
    records,
  };

  return {
    base, supplements, realReconciliation, realIds,
    hashes: {
      base_export_manifest_raw_sha256: base.export_manifest_sha256,
      base_scope_manifest_sha256: base.scope_manifest_sha256,
      base_files: base.per_file_verifications,
      supplements: supplementsVerified.map(value => ({ release_id: value.supplement.release_id, ...value.hashes })),
      reconciliation_raw_sha256: reconciliationRawSha,
      reconciliation_source_semantic_sha256: reconciliation.input_source_hash,
      deployment_manifest_raw_sha256: deploymentRawSha,
      deployment_raw_export_sha256: deploymentHeader.raw_export_sha256,
      approved_drift_raw_sha256: sha256(approvalsRaw),
      current_observations_raw_sha256: sha256(currentRaw),
    },
    driftCounts,
  };
}

function generateSql(validated) {
  const ids = validated.realIds.join(',');
  const tag = `taxonomy_v3_${sha256(JSON.stringify(validated.realReconciliation)).slice(0, 16)}`;
  const legacyJson = `jsonb_build_object(${TAXONOMY_FIELDS.map(field => `'${field}', o.${field}`).join(', ')})`;
  return `\\set ON_ERROR_STOP on
BEGIN;

-- PRIVATE PRODUCTION DATA
-- DO NOT COMMIT
-- PROJECT REF: ${PROJECT_REF}
-- Generated locally. Execute only after independently verifying this file's SHA-256.

DO $preflight$
DECLARE
  v_ids bigint[] := ARRAY[${ids}]::bigint[];
  v_expected integer := 369;
BEGIN
  IF cardinality(v_ids) <> v_expected OR (SELECT count(DISTINCT id) FROM unnest(v_ids) id) <> v_expected THEN
    RAISE EXCEPTION 'taxonomy-v3 preflight: expected 369 distinct real observation IDs';
  END IF;
  IF (SELECT count(*) FROM public.observations WHERE id = ANY(v_ids)) <> v_expected THEN
    RAISE EXCEPTION 'taxonomy-v3 preflight: one or more production observations are missing';
  END IF;
  IF (SELECT count(*) FROM public.observations WHERE id = ANY(v_ids) AND resolved_sporely_taxon_id IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'taxonomy-v3 preflight: one or more canonical observation links are already non-NULL';
  END IF;
  IF (SELECT count(*) FROM taxonomy_v3.registry_concept) <> 0
     OR (SELECT count(*) FROM taxonomy_v3.external_mapping) <> 0
     OR (SELECT count(*) FROM taxonomy_v3.identification_snapshot) <> 0
     OR (SELECT count(*) FROM taxonomy_v3.resolution_link) <> 0
     OR (SELECT count(*) FROM taxonomy_v3.release_installation) <> 0
     OR (SELECT count(*) FROM taxonomy_v3.supplement_installation) <> 0
     OR (SELECT count(*) FROM taxonomy_v3.reconciliation_manifest_audit) <> 0 THEN
    RAISE EXCEPTION 'taxonomy-v3 preflight: installation tables are not empty';
  END IF;
END
$preflight$;

CREATE TEMP TABLE taxonomy_v3_legacy_fingerprint ON COMMIT DROP AS
SELECT o.id AS observation_id, ${legacyJson} AS fingerprint
  FROM public.observations o
 WHERE o.id = ANY(ARRAY[${ids}]::bigint[]);

SELECT taxonomy_v3.install_release_chain(
  ${sqlJson(validated.base, `${tag}_base`)},
  ${sqlJson(validated.supplements, `${tag}_supplements`)},
  ${sqlJson(validated.realReconciliation, `${tag}_reconciliation`)}
);

DO $installed$
BEGIN
  IF (SELECT count(*) FROM taxonomy_v3.release_installation) <> 3 THEN RAISE EXCEPTION 'expected release_installation=3'; END IF;
  IF (SELECT count(*) FROM taxonomy_v3.supplement_installation) <> 1 THEN RAISE EXCEPTION 'expected supplement_installation=1'; END IF;
  IF (SELECT count(*) FROM taxonomy_v3.registry_concept) <> 194 THEN RAISE EXCEPTION 'expected registry_concept=194'; END IF;
  IF (SELECT count(*) FROM taxonomy_v3.external_mapping) <> 145 THEN RAISE EXCEPTION 'expected external_mapping=145'; END IF;
  IF (SELECT count(*) FROM taxonomy_v3.identification_snapshot) <> 369 THEN RAISE EXCEPTION 'expected identification_snapshot=369'; END IF;
  IF (SELECT count(*) FROM taxonomy_v3.resolution_link) <> 369 THEN RAISE EXCEPTION 'expected resolution_link=369'; END IF;
  IF (SELECT count(*) FROM taxonomy_v3.resolution_link WHERE resolved_sporely_taxon_id IS NOT NULL) <> 311 THEN RAISE EXCEPTION 'expected resolved resolution rows=311'; END IF;
  IF (SELECT count(*) FROM taxonomy_v3.resolution_link WHERE resolved_sporely_taxon_id IS NULL) <> 58 THEN RAISE EXCEPTION 'expected NULL resolution rows=58'; END IF;
  IF (SELECT count(*) FROM taxonomy_v3.reconciliation_manifest_audit) <> 1 THEN RAISE EXCEPTION 'expected reconciliation_manifest_audit=1'; END IF;
END
$installed$;

DO $link$
DECLARE v_linked integer;
BEGIN
  SELECT taxonomy_v3.link_observations_to_resolution() INTO v_linked;
  IF v_linked <> 311 THEN RAISE EXCEPTION 'expected first-run linked observations=311, got %', v_linked; END IF;
END
$link$;

DO $final$
BEGIN
  IF (SELECT count(*) FROM public.observations WHERE id = ANY(ARRAY[${ids}]::bigint[]) AND resolved_sporely_taxon_id IS NOT NULL) <> 311 THEN
    RAISE EXCEPTION 'expected 311 observations with non-NULL canonical links';
  END IF;
  IF (SELECT count(*) FROM public.observations WHERE id = ANY(ARRAY[${ids}]::bigint[]) AND resolved_sporely_taxon_id IS NULL) <> 58 THEN
    RAISE EXCEPTION 'expected 58 observations with NULL canonical links';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM taxonomy_v3_legacy_fingerprint before
      JOIN public.observations o ON o.id = before.observation_id
     WHERE before.fingerprint IS DISTINCT FROM ${legacyJson.replaceAll('o.', 'o.')}
  ) THEN
    RAISE EXCEPTION 'legacy taxonomy fingerprint changed during taxonomy-v3 installation';
  END IF;
END
$final$;

COMMIT;
`;
}

export async function prepareProductionInstall(options) {
  for (const required of ['baseRelease', 'reconciliation', 'deploymentManifest', 'approvedDrift', 'currentObservations', 'output']) {
    assert(options[required], `missing required option ${required}`);
  }
  assert(Array.isArray(options.supplements), 'supplements must be an array');
  const output = path.resolve(options.output);
  assert(!output.startsWith(`${REPO_ROOT}${path.sep}`), 'generated SQL must remain outside the repository');
  assert(!output.endsWith(path.sep), 'output must be a file path');
  const validated = await validateInputs({ ...options, output });
  const sql = generateSql(validated);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, sql, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await chmod(output, 0o600);
  const outputSha256 = sha256(sql);
  const containerCommand = `docker run --rm --env-file /path/to/private/production-db.env -v ${shellQuote(`${path.dirname(output)}:/payload:ro`)} postgres:17 sh -c 'psql "$DATABASE_URL" --file=/payload/${path.basename(output)}'`;
  return {
    output_path: output,
    output_sha256: outputSha256,
    verified_input_hashes: validated.hashes,
    bridge_counts: { reconciliation_records: 369, deployment_records: 369, matched_pseudonyms: 369, duplicate_pseudonyms: 0, duplicate_real_ids: 0, unmatched_records: 0 },
    drift_counts: validated.driftCounts,
    expected_counts: { release_installation: 3, supplement_installation: 1, registry_concept: 194, external_mapping: 145, identification_snapshot: 369, resolution_link: 369, resolved_resolution_rows: 311, null_resolution_rows: 58, reconciliation_manifest_audit: 1, linked_observations: 311, null_observations: 58 },
    containerised_psql_command: containerCommand,
  };
}

function parseArgs(argv) {
  const options = { supplements: [] };
  const names = new Map([
    ['--base-release', 'baseRelease'], ['--reconciliation', 'reconciliation'],
    ['--deployment-manifest', 'deploymentManifest'], ['--approved-drift', 'approvedDrift'],
    ['--current-observations', 'currentObservations'], ['--output', 'output'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--supplement') options.supplements.push(argv[++i]);
    else if (names.has(arg)) options[names.get(arg)] = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node scripts/taxonomy-v3/prepare-production-install.mjs --base-release <dir> --supplement <dir> --supplement <dir> --reconciliation <json> --deployment-manifest <jsonl> --approved-drift <json> --current-observations <csv> --output <sql>');
    return;
  }
  const summary = await prepareProductionInstall(options);
  console.log(`output path: ${summary.output_path}`);
  console.log(`output SHA-256: ${summary.output_sha256}`);
  console.log(`verified input hashes: ${JSON.stringify(summary.verified_input_hashes, null, 2)}`);
  console.log(`expected counts: ${JSON.stringify(summary.expected_counts)}`);
  console.log(`containerised psql command: ${summary.containerised_psql_command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
