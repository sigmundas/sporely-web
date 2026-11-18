#!/usr/bin/env node
// Generates a guarded psql script that removes one retired taxonomy-v2
// release's payload rows and rebuilds the payload tables so the space is
// returned to the database quota. It writes nothing to any database itself:
// the operator runs the generated file with psql, after approval, exactly as
// for prepare-production-release-import.mjs.
//
// Retention policy (taxonomy-v2 integration plan §18): keep the active release
// and the immediately previous release. The operator names the previous
// release to keep (--expected-previous); the script refuses if the database
// disagrees or if the target is that release. --allow-previous instead allows
// purging the previous release too.
//
// The release header and its import-run audit rows are kept, so the release
// stays recorded as retired; only the payload is removed. There is no
// supported way to restore a purged release (see the cloud contract).

import { createHash } from 'node:crypto';
import { chmod, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PRODUCTION_SYSTEM_IDENTIFIER } from './prepare-production-release-import.mjs';

const PROJECT_REF = 'zkpjklzfwzefhjluvhfw';
const RELEASE_ID_PATTERN = /^tax-\d{4}\.\d{2}\.\d{2}-\d{2}$/;
const SYSTEM_IDENTIFIER_PATTERN = /^\d{1,20}$/;
// Output basenames are restricted so the printed shell command needs no quoting.
const OUTPUT_BASENAME_PATTERN = /^[A-Za-z0-9._-]+\.sql$/;
// Same advisory locks as the release importer and taxonomy_v2_activate_release.
// The purge holds them as session locks from the guard until every rebuild is
// done, so no import or activation can start in between.
const IMPORT_ADVISORY_LOCK = '846920026072413003';
const ACTIVATION_ADVISORY_LOCK = '846920026072413002';
const DELETE_LOCK_TIMEOUT = '5s';
const DELETE_STATEMENT_TIMEOUT = '10min';
// A rebuild waiting for its ACCESS EXCLUSIVE lock makes new queries on that
// table queue behind it, so the wait is kept short.
const REBUILD_LOCK_TIMEOUT = '2s';
const REBUILD_STATEMENT_TIMEOUT = '5min';

// Child tables first, taxonomy_v2_taxa last; the children also cascade from
// taxa, but explicit deletes keep each step indexed and measurable.
export const PAYLOAD_TABLES = Object.freeze([
  'taxonomy_v2_redlist',
  'taxonomy_v2_legacy_external_ids',
  'taxonomy_v2_external_ids',
  'taxonomy_v2_vernacular_names',
  'taxonomy_v2_scientific_names',
  'taxonomy_v2_taxa',
]);
// Tables with a release_id column that are not payload: the header and the
// import audit are kept.
export const RETAINED_RELEASE_TABLES = Object.freeze(['taxonomy_v2_releases', 'taxonomy_v2_import_runs']);

const sqlText = value => `'${String(value).replaceAll("'", "''")}'`;
const sqlArray = values => `ARRAY[${values.map(sqlText).join(',')}]::text[]`;

function refuse(condition, message) {
  if (!condition) throw new Error(`refuse: ${message}`);
}

export function buildPurgeSql({ releaseId, expectedPrevious = null, allowPrevious = false, systemIdentifier = PRODUCTION_SYSTEM_IDENTIFIER }) {
  refuse(RELEASE_ID_PATTERN.test(String(releaseId || '')), 'release ID must match tax-YYYY.MM.DD-NN');
  refuse(SYSTEM_IDENTIFIER_PATTERN.test(String(systemIdentifier || '')), 'system identifier must be numeric');
  if (allowPrevious) {
    refuse(expectedPrevious == null, 'give either --expected-previous or --allow-previous, not both');
  } else {
    refuse(RELEASE_ID_PATTERN.test(String(expectedPrevious || '')), 'the previous release to keep is required (--expected-previous tax-YYYY.MM.DD-NN), or --allow-previous');
    refuse(expectedPrevious !== releaseId, 'the target is the previous release to keep');
  }
  const rel = sqlText(releaseId);
  const deletes = PAYLOAD_TABLES.map(t => `DELETE FROM public.${t} WHERE release_id = ${rel};`).join('\n');
  const rebuilds = PAYLOAD_TABLES.map(t => `VACUUM (FULL, ANALYZE) public.${t};`).join('\n');
  const previousGuard = allowPrevious ? '' : `
  IF v_previous IS DISTINCT FROM ${sqlText(expectedPrevious)} THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: the previous release is %, not the expected ${expectedPrevious}', v_previous;
  END IF;`;
  return `\\set ON_ERROR_STOP on
-- TAXONOMY-V2 RETIRED RELEASE PURGE
-- DO NOT COMMIT
-- PROJECT REF: ${PROJECT_REF}
-- SYSTEM IDENTIFIER: ${systemIdentifier}
-- RELEASE: ${releaseId}
-- PREVIOUS RELEASE: ${allowPrevious ? 'may be purged (--allow-previous)' : `${expectedPrevious} (kept)`}
-- Part 1 deletes the release's payload rows in one transaction and stops on
-- any failed guard. Part 2 rebuilds each payload table; each rebuild holds an
-- ACCESS EXCLUSIVE lock for as long as it runs. Rerun this file to finish an
-- interrupted rebuild. The advisory locks are session locks: they last until
-- the end of the file, and a dropped connection releases them.

SET lock_timeout = '${DELETE_LOCK_TIMEOUT}';
SET statement_timeout = '${DELETE_STATEMENT_TIMEOUT}';

DO $purge_target$
BEGIN
  IF (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) IS DISTINCT FROM '${systemIdentifier}' THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: connected database is not the expected target (system identifier ${systemIdentifier})';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_lock(${IMPORT_ADVISORY_LOCK}::bigint)
     OR NOT pg_catalog.pg_try_advisory_lock(${ACTIVATION_ADVISORY_LOCK}::bigint) THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: a release import or activation holds its lock';
  END IF;
END
$purge_target$;

BEGIN;

DO $purge_guard$
DECLARE
  v_target public.taxonomy_v2_releases%rowtype;
  v_active_count integer;
  v_previous text;
  v_previous_ties integer;
  v_actual text[];
  v_expected text[] := ${sqlArray([...PAYLOAD_TABLES, ...RETAINED_RELEASE_TABLES])};
BEGIN
  -- Every public table with a release_id column must be known here, so a new
  -- payload table cannot be silently left behind.
  SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname), '{}')
    INTO v_actual
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'release_id'
                    AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_actual IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_expected) x) THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: release-scoped tables changed (found %); update prepare-release-purge.mjs', v_actual;
  END IF;

  SELECT * INTO v_target FROM public.taxonomy_v2_releases WHERE release_id = ${rel} FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: release % does not exist', ${rel};
  END IF;
  IF v_target.status <> 'retired' THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: release % has status %; only retired releases can be purged', ${rel}, v_target.status;
  END IF;

  SELECT count(*) INTO v_active_count FROM public.taxonomy_v2_releases WHERE status = 'active';
  IF v_active_count <> 1 THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: expected exactly one active release, found %', v_active_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.taxonomy_v2_releases WHERE status IN ('loading', 'ready'))
     OR EXISTS (SELECT 1 FROM public.taxonomy_v2_import_runs WHERE status = 'running') THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: a release import is in progress';
  END IF;

  -- activated_at is the activating transaction's start time, so it is only a
  -- hint: the operator-named previous release must agree with it, and a tie
  -- or a missing timestamp is refused.
  SELECT release_id INTO v_previous FROM public.taxonomy_v2_releases
   WHERE status = 'retired'
   ORDER BY activated_at DESC NULLS FIRST, release_id DESC
   LIMIT 1;
  SELECT count(*) INTO v_previous_ties FROM public.taxonomy_v2_releases
   WHERE status = 'retired'
     AND (activated_at IS NULL
          OR activated_at = (SELECT max(activated_at) FROM public.taxonomy_v2_releases WHERE status = 'retired'));
  IF v_previous_ties <> 1 THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: the previous release is ambiguous (% candidates)', v_previous_ties;
  END IF;${previousGuard}
  IF v_previous = ${rel} AND NOT ${allowPrevious ? 'true' : 'false'} THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: % is the previous release (rollback target)', ${rel};
  END IF;
END
$purge_guard$;

${deletes}

DO $purge_check$
BEGIN
  IF ${PAYLOAD_TABLES.map(t => `EXISTS (SELECT 1 FROM public.${t} WHERE release_id = ${rel})`).join('\n     OR ')} THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: payload rows remain for %', ${rel};
  END IF;
  IF (SELECT status FROM public.taxonomy_v2_releases WHERE release_id = ${rel}) <> 'retired'
     OR (SELECT count(*) FROM public.taxonomy_v2_releases WHERE status = 'active') <> 1 THEN
    RAISE EXCEPTION 'taxonomy-v2 purge: release statuses changed during the purge';
  END IF;
END
$purge_check$;

COMMIT;

-- Part 2: return the space to the quota, still holding the advisory locks.
SET lock_timeout = '${REBUILD_LOCK_TIMEOUT}';
SET statement_timeout = '${REBUILD_STATEMENT_TIMEOUT}';
${rebuilds}
RESET lock_timeout;
RESET statement_timeout;
SELECT pg_catalog.pg_advisory_unlock(${ACTIVATION_ADVISORY_LOCK}::bigint) AND pg_catalog.pg_advisory_unlock(${IMPORT_ADVISORY_LOCK}::bigint) AS advisory_locks_released;

SELECT r.release_id, r.status,
       (SELECT count(*) FROM public.taxonomy_v2_taxa t WHERE t.release_id = r.release_id) AS taxa_rows
  FROM public.taxonomy_v2_releases r
 ORDER BY r.release_id;
SELECT c.relname AS payload_table, pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)) AS total_size
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = ANY (${sqlArray(PAYLOAD_TABLES)})
 ORDER BY pg_catalog.pg_total_relation_size(c.oid) DESC;
SELECT pg_catalog.pg_size_pretty(sum(pg_catalog.pg_database_size(datname))) AS cluster_size FROM pg_catalog.pg_database;
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export async function prepareReleasePurge({ releaseId, output, expectedPrevious = null, allowPrevious = false, systemIdentifier = PRODUCTION_SYSTEM_IDENTIFIER } = {}) {
  refuse(releaseId, 'release ID is required (--release-id)');
  refuse(output, 'output path is required (--output)');
  const sql = buildPurgeSql({ releaseId, expectedPrevious, allowPrevious, systemIdentifier });
  const destination = path.resolve(output);
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  refuse(!destination.startsWith(`${repoRoot}${path.sep}`), 'generated SQL must remain outside Git');
  refuse(OUTPUT_BASENAME_PATTERN.test(path.basename(destination)), 'output file name must be letters, digits, ".", "_" or "-" and end in .sql');
  await mkdir(path.dirname(destination), { recursive: true });
  const handle = await open(destination, 'wx', 0o600);
  try {
    await handle.writeFile(sql);
  } catch (error) {
    await handle.close();
    await unlink(destination).catch(() => {});
    throw error;
  }
  await handle.close();
  await chmod(destination, 0o600);
  return {
    generated_sql_path: destination,
    sql_sha256: createHash('sha256').update(sql).digest('hex'),
    release_id: releaseId,
    expected_previous: expectedPrevious,
    allow_previous: allowPrevious,
    system_identifier: systemIdentifier,
    containerised_psql_command: `docker run --rm --env-file /path/to/private/production-db.env -v ${shellQuote(`${path.dirname(destination)}:/payload:ro`)} postgres:17 sh -c 'psql "$DATABASE_URL" --file=/payload/${path.basename(destination)}'`,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--release-id') options.releaseId = argv[++i];
    else if (argv[i] === '--output') options.output = argv[++i];
    else if (argv[i] === '--expected-previous') options.expectedPrevious = argv[++i];
    else if (argv[i] === '--allow-previous') options.allowPrevious = true;
    else if (argv[i] === '--system-identifier') options.systemIdentifier = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('usage: node scripts/taxonomy-v2/prepare-release-purge.mjs --release-id <tax-YYYY.MM.DD-NN> --output <outside-git.sql> (--expected-previous <tax-YYYY.MM.DD-NN> | --allow-previous) [--system-identifier <non-production target>]');
    } else {
      const result = await prepareReleasePurge(options);
      console.log(`generated: ${result.generated_sql_path}`);
      console.log(`sha256: ${result.sql_sha256}`);
      console.log(`release: ${result.release_id}`);
      console.log(`previous release: ${result.allow_previous ? 'may be purged' : `${result.expected_previous} (kept)`}`);
      console.log(`target system identifier: ${result.system_identifier}`);
      console.log(`containerised psql command: ${result.containerised_psql_command}`);
    }
  } catch (error) {
    console.error(`taxonomy-v2 purge preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
