import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export const DATASET_FILES = Object.freeze([
  'taxonomy_release.jsonl',
  'taxon.jsonl',
  'scientific_name.jsonl',
  'vernacular.jsonl',
  'taxon_external_id.jsonl',
  'taxon_external_id_legacy_integer.jsonl',
  'taxon_redlist.jsonl',
]);

const RELEASE_RE = /^tax-[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9]{2}$/;
const fields = {
  'taxonomy_release.jsonl': { content_release_id: 'string', taxonomy_schema_version: 'integer', export_schema_version: 'integer', exporter_version: 'string', scope_predicate_id: 'string' },
  'taxon.jsonl': { taxon_id: 'positiveInteger', parent_taxon_id: 'nullableInteger', genus: 'string', specific_epithet: 'string', family: 'nullableString', canonical_scientific_name: 'nullableString', taxon_rank: 'nullableString', taxonomic_status: 'nullableString', source_system: 'nullableString', canonical_source_system: 'nonblankString', canonical_external_id: 'nonblankString' },
  'scientific_name.jsonl': { taxon_id: 'positiveInteger', language_code: 'nonblankString', scientific_name: 'nonblankString', is_preferred_name: 'boolean', source: 'nullableString', note: 'nullableString' },
  'vernacular.jsonl': { taxon_id: 'positiveInteger', language_code: 'nonblankString', vernacular_name: 'nonblankString', is_preferred_name: 'boolean', source: 'nullableString' },
  'taxon_external_id.jsonl': { taxon_id: 'positiveInteger', source_system: 'nonblankTrimmedString', namespace: 'nonblankTrimmedString', external_id: 'nonblankTrimmedString', id_role: 'nonblankString', is_preferred: 'boolean', external_name: 'nullableString', note: 'nullableString' },
  'taxon_external_id_legacy_integer.jsonl': { taxon_id: 'positiveInteger', source_system: 'nonblankString', external_id: 'nonblankString', id_role: 'nonblankString', is_preferred: 'boolean', external_name: 'nullableString', note: 'nullableString' },
  'taxon_redlist.jsonl': { taxon_id: 'positiveInteger', source_system: 'nonblankString', source_release: 'nonblankString', assessment_id: 'nonblankString', assessment_area: 'nonblankString', assessed_name_source: 'nonblankString', assessed_name_namespace: 'nonblankString', assessed_name_id: 'nonblankString', scientific_name_snapshot: 'nonblankString', authorship_snapshot: 'nullableString', taxon_rank_snapshot: 'nullableString', category_raw: 'nonblankString', category_code: 'nonblankString', category_is_downgraded: 'boolean', criteria: 'nullableString', expert_group: 'nullableString', assessment_url: 'nullableString' },
};

function validType(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'nullableString') return value === null || typeof value === 'string';
  if (type === 'nonblankString') return typeof value === 'string' && value.length > 0;
  if (type === 'nonblankTrimmedString') return typeof value === 'string' && value.length > 0 && value === value.trim();
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'positiveInteger') return Number.isSafeInteger(value) && value > 0;
  if (type === 'nullableInteger') return value === null || Number.isSafeInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function validateObject(file, line, value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${file}:${line}: expected one JSON object`);
  for (const [name, type] of Object.entries(fields[file])) {
    if (!(name in value)) throw new Error(`${file}:${line}: missing field ${name}`);
    if (!validType(value[name], type)) throw new Error(`${file}:${line}: invalid ${type} field ${name}`);
  }
}

function assertCountMap(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error(`${label} must be a non-negative integer map`);
}

export async function preflightExport(sourceDirectory, expectedReleaseId = null) {
  const started = performance.now();
  const root = await realpath(sourceDirectory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('source directory must be a real directory');
  const manifestPath = path.join(root, 'taxonomy_export_manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('manifest must be a regular non-symlink file');
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch (error) { throw new Error(`taxonomy_export_manifest.json: invalid JSON: ${error.message}`); }
  if (manifest.manifest_schema_version !== 1 || manifest.export_schema_version !== 1 || manifest.taxonomy_schema_version !== 2) throw new Error('manifest schema versions must be 1/1/2');
  if (!RELEASE_RE.test(manifest.content_release_id) || (expectedReleaseId && manifest.content_release_id !== expectedReleaseId)) throw new Error(`unexpected release ID ${manifest.content_release_id}`);
  if (manifest.scope_predicate_id !== 'fungi_closure_union_nortaxa_v1') throw new Error('unexpected scope predicate');
  if (!Array.isArray(manifest.files) || manifest.files.map(v => v.name).join('\0') !== DATASET_FILES.join('\0') || new Set(manifest.files.map(v => v.name)).size !== DATASET_FILES.length) throw new Error('manifest dataset order does not match W1 DATASET_FILES');
  assertCountMap(manifest.external_id_authoritative_namespace_counts, 'authoritative namespace counts');
  assertCountMap(manifest.external_id_legacy_integer_source_counts, 'legacy source counts');
  if (!manifest.dangling_parent_references || !Number.isSafeInteger(manifest.dangling_parent_references.count) || manifest.dangling_parent_references.count < 0) throw new Error('invalid dangling-parent report');

  const whole = createHash('sha256');
  const files = {};
  let releaseMetadata;
  for (const entry of manifest.files) {
    const candidate = path.join(root, entry.name);
    const resolved = await realpath(candidate);
    if (path.dirname(resolved) !== root) throw new Error(`${entry.name}: path escapes export directory`);
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${entry.name}: must be a regular non-symlink file`);
    if (stat.size !== entry.bytes) throw new Error(`${entry.name}: byte count ${stat.size} != ${entry.bytes}`);
    whole.update(`${Buffer.byteLength(entry.name)}:${entry.name}:${stat.size}:`);
    const digest = createHash('sha256');
    let rows = 0;
    const input = createReadStream(resolved);
    input.on('data', chunk => { digest.update(chunk); whole.update(chunk); });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      rows += 1;
      let value;
      try { value = JSON.parse(line); } catch (error) { throw new Error(`${entry.name}:${rows}: invalid JSON: ${error.message}`); }
      validateObject(entry.name, rows, value);
      if (entry.name === 'taxonomy_release.jsonl') releaseMetadata = value;
    }
    whole.update('\n');
    const sha256 = digest.digest('hex');
    if (sha256 !== entry.sha256) throw new Error(`${entry.name}: SHA-256 mismatch`);
    if (rows !== entry.row_count) throw new Error(`${entry.name}: row count ${rows} != ${entry.row_count}`);
    files[entry.name] = { path: resolved, row_count: rows, bytes: stat.size, sha256 };
  }
  if (files['taxonomy_release.jsonl'].row_count !== 1) throw new Error('taxonomy_release.jsonl must contain exactly one row');
  for (const key of ['content_release_id', 'taxonomy_schema_version', 'export_schema_version', 'exporter_version', 'scope_predicate_id']) if (releaseMetadata[key] !== manifest[key]) throw new Error(`release metadata disagrees on ${key}`);
  const wholeExportSha256 = whole.digest('hex');
  if (wholeExportSha256 !== manifest.whole_export_sha256) throw new Error('whole-export SHA-256 mismatch');
  return { root, manifest, manifestSha256, wholeExportSha256, files, releaseMetadata, elapsed_ms: performance.now() - started };
}
