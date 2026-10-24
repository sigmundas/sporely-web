import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { discoverLocalTarget, query, queryStdin, spawnSession } from './lib/docker-psql.mjs';
import { prepareProductionReleaseImport } from './prepare-production-release-import.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RELEASE_DIR = path.resolve(REPO_ROOT, '..', 'sporely-py/database/reference_data/generated/taxonomy_v2/global_macrofungi_tax-2026.08.01-01');
const RELEASE_ID = 'tax-2026.08.01-01';
// The 08.01-01 fixture predates release_approval and is not a pinned
// production rollback target, so the importer now refuses it by design.
const integration = false && process.env.TAXONOMY_V2_PRODUCTION_IMPORT_INTEGRATION === '1';

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

test('the release to import must be named explicitly and match the export', { skip: !existsSync(RELEASE_DIR) }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'taxonomy-v2-release-id-test-'));
  try {
    const output = path.join(tempDir, 'refused.sql');
    await assert.rejects(prepareProductionReleaseImport({ releaseDir: RELEASE_DIR, output }), /release ID is required/);
    await assert.rejects(prepareProductionReleaseImport({ releaseDir: RELEASE_DIR, output, releaseId: 'latest' }), /must look like tax-YYYY/);
    await assert.rejects(prepareProductionReleaseImport({ releaseDir: RELEASE_DIR, output, releaseId: 'tax-2099.01.01-01' }), /release ID must be tax-2099\.01\.01-01/);
    assert.equal(existsSync(output), false, 'a refused preparation writes nothing');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('integration: generated full release payload imports, validates, activates, and protects legacy state', { skip: !integration && 'tax-2026.08.01-01 fixture has no release_approval and is not a pinned pre-marker release; the importer refuses it by design' }, async () => {
  const target = await discoverLocalTarget(REPO_ROOT);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'taxonomy-v2-production-import-test-'));
  try {
    const output = path.join(tempDir, `${RELEASE_ID}-import.sql`);
    const prepared = await prepareProductionReleaseImport({ releaseDir: RELEASE_DIR, output, releaseId: RELEASE_ID });
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

    const owner = '00000000-0000-0000-0000-000000000041';
    const other = '00000000-0000-0000-0000-000000000042';
    const historicalBefore = await query(target, "select json_build_object('rows',count(*),'resolved',count(*) filter (where resolved_sporely_taxon_id is not null),'nulls',count(*) filter (where resolved_sporely_taxon_id is null))::text from taxonomy_v3.resolution_link");
    await queryStdin(target, `
      insert into auth.users (id, aud, role, instance_id, email) values
        ('${owner}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', 'taxonomy-owner@example.local'),
        ('${other}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', 'taxonomy-other@example.local')
        on conflict (id) do nothing;
      insert into public.profiles (id) values ('${owner}'), ('${other}') on conflict (id) do nothing;
      insert into public.observations (id, user_id, date, genus, species, common_name, visibility, is_draft)
        overriding system value values
        (901041, '${owner}', '2026-08-02', 'Crystallocystidium', 'albescens', null, 'private', false),
        (901042, '${owner}', '2026-08-02', 'LegacyGenus', 'legacy-species', 'Legacy name', 'private', false)
        on conflict (id) do update set user_id=excluded.user_id;
    `);
    await queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); select public.set_observation_selected_taxon_v2(901041,167); commit;`);
    assert.equal(await query(target, 'select selected_sporely_taxon_id from public.observations where id=901041'), '167');
    assert.equal(await query(target, "select count(*) from public.observations where id=901041 and artsdata_id is null and artportalen_id is null and inaturalist_id is null and mushroomobserver_id is null and desktop_id is null and genus='Crystallocystidium' and species='albescens'"), '1');
    assert.equal(await query(target, 'select selected_sporely_taxon_id is null from public.observations where id=901042'), 't');
    await assert.rejects(queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${other}',true); select public.set_observation_selected_taxon_v2(901041,167); commit;`), /does not own/);
    await assert.rejects(queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); select public.set_observation_selected_taxon_v2(901041,999999999); commit;`), /missing from the active taxonomy-v2 release/);
    await assert.rejects(queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); update public.observations set selected_sporely_taxon_id=168 where id=901041; commit;`), /must be changed through set_observation_selected_taxon_v2/);
    await queryStdin(target, `begin; set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); select public.set_observation_selected_taxon_v2(901041,null); commit;`);
    assert.equal(await query(target, 'select selected_sporely_taxon_id is null from public.observations where id=901041'), 't');
    assert.equal(await query(target, "select json_build_object('rows',count(*),'resolved',count(*) filter (where resolved_sporely_taxon_id is not null),'nulls',count(*) filter (where resolved_sporely_taxon_id is null))::text from taxonomy_v3.resolution_link"), historicalBefore);

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

// Taxonomy v3 Stage 4W: the production preparation accepts Stage 4P Dyntaxa
// bridge rows and Swedish names exactly as the sporely-py export contract
// documents them, and refuses unreviewed or ambiguous Dyntaxa rows. Pure
// file-level test on a synthetic production-format release; no database.
const { createHash: stage4wHash } = await import('node:crypto');
const { writeFile: stage4wWrite } = await import('node:fs/promises');
const STAGE4W_RELEASE = 'tax-2026.09.30-01';
const dyntaxaRow = { external_id: 'urn:lsid:dyntaxa.se:Taxon:3423', external_name: 'Pholiotina rugosa', id_role: 'accepted', is_preferred: false, namespace: 'dyntaxa_taxon_id', note: 'authoritative_bridge:manual_approved_exact', source_system: 'dyntaxa', taxon_id: 83668 };
const national = (sv) => Object.fromEntries(['no', 'sv'].flatMap(c => ['', '_source_system', '_namespace', '_external_id'].map(s => [`preferred_scientific_name_${c}${s}`, null])).concat(sv ? [['preferred_scientific_name_sv', 'Pholiotina rugosa'], ['preferred_scientific_name_sv_source_system', 'dyntaxa'], ['preferred_scientific_name_sv_namespace', 'dyntaxa_taxon_id'], ['preferred_scientific_name_sv_external_id', 'urn:lsid:dyntaxa.se:Taxon:3423']] : []));
const APPROVED = { status: 'candidate_build_only', export_use: 'release', importable: true, decision: { content_release_id: STAGE4W_RELEASE, sqlite_sha256: 'b'.repeat(64), approved_by: 'test', approved_at: '2026-10-23T00:00:00Z', decision_reference: 'test' } };
async function stage4wRelease(externalExtra, { withDyntaxa = true, approval = APPROVED, gz = 'a'.repeat(64), sqliteSha = 'b'.repeat(64) } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage4w-release-'));
  const sha = bytes => stage4wHash('sha256').update(bytes).digest('hex');
  const taxon = (id, genus, epithet, rank, extra = {}) => ({ canonical_external_id: `COL-${id}`, canonical_scientific_name: epithet ? `${genus} ${epithet}` : genus, canonical_source_system: 'col_xr', family: 'Bolbitiaceae', genus, parent_taxon_id: null, source_system: 'col_xr', specific_epithet: epithet, taxon_id: id, taxon_rank: rank, taxonomic_status: 'accepted', ...national(false), ...extra });
  const data = {
    'taxonomy_release.jsonl': [{ content_release_id: STAGE4W_RELEASE, taxonomy_schema_version: 2, scope_predicate_id: 'global_macrofungi_policy_v1', source_gz_sha256: gz }],
    'taxon.jsonl': [taxon(83668, 'Conocybe', 'rugosa', 'species', national(withDyntaxa)), taxon(617026, 'Conocybe', 'vexans', 'species'), taxon(900, 'Conocybe', '', 'genus')],
    'scientific_name.jsonl': [...(withDyntaxa ? [{ taxon_id: 83668, language_code: 'sci', scientific_name: 'Pholiotina rugosa', is_preferred_name: false, source: 'dyntaxa', note: 'manual_approved_exact' }] : []), { taxon_id: 83668, language_code: 'sci', scientific_name: 'Pholiotina rugosa', is_preferred_name: false, source: 'nortaxa', note: 'manual_approved_exact' }],
    'vernacular.jsonl': [{ taxon_id: 83668, language_code: 'nb', vernacular_name: 'slank ringkjeglesopp', is_preferred_name: true, source: 'nortaxa' }],
    'taxon_external_id.jsonl': [{ external_id: 'COL-83668', external_name: 'Conocybe rugosa', id_role: 'accepted', is_preferred: true, namespace: 'col_usage_id', note: null, source_system: 'col_xr', taxon_id: 83668 }, { external_id: 'COL-617026', external_name: 'Conocybe vexans', id_role: 'accepted', is_preferred: true, namespace: 'col_usage_id', note: null, source_system: 'col_xr', taxon_id: 617026 }, ...(withDyntaxa ? [dyntaxaRow] : []), ...externalExtra],
    'taxon_external_id_legacy_integer.jsonl': [],
    'taxon_redlist.jsonl': [],
  };
  const files = [];
  let total = 0;
  for (const [name, rows] of Object.entries(data)) {
    const bytes = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
    await stage4wWrite(path.join(root, name), bytes);
    files.push({ name, bytes: bytes.length, sha256: sha(bytes), row_count: rows.length });
    total += bytes.length;
  }
  const scope = Buffer.from(JSON.stringify({ release_id: STAGE4W_RELEASE, policy_sha256: 'p', source_hashes: { sqlite_gz_sha256: gz } }));
  await stage4wWrite(path.join(root, 'scope-manifest.json'), scope);
  const archive = Buffer.from('archive');
  await stage4wWrite(path.join(root, 'scoped-export.jsonl.gz'), archive);
  await stage4wWrite(path.join(root, `desktop-${STAGE4W_RELEASE}.sqlite3`), 'sqlite');
  await stage4wWrite(path.join(root, `desktop-${STAGE4W_RELEASE}.sqlite3.gz`), 'sqlite-gz');
  await stage4wWrite(path.join(root, 'taxonomy_export_manifest.json'), JSON.stringify({ format: 'sporely-global-macrofungi-export-v1', release_id: STAGE4W_RELEASE, files, source_hashes: { sqlite_gz_sha256: gz, ...(sqliteSha ? { sqlite_sha256: sqliteSha } : {}) }, scope_manifest_sha256: sha(scope), policy_sha256: 'p', compressed_dataset_bytes: archive.length, compressed_dataset_sha256: sha(archive), uncompressed_dataset_bytes: total, ...(approval === 'absent' ? {} : { release_approval: approval }) }));
  return root;
}

test('Stage 4W: production preparation carries Dyntaxa bridges, Swedish names and a resolver probe', async () => {
  const root = await stage4wRelease([]);
  const out = await mkdtemp(path.join(os.tmpdir(), 'stage4w-out-'));
  try {
    const prepared = await prepareProductionReleaseImport({ releaseDir: root, output: path.join(out, 'import.sql'), releaseId: STAGE4W_RELEASE });
    const sql = await readFile(prepared.generated_sql_path, 'utf8');
    assert.match(sql, /"source_system":"dyntaxa"/);
    assert.match(sql, /preferred_scientific_name_sv_external_id/);
    assert.match(sql, /taxonomy_v2_national_name_errors\('tax-2026\.09\.30-01'\)/);
    assert.match(sql, /to_regprocedure\('public\.taxonomy_v2_national_name_errors\(text\)'\) IS NULL/);
    assert.match(sql, /resolve_taxon_external_id_v2\('dyntaxa','dyntaxa_taxon_id','urn:lsid:dyntaxa\.se:Taxon:3423'\)\) <> 1/);
    assert.match(sql, /WHERE taxon_id=83668\)/);
    assert.match(sql, /resolve_taxon_external_id_v2\('dyntaxa','dyntaxa_taxon_id','3423'\)/);
    assert.doesNotMatch(sql, /undefined/);
    assert.ok(sql.includes("FROM (VALUES ('Conocybe rugosa'),('Pholiotina rugosa'),('Conocybe'),('slank ringkjeglesopp')) probe(query);"));
  } finally { await rm(root, { recursive: true }); await rm(out, { recursive: true }); }
});

for (const [label, extra, pattern] of [
  ['an automatic Dyntaxa row', [{ ...dyntaxaRow, external_id: 'urn:lsid:dyntaxa.se:Taxon:1', taxon_id: 617026, note: 'automatic_exact_name' }], /not an authoritative reviewed bridge/],
  ['an ambiguous Dyntaxa LSID', [{ ...dyntaxaRow, taxon_id: 617026 }], /ambiguous across concepts/],
  ['a bare Dyntaxa number', [{ ...dyntaxaRow, external_id: '3957', taxon_id: 617026 }], /Taxon:<n> LSID/],
  ['a Dyntaxa row on a missing concept', [{ ...dyntaxaRow, external_id: 'urn:lsid:dyntaxa.se:Taxon:3957', taxon_id: 424242 }], /not in taxon\.jsonl/],
]) test(`Stage 4W: production preparation refuses ${label}`, async () => {
  const root = await stage4wRelease(extra);
  const out = await mkdtemp(path.join(os.tmpdir(), 'stage4w-out-'));
  try {
    await assert.rejects(prepareProductionReleaseImport({ releaseDir: root, output: path.join(out, 'import.sql'), releaseId: STAGE4W_RELEASE }), pattern);
    assert.equal(existsSync(path.join(out, 'import.sql')), false);
  } finally { await rm(root, { recursive: true }); await rm(out, { recursive: true }); }
});

test('Stage 4W: production preparation of a release without Dyntaxa is unchanged and has no Dyntaxa probe', async () => {
  const root = await stage4wRelease([], { withDyntaxa: false });
  const out = await mkdtemp(path.join(os.tmpdir(), 'stage4w-out-'));
  try {
    const prepared = await prepareProductionReleaseImport({ releaseDir: root, output: path.join(out, 'import.sql'), releaseId: STAGE4W_RELEASE });
    const sql = await readFile(prepared.generated_sql_path, 'utf8');
    assert.doesNotMatch(sql, /undefined/);
    assert.doesNotMatch(sql, /Dyntaxa resolver probe/);
    assert.ok(sql.includes("FROM (VALUES ('Conocybe rugosa'),('Pholiotina rugosa'),('Conocybe'),('slank ringkjeglesopp')) probe(query);"));
    assert.match(sql, /taxonomy_v2_national_name_errors\('tax-2026\.09\.30-01'\)/);
  } finally { await rm(root, { recursive: true }); await rm(out, { recursive: true }); }
});

// Release approval: the scoped export manifest's release_approval marker.
const VALIDATION_ONLY = { status: 'candidate_build_only', export_use: 'candidate_validation_only', importable: false };
for (const [label, options, pattern] of [
  ['a validation-only candidate export', { approval: VALIDATION_ONLY }, /not importable \(export_use: candidate_validation_only\)/],
  ['an export without release_approval that is not a pinned pre-marker release', { approval: 'absent' }, /no release_approval and is not a pinned pre-marker release/],
  ['a stripped marker on a pinned release ID with a different source', { approval: 'absent', gz: 'c'.repeat(64) }, /not a pinned pre-marker release/],
  ['an approval bound to another release', { approval: { ...APPROVED, decision: { ...APPROVED.decision, content_release_id: 'tax-2026.10.23-01' } } }, /bound to a different release/],
  ['an importable marker without a decision', { approval: { ...APPROVED, decision: undefined } }, /no bound release decision/],
  ['a null marker', { approval: null }, /must be an object/],
  ['an approval whose SQLite hash differs from the exported source', { sqliteSha: 'd'.repeat(64) }, /does not match the exported source/],
  ['an approval without source_hashes.sqlite_sha256', { sqliteSha: null }, /no source_hashes\.sqlite_sha256/],
  ['a non-hex source SQLite hash', { sqliteSha: 'B'.repeat(64) }, /no source_hashes\.sqlite_sha256/],
  ['a validation-only export with a matching SQLite hash', { approval: VALIDATION_ONLY }, /not importable/],
]) test(`release approval: production preparation refuses ${label}`, async () => {
  const root = await stage4wRelease([], options);
  const out = await mkdtemp(path.join(os.tmpdir(), 'approval-out-'));
  try {
    await assert.rejects(prepareProductionReleaseImport({ releaseDir: root, output: path.join(out, 'import.sql'), releaseId: STAGE4W_RELEASE }), pattern);
    assert.equal(existsSync(path.join(out, 'import.sql')), false);
  } finally { await rm(root, { recursive: true }); await rm(out, { recursive: true }); }
});

test('release approval: an approved export and a pinned pre-marker release both prepare', async () => {
  for (const options of [{}, { approval: 'absent', sqliteSha: null, gz: '593cd5379bffd53a81a54735ab0ad99b97e7ef890060d6483bed42e4150e907f' }]) {
    const root = await stage4wRelease([], options);
    const out = await mkdtemp(path.join(os.tmpdir(), 'approval-out-'));
    try {
      const prepared = await prepareProductionReleaseImport({ releaseDir: root, output: path.join(out, 'import.sql'), releaseId: STAGE4W_RELEASE });
      assert.ok(existsSync(prepared.generated_sql_path));
    } finally { await rm(root, { recursive: true }); await rm(out, { recursive: true }); }
  }
});

// Release preparation only (owner approval of preparation, not of import): a
// local_rehearsal export prepares only in local-rehearsal mode, and that SQL
// refuses to run on any database without the rehearsal marker table.
const REHEARSAL = { status: 'pending:candidate_build_only', export_use: 'local_rehearsal', importable: false, decision: { decision: 'release_preparation_approved', content_release_id: STAGE4W_RELEASE, sqlite_sha256: 'b'.repeat(64), approved_by: 'test', approved_at: '2026-10-24', decision_reference: 'test' } };
test('preparation only: the production path refuses a local-rehearsal export', async () => {
  const root = await stage4wRelease([], { approval: REHEARSAL });
  const out = await mkdtemp(path.join(os.tmpdir(), 'rehearsal-out-'));
  try {
    await assert.rejects(prepareProductionReleaseImport({ releaseDir: root, output: path.join(out, 'import.sql'), releaseId: STAGE4W_RELEASE }), /not importable \(export_use: local_rehearsal\)/);
    assert.equal(existsSync(path.join(out, 'import.sql')), false);
  } finally { await rm(root, { recursive: true }); await rm(out, { recursive: true }); }
});

test('preparation only: local-rehearsal SQL carries the marker guard before any write', async () => {
  const root = await stage4wRelease([], { approval: REHEARSAL });
  const out = await mkdtemp(path.join(os.tmpdir(), 'rehearsal-out-'));
  try {
    const prepared = await prepareProductionReleaseImport({ releaseDir: root, output: path.join(out, 'import.sql'), releaseId: STAGE4W_RELEASE, localRehearsal: true });
    const sql = await readFile(prepared.generated_sql_path, 'utf8');
    const guard = sql.indexOf("to_regclass('public.sporely_local_rehearsal_marker') IS NULL");
    assert.ok(guard > 0 && guard < sql.indexOf('pg_advisory_xact_lock') && guard < sql.indexOf('INSERT INTO'));
    assert.match(sql, /LOCAL REHEARSAL TAXONOMY IMPORT \(NOT FOR PRODUCTION\)/);
    assert.doesNotMatch(prepared.containerised_psql_command, /production-db\.env/);
  } finally { await rm(root, { recursive: true }); await rm(out, { recursive: true }); }
});

for (const [label, approval, pattern] of [
  ['an importable release export', APPROVED, /needs a local_rehearsal export/],
  ['a validation-only export', VALIDATION_ONLY, /needs a local_rehearsal export/],
  ['a rehearsal export bound to another release', { ...REHEARSAL, decision: { ...REHEARSAL.decision, content_release_id: 'tax-2026.10.23-01' } }, /bound to a different release/],
  ['a rehearsal export without a preparation decision', { ...REHEARSAL, decision: { ...REHEARSAL.decision, decision: 'pending' } }, /no bound preparation decision/],
]) test(`preparation only: local rehearsal refuses ${label}`, async () => {
  const root = await stage4wRelease([], { approval });
  const out = await mkdtemp(path.join(os.tmpdir(), 'rehearsal-out-'));
  try {
    await assert.rejects(prepareProductionReleaseImport({ releaseDir: root, output: path.join(out, 'import.sql'), releaseId: STAGE4W_RELEASE, localRehearsal: true }), pattern);
  } finally { await rm(root, { recursive: true }); await rm(out, { recursive: true }); }
});
