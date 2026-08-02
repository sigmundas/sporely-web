import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { discoverLocalTarget, query, spawnSession } from './lib/docker-psql.mjs';
import { prepareProductionReleaseImport } from './prepare-production-release-import.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RELEASE_DIR = path.resolve(REPO_ROOT, '..', 'sporely-py/database/reference_data/generated/taxonomy_v2/global_macrofungi_tax-2026.08.01-01');
const RELEASE_ID = 'tax-2026.08.01-01';
const integration = process.env.TAXONOMY_V2_PRODUCTION_IMPORT_INTEGRATION === '1';

function applyFile(target, file) {
  return new Promise((resolve, reject) => {
    const child = spawnSession(target);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `psql exited ${code}`)));
    createReadStream(file).on('error', reject).pipe(child.stdin);
  });
}

test('production taxonomy-v2 generator is local-only and uses bulk COPY', async () => {
  const source = await readFile(path.join(REPO_ROOT, 'scripts/taxonomy-v2/prepare-production-release-import.mjs'), 'utf8');
  assert.doesNotMatch(source, /discoverLocalTarget|queryStdin|supabase\s+link|db\s+push|fetch\s*\(/);
  assert.match(source, /\\set ON_ERROR_STOP on\nBEGIN;/);
  assert.match(source, /PRIVATE PRODUCTION TAXONOMY IMPORT/);
  assert.match(source, /PROJECT REF: \$\{PROJECT_REF\}/);
  assert.match(source, /COPY taxonomy_v2_stage\(raw\) FROM STDIN/);
  assert.doesNotMatch(source, /insert into public\.taxa(?:\s|\()/i);
  assert.doesNotMatch(source, /insert into public\.observations/i);
});

test('integration: generated full release payload imports, validates, activates, and protects legacy state', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'taxonomy-v2-production-import-test-'));
  try {
    const output = path.join(tempDir, `${RELEASE_ID}-import.sql`);
    const prepared = await prepareProductionReleaseImport({ releaseDir: RELEASE_DIR, output });
    assert.equal(prepared.release_id, RELEASE_ID);
    assert.deepEqual(prepared.expected_table_counts, {
      concepts: 52917,
      taxa: 52917,
      scientific_names: 57769,
      vernacular_names: 3923,
      external_ids: 52881,
      legacy_external_ids: 0,
      redlist: 2262,
      releases: 1,
      import_runs: 1,
      active_releases: 1,
    });
    const sql = await readFile(output, 'utf8');
    assert.ok(sql.startsWith('\\set ON_ERROR_STOP on\nBEGIN;'));
    assert.match(sql.slice(0, 400), /RELEASE: tax-2026\.08\.01-01/);
    assert.equal((sql.match(/COPY taxonomy_v2_stage\(raw\) FROM STDIN/g) || []).length, 6);
    assert.ok(sql.trimEnd().endsWith('COMMIT;'));

    const legacyBefore = await query(target, "select json_build_object('taxa',(select count(*) from public.taxa),'vernacular',(select count(*) from public.taxa_vernacular),'search',pg_get_functiondef('public.search_taxa(text,text,integer)'::regprocedure))::text");
    const protectedBefore = await query(target, "select json_build_object('taxonomy_v3',(select count(*) from taxonomy_v3.registry_concept)+(select count(*) from taxonomy_v3.external_mapping)+(select count(*) from taxonomy_v3.identification_snapshot)+(select count(*) from taxonomy_v3.resolution_link),'observations',(select count(*) from public.observations))::text");
    await applyFile(target, output);

    const counts = JSON.parse(await query(target, `select json_build_object(
      'concepts',(select count(*) from public.taxonomy_v2_concepts),
      'taxa',(select count(*) from public.taxonomy_v2_taxa where release_id='${RELEASE_ID}'),
      'scientific_names',(select count(*) from public.taxonomy_v2_scientific_names where release_id='${RELEASE_ID}'),
      'vernacular_names',(select count(*) from public.taxonomy_v2_vernacular_names where release_id='${RELEASE_ID}'),
      'external_ids',(select count(*) from public.taxonomy_v2_external_ids where release_id='${RELEASE_ID}'),
      'legacy_external_ids',(select count(*) from public.taxonomy_v2_legacy_external_ids where release_id='${RELEASE_ID}'),
      'redlist',(select count(*) from public.taxonomy_v2_redlist where release_id='${RELEASE_ID}'),
      'releases',(select count(*) from public.taxonomy_v2_releases),
      'import_runs',(select count(*) from public.taxonomy_v2_import_runs),
      'active_releases',(select count(*) from public.taxonomy_v2_releases where status='active')
    )::text`));
    assert.deepEqual(counts, prepared.expected_table_counts);
    assert.equal(JSON.parse(await query(target, `select public.taxonomy_v2_validate_release('${RELEASE_ID}')::text`)).ok, true);
    assert.equal(await query(target, `select status from public.taxonomy_v2_releases where release_id='${RELEASE_ID}'`), 'active');
    assert.equal(await query(target, `select status from public.taxonomy_v2_import_runs where release_id='${RELEASE_ID}'`), 'succeeded');
    assert.equal(await query(target, "select count(*) from public.taxonomy_v2_external_ids where source_system='nortaxa' and namespace='nortaxa_taxon_id'"), '0');
    assert.equal(await query(target, "select count(*) from public.search_taxa_v2('Crystallocystidium albescens','no',20) where taxon_id=167 and col_usage_id='323XQ' and nortaxa_taxon_id is null"), '1');
    assert.equal(await query(target, "select count(*) from public.taxonomy_v2_scientific_names where source='nortaxa'"), '4887');
    assert.equal(await query(target, "select count(*) from public.taxonomy_v2_vernacular_names where source='nortaxa'"), '3923');
    assert.equal(await query(target, "select count(*) from public.search_taxa_v2('Crystallocystidium','no',20) where taxon_rank='genus'"), '1');
    assert.equal(await query(target, "select count(*) from public.search_taxa_v2('grå torvvokssopp','nb',20) where match_type like 'vernacular_%'"), '1');
    assert.equal(await query(target, "select count(*) from public.search_taxa_v2('Ustilago maydis','no',20) where match_type like 'scientific_alias_%'"), '1');
    assert.equal(await query(target, "select json_build_object('taxa',(select count(*) from public.taxa),'vernacular',(select count(*) from public.taxa_vernacular),'search',pg_get_functiondef('public.search_taxa(text,text,integer)'::regprocedure))::text"), legacyBefore);
    assert.equal(await query(target, "select json_build_object('taxonomy_v3',(select count(*) from taxonomy_v3.registry_concept)+(select count(*) from taxonomy_v3.external_mapping)+(select count(*) from taxonomy_v3.identification_snapshot)+(select count(*) from taxonomy_v3.resolution_link),'observations',(select count(*) from public.observations))::text"), protectedBefore);

    await assert.rejects(applyFile(target, output), /identical completed release already installed; safe replay stopped/);
    await query(target, `update public.taxonomy_v2_releases set whole_export_sha256='${'f'.repeat(64)}' where release_id='${RELEASE_ID}'`);
    await assert.rejects(applyFile(target, output), /release ID exists with different immutable hashes/);
    await query(target, `update public.taxonomy_v2_releases set whole_export_sha256='${prepared.verified_release_hashes.computed_whole_export_sha256}',status='loading' where release_id='${RELEASE_ID}'`);
    await assert.rejects(applyFile(target, output), /partial or invalid existing release requires manual recovery/);
    await query(target, `update public.taxonomy_v2_releases set status='active' where release_id='${RELEASE_ID}'`);
    assert.deepEqual(JSON.parse(await query(target, `select json_build_object(
      'concepts',(select count(*) from public.taxonomy_v2_concepts),
      'taxa',(select count(*) from public.taxonomy_v2_taxa),
      'scientific_names',(select count(*) from public.taxonomy_v2_scientific_names),
      'vernacular_names',(select count(*) from public.taxonomy_v2_vernacular_names),
      'external_ids',(select count(*) from public.taxonomy_v2_external_ids),
      'legacy_external_ids',(select count(*) from public.taxonomy_v2_legacy_external_ids),
      'redlist',(select count(*) from public.taxonomy_v2_redlist),
      'releases',(select count(*) from public.taxonomy_v2_releases),
      'import_runs',(select count(*) from public.taxonomy_v2_import_runs),
      'active_releases',(select count(*) from public.taxonomy_v2_releases where status='active')
    )::text`)), prepared.expected_table_counts);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
