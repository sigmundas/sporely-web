#!/usr/bin/env bash
# Point order of get_public_observation before 20261012100000 (no ORDER BY,
# plan order) against after (image id, measurement id), over every eligible
# seeded observation. LOCAL ONLY; seed.sql first. One transaction, rolled
# back: the previous definitions are restored from the applied migrations,
# as in supabase/tests/public_observation_spore_previews_identity_test.sh.
#
#   bash docs/perf/2026-10-batch-spore-preview/order-vs-old.sh
set -euo pipefail
DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
extract_function() {
  awk -v start="$2" 'index($0, start) == 1 { on = 1 } on { print } on && $0 == "$function$;" { exit }' "$1"
}
OLD_STAGE2A="$(extract_function "$HERE/supabase/migrations/20260925120000_owner_sync_metadata_parents.sql" 'CREATE OR REPLACE FUNCTION public._get_public_observation_stage2a(')"
OLD_WRAPPER="$(extract_function "$HERE/supabase/migrations/20261001195524_hide_observation_time_of_day_from_non_owners.sql" 'CREATE OR REPLACE FUNCTION public.get_public_observation(p_observation_id bigint)')"

docker exec -i "$DB" psql -U postgres -X -v ON_ERROR_STOP=1 -qAt <<SQL
BEGIN;
CREATE TEMP TABLE ord (phase text, observation_id bigint, ids jsonb) ON COMMIT DROP;
CREATE TEMP TABLE elig ON COMMIT DROP AS SELECT observation_id FROM perf_bsp.obs WHERE kind = 'eligible';
CREATE FUNCTION pg_temp.snap(p text) RETURNS void LANGUAGE sql AS \$f\$
  INSERT INTO ord
  SELECT p, e.observation_id,
         (SELECT jsonb_agg(pt.value->'id' ORDER BY pt.n)
          FROM public.get_public_observation(e.observation_id) g,
               jsonb_array_elements(g."sporePoints") WITH ORDINALITY pt(value, n))
  FROM elig e
\$f\$;
CREATE FUNCTION pg_temp.diff(a text, b text) RETURNS bigint LANGUAGE sql AS \$f\$
  SELECT count(*) FROM ord x JOIN ord y USING (observation_id)
  WHERE x.phase = a AND y.phase = b AND x.ids IS DISTINCT FROM y.ids
\$f\$;

SELECT pg_temp.snap('new');
$OLD_STAGE2A
$OLD_WRAPPER
SELECT pg_temp.snap('old default plan');

SET LOCAL enable_nestloop = off;
SET LOCAL enable_mergejoin = off;
SELECT pg_temp.snap('old hash plan');
RESET enable_nestloop;
RESET enable_mergejoin;

-- Update of an unindexed column of the first measurement of 20
-- observations. HOT only if the row's page has room; the count is printed.
UPDATE public.spore_measurements m SET length_um = m.length_um
 WHERE m.id IN (SELECT min(m2.id) FROM public.spore_measurements m2
                JOIN public.observation_images i ON i.id = m2.image_id
                WHERE i.observation_id IN (SELECT observation_id FROM elig ORDER BY 1 LIMIT 20)
                GROUP BY i.observation_id);
SELECT 'HOT updates among those 20', n_tup_hot_upd FROM pg_stat_xact_user_tables WHERE relid = 'public.spore_measurements'::regclass;
SELECT pg_temp.snap('old after unindexed-column update');

-- Update of an indexed column (thumb_key; never HOT) of the first
-- measurement of the next 20 observations. Counts are cumulative.
UPDATE public.spore_measurements m SET thumb_key = m.thumb_key || '?r=1'
 WHERE m.id IN (SELECT min(m2.id) FROM public.spore_measurements m2
                JOIN public.observation_images i ON i.id = m2.image_id
                WHERE i.observation_id IN (SELECT observation_id FROM elig ORDER BY 1 OFFSET 20 LIMIT 20)
                GROUP BY i.observation_id);
SELECT pg_temp.snap('old after indexed-column update');

SELECT 'eligible observations', count(*) FROM elig;
SELECT 'differs from new: ' || phase, pg_temp.diff('new', phase)
FROM (VALUES ('old default plan'), ('old hash plan'), ('old after unindexed-column update'), ('old after indexed-column update')) v(phase);
ROLLBACK;
SQL
