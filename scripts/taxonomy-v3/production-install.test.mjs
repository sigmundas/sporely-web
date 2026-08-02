import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { discoverLocalTarget, query, queryStdin } from '../taxonomy-v2/lib/docker-psql.mjs';
import { parseCsv, prepareProductionInstall } from './prepare-production-install.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SPORELY_PY = path.resolve(REPO_ROOT, '..', 'sporely-py');
const PRIVATE = {
  baseRelease: path.join(SPORELY_PY, 'database/reference_data/generated/taxonomy_v2/global_macrofungi_tax-2026.08.01-01'),
  supplements: ['/tmp/w2ea2v2-supp-a', '/tmp/w2ebv2-supp-a'],
  reconciliation: '/tmp/w3b-final/reconciliation-manifest.json',
  deploymentManifest: '/tmp/w3b-deployment/deployment-manifest-drift-checked.jsonl',
  approvedDrift: '/tmp/w3b-deployment/approved-drift.json',
  currentObservations: '/tmp/w3b-deployment/current-observations.csv',
};
const integration = process.env.TAXONOMY_V3_PRODUCTION_PAYLOAD_INTEGRATION === '1';

test('production payload generator is local-only and emits guarded transaction SQL', async () => {
  const source = await readFile(path.join(REPO_ROOT, 'scripts/taxonomy-v3/prepare-production-install.mjs'), 'utf8');
  assert.doesNotMatch(source, /discoverLocalTarget|queryStdin|supabase\s+link|db\s+push|fetch\s*\(/);
  assert.match(source, /\\set ON_ERROR_STOP on\nBEGIN;/);
  assert.match(source, /PRIVATE PRODUCTION DATA/);
  assert.match(source, /const PROJECT_REF = 'zkpjklzfwzefhjluvhfw'/);
  assert.match(source, /taxonomy_v3\.install_release_chain/);
  assert.match(source, /taxonomy_v3\.link_observations_to_resolution/);
});

test('integration: generate and apply final production payload to disposable local database', { skip: !integration }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'taxonomy-v3-production-payload-test-'));
  try {
    const output = path.join(tempDir, 'production-install.sql');
    const summary = await prepareProductionInstall({ ...PRIVATE, output });
    assert.equal(summary.bridge_counts.matched_pseudonyms, 369);
    assert.deepEqual(summary.drift_counts, { no_drift: 367, approved_drift: 2, unapproved_drift: 0, observation_missing: 0 });
    assert.equal(summary.expected_counts.external_mapping, 145);

    const sql = await readFile(output, 'utf8');
    assert.ok(sql.startsWith('\\set ON_ERROR_STOP on\nBEGIN;'));
    assert.doesNotMatch(sql, /"observation_id":"obs_/);
    assert.ok(sql.trimEnd().endsWith('COMMIT;'));

    const currentRows = parseCsv(await readFile(PRIVATE.currentObservations, 'utf8'));
    assert.equal(currentRows.length, 369);
    const seedRecords = currentRows.map(row => ({
      id: row.id,
      ...Object.fromEntries([
        'artsdata_id', 'artportalen_id', 'inaturalist_id', 'mushroomobserver_id', 'desktop_id',
        'ai_selected_service', 'ai_selected_taxon_id', 'ai_selected_scientific_name',
        'genus', 'species', 'common_name', 'species_guess',
      ].map(field => [field, !row[field] || row[field].trim().toUpperCase() === 'NULL' ? null : row[field]])),
    }));
    const seedJson = JSON.stringify(seedRecords);
    assert.doesNotMatch(seedJson, /obs_[0-9a-f]+/);
    await queryStdin(target, `
      insert into auth.users (id, aud, role, instance_id, email)
        values ('00000000-0000-0000-0000-000000000041', 'authenticated', 'authenticated',
                '00000000-0000-0000-0000-000000000000', 'production-payload-test@example.local')
        on conflict (id) do nothing;
      insert into public.profiles (id) values ('00000000-0000-0000-0000-000000000041') on conflict (id) do nothing;
      insert into public.observations (
        id, user_id, date, artsdata_id, artportalen_id, inaturalist_id, mushroomobserver_id, desktop_id,
        ai_selected_service, ai_selected_taxon_id, ai_selected_scientific_name,
        genus, species, common_name, species_guess
      ) overriding system value
      select r.id::bigint, '00000000-0000-0000-0000-000000000041'::uuid, '2026-08-02'::date,
             nullif(r.artsdata_id, '')::integer, nullif(r.artportalen_id, '')::integer,
             nullif(r.inaturalist_id, '')::integer, nullif(r.mushroomobserver_id, '')::integer,
             nullif(r.desktop_id, '')::integer, r.ai_selected_service, r.ai_selected_taxon_id,
             r.ai_selected_scientific_name, r.genus, r.species, r.common_name, r.species_guess
        from jsonb_to_recordset($seed$${seedJson}$seed$::jsonb) as r(
          id text, artsdata_id text, artportalen_id text, inaturalist_id text,
          mushroomobserver_id text, desktop_id text, ai_selected_service text,
          ai_selected_taxon_id text, ai_selected_scientific_name text,
          genus text, species text, common_name text, species_guess text
        );
    `);

    assert.equal(Number((await query(target, 'select count(*) from public.observations')).trim()), 369);
    await queryStdin(target, sql);

    const counts = JSON.parse((await query(target, `select json_build_object(
      'release_installation',(select count(*) from taxonomy_v3.release_installation),
      'supplement_installation',(select count(*) from taxonomy_v3.supplement_installation),
      'registry_concept',(select count(*) from taxonomy_v3.registry_concept),
      'external_mapping',(select count(*) from taxonomy_v3.external_mapping),
      'identification_snapshot',(select count(*) from taxonomy_v3.identification_snapshot),
      'resolution_link',(select count(*) from taxonomy_v3.resolution_link),
      'resolved_resolution_rows',(select count(*) from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is not null),
      'null_resolution_rows',(select count(*) from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is null),
      'reconciliation_manifest_audit',(select count(*) from taxonomy_v3.reconciliation_manifest_audit),
      'linked_observations',(select count(*) from public.observations where resolved_sporely_taxon_id is not null),
      'null_observations',(select count(*) from public.observations where resolved_sporely_taxon_id is null)
    )::text`)).trim());
    assert.deepEqual(counts, summary.expected_counts);

    const before = counts;
    await assert.rejects(queryStdin(target, sql), /canonical observation links are already non-NULL|installation tables are not empty/);
    const after = JSON.parse((await query(target, `select json_build_object(
      'release_installation',(select count(*) from taxonomy_v3.release_installation),
      'supplement_installation',(select count(*) from taxonomy_v3.supplement_installation),
      'registry_concept',(select count(*) from taxonomy_v3.registry_concept),
      'external_mapping',(select count(*) from taxonomy_v3.external_mapping),
      'identification_snapshot',(select count(*) from taxonomy_v3.identification_snapshot),
      'resolution_link',(select count(*) from taxonomy_v3.resolution_link),
      'resolved_resolution_rows',(select count(*) from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is not null),
      'null_resolution_rows',(select count(*) from taxonomy_v3.resolution_link where resolved_sporely_taxon_id is null),
      'reconciliation_manifest_audit',(select count(*) from taxonomy_v3.reconciliation_manifest_audit),
      'linked_observations',(select count(*) from public.observations where resolved_sporely_taxon_id is not null),
      'null_observations',(select count(*) from public.observations where resolved_sporely_taxon_id is null)
    )::text`)).trim());
    assert.deepEqual(after, before, 'failed replay must not change installed state');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('integration: deployment-manifest tampering is rejected before output', { skip: !integration }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'taxonomy-v3-production-payload-tamper-'));
  try {
    const tampered = path.join(tempDir, 'deployment.jsonl');
    const lines = (await readFile(PRIVATE.deploymentManifest, 'utf8')).trimEnd().split('\n');
    const record = JSON.parse(lines[1]);
    record.drift_status = 'unapproved_drift';
    lines[1] = JSON.stringify(record);
    await writeFile(tampered, `${lines.join('\n')}\n`);
    await assert.rejects(
      prepareProductionInstall({ ...PRIVATE, deploymentManifest: tampered, output: path.join(tempDir, 'must-not-exist.sql') }),
      /deployment manifest raw SHA-256 is not the frozen drift-checked input/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
