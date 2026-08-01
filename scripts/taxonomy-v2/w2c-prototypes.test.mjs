import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { discoverLocalTarget, query } from './lib/docker-psql.mjs';

test('W2C prototype is experimental and preserves the search boundary', async () => {
  const sql = await readFile(new URL('./w2c-prototypes.sql', import.meta.url), 'utf8');
  assert.match(sql, /taxonomy_v2_experiment_c/);
  assert.doesNotMatch(sql, /create schema public/i);
  assert.match(sql, /scientific_name is distinct from t\.canonical_scientific_name/);
  assert.match(sql, /like q\.escaped\|\|'%' escape/);
  assert.match(sql, /greatest\(1,least\(coalesce\(p_limit,20\),50\)\)/);
  assert.match(sql, /active_publication/);
});

test('W2C complete local prototype preserves named semantics', { skip: process.env.W2C_INTEGRATION !== '1' }, async () => {
  const target = await discoverLocalTarget();
  const rows = JSON.parse(await query(target, `select jsonb_agg(x) from (
    select * from taxonomy_v2_experiment_c.search('Psathyrella candolleana')
  ) x`));
  assert.equal(rows[0].sporely_taxon_id, 133345);
  assert.equal(rows[0].ranking_class, 2);
  assert.equal(await query(target, `select count(*) from taxonomy_v2_experiment_c.search('C')`), '0');
  assert.equal(await query(target, `select count(*) from taxonomy_v2_experiment_c.external_id_exceptions`), '0');
  assert.equal(await query(target, `select count(*) from taxonomy_v2_experiment_c.taxa where slot=(select slot from taxonomy_v2_experiment_c.active_publication)`), '634894');
});
