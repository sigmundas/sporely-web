import { discoverLocalTarget, query } from './lib/docker-psql.mjs';

const target = await discoverLocalTarget();
const cases = {
  canonical_exact: `select * from taxonomy_v2_experiment_c.taxa where slot=1 and lower(canonical_scientific_name) like 'cantharellus cibarius%' escape '\\' order by (lower(canonical_scientific_name)='cantharellus cibarius') desc limit 20`,
  canonical_prefix: `select * from taxonomy_v2_experiment_c.taxa where slot=1 and lower(canonical_scientific_name) like 'cantharellus%' escape '\\' limit 20`,
  alias_exact: `select * from taxonomy_v2_experiment_c.scientific_aliases where slot=1 and lower(scientific_name) like 'psathyrella candolleana%' escape '\\' order by (lower(scientific_name)='psathyrella candolleana') desc limit 20`,
  alias_prefix: `select * from taxonomy_v2_experiment_c.scientific_aliases where slot=1 and lower(scientific_name) like 'psathyrella cand%' escape '\\' limit 20`,
  vernacular_exact: `select * from taxonomy_v2_experiment_c.vernacular_names where slot=1 and language_code=1 and lower(vernacular_name) like 'hvit sprøsopp%' escape '\\' order by (lower(vernacular_name)='hvit sprøsopp') desc limit 20`,
  vernacular_prefix: `select * from taxonomy_v2_experiment_c.vernacular_names where slot=1 and language_code=1 and lower(vernacular_name) like 'hvit sprø%' escape '\\' limit 20`,
  broad_two_character: `select * from taxonomy_v2_experiment_c.taxa where slot=1 and lower(canonical_scientific_name) like 'ca%' escape '\\' limit 20`,
  no_result: `select * from taxonomy_v2_experiment_c.taxa where slot=1 and lower(canonical_scientific_name) like 'zzzz-no-result%' escape '\\' limit 20`,
  col_resolution: `select * from taxonomy_v2_experiment_c.taxa where slot=1 and source_code=1 and canonical_external_id='QMKY'`,
  nortaxa_resolution: `select * from taxonomy_v2_experiment_c.taxa where slot=1 and source_code=2 and canonical_external_id='56210'`,
};

function nodes(plan, out = []) {
  out.push(plan);
  for (const child of plan.Plans ?? []) nodes(child, out);
  return out;
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}
const result = {};
for (const [name, sql] of Object.entries(cases)) {
  const runs = [];
  for (let i = 0; i < 10; i += 1) {
    const explained = JSON.parse(await query(target, `explain (analyze,buffers,format json) ${sql}`))[0];
    const all = nodes(explained.Plan);
    runs.push({
      planning_ms: explained['Planning Time'], execution_ms: explained['Execution Time'],
      shared_hit_blocks: all.reduce((n, x) => n + (x['Shared Hit Blocks'] ?? 0), 0),
      shared_read_blocks: all.reduce((n, x) => n + (x['Shared Read Blocks'] ?? 0), 0),
      temp_blocks: all.reduce((n, x) => n + (x['Temp Read Blocks'] ?? 0) + (x['Temp Written Blocks'] ?? 0), 0),
      rows_returned: explained.Plan['Actual Rows'],
      rows_removed: all.reduce((n, x) => n + (x['Rows Removed by Filter'] ?? 0), 0),
      indexes: [...new Set(all.map(x => x['Index Name']).filter(Boolean))], plan: explained.Plan['Node Type'],
    });
  }
  const times = runs.map(x => x.execution_ms);
  result[name] = { min_ms: Math.min(...times), p50_ms: percentile(times, .5), p95_ms: percentile(times, .95), max_ms: Math.max(...times), cold: runs[0], warm: runs.slice(1), indexes: [...new Set(runs.flatMap(x => x.indexes))] };
}
console.log(JSON.stringify({ target: { context: target.context, engine_version: target.engineVersion, postgres_version: target.postgresVersion, psql_version: target.psqlVersion }, result }, null, 2));
