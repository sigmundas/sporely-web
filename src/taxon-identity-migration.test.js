/**
 * Taxonomy-v2 closeout Stage 2 Part B — structural guards on the identity
 * migrations.
 *
 * These are static assertions over the migration SQL, NOT execution against
 * Postgres. Neither a local Supabase stack nor a Postgres binary is available
 * in this environment, so the constraints and the RPC body have not been run;
 * that remains owed as human verification. What these tests do buy is a
 * regression guard on the two properties that made the first draft wrong:
 *
 *   1. the CHECK constraint that forbids a bound id under
 *      `external_unresolved` must exist, AND
 *   2. the guarded RPC must move `selected_sporely_taxon_id` and
 *      `taxon_identity_state` in ONE statement.
 *
 * Property 2 is what stops property 1 from deadlocking the unresolved ->
 * resolved transition. Splitting the write between client and RPC cannot
 * work: a CHECK constraint is evaluated per statement.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const _MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')

function _migration(nameFragment) {
  const file = readdirSync(_MIGRATIONS).find(name => name.includes(nameFragment))
  assert.ok(file, `no migration matching ${nameFragment}`)
  return readFileSync(join(_MIGRATIONS, file), 'utf8')
}

test('the provenance migration is additive and constrains the unresolved state', () => {
  const sql = _migration('add_observation_taxon_identity_provenance')
  // Additive only — never a destructive column change on a production table.
  assert.match(sql, /ADD COLUMN IF NOT EXISTS taxon_identity_state text/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS taxon_identity_source_system text/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS taxon_identity_namespace text/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS taxon_identity_external_id text/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS taxon_identity_raw_external_id text/)
  assert.doesNotMatch(sql, /DROP COLUMN/)
  assert.doesNotMatch(sql, /ALTER COLUMN .* TYPE/)

  // An unresolved external identity may not coexist with a bound concept.
  assert.match(sql, /observations_unresolved_identity_has_no_selection_check/)
  assert.match(sql, /selected_sporely_taxon_id IS NULL/)
  // ...and it must carry complete evidence to be offerable to the resolver.
  assert.match(sql, /observations_taxon_identity_tuple_complete_check/)
})

test('the guarded RPC moves the id and the state in one statement', () => {
  const sql = _migration('selected_taxon_rpc_owns_identity_state')

  // Exactly one UPDATE inside the function body — a split write would be
  // evaluated as two statements and would trip the CHECK constraint.
  const updates = sql.match(/UPDATE public\.observations/g) || []
  assert.equal(updates.length, 1, 'the RPC must perform a single UPDATE')

  const update = sql.slice(sql.indexOf('UPDATE public.observations'))
  assert.match(update, /SET selected_sporely_taxon_id = p_sporely_taxon_id/)
  assert.match(update, /taxon_identity_state = CASE/)
  assert.match(update, /WHEN p_sporely_taxon_id IS NOT NULL THEN 'sporely_v2'/)

  // The pre-existing safety properties survive the CREATE OR REPLACE.
  assert.match(sql, /auth\.uid\(\) IS NULL/)
  assert.match(sql, /caller does not own it/)
  assert.match(sql, /missing from the active taxonomy-v2 release/)
  assert.match(sql, /SECURITY DEFINER/)
  assert.match(sql, /SET search_path = ''/)
  // Still no-op avoiding, so it cannot churn `updated_at` cursors.
  assert.match(update, /IS DISTINCT FROM/)
  // Grants unchanged: never executable by anon.
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.set_observation_selected_taxon_v2\(bigint,bigint\)\s*\n?\s*FROM PUBLIC, anon/)

  // Clearing an identity must not resurrect or fabricate an unresolved claim.
  assert.match(update, /WHEN taxon_identity_state = 'sporely_v2' THEN NULL/)
  assert.match(update, /ELSE taxon_identity_state/)
})

test('the RPC does not touch the preserved external evidence', () => {
  // A resolution stays auditable: only the state advances, the source tuple
  // is left exactly as the client preserved it.
  const sql = _migration('selected_taxon_rpc_owns_identity_state')
  const update = sql.slice(sql.indexOf('UPDATE public.observations'))
  const setClause = update.slice(0, update.indexOf('WHERE'))
  for (const column of [
    'taxon_identity_source_system',
    'taxon_identity_namespace',
    'taxon_identity_external_id',
    'taxon_identity_raw_external_id',
  ]) {
    assert.doesNotMatch(setClause, new RegExp(`${column}\\s*=`), column)
  }
})

test('the identification RPC writes the coupled set in one statement', () => {
  // The structural property that makes client compensation unnecessary: the
  // bound concept, the provenance and the accepted name are set by a single
  // UPDATE, so the CHECK constraints see only the final row and a failure
  // rolls the whole identification back.
  const sql = _migration('atomic_observation_identification')

  const updates = sql.match(/UPDATE public\.observations/g) || []
  assert.equal(updates.length, 1, 'the coupled change must be ONE statement')

  const update = sql.slice(sql.indexOf('UPDATE public.observations'))
  for (const column of [
    'selected_sporely_taxon_id',
    'taxon_identity_state',
    'taxon_identity_source_system',
    'taxon_identity_namespace',
    'taxon_identity_external_id',
    'taxon_identity_raw_external_id',
    'genus',
    'species',
    'common_name',
  ]) {
    assert.match(update, new RegExp(`${column} =`), column)
  }
  // The name is optional within the same statement, so "leave the name alone"
  // is not a separate client branch that could drift.
  assert.match(update, /CASE WHEN p_write_name THEN p_genus ELSE genus END/)

  // Same guards as the narrower RPC — this must not be a weaker door.
  assert.match(sql, /auth\.uid\(\) IS NULL/)
  assert.match(sql, /caller does not own it/)
  assert.match(sql, /missing from the active taxonomy-v2 release/)
  assert.match(sql, /SECURITY DEFINER/)
  assert.match(sql, /SET search_path = ''/)
  assert.match(sql, /FROM PUBLIC, anon/)
  // An unresolved external identity may not carry a bound concept.
  assert.match(sql, /external_unresolved.*cannot carry a selected_sporely_taxon_id/s)
})

test('the identification RPC does not touch provider history', () => {
  // `ai_selected_*` is suggestion history, which the plan requires be kept
  // distinct from an accepted identification.
  const sql = _migration('atomic_observation_identification')
  const update = sql.slice(sql.indexOf('UPDATE public.observations'))
  const setClause = update.slice(0, update.indexOf('WHERE'))
  assert.doesNotMatch(setClause, /ai_selected_/)
})
