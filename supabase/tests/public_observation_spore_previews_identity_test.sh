#!/usr/bin/env bash
# Proves that 20261012100000_add_public_observation_spore_previews.sql left the
# output of public.get_public_observation(bigint) and
# public._get_public_observation_stage2a(bigint) byte-identical for these
# fixtures, whose old point order is id order. The migration's owner-approved
# exception (point order is now image id, then measurement id) can reorder
# sporePoints for rows whose old order differed; this script does not cover
# that case (see public_observation_spore_previews_order_test.sql).
#
# In ONE transaction that is rolled back:
#   1. load the fixtures of public_observation_spore_previews_test.sql, then
#      move rows (HOT) so that physical (ctid) order differs from id order;
#   2. snapshot both functions' rows as text, for every observation in the
#      database and for an anon, a stranger, a blocked and an owner viewer;
#   3. CREATE OR REPLACE both functions with their previous definitions, read
#      from the applied (immutable) migrations 20260925120000 and
#      20261001195524;
#   4. snapshot again and require the two snapshots to be equal.
# Nothing is committed, so the local database is unchanged afterwards.
#
#   supabase db reset --local && bash supabase/tests/public_observation_spore_previews_identity_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STAGE2A_SRC="$HERE/migrations/20260925120000_owner_sync_metadata_parents.sql"
WRAPPER_SRC="$HERE/migrations/20261001195524_hide_observation_time_of_day_from_non_owners.sql"
FIXTURES_SRC="$HERE/tests/public_observation_spore_previews_test.sql"

fail() { echo "FAIL: $*" >&2; exit 1; }

# Print from the first line matching $2 through the next line that is exactly
# "$function$;".
extract_function() {
  awk -v start="$2" 'index($0, start) == 1 { on = 1 } on { print } on && $0 == "$function$;" { exit }' "$1"
}

OLD_STAGE2A="$(extract_function "$STAGE2A_SRC" 'CREATE OR REPLACE FUNCTION public._get_public_observation_stage2a(')"
OLD_WRAPPER="$(extract_function "$WRAPPER_SRC" 'CREATE OR REPLACE FUNCTION public.get_public_observation(p_observation_id bigint)')"
FIXTURES="$(awk '/^-- @fixtures-begin$/ { on = 1; next } /^-- @fixtures-end$/ { on = 0 } on' "$FIXTURES_SRC")"

grep -q 'point_agg ON true' <<<"$OLD_STAGE2A" || fail "could not extract the previous _get_public_observation_stage2a"
grep -q 'build_worker_media_url' <<<"$OLD_WRAPPER" || fail "could not extract the previous get_public_observation"
grep -q 'spv_fixture' <<<"$FIXTURES" || fail "could not extract the fixtures"

SNAPSHOT="
DO \$snap\$
DECLARE
  v record;
  obs_id bigint;
BEGIN
  FOR v IN SELECT * FROM spv_viewer LOOP
    PERFORM set_config('request.jwt.claim.sub', coalesce(v.user_id::text, ''), true);
    PERFORM set_config('request.jwt.claims',
      CASE WHEN v.user_id IS NULL THEN jsonb_build_object('role', 'anon')
           ELSE jsonb_build_object('sub', v.user_id::text, 'role', 'authenticated') END::text,
      true);
    FOR obs_id IN
      SELECT id FROM public.observations
      UNION SELECT observation_id FROM spv_fixture
    LOOP
      INSERT INTO spv_snapshot
      SELECT current_setting('spv.phase'), v.label, 'get_public_observation', obs_id,
             (SELECT string_agg(g::text, E'\n') FROM public.get_public_observation(obs_id) g);
      INSERT INTO spv_snapshot
      SELECT current_setting('spv.phase'), v.label, '_get_public_observation_stage2a', obs_id,
             (SELECT string_agg(g::text, E'\n') FROM public._get_public_observation_stage2a(obs_id) g);
    END LOOP;
  END LOOP;
END
\$snap\$;
"

# Move the first image and the first measurement of every observation to a
# new heap position (HOT updates of unindexed columns), so that physical
# (ctid) order differs from id order. The old point aggregate had no ORDER BY
# and its index plan returned index-entry order, which HOT updates leave at
# the original (id) order; the new one orders by image id, measurement id.
# The two must still agree. The guard makes sure the rows really moved.
SHUFFLE="
UPDATE public.observation_images i
   SET sample_type = i.sample_type
 WHERE i.id IN (SELECT min(id) FROM public.observation_images GROUP BY observation_id HAVING count(*) > 1);
UPDATE public.spore_measurements m
   SET length_um = m.length_um
 WHERE m.id IN (SELECT min(id) FROM public.spore_measurements GROUP BY image_id HAVING count(*) > 1);
DO \$shuffled\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.spore_measurements a JOIN public.spore_measurements b
      ON a.image_id = b.image_id AND a.id < b.id AND a.ctid > b.ctid
  ) OR NOT EXISTS (
    SELECT 1 FROM public.observation_images a JOIN public.observation_images b
      ON a.observation_id = b.observation_id AND a.id < b.id AND a.ctid > b.ctid
  ) THEN
    RAISE EXCEPTION 'shuffle did not make ctid order differ from id order';
  END IF;
END
\$shuffled\$;
"

docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt <<SQL
BEGIN;
$FIXTURES
$SHUFFLE

CREATE TEMP TABLE spv_snapshot (
  phase text, viewer text, fn text, observation_id bigint, out text
) ON COMMIT DROP;

DO \$phase\$ BEGIN PERFORM set_config('spv.phase', 'new', true); END \$phase\$;
$SNAPSHOT

$OLD_STAGE2A

$OLD_WRAPPER

DO \$phase\$ BEGIN PERFORM set_config('spv.phase', 'old', true); END \$phase\$;
$SNAPSHOT

DO \$cmp\$
DECLARE
  diff record;
  n_rows bigint;
  n_points bigint;
BEGIN
  FOR diff IN
    SELECT viewer, fn, observation_id,
           max(out) FILTER (WHERE phase = 'new') AS new_out,
           max(out) FILTER (WHERE phase = 'old') AS old_out
      FROM spv_snapshot
     GROUP BY viewer, fn, observation_id
    HAVING max(out) FILTER (WHERE phase = 'new') IS DISTINCT FROM max(out) FILTER (WHERE phase = 'old')
        OR count(*) <> 2
  LOOP
    RAISE EXCEPTION 'output changed: % as % for observation %: new=% old=%',
      diff.fn, diff.viewer, diff.observation_id, diff.new_out, diff.old_out;
  END LOOP;

  -- Guard against a vacuous pass: the snapshot must contain visible rows,
  -- spore points with worker crop URLs, and an authorized mosaic.
  SELECT count(*) FILTER (WHERE out IS NOT NULL),
         count(*) FILTER (WHERE out LIKE '%/thumb?v=%' AND out LIKE '%mosaicMediaUrl%')
    INTO n_rows, n_points
    FROM spv_snapshot WHERE phase = 'new' AND fn = 'get_public_observation';
  IF n_rows < 20 OR n_points < 3 THEN
    RAISE EXCEPTION 'snapshot too thin to prove anything (rows %, with points and mosaic %)', n_rows, n_points;
  END IF;
  RAISE NOTICE 'compared % visible rows (% with points and mosaic)', n_rows, n_points;
END
\$cmp\$;

ROLLBACK;
SQL

echo "ok: get_public_observation and _get_public_observation_stage2a output is byte-identical before and after 20261012100000 for these fixtures"
