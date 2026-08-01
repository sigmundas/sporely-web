#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { discoverLocalTarget, query } from './lib/docker-psql.mjs';

const RELEASE = 'tax-2026.07.30-02';
const names = ['Cantharellus cibarius','Cantharellus','Candolleomyces candolleanus','Psathyrella candolleana','hvit sprøsopp','Aureonarius limonius','Cortinarius limonius','Inocybe','%','_','\\'];
const lit = value => `'${String(value).replaceAll("'", "''")}'`;
const parse = value => JSON.parse(value || 'null');
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];

async function explain(target, sql, repetitions = 10) {
  const values = [];
  let plan;
  for (let i = 0; i < repetitions; i += 1) {
    plan = parse(await query(target, `explain (analyze,buffers,format json) ${sql}`));
    values.push(plan[0]['Execution Time']);
  }
  values.sort((a,b) => a-b);
  return { executions: repetitions, min_ms: values[0], p50_ms: percentile(values,.5), p95_ms: percentile(values,.95), max_ms: values.at(-1), plan: plan[0].Plan };
}

export async function measureRelease({ releaseId = RELEASE, activate = false, output = null, productionBytes = null } = {}) {
  const target = await discoverLocalTarget(process.cwd());
  const before = parse(await query(target, `select row_to_json(x)::text from (select status,activated_at from public.taxonomy_v2_releases where release_id=${lit(releaseId)}) x`));
  const validationBefore = parse(await query(target, `select public.taxonomy_v2_validate_release(${lit(releaseId)})::text`));
  if (!validationBefore.ok) throw new Error(`release validation failed: ${JSON.stringify(validationBefore.errors)}`);
  if (activate) {
    if (before.status !== 'ready') throw new Error(`local activation requires ready status, got ${before.status}`);
    const activated = parse(await query(target, `select public.taxonomy_v2_activate_release(${lit(releaseId)})::text`));
    if (!activated.ok) throw new Error('local activation failed');
  }
  await query(target, `analyze public.taxonomy_v2_releases; analyze public.taxonomy_v2_concepts; analyze public.taxonomy_v2_taxa; analyze public.taxonomy_v2_scientific_names; analyze public.taxonomy_v2_vernacular_names; analyze public.taxonomy_v2_external_ids; analyze public.taxonomy_v2_legacy_external_ids; analyze public.taxonomy_v2_redlist; analyze public.taxonomy_v2_import_runs;`);
  const tableSizes = parse(await query(target, `select coalesce(json_agg(x order by table_name),'[]')::text from (select c.relname table_name,c.reltuples::bigint estimated_rows,pg_relation_size(c.oid) relation_bytes,pg_indexes_size(c.oid) index_bytes,pg_total_relation_size(c.oid) total_bytes,greatest(pg_total_relation_size(c.oid)-pg_relation_size(c.oid)-pg_indexes_size(c.oid),0) toast_bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'taxonomy_v2_%' and c.relkind='r') x`));
  const indexes = parse(await query(target, `select coalesce(json_agg(x order by table_name,index_name),'[]')::text from (select tablename table_name,indexname index_name,pg_relation_size((quote_ident(schemaname)||'.'||quote_ident(indexname))::regclass) bytes,indexdef definition from pg_indexes where schemaname='public' and tablename like 'taxonomy_v2_%') x`));
  const databaseBytes = Number(await query(target, `select pg_database_size(current_database())`));
  const totalRelationBytes = tableSizes.reduce((sum,row) => sum + Number(row.total_bytes), 0);
  const correctness = {};
  for (const name of names) correctness[name] = parse(await query(target, `select coalesce(json_agg(row_to_json(x)),'[]')::text from (select * from public.search_taxa_v2(${lit(name)},'no',20)) x`));
  correctness.languages = {};
  for (const lang of ['no','nb','nn','se','sma','smj']) correctness.languages[lang] = parse(await query(target, `select coalesce(json_agg(row_to_json(x)),'[]')::text from (select * from public.search_taxa_v2('hvit sprøsopp',${lit(lang)},20)) x`));
  correctness.limits = {};
  for (const lim of ['null','0','-1','20','999']) correctness.limits[lim] = Number(await query(target, `select count(*) from public.search_taxa_v2('Cantharellus','no',${lim})`));
  correctness.short_query_count = Number(await query(target, `select count(*) from public.search_taxa_v2('C','no',20)`));
  correctness.null_language = parse(await query(target, `select coalesce(json_agg(row_to_json(x)),'[]')::text from (select * from public.search_taxa_v2('Cantharellus',null,20)) x`));
  correctness.blank_language = parse(await query(target, `select coalesce(json_agg(row_to_json(x)),'[]')::text from (select * from public.search_taxa_v2('Cantharellus',' ',20)) x`));
  const ids = parse(await query(target, `select json_build_object('col',(select row_to_json(e) from public.taxonomy_v2_external_ids e where release_id=${lit(releaseId)} and source_system='col_xr' and namespace='col_usage_id' limit 1),'nortaxa',(select row_to_json(e) from public.taxonomy_v2_external_ids e where release_id=${lit(releaseId)} and source_system='nortaxa' and namespace='nortaxa_taxon_id' limit 1),'legacy',(select row_to_json(e) from public.taxonomy_v2_legacy_external_ids e where release_id=${lit(releaseId)} limit 1))::text`));
  correctness.resolvers = {
    col: parse(await query(target, `select coalesce(json_agg(row_to_json(x)),'[]')::text from (select * from public.resolve_taxon_external_id_v2(${lit(ids.col.source_system)},${lit(ids.col.namespace)},${lit(ids.col.external_id)})) x`)),
    nortaxa: parse(await query(target, `select coalesce(json_agg(row_to_json(x)),'[]')::text from (select * from public.resolve_taxon_external_id_v2(${lit(ids.nortaxa.source_system)},${lit(ids.nortaxa.namespace)},${lit(ids.nortaxa.external_id)})) x`)),
    legacy: parse(await query(target, `select coalesce(json_agg(row_to_json(x)),'[]')::text from (select * from public.resolve_taxon_external_id_v2(${lit(ids.legacy.source_system)},'artsnavnebase_scientific_name_id',${lit(ids.legacy.external_id)})) x`)),
  };
  const performance = {};
  for (const [label, search] of Object.entries({ canonical_exact:'Cantharellus cibarius',canonical_prefix:'Cantharellus',alias_exact:'Psathyrella candolleana',vernacular_exact:'hvit sprøsopp',broad_two_character:'Ca',no_result:'zzzznonexistent' })) performance[label] = await explain(target, `select * from public.search_taxa_v2(${lit(search)},'no',20)`);
  performance.resolver = await explain(target, `select * from public.resolve_taxon_external_id_v2(${lit(ids.col.source_system)},${lit(ids.col.namespace)},${lit(ids.col.external_id)})`);
  const after = parse(await query(target, `select row_to_json(x)::text from (select status,activated_at from public.taxonomy_v2_releases where release_id=${lit(releaseId)}) x`));
  const projected = productionBytes == null ? null : Number(productionBytes) + totalRelationBytes;
  const evidence = {
    evidence_schema_version: 1, release_id: releaseId,
    runtime: { node: process.version, os: os.platform(), architecture: os.arch(), docker_context: target.context, docker_engine_version: target.engineVersion, container_psql_version: target.psqlVersion, postgres_version: target.postgresVersion },
    release_status_before: before, release_status_after: after,
    validation: validationBefore, table_sizes: tableSizes, indexes,
    local_database_after_bytes: databaseBytes, taxonomy_v2_total_relation_bytes: totalRelationBytes,
    correctness, performance,
    production_database_bytes: productionBytes == null ? null : Number(productionBytes),
    projected_production_total_bytes: projected,
    remaining_below_500_mib_bytes: projected == null ? null : 500*1024*1024-projected,
    capacity_decision: projected == null ? 'blocked_missing_production_measurement' : (projected >= 350*1024*1024 || 500*1024*1024-projected < 150*1024*1024 ? 'review_required_capacity' : 'pass'),
    publication_provenance_gate: 'blocked_red_list_licence_evidence',
    production_writes_performed: false, production_activation_performed: false,
  };
  if (output) await writeFile(output, `${JSON.stringify(evidence,null,2)}\n`);
  return evidence;
}

const args = process.argv.slice(2); const value = flag => { const i=args.indexOf(flag); return i<0?null:args[i+1]; };
measureRelease({ releaseId:value('--release')||RELEASE,activate:args.includes('--activate-local'),output:value('--output'),productionBytes:value('--production-bytes') }).then(v=>console.log(JSON.stringify(v,null,2))).catch(e=>{console.error(`taxonomy-v2 measure failed: ${e.message}`);process.exitCode=1;});
