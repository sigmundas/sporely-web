#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_REF = 'zkpjklzfwzefhjluvhfw';
const TARGET_RELEASE = 'tax-2026.08.01-01';
const IMPORTER_VERSION = 'taxonomy-v2-production-payload-1';
const IMPORT_ADVISORY_LOCK = '846920026072413003';
const DATASET_FILES = [
  'taxonomy_release.jsonl',
  'taxon.jsonl',
  'scientific_name.jsonl',
  'vernacular.jsonl',
  'taxon_external_id.jsonl',
  'taxon_external_id_legacy_integer.jsonl',
  'taxon_redlist.jsonl',
];
const TABLE_FILES = DATASET_FILES.slice(1);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sqlText = value => `'${String(value).replaceAll("'", "''")}'`;
const sqlJson = value => `${sqlText(JSON.stringify(value))}::jsonb`;

function assert(condition, message) {
  if (!condition) throw new Error(`refuse: ${message}`);
}

function countMap(rows, keyFn) {
  const result = {};
  for (const row of rows) {
    const key = keyFn(row);
    result[key] = (result[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function wholeExportSha(files) {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(`${Buffer.byteLength(file.name)}:${file.name}:${file.bytes.length}:`);
    digest.update(file.bytes);
    digest.update('\n');
  }
  return digest.digest('hex');
}

function chooseProbes(data) {
  const taxa = new Map(data['taxon.jsonl'].map(row => [row.taxon_id, row]));
  const external = data['taxon_external_id.jsonl'];
  const colByTaxon = new Map();
  const nortaxaByTaxon = new Map();
  for (const row of external) {
    if (row.source_system === 'col_xr' && row.namespace === 'col_usage_id' && !colByTaxon.has(row.taxon_id)) colByTaxon.set(row.taxon_id, row.external_id);
    if (row.source_system === 'nortaxa' && row.namespace === 'nortaxa_taxon_id' && !nortaxaByTaxon.has(row.taxon_id)) nortaxaByTaxon.set(row.taxon_id, row.external_id);
  }
  const orderedTaxa = [...taxa.values()].filter(row => row.canonical_scientific_name?.length >= 2)
    .sort((a, b) => a.canonical_scientific_name.localeCompare(b.canonical_scientific_name) || a.taxon_id - b.taxon_id);
  const colOnly = orderedTaxa.find(row => colByTaxon.has(row.taxon_id) && !nortaxaByTaxon.has(row.taxon_id));
  const nortaxaName = data['scientific_name.jsonl']
    .filter(row => row.source === 'nortaxa' && row.scientific_name?.length >= 2 && taxa.has(row.taxon_id))
    .sort((a, b) => a.scientific_name.localeCompare(b.scientific_name) || a.taxon_id - b.taxon_id)[0];
  const genus = orderedTaxa.find(row => row.taxon_rank === 'genus');
  const alias = data['scientific_name.jsonl']
    .filter(row => !row.is_preferred_name && row.scientific_name?.length >= 2 && taxa.has(row.taxon_id)
      && row.scientific_name !== taxa.get(row.taxon_id).canonical_scientific_name)
    .sort((a, b) => a.scientific_name.localeCompare(b.scientific_name) || a.taxon_id - b.taxon_id)[0];
  const vernacular = data['vernacular.jsonl']
    .filter(row => row.vernacular_name?.length >= 2 && ['nb', 'nn', 'no'].includes(row.language_code) && taxa.has(row.taxon_id))
    .sort((a, b) => a.vernacular_name.localeCompare(b.vernacular_name) || a.taxon_id - b.taxon_id)[0];
  assert(colOnly && nortaxaName && genus && alias && vernacular, 'release does not contain every required representative search probe');
  return {
    colOnly: { query: colOnly.canonical_scientific_name, taxonId: colOnly.taxon_id, colUsageId: colByTaxon.get(colOnly.taxon_id) },
    nortaxa: { query: nortaxaName.scientific_name, taxonId: nortaxaName.taxon_id },
    alias: { query: alias.scientific_name, taxonId: alias.taxon_id },
    genus: { query: genus.canonical_scientific_name, taxonId: genus.taxon_id },
    vernacular: { query: vernacular.vernacular_name, language: vernacular.language_code, taxonId: vernacular.taxon_id },
  };
}

async function verifyRelease(releaseDirectory) {
  const root = await realpath(releaseDirectory);
  const manifestPath = path.join(root, 'taxonomy_export_manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert(manifest.format === 'sporely-global-macrofungi-export-v1', 'unexpected export format');
  assert(manifest.release_id === TARGET_RELEASE, `release ID must be ${TARGET_RELEASE}`);
  assert(Array.isArray(manifest.files), 'export manifest files must be an array');
  assert(manifest.files.map(entry => entry.name).join('\0') === DATASET_FILES.join('\0'), 'manifest dataset order is incompatible');
  assert(new Set(manifest.files.map(entry => entry.name)).size === DATASET_FILES.length, 'manifest contains duplicate dataset names');

  const files = [];
  const data = {};
  for (const entry of manifest.files) {
    const filePath = path.join(root, entry.name);
    assert(await realpath(filePath) === filePath, `${entry.name} is not a direct regular release file`);
    const info = await stat(filePath);
    assert(info.isFile() && info.size === entry.bytes, `${entry.name} byte count does not match manifest`);
    const bytes = await readFile(filePath);
    assert(sha256(bytes) === entry.sha256, `${entry.name} SHA-256 mismatch`);
    const lines = bytes.toString('utf8').split('\n').filter(Boolean);
    assert(lines.length === entry.row_count, `${entry.name} row count does not match manifest`);
    data[entry.name] = lines.map((line, index) => {
      try { return JSON.parse(line); } catch (error) { throw new Error(`refuse: ${entry.name}:${index + 1} invalid JSON: ${error.message}`); }
    });
    files.push({ name: entry.name, path: filePath, bytes, row_count: entry.row_count, sha256: entry.sha256 });
  }

  assert(data['taxonomy_release.jsonl'].length === 1, 'taxonomy_release.jsonl must contain exactly one row');
  const releaseMetadata = data['taxonomy_release.jsonl'][0];
  assert(releaseMetadata.content_release_id === TARGET_RELEASE, 'release metadata ID mismatch');
  assert(releaseMetadata.taxonomy_schema_version === 2, 'taxonomy schema version must be 2');
  assert(releaseMetadata.scope_predicate_id === 'global_macrofungi_policy_v1', 'scope predicate mismatch');
  assert(releaseMetadata.source_gz_sha256 === manifest.source_hashes?.sqlite_gz_sha256, 'source gzip hash disagrees across manifests');

  const scopePath = path.join(root, 'scope-manifest.json');
  const scopeBytes = await readFile(scopePath);
  assert(sha256(scopeBytes) === manifest.scope_manifest_sha256, 'scope manifest SHA-256 mismatch');
  const scopeManifest = JSON.parse(scopeBytes);
  assert(scopeManifest.release_id === TARGET_RELEASE, 'scope manifest release ID mismatch');
  assert(scopeManifest.policy_sha256 === manifest.policy_sha256, 'scope policy hash mismatch');
  assert(scopeManifest.source_hashes?.sqlite_gz_sha256 === releaseMetadata.source_gz_sha256, 'scope source gzip hash mismatch');

  const archivePath = path.join(root, 'scoped-export.jsonl.gz');
  const archiveInfo = await stat(archivePath);
  const archiveSha = await fileSha256(archivePath);
  assert(archiveInfo.size === manifest.compressed_dataset_bytes, 'compressed dataset byte count mismatch');
  assert(archiveSha === manifest.compressed_dataset_sha256, 'compressed dataset SHA-256 mismatch');
  assert(files.reduce((sum, file) => sum + file.bytes.length, 0) === manifest.uncompressed_dataset_bytes, 'uncompressed dataset byte count mismatch');

  const desktopPath = path.join(root, `desktop-${TARGET_RELEASE}.sqlite3`);
  const desktopGzPath = `${desktopPath}.gz`;
  const desktopSha = await fileSha256(desktopPath);
  const desktopGzSha = await fileSha256(desktopGzPath);
  const computedWholeExportSha = wholeExportSha(files);
  const rowCounts = Object.fromEntries(manifest.files.filter(entry => entry.name !== 'taxonomy_release.jsonl').map(entry => [entry.name, entry.row_count]));
  const taxonIds = new Set(data['taxon.jsonl'].map(row => row.taxon_id));
  assert(taxonIds.size === rowCounts['taxon.jsonl'], 'taxon IDs are not unique');
  const dangling = data['taxon.jsonl'].filter(row => row.parent_taxon_id != null && !taxonIds.has(row.parent_taxon_id));
  const authoritativeCounts = countMap(data['taxon_external_id.jsonl'], row => `${row.source_system}/${row.namespace}`);
  const legacyCounts = countMap(data['taxon_external_id_legacy_integer.jsonl'], row => row.source_system);
  const probes = chooseProbes(data);
  const generatedAt = `${TARGET_RELEASE.slice(4, 14).replaceAll('.', '-')}T00:00:00Z`;
  const sourceManifest = {
    ...manifest,
    production_import_compatibility: {
      importer_version: IMPORTER_VERSION,
      manifest_schema_version: 1,
      export_schema_version: 1,
      exporter_version: manifest.format,
      generated_at_derivation: 'UTC midnight from immutable release ID date',
      source_sqlite_sha256_derivation: `SHA-256 of desktop-${TARGET_RELEASE}.sqlite3`,
      whole_export_sha256_derivation: 'ordered name:length:bytes plus LF framing over manifest files',
      computed_whole_export_sha256: computedWholeExportSha,
      desktop_sqlite_sha256: desktopSha,
      desktop_sqlite_gz_sha256: desktopGzSha,
      scope_manifest_sha256: manifest.scope_manifest_sha256,
    },
  };
  return {
    root, manifest, releaseMetadata, files, data, rowCounts, authoritativeCounts, legacyCounts, probes,
    metadata: {
      releaseId: TARGET_RELEASE,
      taxonomySchemaVersion: 2,
      exportSchemaVersion: 1,
      manifestSchemaVersion: 1,
      exporterVersion: manifest.format,
      scopePredicateId: releaseMetadata.scope_predicate_id,
      sourceGzSha256: releaseMetadata.source_gz_sha256,
      sourceSqliteSha256: desktopSha,
      wholeExportSha256: computedWholeExportSha,
      manifestSha256: sha256(manifestBytes),
      generatedAt,
      danglingParentCount: dangling.length,
      danglingParentReport: { count: dangling.length, sample: dangling.slice(0, 20).map(row => ({ taxon_id: row.taxon_id, parent_taxon_id: row.parent_taxon_id })) },
      sourceManifest,
    },
    verifiedHashes: {
      taxonomy_export_manifest_raw_sha256: sha256(manifestBytes),
      scope_manifest_raw_sha256: sha256(scopeBytes),
      compressed_dataset_sha256: archiveSha,
      desktop_sqlite_sha256: desktopSha,
      desktop_sqlite_gz_sha256: desktopGzSha,
      computed_whole_export_sha256: computedWholeExportSha,
      files: Object.fromEntries(files.map(file => [file.name, file.sha256])),
    },
  };
}

async function fileSha256(file) {
  return sha256(await readFile(file));
}

const insertMappings = {
  'taxon.jsonl': `
insert into public.taxonomy_v2_concepts(sporely_taxon_id, first_seen_release_id)
select (raw->>'taxon_id')::bigint, current_setting('taxonomy_v2.release_id') from taxonomy_v2_stage
on conflict (sporely_taxon_id) do nothing;
insert into public.taxonomy_v2_taxa(release_id,sporely_taxon_id,parent_sporely_taxon_id,genus,specific_epithet,family,canonical_scientific_name,taxon_rank,taxonomic_status,source_system,canonical_source_system,canonical_external_id)
select current_setting('taxonomy_v2.release_id'),(raw->>'taxon_id')::bigint,(raw->>'parent_taxon_id')::bigint,raw->>'genus',raw->>'specific_epithet',raw->>'family',raw->>'canonical_scientific_name',raw->>'taxon_rank',raw->>'taxonomic_status',raw->>'source_system',raw->>'canonical_source_system',raw->>'canonical_external_id' from taxonomy_v2_stage;`,
  'scientific_name.jsonl': `insert into public.taxonomy_v2_scientific_names(release_id,sporely_taxon_id,language_code,scientific_name,is_preferred_name,source,alias_reason) select current_setting('taxonomy_v2.release_id'),(raw->>'taxon_id')::bigint,raw->>'language_code',raw->>'scientific_name',(raw->>'is_preferred_name')::boolean,raw->>'source',raw->>'note' from taxonomy_v2_stage;`,
  'vernacular.jsonl': `insert into public.taxonomy_v2_vernacular_names(release_id,sporely_taxon_id,language_code,vernacular_name,is_preferred_name,source) select current_setting('taxonomy_v2.release_id'),(raw->>'taxon_id')::bigint,raw->>'language_code',raw->>'vernacular_name',(raw->>'is_preferred_name')::boolean,raw->>'source' from taxonomy_v2_stage;`,
  'taxon_external_id.jsonl': `insert into public.taxonomy_v2_external_ids(release_id,sporely_taxon_id,source_system,namespace,external_id,id_role,is_preferred,external_name,note) select current_setting('taxonomy_v2.release_id'),(raw->>'taxon_id')::bigint,raw->>'source_system',raw->>'namespace',raw->>'external_id',raw->>'id_role',(raw->>'is_preferred')::boolean,raw->>'external_name',raw->>'note' from taxonomy_v2_stage;`,
  'taxon_external_id_legacy_integer.jsonl': `insert into public.taxonomy_v2_legacy_external_ids(release_id,sporely_taxon_id,source_system,external_id,id_role,is_preferred,external_name,note) select current_setting('taxonomy_v2.release_id'),(raw->>'taxon_id')::bigint,raw->>'source_system',raw->>'external_id',raw->>'id_role',(raw->>'is_preferred')::boolean,raw->>'external_name',raw->>'note' from taxonomy_v2_stage;`,
  'taxon_redlist.jsonl': `insert into public.taxonomy_v2_redlist(release_id,sporely_taxon_id,source_system,source_release,assessment_id,assessment_area,assessed_name_source,assessed_name_namespace,assessed_name_id,scientific_name_snapshot,authorship_snapshot,taxon_rank_snapshot,category_raw,category_code,category_is_downgraded,criteria,expert_group,assessment_url) select current_setting('taxonomy_v2.release_id'),(raw->>'taxon_id')::bigint,raw->>'source_system',raw->>'source_release',raw->>'assessment_id',raw->>'assessment_area',raw->>'assessed_name_source',raw->>'assessed_name_namespace',raw->>'assessed_name_id',raw->>'scientific_name_snapshot',raw->>'authorship_snapshot',raw->>'taxon_rank_snapshot',raw->>'category_raw',raw->>'category_code',(raw->>'category_is_downgraded')::boolean,raw->>'criteria',raw->>'expert_group',raw->>'assessment_url' from taxonomy_v2_stage;`,
};

function protectedStateSql() {
  return `jsonb_build_object(
    'legacy_taxa_count',(select count(*) from public.taxa),
    'legacy_taxa_hash',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),'')) from public.taxa x),
    'legacy_vernacular_count',(select count(*) from public.taxa_vernacular),
    'legacy_vernacular_hash',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),'')) from public.taxa_vernacular x),
    'legacy_search_definition',pg_get_functiondef('public.search_taxa(text,text,integer)'::regprocedure),
    'observations_count',(select count(*) from public.observations),
    'observations_hash',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by x.id),'')) from public.observations x),
    'taxonomy_v3_registry',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),''))) from taxonomy_v3.registry_concept x),
    'taxonomy_v3_mapping',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),''))) from taxonomy_v3.external_mapping x),
    'taxonomy_v3_snapshots',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),''))) from taxonomy_v3.identification_snapshot x),
    'taxonomy_v3_resolution',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),''))) from taxonomy_v3.resolution_link x),
    'taxonomy_v3_release_audit',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),''))) from taxonomy_v3.release_installation x),
    'taxonomy_v3_supplement_audit',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),''))) from taxonomy_v3.supplement_installation x),
    'taxonomy_v3_manifest_audit',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),''))) from taxonomy_v3.reconciliation_manifest_audit x)
  )`;
}

function preamble(verified) {
  const m = verified.metadata;
  const expectedRelations = [
    'taxonomy_v2_releases','taxonomy_v2_concepts','taxonomy_v2_taxa','taxonomy_v2_scientific_names',
    'taxonomy_v2_vernacular_names','taxonomy_v2_external_ids','taxonomy_v2_legacy_external_ids',
    'taxonomy_v2_redlist','taxonomy_v2_import_runs',
  ];
  const legacyQueries = [...new Set(Object.values(verified.probes).map(probe => probe.query))];
  return `\\set ON_ERROR_STOP on
BEGIN;

-- PRIVATE PRODUCTION TAXONOMY IMPORT
-- DO NOT COMMIT
-- PROJECT REF: ${PROJECT_REF}
-- RELEASE: ${TARGET_RELEASE}

select pg_catalog.pg_advisory_xact_lock(${IMPORT_ADVISORY_LOCK}::bigint);

DO $preflight$
DECLARE
  v_existing public.taxonomy_v2_releases%rowtype;
  v_validation jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[${expectedRelations.map(sqlText).join(',')}]) name
     WHERE to_regclass('public.' || name) IS NULL
  ) OR to_regprocedure('public.taxonomy_v2_validate_release(text)') IS NULL
     OR to_regprocedure('public.taxonomy_v2_activate_release(text)') IS NULL
     OR to_regprocedure('public.search_taxa_v2(text,text,integer)') IS NULL
     OR to_regprocedure('public.resolve_taxon_external_id_v2(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'taxonomy-v2 preflight: required schema objects are missing';
  END IF;

  SELECT * INTO v_existing FROM public.taxonomy_v2_releases WHERE release_id=${sqlText(TARGET_RELEASE)};
  IF FOUND THEN
    IF v_existing.whole_export_sha256 <> ${sqlText(m.wholeExportSha256)}
       OR v_existing.manifest_sha256 <> ${sqlText(m.manifestSha256)}
       OR v_existing.source_gz_sha256 <> ${sqlText(m.sourceGzSha256)}
       OR v_existing.source_sqlite_sha256 <> ${sqlText(m.sourceSqliteSha256)} THEN
      RAISE EXCEPTION 'taxonomy-v2 preflight: release ID exists with different immutable hashes';
    END IF;
    IF v_existing.status IN ('ready','active') THEN
      v_validation := public.taxonomy_v2_validate_release(${sqlText(TARGET_RELEASE)});
      IF coalesce((v_validation->>'ok')::boolean,false) THEN
        RAISE EXCEPTION 'taxonomy-v2 preflight: identical completed release already installed; safe replay stopped';
      END IF;
    END IF;
    RAISE EXCEPTION 'taxonomy-v2 preflight: partial or invalid existing release requires manual recovery';
  END IF;
END
$preflight$;

CREATE TEMP TABLE taxonomy_v2_protected_before(value jsonb) ON COMMIT DROP;
INSERT INTO taxonomy_v2_protected_before VALUES (${protectedStateSql()});

CREATE TEMP TABLE taxonomy_v2_legacy_search_before(query text primary key, result jsonb) ON COMMIT DROP;
INSERT INTO taxonomy_v2_legacy_search_before(query,result)
SELECT probe.query, coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::text) FROM public.search_taxa(probe.query,'no',50) s),'[]'::jsonb)
  FROM (VALUES ${legacyQueries.map(value => `(${sqlText(value)})`).join(',')}) probe(query);

SELECT set_config('taxonomy_v2.release_id',${sqlText(TARGET_RELEASE)},true);
INSERT INTO public.taxonomy_v2_releases(
  release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,exporter_version,
  scope_predicate_id,source_gz_sha256,source_sqlite_sha256,whole_export_sha256,manifest_sha256,
  generated_at,status,row_counts,authoritative_namespace_counts,legacy_source_counts,
  dangling_parent_count,dangling_parent_report,source_manifest
) VALUES (
  ${sqlText(TARGET_RELEASE)},${m.taxonomySchemaVersion},${m.exportSchemaVersion},${m.manifestSchemaVersion},${sqlText(m.exporterVersion)},
  ${sqlText(m.scopePredicateId)},${sqlText(m.sourceGzSha256)},${sqlText(m.sourceSqliteSha256)},${sqlText(m.wholeExportSha256)},${sqlText(m.manifestSha256)},
  ${sqlText(m.generatedAt)}::timestamptz,'loading',${sqlJson(verified.rowCounts)},${sqlJson(verified.authoritativeCounts)},${sqlJson(verified.legacyCounts)},
  ${m.danglingParentCount},${sqlJson(m.danglingParentReport)},${sqlJson(m.sourceManifest)}
);
INSERT INTO public.taxonomy_v2_import_runs(release_id,status,importer_version,source_directory,whole_export_sha256)
VALUES (${sqlText(TARGET_RELEASE)},'running',${sqlText(IMPORTER_VERSION)},${sqlText(path.basename(verified.root))},${sqlText(m.wholeExportSha256)});

CREATE TEMP TABLE taxonomy_v2_stage(raw jsonb) ON COMMIT DROP;
`;
}

function postamble(verified) {
  const p = verified.probes;
  const counts = verified.rowCounts;
  return `
DO $counts$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.taxonomy_v2_releases
     WHERE release_id=${sqlText(TARGET_RELEASE)}
       AND status='loading'
       AND whole_export_sha256=${sqlText(verified.metadata.wholeExportSha256)}
       AND manifest_sha256=${sqlText(verified.metadata.manifestSha256)}
       AND source_gz_sha256=${sqlText(verified.metadata.sourceGzSha256)}
       AND source_sqlite_sha256=${sqlText(verified.metadata.sourceSqliteSha256)}
  ) THEN RAISE EXCEPTION 'loading release metadata or immutable hashes changed'; END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_concepts c JOIN public.taxonomy_v2_taxa t ON t.sporely_taxon_id=c.sporely_taxon_id WHERE t.release_id=${sqlText(TARGET_RELEASE)}) <> ${counts['taxon.jsonl']} THEN RAISE EXCEPTION 'expected concepts=${counts['taxon.jsonl']}'; END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_taxa WHERE release_id=${sqlText(TARGET_RELEASE)}) <> ${counts['taxon.jsonl']} THEN RAISE EXCEPTION 'expected taxa=${counts['taxon.jsonl']}'; END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_scientific_names WHERE release_id=${sqlText(TARGET_RELEASE)}) <> ${counts['scientific_name.jsonl']} THEN RAISE EXCEPTION 'scientific-name count mismatch'; END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_vernacular_names WHERE release_id=${sqlText(TARGET_RELEASE)}) <> ${counts['vernacular.jsonl']} THEN RAISE EXCEPTION 'vernacular count mismatch'; END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_external_ids WHERE release_id=${sqlText(TARGET_RELEASE)}) <> ${counts['taxon_external_id.jsonl']} THEN RAISE EXCEPTION 'external-ID count mismatch'; END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_legacy_external_ids WHERE release_id=${sqlText(TARGET_RELEASE)}) <> ${counts['taxon_external_id_legacy_integer.jsonl']} THEN RAISE EXCEPTION 'legacy external-ID count mismatch'; END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_redlist WHERE release_id=${sqlText(TARGET_RELEASE)}) <> ${counts['taxon_redlist.jsonl']} THEN RAISE EXCEPTION 'red-list count mismatch'; END IF;
END
$counts$;

UPDATE public.taxonomy_v2_releases SET status='ready',loaded_at=clock_timestamp() WHERE release_id=${sqlText(TARGET_RELEASE)};

DO $validate$
DECLARE v_result jsonb;
BEGIN
  v_result := public.taxonomy_v2_validate_release(${sqlText(TARGET_RELEASE)});
  IF NOT coalesce((v_result->>'ok')::boolean,false) THEN RAISE EXCEPTION 'taxonomy-v2 validation failed: %',v_result; END IF;
END
$validate$;

DO $activate$
DECLARE v_result jsonb;
BEGIN
  v_result := public.taxonomy_v2_activate_release(${sqlText(TARGET_RELEASE)});
  IF NOT coalesce((v_result->>'ok')::boolean,false) OR v_result->>'status' <> 'active' THEN RAISE EXCEPTION 'taxonomy-v2 activation failed: %',v_result; END IF;
  IF (SELECT count(*) FROM public.taxonomy_v2_releases WHERE status='active') <> 1 THEN RAISE EXCEPTION 'expected exactly one active taxonomy-v2 release'; END IF;
END
$activate$;

DO $searches$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.search_taxa_v2(${sqlText(p.colOnly.query)},'no',50) WHERE taxon_id=${p.colOnly.taxonId} AND col_usage_id=${sqlText(p.colOnly.colUsageId)} AND nortaxa_taxon_id IS NULL) THEN RAISE EXCEPTION 'COL-only search probe failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.search_taxa_v2(${sqlText(p.nortaxa.query)},'no',50) WHERE taxon_id=${p.nortaxa.taxonId})
     OR NOT EXISTS (SELECT 1 FROM public.taxonomy_v2_scientific_names WHERE release_id=${sqlText(TARGET_RELEASE)} AND sporely_taxon_id=${p.nortaxa.taxonId} AND source='nortaxa') THEN RAISE EXCEPTION 'NorTaxa-backed name search probe failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.search_taxa_v2(${sqlText(p.alias.query)},'no',50) WHERE taxon_id=${p.alias.taxonId} AND match_type LIKE 'scientific_alias_%') THEN RAISE EXCEPTION 'scientific-alias search probe failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.search_taxa_v2(${sqlText(p.genus.query)},'no',50) WHERE taxon_id=${p.genus.taxonId} AND taxon_rank='genus') THEN RAISE EXCEPTION 'genus search probe failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.search_taxa_v2(${sqlText(p.vernacular.query)},${sqlText(p.vernacular.language)},50) WHERE taxon_id=${p.vernacular.taxonId} AND match_type LIKE 'vernacular_%') THEN RAISE EXCEPTION 'vernacular search probe failed'; END IF;
END
$searches$;

DO $protected$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  SELECT value INTO v_before FROM taxonomy_v2_protected_before;
  v_after := ${protectedStateSql()};
  IF v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'protected legacy, taxonomy-v3, or observation state changed'; END IF;
  IF EXISTS (
    SELECT 1 FROM taxonomy_v2_legacy_search_before before
    WHERE before.result IS DISTINCT FROM coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::text) FROM public.search_taxa(before.query,'no',50) s),'[]'::jsonb)
  ) THEN RAISE EXCEPTION 'legacy public.search_taxa result set changed'; END IF;
END
$protected$;

UPDATE public.taxonomy_v2_import_runs
   SET status='succeeded',finished_at=clock_timestamp(),counts=${sqlJson({ row_counts: verified.rowCounts, expected_active_releases: 1 })}
 WHERE release_id=${sqlText(TARGET_RELEASE)} AND status='running';

COMMIT;
`;
}

async function writePayload(verified, output) {
  const destination = path.resolve(output);
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  assert(!destination.startsWith(`${repoRoot}${path.sep}`), 'generated SQL must remain outside Git');
  await mkdir(path.dirname(destination), { recursive: true });
  const handle = await open(destination, 'wx', 0o600);
  const digest = createHash('sha256');
  let bytesWritten = 0;
  const write = async value => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await handle.write(buffer);
    digest.update(buffer);
    bytesWritten += buffer.length;
  };
  try {
    await write(preamble(verified));
    for (const name of TABLE_FILES) {
      await write(`\nTRUNCATE taxonomy_v2_stage;\nCOPY taxonomy_v2_stage(raw) FROM STDIN WITH (FORMAT csv, DELIMITER E'\\x1f', QUOTE E'\\x1e', ESCAPE E'\\x1e');\n`);
      await write(verified.files.find(file => file.name === name).bytes);
      await write(`\\.\n${insertMappings[name]}\n`);
    }
    await write(postamble(verified));
  } catch (error) {
    await handle.close();
    await unlink(destination).catch(() => {});
    throw error;
  }
  await handle.close();
  await chmod(destination, 0o600);
  return { path: destination, sha256: digest.digest('hex'), bytes: bytesWritten };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export async function prepareProductionReleaseImport({ releaseDir, output } = {}) {
  assert(releaseDir, 'release directory is required');
  assert(output, 'output path is required');
  const verified = await verifyRelease(releaseDir);
  const generated = await writePayload(verified, output);
  const expectedCounts = {
    concepts: verified.rowCounts['taxon.jsonl'],
    taxa: verified.rowCounts['taxon.jsonl'],
    scientific_names: verified.rowCounts['scientific_name.jsonl'],
    vernacular_names: verified.rowCounts['vernacular.jsonl'],
    external_ids: verified.rowCounts['taxon_external_id.jsonl'],
    legacy_external_ids: verified.rowCounts['taxon_external_id_legacy_integer.jsonl'],
    redlist: verified.rowCounts['taxon_redlist.jsonl'],
    releases: 1,
    import_runs: 1,
    active_releases: 1,
  };
  const command = `docker run --rm --env-file /path/to/private/production-db.env -v ${shellQuote(`${path.dirname(generated.path)}:/payload:ro`)} postgres:17 sh -c 'psql "$DATABASE_URL" --file=/payload/${path.basename(generated.path)}'`;
  return { generated_sql_path: generated.path, sql_sha256: generated.sha256, sql_bytes: generated.bytes, release_id: TARGET_RELEASE, verified_release_hashes: verified.verifiedHashes, expected_table_counts: expectedCounts, containerised_psql_command: command };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--release-dir') options.releaseDir = argv[++i];
    else if (argv[i] === '--output') options.output = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node scripts/taxonomy-v2/prepare-production-release-import.mjs --release-dir <directory> --output <outside-git.sql>');
    return;
  }
  const result = await prepareProductionReleaseImport(options);
  console.log(`generated SQL path: ${result.generated_sql_path}`);
  console.log(`SQL SHA-256: ${result.sql_sha256}`);
  console.log(`verified release hashes: ${JSON.stringify(result.verified_release_hashes, null, 2)}`);
  console.log(`expected table counts: ${JSON.stringify(result.expected_table_counts)}`);
  console.log(`containerised psql command: ${result.containerised_psql_command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
