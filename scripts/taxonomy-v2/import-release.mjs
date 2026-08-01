#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { preflightExport } from './lib/export-contract.mjs';
import { discoverLocalTarget, query, spawnSession } from './lib/docker-psql.mjs';

export const IMPORTER_VERSION = 'w2b-importer-1';
export const IMPORT_ADVISORY_LOCK = '846920026072413003';

const q = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${q(JSON.stringify(value))}::jsonb`;
const sanitize = value => String(value).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-connection]').replace(/password\s*=\s*\S+/gi, 'password=[redacted]').slice(0, 1000);
const targetEvidence = target => ({ projectId: target.projectId, context: target.context, engineVersion: target.engineVersion, database: target.database, postgresVersion: target.postgresVersion, psqlVersion: target.psqlVersion });

function markerChannel(child) {
  let text = '';
  const waiters = new Map();
  child.stdout.on('data', chunk => {
    text += chunk;
    for (const [marker, waiter] of waiters) if (text.includes(marker)) { waiters.delete(marker); waiter.resolve(); }
  });
  child.on('close', code => {
    for (const [, waiter] of waiters) waiter.reject(new Error(`psql exited ${code} before expected marker`));
    waiters.clear();
  });
  return marker => text.includes(marker) ? Promise.resolve() : new Promise((resolveMarker, reject) => waiters.set(marker, { resolve: resolveMarker, reject }));
}

async function write(stream, chunk) {
  if (!stream.write(chunk)) await new Promise(resolveDrain => stream.once('drain', resolveDrain));
}

async function copyFile(child, filePath) {
  for await (const chunk of createReadStream(filePath)) await write(child.stdin, chunk);
  await write(child.stdin, '\\.\n');
}

const mappings = {
  'taxon.jsonl': `
insert into public.taxonomy_v2_concepts(sporely_taxon_id, first_seen_release_id)
select (raw->>'taxon_id')::bigint, current_setting('w2b.release_id') from w2b_stage
on conflict (sporely_taxon_id) do nothing;
insert into public.taxonomy_v2_taxa(release_id,sporely_taxon_id,parent_sporely_taxon_id,genus,specific_epithet,family,canonical_scientific_name,taxon_rank,taxonomic_status,source_system,canonical_source_system,canonical_external_id)
select current_setting('w2b.release_id'),(raw->>'taxon_id')::bigint,(raw->>'parent_taxon_id')::bigint,raw->>'genus',raw->>'specific_epithet',raw->>'family',raw->>'canonical_scientific_name',raw->>'taxon_rank',raw->>'taxonomic_status',raw->>'source_system',raw->>'canonical_source_system',raw->>'canonical_external_id' from w2b_stage;`,
  'scientific_name.jsonl': `insert into public.taxonomy_v2_scientific_names(release_id,sporely_taxon_id,language_code,scientific_name,is_preferred_name,source,alias_reason) select current_setting('w2b.release_id'),(raw->>'taxon_id')::bigint,raw->>'language_code',raw->>'scientific_name',(raw->>'is_preferred_name')::boolean,raw->>'source',raw->>'note' from w2b_stage;`,
  'vernacular.jsonl': `insert into public.taxonomy_v2_vernacular_names(release_id,sporely_taxon_id,language_code,vernacular_name,is_preferred_name,source) select current_setting('w2b.release_id'),(raw->>'taxon_id')::bigint,raw->>'language_code',raw->>'vernacular_name',(raw->>'is_preferred_name')::boolean,raw->>'source' from w2b_stage;`,
  'taxon_external_id.jsonl': `insert into public.taxonomy_v2_external_ids(release_id,sporely_taxon_id,source_system,namespace,external_id,id_role,is_preferred,external_name,note) select current_setting('w2b.release_id'),(raw->>'taxon_id')::bigint,raw->>'source_system',raw->>'namespace',raw->>'external_id',raw->>'id_role',(raw->>'is_preferred')::boolean,raw->>'external_name',raw->>'note' from w2b_stage;`,
  'taxon_external_id_legacy_integer.jsonl': `insert into public.taxonomy_v2_legacy_external_ids(release_id,sporely_taxon_id,source_system,external_id,id_role,is_preferred,external_name,note) select current_setting('w2b.release_id'),(raw->>'taxon_id')::bigint,raw->>'source_system',raw->>'external_id',raw->>'id_role',(raw->>'is_preferred')::boolean,raw->>'external_name',raw->>'note' from w2b_stage;`,
  'taxon_redlist.jsonl': `insert into public.taxonomy_v2_redlist(release_id,sporely_taxon_id,source_system,source_release,assessment_id,assessment_area,assessed_name_source,assessed_name_namespace,assessed_name_id,scientific_name_snapshot,authorship_snapshot,taxon_rank_snapshot,category_raw,category_code,category_is_downgraded,criteria,expert_group,assessment_url) select current_setting('w2b.release_id'),(raw->>'taxon_id')::bigint,raw->>'source_system',raw->>'source_release',raw->>'assessment_id',raw->>'assessment_area',raw->>'assessed_name_source',raw->>'assessed_name_namespace',raw->>'assessed_name_id',raw->>'scientific_name_snapshot',raw->>'authorship_snapshot',raw->>'taxon_rank_snapshot',raw->>'category_raw',raw->>'category_code',(raw->>'category_is_downgraded')::boolean,raw->>'criteria',raw->>'expert_group',raw->>'assessment_url' from w2b_stage;`,
};

export async function importRelease({ source, expectedReleaseId = null, projectRoot = process.cwd(), testFailureAfter = null } = {}) {
  if (!source) throw new Error('source directory is required');
  const commandStarted = performance.now();
  const checked = await preflightExport(resolve(source), expectedReleaseId);
  const target = await discoverLocalTarget(projectRoot);
  const releaseId = checked.manifest.content_release_id;
  const existingRaw = await query(target, `select coalesce(row_to_json(x)::text,'null') from (select release_id,whole_export_sha256,status from public.taxonomy_v2_releases where release_id=${q(releaseId)}) x`);
  const existing = JSON.parse(existingRaw || 'null');
  if (existing) {
    if (existing.whole_export_sha256 !== checked.wholeExportSha256) throw new Error(`release ${releaseId} already exists with a different whole-export hash`);
    if (!['ready', 'active'].includes(existing.status)) throw new Error(`release ${releaseId} exists with status ${existing.status}; inspect and recover manually`);
    const validation = JSON.parse(await query(target, `select public.taxonomy_v2_validate_release(${q(releaseId)})::text`));
    if (!validation.ok) throw new Error(`existing release validation failed: ${JSON.stringify(validation.errors)}`);
    await query(target, `insert into public.taxonomy_v2_import_runs(status,finished_at,importer_version,source_directory,whole_export_sha256,counts) values ('verified_existing',clock_timestamp(),${q(IMPORTER_VERSION)},${q(basename(checked.root))},${q(checked.wholeExportSha256)},${json({ validation })})`);
    return { outcome: 'verified_existing', release_id: releaseId, validation, preflight_ms: checked.elapsed_ms, target: targetEvidence(target) };
  }

  const auditId = Number(await query(target, `insert into public.taxonomy_v2_import_runs(status,importer_version,source_directory,whole_export_sha256) values ('running',${q(IMPORTER_VERSION)},${q(basename(checked.root))},${q(checked.wholeExportSha256)}) returning id`));
  const child = spawnSession(target);
  const waitMarker = markerChannel(child);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolveExit, rejectExit) => { child.on('error', rejectExit); child.on('close', code => resolveExit(code)); });
  const timings = { preflight_ms: checked.elapsed_ms, datasets: {} };
  try {
    const m = checked.manifest;
    const rowCounts = Object.fromEntries(m.files.filter(v => v.name !== 'taxonomy_release.jsonl').map(v => [v.name, v.row_count]));
    await write(child.stdin, `\\set ON_ERROR_STOP on
begin;
select pg_catalog.pg_advisory_xact_lock(${IMPORT_ADVISORY_LOCK}::bigint);
select set_config('w2b.release_id',${q(releaseId)},true);
insert into public.taxonomy_v2_releases(release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,whole_export_sha256,manifest_sha256,generated_at,status,row_counts,authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,dangling_parent_report,source_manifest)
values (${q(releaseId)},${m.taxonomy_schema_version},${m.export_schema_version},${m.manifest_schema_version},${q(m.exporter_version)},${q(m.scope_predicate_id)},${q(m.source.gz_sha256)},${q(m.source.sqlite_sha256)},${q(checked.wholeExportSha256)},${q(checked.manifestSha256)},${q(m.generated_at)}::timestamptz,'loading',${json(rowCounts)},${json(m.external_id_authoritative_namespace_counts)},${json(m.external_id_legacy_integer_source_counts)},${m.dangling_parent_references.count},${json(m.dangling_parent_references)},${json(m)});
\\echo W2B_BEGIN
`);
    await waitMarker('W2B_BEGIN');
    for (const name of Object.keys(mappings)) {
      const copyStarted = performance.now();
      await write(child.stdin, `create temp table w2b_stage(raw jsonb) on commit drop;\ncopy w2b_stage(raw) from stdin with (format csv, delimiter E'\\x1f', quote E'\\x1e', escape E'\\x1e');\n`);
      await copyFile(child, checked.files[name].path);
      await write(child.stdin, `\\echo W2B_COPY_${name}\n`);
      await waitMarker(`W2B_COPY_${name}`);
      const copied = performance.now();
      await write(child.stdin, `${mappings[name]}\ndrop table w2b_stage;\n\\echo W2B_INSERT_${name}\n`);
      await waitMarker(`W2B_INSERT_${name}`);
      timings.datasets[name] = { copy_ms: copied - copyStarted, insert_ms: performance.now() - copied };
      if (testFailureAfter === name) await write(child.stdin, `select 1/0;\n`);
    }
    await write(child.stdin, `update public.taxonomy_v2_releases set status='ready',loaded_at=clock_timestamp(),failure_message=null,failed_at=null where release_id=${q(releaseId)};
do $$ declare result jsonb; begin result:=public.taxonomy_v2_validate_release(${q(releaseId)}); if not coalesce((result->>'ok')::boolean,false) then raise exception 'W2B validation failed: %',result; end if; end $$;
update public.taxonomy_v2_import_runs set release_id=${q(releaseId)},status='succeeded',finished_at=clock_timestamp(),counts=${json({ row_counts: rowCounts, timings })} where id=${auditId};
commit;
\\echo W2B_COMMITTED
`);
    child.stdin.end();
    const code = await exit;
    if (code !== 0) throw new Error(stderr.trim() || `psql exited ${code}`);
    const validation = JSON.parse(await query(target, `select public.taxonomy_v2_validate_release(${q(releaseId)})::text`));
    timings.complete_ms = performance.now() - commandStarted;
    return { outcome: 'imported', release_id: releaseId, validation, timings, audit_id: auditId, target: targetEvidence(target), manifest_sha256: checked.manifestSha256, whole_export_sha256: checked.wholeExportSha256, files: Object.fromEntries(Object.entries(checked.files).map(([name, value]) => [name, { row_count: value.row_count, bytes: value.bytes, sha256: value.sha256 }])) };
  } catch (error) {
    child.stdin.destroy();
    await query(target, `update public.taxonomy_v2_import_runs set status='failed',finished_at=clock_timestamp(),error_message=${q(sanitize(error.message))} where id=${auditId}`);
    throw error;
  }
}

function parseArgs(argv) {
  const options = { projectRoot: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--local') continue;
    if (argv[i] === '--source') options.source = argv[++i];
    else if (argv[i] === '--release') options.expectedReleaseId = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  importRelease(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`taxonomy-v2 import failed: ${sanitize(error.message)}`); process.exitCode = 1; });
}
