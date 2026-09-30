import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFixtureManifest } from './lib/build-fixture-manifest.mjs';
import { importRelease } from './import-release.mjs';
import { discoverLocalTarget, query } from './lib/docker-psql.mjs';

const fixture=path.resolve('scripts/taxonomy-v2/fixtures/complete');
const integration=process.env.W2B_INTEGRATION==='1';

test('fixture imports atomically, validates, remains ready, and reruns safely',{skip:!integration},async()=>{
  const first=await importRelease({source:fixture,expectedReleaseId:'tax-2026.07.01-01'});
  assert.equal(first.outcome,'imported'); assert.equal(first.validation.ok,true); assert.equal(first.validation.status,'ready');
  const target=await discoverLocalTarget();
  assert.equal(await query(target,"select count(*) from public.taxonomy_v2_taxa where canonical_scientific_name='Fixture duplicate'"),'2');
  assert.equal(await query(target,"select specific_epithet from public.taxonomy_v2_taxa where taxon_rank='genus'"),'');
  assert.equal(await query(target,"select source_directory from public.taxonomy_v2_import_runs where id=1"),'complete');
  const rerun=await importRelease({source:fixture,expectedReleaseId:'tax-2026.07.01-01'}); assert.equal(rerun.outcome,'verified_existing');
  await query(target,"select public.taxonomy_v2_activate_release('tax-2026.07.01-01')");
  assert.equal(await query(target,"select count(*) from public.resolve_taxon_external_id_v2('artsdatabanken','artsnavnebase_scientific_name_id','123')"),'0');
});

test('forced failure rolls back release rows and leaves sanitized audit',{skip:!integration},async()=>{
  const target=await discoverLocalTarget();
  await query(target,"delete from public.taxonomy_v2_import_runs; delete from public.taxonomy_v2_redlist; delete from public.taxonomy_v2_legacy_external_ids; delete from public.taxonomy_v2_external_ids; delete from public.taxonomy_v2_vernacular_names; delete from public.taxonomy_v2_scientific_names; delete from public.taxonomy_v2_taxa; delete from public.taxonomy_v2_concepts; delete from public.taxonomy_v2_releases;");
  await assert.rejects(importRelease({source:fixture,testFailureAfter:'taxon.jsonl'}));
  assert.equal(await query(target,"select count(*) from public.taxonomy_v2_releases"),'0');
  assert.equal(await query(target,"select count(*) from public.taxonomy_v2_taxa"),'0');
  const audit=JSON.parse(await query(target,"select row_to_json(x)::text from (select status,source_directory,error_message from public.taxonomy_v2_import_runs order by id desc limit 1)x"));
  assert.equal(audit.status,'failed'); assert.equal(audit.source_directory,'complete'); assert.doesNotMatch(audit.error_message,/postgres(?:ql)?:\/\//i);
});

// Taxonomy v3 Stage 3W: a Stage 3P-shaped taxon.jsonl (national name plus
// provenance naming an accepted authoritative bridge row) imports into the
// national-name columns; a name without its bridge row aborts the import.
async function stage3pExport(releaseId, { withBridgeRow }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'w3w-fixture-'));
  await cp(fixture, root, { recursive: true });
  const rewrite = async (name, fn) => { const p = path.join(root, name); const rows = (await readFile(p, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); await writeFile(p, rows.map(fn).filter(Boolean).map(r => JSON.stringify(r)).join('\n') + '\n'); };
  await rewrite('taxonomy_release.jsonl', r => ({ ...r, content_release_id: releaseId }));
  await rewrite('taxon.jsonl', r => ({ ...r, preferred_scientific_name_no: null, preferred_scientific_name_no_source_system: null, preferred_scientific_name_no_namespace: null, preferred_scientific_name_no_external_id: null, preferred_scientific_name_sv: null, preferred_scientific_name_sv_source_system: null, preferred_scientific_name_sv_namespace: null, preferred_scientific_name_sv_external_id: null,
    ...(r.taxon_id === 1 ? { preferred_scientific_name_no: 'Fixture nationalis', preferred_scientific_name_no_source_system: 'nortaxa', preferred_scientific_name_no_namespace: 'nortaxa_taxon_id', preferred_scientific_name_no_external_id: 'W3W-1' } : {}) }));
  const scientific = await readFile(path.join(root, 'scientific_name.jsonl'), 'utf8');
  await writeFile(path.join(root, 'scientific_name.jsonl'), scientific + JSON.stringify({ is_preferred_name: false, language_code: 'sci', note: 'manual_approved_exact', scientific_name: 'Fixture nationalis', source: 'nortaxa', taxon_id: 1 }) + '\n');
  if (withBridgeRow) {
    const external = await readFile(path.join(root, 'taxon_external_id.jsonl'), 'utf8');
    await writeFile(path.join(root, 'taxon_external_id.jsonl'), external + JSON.stringify({ external_id: 'W3W-1', external_name: 'Fixture nationalis', id_role: 'accepted', is_preferred: false, namespace: 'nortaxa_taxon_id', note: 'authoritative_bridge:manual_mapping', source_system: 'nortaxa', taxon_id: 1 }) + '\n');
  }
  await buildFixtureManifest(root, { content_release_id: releaseId, external_id_authoritative_namespace_counts: { 'col_xr/col_usage_id': 2, 'nortaxa/nortaxa_taxon_id': withBridgeRow ? 2 : 1 } });
  return root;
}

test('Stage 3P national names import with provenance; an untraced name aborts',{skip:!integration},async()=>{
  const target=await discoverLocalTarget();
  const good=await stage3pExport('tax-2026.07.02-01',{withBridgeRow:true});
  const bad=await stage3pExport('tax-2026.07.03-01',{withBridgeRow:false});
  try {
    const imported=await importRelease({source:good,expectedReleaseId:'tax-2026.07.02-01'});
    assert.equal(imported.outcome,'imported'); assert.equal(imported.validation.ok,true);
    assert.equal(await query(target,"select concat_ws('|',canonical_scientific_name,preferred_scientific_name_no,preferred_scientific_name_no_source_system,preferred_scientific_name_no_namespace,preferred_scientific_name_no_external_id) from public.taxonomy_v2_taxa where release_id='tax-2026.07.02-01' and sporely_taxon_id=1"),'Fixture duplicate|Fixture nationalis|nortaxa|nortaxa_taxon_id|W3W-1');
    assert.equal(await query(target,"select count(*) from public.taxonomy_v2_taxa where release_id='tax-2026.07.02-01' and preferred_scientific_name_sv is not null"),'0');
    await assert.rejects(importRelease({source:bad,expectedReleaseId:'tax-2026.07.03-01'}),/national-name validation failed/);
    assert.equal(await query(target,"select count(*) from public.taxonomy_v2_releases where release_id='tax-2026.07.03-01'"),'0');
  } finally { await rm(good,{recursive:true}); await rm(bad,{recursive:true}); }
});
