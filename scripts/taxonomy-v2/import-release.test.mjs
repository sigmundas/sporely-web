import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
