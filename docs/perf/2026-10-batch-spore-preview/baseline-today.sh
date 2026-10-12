#!/usr/bin/env bash
# Prints SQL that restores the pre-20261012100000 get_public_observation and
# _get_public_observation_stage2a (production today), from the applied
# migrations. With --as-copies, it renames them to public.zz_today_* instead,
# so both versions exist side by side for the HTTP benchmark.
#
#   bash docs/perf/2026-10-batch-spore-preview/baseline-today.sh > /tmp/today.sql
#   bash docs/perf/2026-10-batch-spore-preview/baseline-today.sh --as-copies > /tmp/today-copies.sql
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
extract_function() {
  awk -v start="$2" 'index($0, start) == 1 { on = 1 } on { print } on && $0 == "$function$;" { exit }' "$1"
}
SQL="$(extract_function "$HERE/supabase/migrations/20260925120000_owner_sync_metadata_parents.sql" 'CREATE OR REPLACE FUNCTION public._get_public_observation_stage2a(')
$(extract_function "$HERE/supabase/migrations/20261001195524_hide_observation_time_of_day_from_non_owners.sql" 'CREATE OR REPLACE FUNCTION public.get_public_observation(p_observation_id bigint)')"
if [ "${1:-}" = "--as-copies" ]; then
  SQL="$(printf '%s\n' "$SQL" \
    | sed -e 's/public\._get_public_observation_stage2a(/public.zz_today_stage2a(/g' \
          -e 's/public\.get_public_observation(p_observation_id bigint)/public.zz_today_get_public_observation(p_observation_id bigint)/')"
  SQL="$SQL
GRANT EXECUTE ON FUNCTION public.zz_today_get_public_observation(bigint) TO anon;
NOTIFY pgrst, 'reload schema';"
fi
printf '%s\n' "$SQL"
