import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATASET_FILES } from './export-contract.mjs';

const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;

export async function buildFixtureManifest(root, overrides = {}) {
  const files = [];
  const whole = createHash('sha256');
  for (const name of DATASET_FILES) {
    const bytes = await readFile(path.join(root, name));
    const rows = bytes.toString('utf8').trimEnd().split('\n').length;
    files.push({ bytes: bytes.length, name, row_count: rows, sha256: createHash('sha256').update(bytes).digest('hex'), sort_keys: [] });
    whole.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes).update('\n');
  }
  const manifest = {
    content_release_id: 'tax-2026.07.01-01',
    dangling_parent_references: { count: 1, sample: [{ parent_taxon_id: 999, taxon_id: 1 }] },
    excluded_concept_count: 0,
    export_schema_version: 1,
    exporter_version: 'fixture-1',
    external_id_authoritative_namespace_counts: { 'col_xr/col_usage_id': 2, 'nortaxa/nortaxa_taxon_id': 1 },
    external_id_legacy_integer_source_counts: { artsdatabanken: 1 },
    files,
    generated_at: '2026-07-01T00:00:00Z',
    included_concept_count: 3,
    manifest_schema_version: 1,
    scope_predicate_id: 'fungi_closure_union_nortaxa_v1',
    source: { artifact_gz_path: 'fixture.sqlite3.gz', gz_sha256: 'a'.repeat(64), manifest_path: 'fixture-manifest.json', sqlite_sha256: 'b'.repeat(64) },
    taxonomy_schema_version: 2,
    whole_export_sha256: whole.digest('hex'),
    ...overrides,
  };
  await writeFile(path.join(root, 'taxonomy_export_manifest.json'), `${JSON.stringify(sort(manifest))}\n`);
  return manifest;
}
