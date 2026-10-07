import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverLocalTarget, queryStdin } from './lib/docker-psql.mjs';

const migrationPath = 'supabase/migrations/20261007123912_fix_taxonomy_v2_parent_reference_plan.sql';
const historicalPath = 'supabase/migrations/20260724130000_add_taxonomy_v2_schema_and_search.sql';
const oldPredicate = 'where p.release_id = t.release_id\n        and p.sporely_taxon_id = t.parent_sporely_taxon_id';
const newPredicate = `where p.release_id = t.release_id
        and p.sporely_taxon_id = t.parent_sporely_taxon_id
      -- Keep this existence lookup correlated. Without the zero offset,
      -- a fresh release absent from statistics can flatten to an anti join
      -- that repeatedly scans every parent row using only release_id.
      offset 0`;
function originalFunction(source) {
  const start = source.indexOf('create function public.taxonomy_v2_validate_release(');
  return source.slice(start, source.indexOf('\n$$;', start) + 4);
}

test('forward migration changes only the parent lookup; security and all checks are retained', async () => {
  const old = originalFunction(await readFile(historicalPath, 'utf8'));
  const migration = await readFile(migrationPath, 'utf8');
  const replacement = migration.slice(migration.indexOf('create or replace function')).trim();
  assert.equal(replacement, old.replace('create function', 'create or replace function').replace(oldPredicate, newPredicate));
  assert.doesNotMatch(migration, /alter role|statement_timeout|grant |revoke |drop |insert |update |delete /i);
});

test('local full validator equivalence, cross-release isolation, and fresh-release indexed plan', {
  skip: process.env.TAXONOMY_V2_PARENT_VALIDATION_INTEGRATION !== '1',
}, async () => {
  const target = await discoverLocalTarget();
  const old = originalFunction(await readFile(historicalPath, 'utf8'))
    .replace('public.taxonomy_v2_validate_release', 'pg_temp.old_validate_release');
  const migration = await readFile(migrationPath, 'utf8');
  const before = `jsonb_build_object('owner',proowner,'acl',proacl::text,'config',proconfig,'oid',oid)`;
  const sql = `BEGIN;
SET LOCAL statement_timeout='2min';
SET LOCAL plan_cache_mode=force_custom_plan;
CREATE TEMP TABLE function_before AS SELECT ${before} value FROM pg_proc WHERE oid='public.taxonomy_v2_validate_release(text)'::regprocedure;
${old}
${migration}
DO $$ BEGIN
 IF (SELECT value FROM function_before) IS DISTINCT FROM (SELECT ${before} FROM pg_proc WHERE oid='public.taxonomy_v2_validate_release(text)'::regprocedure) THEN RAISE EXCEPTION 'function identity/security changed'; END IF;
END $$;
CREATE FUNCTION pg_temp.fixture_release(r text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO public.taxonomy_v2_releases(release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,whole_export_sha256,manifest_sha256,generated_at,status,row_counts,authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,dangling_parent_report,source_manifest)
 VALUES(r,2,1,1,'fixture','fixture',repeat('a',64),repeat('b',64),md5(r)||md5(r),repeat('c',64),now(),'ready','{"taxon.jsonl":0,"scientific_name.jsonl":0,"vernacular.jsonl":0,"taxon_external_id.jsonl":0,"taxon_external_id_legacy_integer.jsonl":0,"taxon_redlist.jsonl":0}','{}','{}',0,'{}','{}');
END $$;
SELECT pg_temp.fixture_release('tax-2098.01.01-01');
SELECT pg_temp.fixture_release('tax-2098.01.02-01');
INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id) SELECT 900000000+i,'tax-2098.01.01-01' FROM generate_series(1,52917) i;
INSERT INTO public.taxonomy_v2_taxa(release_id,sporely_taxon_id,parent_sporely_taxon_id,canonical_source_system,canonical_external_id)
SELECT 'tax-2098.01.01-01',900000000+i,CASE WHEN i=1 THEN NULL ELSE 900000001 END,'fixture',i::text FROM generate_series(1,52917) i;
-- Seed known-release statistics, then load the fresh release without ANALYZE.
ANALYZE public.taxonomy_v2_taxa;
SELECT pg_temp.fixture_release('tax-2098.01.03-01');
INSERT INTO public.taxonomy_v2_taxa SELECT 'tax-2098.01.03-01',sporely_taxon_id,parent_sporely_taxon_id,genus,specific_epithet,family,canonical_scientific_name,taxon_rank,taxonomic_status,source_system,canonical_source_system,canonical_external_id,preferred_scientific_name_no,preferred_scientific_name_no_source_system,preferred_scientific_name_no_namespace,preferred_scientific_name_no_external_id,preferred_scientific_name_sv,preferred_scientific_name_sv_source_system,preferred_scientific_name_sv_namespace,preferred_scientific_name_sv_external_id FROM public.taxonomy_v2_taxa WHERE release_id='tax-2098.01.01-01';
UPDATE public.taxonomy_v2_releases SET row_counts=jsonb_set(row_counts,'{taxon.jsonl}','52917') WHERE release_id IN ('tax-2098.01.01-01','tax-2098.01.03-01');
DO $$ DECLARE old jsonb; new jsonb; n int; BEGIN
 -- Full result equality under a safe generic plan; fixed validator also checked with fresh custom plans below.
 FOR n IN 0..3 LOOP
  IF n>0 THEN UPDATE public.taxonomy_v2_taxa SET parent_sporely_taxon_id=999999999 WHERE release_id='tax-2098.01.03-01' AND sporely_taxon_id=900000000+n; END IF;
  UPDATE public.taxonomy_v2_releases SET dangling_parent_count=n WHERE release_id='tax-2098.01.03-01';
  PERFORM set_config('plan_cache_mode','force_generic_plan',true);
  old:=pg_temp.old_validate_release('tax-2098.01.03-01');
  PERFORM set_config('plan_cache_mode','force_custom_plan',true);
  new:=public.taxonomy_v2_validate_release('tax-2098.01.03-01');
  IF old IS DISTINCT FROM new OR NOT (new->>'ok')::boolean THEN RAISE EXCEPTION 'result mismatch for % dangling: %, %',n,old,new; END IF;
  IF n>0 THEN
   UPDATE public.taxonomy_v2_releases SET dangling_parent_count=0 WHERE release_id='tax-2098.01.03-01';
   new:=public.taxonomy_v2_validate_release('tax-2098.01.03-01');
   IF (new->>'ok')::boolean OR NOT (new->'errors' ? 'dangling parent count does not match metadata') THEN RAISE EXCEPTION 'dangling parent not detected'; END IF;
  END IF;
 END LOOP;
 -- Parent exists only in another release: remove same-release parent, retain other copy.
 UPDATE public.taxonomy_v2_taxa SET parent_sporely_taxon_id=NULL WHERE release_id='tax-2098.01.03-01';
 DELETE FROM public.taxonomy_v2_taxa WHERE release_id='tax-2098.01.03-01' AND sporely_taxon_id=900000001;
 UPDATE public.taxonomy_v2_taxa SET parent_sporely_taxon_id=900000001 WHERE release_id='tax-2098.01.03-01' AND sporely_taxon_id=900000002;
 UPDATE public.taxonomy_v2_releases SET row_counts=jsonb_set(row_counts,'{taxon.jsonl}','52916'),dangling_parent_count=0 WHERE release_id='tax-2098.01.03-01';
 new:=public.taxonomy_v2_validate_release('tax-2098.01.03-01');
 IF (new->>'ok')::boolean OR NOT (new->'errors' ? 'dangling parent count does not match metadata') THEN RAISE EXCEPTION 'cross-release parent incorrectly accepted'; END IF;
 UPDATE public.taxonomy_v2_releases SET dangling_parent_count=1 WHERE release_id='tax-2098.01.03-01';
 IF NOT (public.taxonomy_v2_validate_release('tax-2098.01.03-01')->>'ok')::boolean THEN RAISE EXCEPTION 'declared boundary parent rejected'; END IF;
 IF pg_temp.old_validate_release('tax-2098.01.02-01') IS DISTINCT FROM public.taxonomy_v2_validate_release('tax-2098.01.02-01') THEN RAISE EXCEPTION 'empty release changed'; END IF;
 IF pg_temp.old_validate_release('tax-2098.01.04-01') IS DISTINCT FROM public.taxonomy_v2_validate_release('tax-2098.01.04-01') THEN RAISE EXCEPTION 'absent release changed'; END IF;
END $$;
PREPARE fixed_parent(text) AS SELECT count(*) FROM public.taxonomy_v2_taxa t WHERE t.release_id=$1 AND t.parent_sporely_taxon_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.taxonomy_v2_taxa p WHERE p.release_id=t.release_id AND p.sporely_taxon_id=t.parent_sporely_taxon_id OFFSET 0);
DO $$ DECLARE r text; plan json; BEGIN
 FOREACH r IN ARRAY ARRAY['tax-2098.01.01-01','tax-2098.01.03-01','tax-2098.01.04-01'] LOOP
  EXECUTE format('EXPLAIN (FORMAT JSON) EXECUTE fixed_parent(%L)',r) INTO plan;
  IF plan::text NOT LIKE '%Index Cond%sporely_taxon_id = t.parent_sporely_taxon_id%' OR plan::text NOT LIKE '%release_id = t.release_id%' THEN RAISE EXCEPTION 'both-key lookup absent: %',plan; END IF;
 END LOOP;
END $$;
DEALLOCATE fixed_parent;
SELECT 'parent-reference regression cases passed';
ROLLBACK;`;
  const output = await queryStdin(target, sql);
  assert.match(output, /parent-reference regression cases passed/);
  if (process.env.TAXONOMY_V2_PARENT_EVIDENCE_DIR) {
    const dir = path.resolve(process.env.TAXONOMY_V2_PARENT_EVIDENCE_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'regression.sql'), sql);
    await writeFile(path.join(dir, 'regression.out'), output);
  }
});
