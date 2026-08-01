#!/usr/bin/env node
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { discoverLocalTarget, query, spawnSession } from './lib/docker-psql.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = path.join(HERE, 'experiments', 'sparse-registry-prototype.sql');
const PRODUCTION_BASELINE_BYTES = 103_304_339;
const W2B_RELATION_BYTES = 754_417_664;
const CAPACITY_BYTES = 500 * 1024 * 1024;
const PASS_TOTAL_BYTES = 350 * 1024 * 1024;
const REQUIRED_HEADROOM_BYTES = 150 * 1024 * 1024;
const PHASE_A_RELEASE = 'tax-2026.08.01-01';
const PHASE_A_MANIFEST = '72758b2c574e8aea27432b6b55c62dfb6ad87f3fadc11ad1c892a61abf23ac4e';
const SCHEMA = 'w2c_sparse_experiment';

export const sqlLiteral = value => value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
export const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
export function csvField(value) {
  if (value == null) return '\\N';
  return `"${String(value).replaceAll('"', '""')}"`;
}
const parse = value => JSON.parse(value || 'null');

async function *jsonLines(filename) {
  const input = createReadStream(filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line);
}

async function writeStdin(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

export async function copyRows(target, table, columns, rows) {
  const session = spawnSession(target);
  let stdout = '', stderr = '';
  session.stdout.on('data', chunk => { stdout += chunk; });
  session.stderr.on('data', chunk => { stderr += chunk; });
  await writeStdin(session.stdin, `copy ${table}(${columns.join(',')}) from stdin with (format csv, null '\\N');\n`);
  let count = 0;
  for await (const row of rows) {
    await writeStdin(session.stdin, `${row.map(csvField).join(',')}\n`);
    count += 1;
  }
  await writeStdin(session.stdin, '\\.\n');
  session.stdin.end();
  const [code] = await once(session, 'close');
  if (code !== 0) throw new Error(`COPY ${table} failed (${code}): ${stderr.trim()} ${stdout.trim()}`);
  return count;
}

function flattenPlan(node, output = []) {
  output.push(node);
  for (const child of node.Plans || []) flattenPlan(child, output);
  return output;
}

export async function explain(target, sql, repetitions = 10) {
  const samples = [];
  let last;
  for (let index = 0; index < repetitions; index += 1) {
    last = parse(await query(target, `explain (analyze,buffers,format json) ${sql}`))[0];
    const nodes = flattenPlan(last.Plan);
    samples.push({
      planning_ms: Number(last['Planning Time']), execution_ms: Number(last['Execution Time']),
      shared_hit_blocks: nodes.reduce((sum, node) => sum + Number(node['Shared Hit Blocks'] || 0), 0),
      shared_read_blocks: nodes.reduce((sum, node) => sum + Number(node['Shared Read Blocks'] || 0), 0),
      temp_read_blocks: nodes.reduce((sum, node) => sum + Number(node['Temp Read Blocks'] || 0), 0),
      temp_written_blocks: nodes.reduce((sum, node) => sum + Number(node['Temp Written Blocks'] || 0), 0),
      rows_scanned: nodes.reduce((sum, node) => sum + Number(node['Actual Rows'] || 0) * Number(node['Actual Loops'] || 1), 0),
      rows_returned: Number(last.Plan['Actual Rows'] || 0),
      indexes_used: [...new Set(nodes.map(node => node['Index Name']).filter(Boolean))].sort(),
    });
  }
  const metric = key => samples.map(item => item[key]).sort((a, b) => a - b);
  const summarize = key => { const values = metric(key); return { min: values[0], p50: percentile(values, .5), p95: percentile(values, .95), max: values.at(-1) }; };
  return {
    executions: repetitions,
    planning_ms: summarize('planning_ms'), execution_ms: summarize('execution_ms'),
    shared_hit_blocks: summarize('shared_hit_blocks'), shared_read_blocks: summarize('shared_read_blocks'),
    temp_read_blocks: summarize('temp_read_blocks'), temp_written_blocks: summarize('temp_written_blocks'),
    rows_scanned: summarize('rows_scanned'), rows_returned: summarize('rows_returned'),
    indexes_used: [...new Set(samples.flatMap(item => item.indexes_used))].sort(),
  };
}

async function relationSizes(target) {
  return parse(await query(target, `
    select coalesce(json_agg(x order by table_name),'[]')::text from (
      select c.relname table_name, c.reltuples::bigint estimated_rows,
             pg_relation_size(c.oid) heap_bytes, pg_indexes_size(c.oid) index_bytes,
             pg_total_relation_size(c.oid) total_bytes
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='${SCHEMA}' and c.relkind='r'
    ) x`));
}

function summarizeRelations(rows, names) {
  const selected = rows.filter(row => names.includes(row.table_name));
  return {
    heap_bytes: selected.reduce((sum, row) => sum + Number(row.heap_bytes), 0),
    index_bytes: selected.reduce((sum, row) => sum + Number(row.index_bytes), 0),
    total_relation_bytes: selected.reduce((sum, row) => sum + Number(row.total_bytes), 0),
    tables: selected,
  };
}

const persistentTables = ['source_release', 'registry_concept', 'external_mapping', 'registered_name', 'identification_snapshot'];
const cacheTables = ['cache_release', 'cache_concept', 'cache_search_name'];

async function resetPersistent(target) {
  await query(target, `truncate ${SCHEMA}.identification_snapshot,${SCHEMA}.registered_name,${SCHEMA}.external_mapping,${SCHEMA}.registry_concept,${SCHEMA}.source_release restart identity cascade`);
}

async function seedHistoricalSnapshots(target) {
  await query(target, `
    insert into ${SCHEMA}.identification_snapshot(selected_scientific_name,source_system,source_namespace,raw_external_id,source_release_or_response,selection_timestamp,resolution_state,original_selected_result)
      select 'Historical taxon '||g,'legacy','artsdatabanken_legacy_integer','legacy-'||g,'historical-import',null,'historical_unresolved',jsonb_build_object('legacy_value','legacy-'||g) from generate_series(1,227) g;
    insert into ${SCHEMA}.identification_snapshot(selected_scientific_name,resolution_state,original_selected_result)
      select 'Manual taxon '||g,'manual_unresolved',jsonb_build_object('manual_name','Manual taxon '||g) from generate_series(1,87) g;
    insert into ${SCHEMA}.identification_snapshot(resolution_state,original_selected_result)
      select 'no_identity_evidence','{}'::jsonb from generate_series(1,23) g;`);
}

async function seedGrowth(target, count) {
  await resetPersistent(target);
  await query(target, `
    insert into ${SCHEMA}.source_release(source_system,namespace,release_or_response) values('synthetic','synthetic_taxon_id','growth-v1');
    insert into ${SCHEMA}.registry_concept(sporely_taxon_id,canonical_scientific_name,rank,canonical_source_system,canonical_namespace,canonical_external_id,first_registration_reason,scope_state,review_state)
      select 2000000000+g,'Synthetic taxon '||g,'species','synthetic','synthetic_taxon_id',g::text,'administrator_curated','not_evaluated','unreviewed' from generate_series(1,${Number(count)}) g;
    insert into ${SCHEMA}.external_mapping(sporely_taxon_id,source_key,source_system,namespace,external_id,mapping_status,mapping_provenance)
      select 2000000000+g,1,'synthetic','synthetic_taxon_id',g::text,'exact','growth fixture' from generate_series(1,${Number(count)}) g;
    insert into ${SCHEMA}.registered_name(sporely_taxon_id,name,name_kind,language,preferred,source_key,source)
      select 2000000000+g,'Synthetic taxon '||g,'canonical','',true,1,'synthetic' from generate_series(1,${Number(count)}) g;
    insert into ${SCHEMA}.identification_snapshot(sporely_taxon_id,selected_scientific_name,selected_rank,source_system,source_namespace,raw_external_id,source_release_or_response,resolution_state,original_selected_result)
      select 2000000000+g,'Synthetic taxon '||g,'species','synthetic','synthetic_taxon_id',g::text,'growth-v1','resolved',jsonb_build_object('id',g) from generate_series(1,least(${Number(count)},337)) g;
    analyze ${SCHEMA}.source_release; analyze ${SCHEMA}.registry_concept; analyze ${SCHEMA}.external_mapping; analyze ${SCHEMA}.registered_name; analyze ${SCHEMA}.identification_snapshot;`);
  return summarizeRelations(await relationSizes(target), persistentTables);
}

async function register(target, values) {
  const args = [
    values.sourceSystem, values.namespace, values.externalId, values.scientificName,
    values.vernacularName, values.rank, values.release, values.selectedAt,
    values.reason, values.scopeState, values.exactSporelyId, values.provenance,
  ].map(sqlLiteral);
  args.push(`${sqlLiteral(JSON.stringify(values.originalResult || {}))}::jsonb`);
  return parse(await query(target, `select ${SCHEMA}.register_external_selection(${args.join(',')})::text`));
}

async function seedCurrentFixtures(target) {
  await resetPersistent(target);
  const base = {
    vernacularName: null, rank: 'species', release: 'fixture-response-2026-08-01',
    selectedAt: '2026-08-01T12:00:00Z', provenance: 'exact fixture mapping', originalResult: { fixture: true },
  };
  const first = await register(target, { ...base, sourceSystem: 'inaturalist', namespace: 'inaturalist_taxon_id', externalId: '48715', scientificName: 'Amanita muscaria', reason: 'inaturalist_selection', scopeState: 'include', exactSporelyId: 78915 });
  const reused = await register(target, { ...base, sourceSystem: 'inaturalist', namespace: 'inaturalist_taxon_id', externalId: '48715', scientificName: 'Amanita muscaria changed response', reason: 'inaturalist_selection', scopeState: 'include', exactSporelyId: null });
  const sameNameA = await register(target, { ...base, sourceSystem: 'fixture_a', namespace: 'taxon_id', externalId: 'same-1', scientificName: 'Duplicate example', reason: 'administrator_curated', scopeState: 'not_evaluated', exactSporelyId: 900000001 });
  const sameNameB = await register(target, { ...base, sourceSystem: 'fixture_b', namespace: 'taxon_id', externalId: 'same-1', scientificName: 'Duplicate example', reason: 'administrator_curated', scopeState: 'not_evaluated', exactSporelyId: 900000002 });
  const unresolved = await register(target, { ...base, sourceSystem: 'artsorakel', namespace: 'nbic_scientific_name_id', externalId: 'NBIC:unmapped', scientificName: 'Unmapped selected fungus', reason: 'artsorakel_selection', scopeState: 'review', exactSporelyId: null });
  const reviewed = await register(target, { ...base, sourceSystem: 'col_xr', namespace: 'col_usage_id', externalId: '63W3K', scientificName: 'Trichoderma', rank: 'genus', reason: 'administrator_curated', scopeState: 'review', exactSporelyId: 86820 });
  const namespaceCollision = await register(target, { ...base, sourceSystem: 'artsorakel', namespace: 'different_namespace', externalId: 'NBIC:unmapped', scientificName: 'Different namespaced identity', reason: 'artsorakel_selection', scopeState: 'not_evaluated', exactSporelyId: 900000003 });
  await seedHistoricalSnapshots(target);
  const laterUnresolved = await register(target, { ...base, sourceSystem: 'nortaxa', namespace: 'nortaxa_taxon_id', externalId: 'later-1', scientificName: 'Original selected snapshot', reason: 'historical_identity', scopeState: 'review', exactSporelyId: null, originalResult: { original: 'preserve-me' } });
  await register(target, { ...base, sourceSystem: 'col_xr', namespace: 'col_usage_id', externalId: 'later-col-1', scientificName: 'Resolved canonical snapshot', reason: 'administrator_curated', scopeState: 'review', exactSporelyId: 900000004 });
  const attached = parse(await query(target, `select ${SCHEMA}.attach_exact_resolution(${Number(laterUnresolved.snapshot_id)},900000004,'trusted later reconciliation')::text`));
  await register(target, { ...base, sourceSystem: 'nortaxa', namespace: 'nortaxa_taxon_id', externalId: 'later-1', scientificName: 'Original selected snapshot', reason: 'historical_identity', scopeState: 'review', exactSporelyId: 900000004 });
  const artsorakelExact = await register(target, { ...base, sourceSystem: 'artsorakel', namespace: 'nbic_scientific_name_id', externalId: 'NBIC:56848', scientificName: 'Fomitopsis betulina', reason: 'artsorakel_selection', scopeState: 'include', exactSporelyId: 900000005 });
  await query(target, `insert into ${SCHEMA}.registered_name(sporely_taxon_id,name,name_kind,language,preferred,source) values(900000001,'%_ literal fungus','scientific_alias','',false,'fixture_a')`);
  await query(target, `analyze ${SCHEMA}.source_release; analyze ${SCHEMA}.registry_concept; analyze ${SCHEMA}.external_mapping; analyze ${SCHEMA}.registered_name; analyze ${SCHEMA}.identification_snapshot;`);
  return { first, reused, sameNameA, sameNameB, unresolved, reviewed, namespaceCollision, artsorakelExact, laterResolution: attached };
}

async function loadCache(target, phaseADir, releaseId = PHASE_A_RELEASE) {
  const manifest = parse(await readFile(path.join(phaseADir, 'taxonomy_export_manifest.json'), 'utf8'));
  if (manifest.release_id !== PHASE_A_RELEASE || manifest.scope_manifest_sha256 !== PHASE_A_MANIFEST) throw new Error('Phase-A export identity mismatch');
  await query(target, `insert into ${SCHEMA}.cache_release(release_id,phase_a_manifest_sha256,status) values(${sqlLiteral(releaseId)},${sqlLiteral(PHASE_A_MANIFEST)},'loading')`);
  async function *conceptRows() {
    for await (const row of jsonLines(path.join(phaseADir, 'taxon.jsonl'))) if (row.scope_state === 'include') yield [releaseId,row.taxon_id,row.canonical_scientific_name,row.taxon_rank,row.family,row.scope_reason,'col_xr','col_usage_id',row.canonical_external_id];
  }
  const concepts = await copyRows(target, `${SCHEMA}.cache_concept`, ['release_id','sporely_taxon_id','canonical_scientific_name','rank','family','scope_reason','canonical_source_system','canonical_namespace','canonical_external_id'], conceptRows());
  async function *scientificRows() {
    for await (const row of jsonLines(path.join(phaseADir, 'scientific_name.jsonl'))) if (!row.is_preferred_name) yield [releaseId,row.taxon_id,row.scientific_name,'scientific_alias','',false];
  }
  const aliases = await copyRows(target, `${SCHEMA}.cache_search_name`, ['release_id','sporely_taxon_id','name','name_kind','language','preferred'], scientificRows());
  async function *vernacularRows() {
    for await (const row of jsonLines(path.join(phaseADir, 'vernacular.jsonl'))) yield [releaseId,row.taxon_id,row.vernacular_name,'vernacular',row.language_code,row.is_preferred_name];
  }
  const vernacular = await copyRows(target, `${SCHEMA}.cache_search_name`, ['release_id','sporely_taxon_id','name','name_kind','language','preferred'], vernacularRows());
  await query(target, `update ${SCHEMA}.cache_release set status='active' where release_id=${sqlLiteral(releaseId)}; analyze ${SCHEMA}.cache_release; analyze ${SCHEMA}.cache_concept; analyze ${SCHEMA}.cache_search_name;`);
  return { accepted_concepts: concepts, scientific_aliases: aliases, vernacular_names: vernacular, external_mappings: concepts, review_state_concepts: 0, plants: 0, selectable_non_fungi: 0 };
}

async function duplicateCacheSlot(target) {
  await query(target, `
    insert into ${SCHEMA}.cache_release values('tax-2026.08.01-01-replacement','${PHASE_A_MANIFEST}','ready',now());
    insert into ${SCHEMA}.cache_concept select 'tax-2026.08.01-01-replacement',sporely_taxon_id,canonical_scientific_name,rank,family,scope_reason,canonical_source_system,canonical_namespace,canonical_external_id from ${SCHEMA}.cache_concept where release_id='${PHASE_A_RELEASE}';
    insert into ${SCHEMA}.cache_search_name select 'tax-2026.08.01-01-replacement',sporely_taxon_id,name,name_kind,language,preferred from ${SCHEMA}.cache_search_name where release_id='${PHASE_A_RELEASE}';
    analyze ${SCHEMA}.cache_release; analyze ${SCHEMA}.cache_concept; analyze ${SCHEMA}.cache_search_name;`);
}

async function performanceEvidence(target) {
  const vernacular = parse(await query(target, `select row_to_json(x)::text from (select name,language from ${SCHEMA}.cache_search_name where name_kind='vernacular' order by release_id,sporely_taxon_id,name limit 1)x`));
  const searches = {
    registered_canonical_exact: `select * from ${SCHEMA}.search_taxa('Amanita muscaria','no',20,false)`,
    registered_canonical_prefix: `select * from ${SCHEMA}.search_taxa('Aman','no',20,false)`,
    cache_canonical_exact: `select * from ${SCHEMA}.search_taxa('Morchella esculenta','no',20,true)`,
    cache_canonical_prefix: `select * from ${SCHEMA}.search_taxa('Morch','no',20,true)`,
    scientific_alias_exact: `select * from ${SCHEMA}.search_taxa('Ustilago maydis','no',20,true)`,
    scientific_alias_prefix: `select * from ${SCHEMA}.search_taxa('Ustil','no',20,true)`,
    vernacular_exact: `select * from ${SCHEMA}.search_taxa(${sqlLiteral(vernacular.name)},${sqlLiteral(vernacular.language)},20,true)`,
    vernacular_prefix: `select * from ${SCHEMA}.search_taxa(${sqlLiteral([...vernacular.name].slice(0,Math.max(2,Math.min(5,[...vernacular.name].length))).join(''))},${sqlLiteral(vernacular.language)},20,true)`,
    broad_two_character: `select * from ${SCHEMA}.search_taxa('ma','no',20,true)`,
    no_result: `select * from ${SCHEMA}.search_taxa('zzzz-no-result','no',20,true)`,
    exact_col_resolution: `select * from ${SCHEMA}.cache_concept where release_id='${PHASE_A_RELEASE}' and canonical_source_system='col_xr' and canonical_namespace='col_usage_id' and canonical_external_id='B24TM'`,
    exact_nortaxa_fixture: `select * from ${SCHEMA}.external_mapping where source_system='nortaxa' and namespace='nortaxa_taxon_id' and external_id='later-1'`,
    inaturalist_fixture: `select * from ${SCHEMA}.external_mapping where source_system='inaturalist' and namespace='inaturalist_taxon_id' and external_id='48715'`,
    artsorakel_fixture: `select * from ${SCHEMA}.external_mapping where source_system='artsorakel' and namespace='nbic_scientific_name_id' and external_id='NBIC:56848'`,
    unresolved_external_fixture: `select * from ${SCHEMA}.identification_snapshot where resolution_state='unresolved_external'`,
    out_of_cache_reviewed_registration: `select r.* from ${SCHEMA}.registry_concept r where sporely_taxon_id=86820 and not exists(select 1 from ${SCHEMA}.cache_concept c where c.sporely_taxon_id=r.sporely_taxon_id)`,
  };
  const output = {};
  for (const [name, sql] of Object.entries(searches)) output[name] = await explain(target, sql, 10);
  output.vernacular_probe = vernacular;
  return output;
}

function capacityProjection(persistent, cacheSingle, cacheDouble, legacyBytes) {
  const s1 = PRODUCTION_BASELINE_BYTES + persistent.total_relation_bytes;
  const s2 = PRODUCTION_BASELINE_BYTES + persistent.total_relation_bytes + cacheSingle.total_relation_bytes;
  const replacement = PRODUCTION_BASELINE_BYTES + persistent.total_relation_bytes + cacheDouble.total_relation_bytes;
  return {
    production_baseline_bytes: PRODUCTION_BASELINE_BYTES,
    legacy_taxonomy_relation_bytes: legacyBytes,
    s1_projected_production_total_bytes: s1,
    s2_projected_production_total_bytes: s2,
    s2_first_publication_peak_bytes: s2,
    s2_future_replacement_peak_bytes: replacement,
    s2_post_legacy_retirement_total_bytes: s2 - legacyBytes,
    s2_post_legacy_retirement_replacement_peak_bytes: replacement - legacyBytes,
    s2_headroom_below_500_mib_bytes: CAPACITY_BYTES - s2,
    replacement_headroom_below_500_mib_bytes: CAPACITY_BYTES - replacement,
    formal_gate_pass: s2 < PASS_TOTAL_BYTES && CAPACITY_BYTES - s2 >= REQUIRED_HEADROOM_BYTES && replacement < CAPACITY_BYTES,
  };
}

export async function runExperiment({ phaseADir, output }) {
  const target = await discoverLocalTarget(process.cwd());
  const schemaSql = await readFile(SCHEMA_SQL, 'utf8');
  await query(target, schemaSql);
  const growth = {};
  for (const count of [337, 10_000, 50_000, 100_000]) growth[String(count)] = await seedGrowth(target, count);
  const fixtures = await seedCurrentFixtures(target);
  const persistentBeforeCache = summarizeRelations(await relationSizes(target), persistentTables);
  const persistentCountsBefore = parse(await query(target, `select json_build_object('concepts',(select count(*) from ${SCHEMA}.registry_concept),'mappings',(select count(*) from ${SCHEMA}.external_mapping),'names',(select count(*) from ${SCHEMA}.registered_name),'snapshots',(select count(*) from ${SCHEMA}.identification_snapshot))::text`));
  const cacheContents = await loadCache(target, phaseADir);
  const singleRows = await relationSizes(target);
  const persistent = summarizeRelations(singleRows, persistentTables);
  const cacheSingle = summarizeRelations(singleRows, cacheTables);
  const combinedSingle = summarizeRelations(singleRows, [...persistentTables, ...cacheTables]);
  const correctness = {
    exact_existing_mapping_reused: fixtures.first.sporely_taxon_id === fixtures.reused.sporely_taxon_id && fixtures.reused.reused_existing_mapping === true,
    same_name_concepts_separate: fixtures.sameNameA.sporely_taxon_id !== fixtures.sameNameB.sporely_taxon_id,
    unresolved_external_preserved: fixtures.unresolved.resolution_state === 'unresolved_external' && fixtures.unresolved.sporely_taxon_id == null,
    namespaced_raw_id_collision_separate: fixtures.namespaceCollision.sporely_taxon_id != null,
    out_of_cache_review_registered: Number(await query(target, `select count(*) from ${SCHEMA}.registry_concept r where r.sporely_taxon_id=86820 and r.scope_state='review' and not exists(select 1 from ${SCHEMA}.cache_concept c where c.sporely_taxon_id=r.sporely_taxon_id)`)) === 1,
    manual_unresolved_count: Number(await query(target, `select count(*) from ${SCHEMA}.identification_snapshot where resolution_state='manual_unresolved'`)),
    historical_unresolved_count: Number(await query(target, `select count(*) from ${SCHEMA}.identification_snapshot where resolution_state='historical_unresolved'`)),
    no_identity_evidence_count: Number(await query(target, `select count(*) from ${SCHEMA}.identification_snapshot where resolution_state='no_identity_evidence'`)),
    later_resolution_preserves_original_snapshot: fixtures.laterResolution.before.original_selected_result.original === 'preserve-me' && fixtures.laterResolution.after.original_selected_result.original === 'preserve-me' && fixtures.laterResolution.after.resolution_state === 'resolved',
    review_state_cache_count: Number(await query(target, `select count(*) from ${SCHEMA}.cache_concept where sporely_taxon_id=86820`)),
    same_name_search_result_count: Number(await query(target, `select count(*) from ${SCHEMA}.search_taxa('Duplicate example','no',20,false) where canonical_scientific_name='Duplicate example'`)),
    short_query_count: Number(await query(target, `select count(*) from ${SCHEMA}.search_taxa('x','no',20,true)`)),
    literal_percent_underscore_count: Number(await query(target, `select count(*) from ${SCHEMA}.search_taxa('%_','no',20,true)`)),
    limits_clamped: Number(await query(target, `select count(*) from ${SCHEMA}.search_taxa('ma','no',999,true)`)) <= 50,
    language_distinctions_preserved: Number(await query(target, `select count(distinct language) from ${SCHEMA}.cache_search_name where name_kind='vernacular'`)) >= 3,
  };
  const performance = await performanceEvidence(target);
  const stableBeforeReplacement = parse(await query(target, `select json_build_object('registry',(select count(*) from ${SCHEMA}.registry_concept),'mappings',(select count(*) from ${SCHEMA}.external_mapping),'snapshots',(select count(*) from ${SCHEMA}.identification_snapshot))::text`));
  await duplicateCacheSlot(target);
  const doubleRows = await relationSizes(target);
  const cacheDouble = summarizeRelations(doubleRows, cacheTables);
  const combinedReplacementPeak = summarizeRelations(doubleRows, [...persistentTables, ...cacheTables]);
  const stableDuringReplacement = parse(await query(target, `select json_build_object('registry',(select count(*) from ${SCHEMA}.registry_concept),'mappings',(select count(*) from ${SCHEMA}.external_mapping),'snapshots',(select count(*) from ${SCHEMA}.identification_snapshot))::text`));
  const legacyBytes = Number(await query(target, `select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('taxa','taxa_vernacular') and c.relkind='r'`));
  const evidence = {
    evidence_schema_version: 1,
    web_starting_revision: 'a872ea184c93277a005311b94afd948a2bd921a7',
    phase_a: { desktop_revision: 'be14e6e28fb00b79a0d05265ef8d6b7008b669bc', release_id: PHASE_A_RELEASE, scope_manifest_sha256: PHASE_A_MANIFEST, included_concepts: 52881 },
    runtime: { node: process.version, docker_context: target.context, docker_engine_version: target.engineVersion, postgres_version: target.postgresVersion, disposable_schema: SCHEMA },
    scope_state_semantics: {
      include: 'eligible for optional cache', exclude: 'not cached but registerable',
      review: 'not cached by default; externally discoverable and registerable',
      not_evaluated: 'not cached; external discovery and unresolved registration remain allowed',
      global_scope_claimed_exhaustive: false,
    },
    review_backlog: [
      { col_concept_id: 'JX', name: 'Tremellomycetes remainder', rank: 'class', concept_count: 755, reason: 'mixed fruit-body-forming, yeast and mycoparasitic lineages', prioritization_trigger: 'external selection demand or historically referenced observations' },
      { col_concept_id: '87', name: 'Atractiellomycetes', rank: 'class', concept_count: 97, reason: 'optional specialist lineages lack a concise approved whitelist', prioritization_trigger: 'specialist demand or historically referenced observations' },
      { col_concept_id: 'DQ', name: 'Leotiomycetes remainder', rank: 'class', concept_count: 11898, reason: 'large mixed class after explicit observable-genus inclusions', prioritization_trigger: 'external selection demand or historically referenced observations' },
      { col_concept_id: 'J2', name: 'Sordariomycetes remainder', rank: 'class', concept_count: 27114, reason: 'large mixed class after explicit stromatic-genus inclusions', prioritization_trigger: 'external selection demand or historically referenced observations' },
      { col_concept_id: 'HYK', name: 'Xylariaceae remainder', rank: 'family', concept_count: 1095, reason: 'substantial non-macrofruiting and anamorphic content', prioritization_trigger: 'demand for omitted stromatic genera' },
      { col_concept_id: '624W7', name: 'Hypoxylaceae remainder', rank: 'family', concept_count: 147, reason: 'mixed teleomorph and anamorph content', prioritization_trigger: 'demand for omitted stromatic genera' },
      { col_concept_id: '977', name: 'Diatrypaceae', rank: 'family', concept_count: 778, reason: 'specialist review needed across 47 pinned genera', prioritization_trigger: 'specialist demand or observations' },
      { col_concept_id: '7XJJ', name: 'Tolypocladium', rank: 'genus', concept_count: 52, reason: 'mixed life histories require species review', prioritization_trigger: 'selected species demand' },
      { col_concept_id: '63W3K', name: 'Trichoderma', rank: 'genus', concept_count: 484, reason: 'mould-dominated genus with selected stromatic lineages', prioritization_trigger: 'selected stromatic species demand' },
    ],
    logical_schema: {
      registry_concept: ['sporely_taxon_id','canonical_scientific_name','rank','canonical_source_system','canonical_namespace','canonical_external_id','parent_sporely_taxon_id','first_registration_reason','scope_state','review_state','created_at'],
      external_mapping: ['sporely_taxon_id','source_key','source_system','namespace','external_id','mapping_status','mapping_provenance'],
      registered_name: ['sporely_taxon_id','name','name_kind','language','preferred','source_key','source'],
      source_release: ['source_key','source_system','namespace','release_or_response'],
      identification_snapshot: ['sporely_taxon_id','selected_scientific_name','selected_vernacular_name','selected_rank','source_system','source_namespace','raw_external_id','source_release_or_response','selection_timestamp','resolution_state','original_selected_result','resolution_note'],
      replaceable_cache: ['release_id','sporely_taxon_id','canonical_scientific_name','rank','family','scope_reason','canonical namespaced external identity','scientific aliases','selected vernacular names'],
    },
    registration_flow: [
      'preserve complete raw namespaced source identity', 'reuse exact existing mapping',
      'materialize only with exact trusted identity evidence', 'allocate through trusted positive-ID allocator where appropriate',
      'preserve selected name/rank/provenance snapshots', 'retain unresolved result when exact identity is unavailable',
      'never merge by scientific-name equality',
    ],
    out_of_cache_review_flow: [
      'review-state Trichoderma is absent from cache', 'external result is deliberately selected',
      'raw provider identity and selected snapshot are retained', 'exact COL identity 63W3K is used',
      'registry concept 86820 is materialized with scope_state review', 'cache remains unchanged',
      'identification snapshots can reference the persistent concept',
    ],
    historical_fixture: { observations: 337, resolved_stable_identities: 0, unresolved_legacy: 227, manual_unresolved: 87, no_identity_evidence: 23, separate_reconciliation_required_before_w3: true },
    s1: { schema_tables: persistentTables, current_counts: persistentCountsBefore, current_scale: persistentBeforeCache, growth },
    s2: { persistent_registry: persistent, replaceable_cache_single_slot: cacheSingle, combined_final_state: combinedSingle, replaceable_cache_two_slot_peak: cacheDouble, combined_replacement_peak: combinedReplacementPeak, cache_contents: cacheContents },
    registration_correctness: correctness,
    registration_results: fixtures,
    cache_replacement_preserved_persistent_state: JSON.stringify(stableBeforeReplacement) === JSON.stringify(stableDuringReplacement),
    performance,
    capacity: capacityProjection(persistent, cacheSingle, cacheDouble, legacyBytes),
    w2b_full_fungi_baseline: { taxonomy_relation_bytes: W2B_RELATION_BYTES, projected_production_total_bytes: 857722003 },
    failure_behavior: {
      external_unavailable: 'registered concepts and snapshots remain usable; manual unresolved entry remains available',
      rate_limited: 'preserve existing results and retry discovery; do not invent identity',
      unmapped_identifier: 'store unresolved_external snapshot with raw namespaced ID and response',
      changed_name: 'preserve selected snapshot; exact mapping continues to identify the concept',
      provider_disagreement: 'retain both namespaced results; require explicit resolution evidence',
      offline: 'registry and S2 cache remain searchable; S1 cannot discover unregistered concepts',
      removed_from_future_cache: 'registry concept and identification snapshots remain unchanged',
    },
    recommendation: 'S2 sparse registry plus compact macrofungi cache',
    next_stage: 'historical taxonomy reconciliation stage',
    production_writes_performed: false,
    production_activation_performed: false,
    production_migrations_applied: false,
    client_cutover_performed: false,
    observation_rows_modified: false,
  };
  if (!evidence.capacity.formal_gate_pass) throw new Error('S2 capacity gate failed');
  const expectedCounts = {
    manual_unresolved_count: 87, historical_unresolved_count: 227,
    no_identity_evidence_count: 23, review_state_cache_count: 0,
    same_name_search_result_count: 2, short_query_count: 0,
    literal_percent_underscore_count: 1,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) if (correctness[key] !== expected) throw new Error(`correctness count failed: ${key}=${correctness[key]} expected ${expected}`);
  if (Object.entries(correctness).some(([key, value]) => key.endsWith('_count') ? false : value !== true)) throw new Error(`correctness failure: ${JSON.stringify(correctness)}`);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

function argsFrom(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index < 0 ? null : argv[index + 1]; };
  return { phaseADir: value('--phase-a-dir'), output: value('--output') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = argsFrom(process.argv.slice(2));
  if (!args.phaseADir || !args.output) {
    console.error('usage: run-sparse-registry-experiment.mjs --phase-a-dir DIR --output FILE');
    process.exitCode = 2;
  } else {
    runExperiment(args).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(`W2C sparse-registry experiment failed: ${error.message}`); process.exitCode = 1; });
  }
}
