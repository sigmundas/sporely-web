import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { csvField, percentile, sqlLiteral } from './run-sparse-registry-experiment.mjs';
import { discoverLocalTarget, query } from './lib/docker-psql.mjs';

const integration = process.env.W2C_INTEGRATION === '1';
const schemaPath = new URL('./experiments/sparse-registry-prototype.sql', import.meta.url);

test('CSV and SQL encoding preserve arbitrary source values', () => {
  assert.equal(csvField(null), '\\N');
  assert.equal(csvField('a,"b"'), '"a,""b"""');
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
});

test('percentile uses nearest-rank selection', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], .5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], .95), 5);
});

test('prototype is isolated and encodes complete namespaced uniqueness', async () => {
  const sql = await readFile(schemaPath, 'utf8');
  assert.match(sql, /drop schema if exists w2c_sparse_experiment cascade/);
  assert.match(sql, /primary key \(source_system, namespace, external_id\)/);
  assert.match(sql, /revoke all on schema w2c_sparse_experiment from public/);
  assert.doesNotMatch(sql, /create table public\./i);
  assert.doesNotMatch(sql, /alter table public\./i);
});

test('search uses escaped literal prefix and ordinary prefix indexes', async () => {
  const sql = await readFile(schemaPath, 'utf8');
  assert.match(sql, /text_pattern_ops/);
  assert.match(sql, /replace\(replace\(replace/);
  assert.match(sql, /like .* escape '\\'/i);
  assert.doesNotMatch(sql, /left\(lower\(/i);
  assert.doesNotMatch(sql, /gin_trgm_ops|gist_trgm_ops/i);
});

test('scope state constrains cache eligibility but not registry concepts', async () => {
  const sql = await readFile(schemaPath, 'utf8');
  assert.match(sql, /scope_state text not null check \(scope_state in \('include','exclude','review','not_evaluated'\)\)/);
  assert.match(sql, /cache_concept/);
  assert.match(sql, /registry_concept/);
});

test('disposable prototype represents every historical state', { skip: !integration }, async () => {
  const target = await discoverLocalTarget();
  const counts = JSON.parse(await query(target, `select json_build_object(
    'resolved',(select count(*) from w2c_sparse_experiment.identification_snapshot where resolution_state='resolved'),
    'legacy',(select count(*) from w2c_sparse_experiment.identification_snapshot where resolution_state='historical_unresolved'),
    'manual',(select count(*) from w2c_sparse_experiment.identification_snapshot where resolution_state='manual_unresolved'),
    'none',(select count(*) from w2c_sparse_experiment.identification_snapshot where resolution_state='no_identity_evidence'))::text`));
  assert.ok(counts.resolved > 0);
  assert.equal(counts.legacy, 227);
  assert.equal(counts.manual, 87);
  assert.equal(counts.none, 23);
});

test('exact mapping reuse and same-name separation survive experiment', { skip: !integration }, async () => {
  const target = await discoverLocalTarget();
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.external_mapping where source_system='inaturalist' and namespace='inaturalist_taxon_id' and external_id='48715'`), '1');
  assert.equal(await query(target, `select count(distinct sporely_taxon_id) from w2c_sparse_experiment.registry_concept where canonical_scientific_name='Duplicate example'`), '2');
});

test('review-state taxon is registered but excluded from cache', { skip: !integration }, async () => {
  const target = await discoverLocalTarget();
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.registry_concept where sporely_taxon_id=86820 and scope_state='review'`), '1');
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.cache_concept where sporely_taxon_id=86820`), '0');
});

test('cache contains only Phase-A include rows and no review rows', { skip: !integration }, async () => {
  const target = await discoverLocalTarget();
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.cache_concept where release_id='tax-2026.08.01-01'`), '52881');
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.cache_concept c join w2c_sparse_experiment.registry_concept r using(sporely_taxon_id) where r.scope_state='review'`), '0');
});

test('literal metacharacters, minimum length and same-name results are preserved', { skip: !integration }, async () => {
  const target = await discoverLocalTarget();
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.search_taxa('%_','no',20,true)`), '1');
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.search_taxa('x','no',20,true)`), '0');
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.search_taxa('Duplicate example','no',20,false)`), '2');
});

test('two cache slots do not mutate persistent state', { skip: !integration }, async () => {
  const target = await discoverLocalTarget();
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.cache_release`), '2');
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.registry_concept`), '7');
  assert.equal(await query(target, `select count(*) from w2c_sparse_experiment.identification_snapshot`), '348');
});
