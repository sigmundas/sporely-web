#!/usr/bin/env bash
# Both-ways test of supabase/rollbacks/20261002120000_rollback.sql (Stage M,
# server-side minimum-client capability):
#   1. forward state (after reset): the Stage M SQL test passes;
#   2. rollback applied as is (its own transaction): the state fingerprint
#      equals PRE_STAGE (a reset without 20261002120000, taken 2026-10-02 at
#      base 1bda3c1) and the Stage M SQL test fails;
#   3. the forward migration re-applied as is: the fingerprint is identical
#      to step 1 and the Stage M SQL test passes again.
#
# DDL is COMMITTED, so run it only against a freshly reset LOCAL database,
# and reset afterwards:
#   supabase db reset --local && bash supabase/tests/reference_client_capability_rollback_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FORWARD="$HERE/migrations/20261002120000_reference_client_capability_minimum.sql"
ROLLBACK="$HERE/rollbacks/20261002120000_rollback.sql"
STAGE_TEST="$HERE/tests/reference_client_capability_test.sql"

PRE_STAGE="$(cat "$HERE/tests/reference_client_capability_rollback_pre_stage.txt")"

fingerprint() {
  P -c "
    SELECT string_agg(x, E'\n' ORDER BY x) FROM (
      SELECT p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' '
             || coalesce(p.proacl::text,'-') || ' ' || p.prosecdef || ' '
             || md5(pg_get_functiondef(p.oid)) AS x
        FROM pg_proc p
       WHERE p.proname IN ('sync_reference_measurement_set','sync_observation_reference_use',
                           'sync_reference_measurement_set_unthrottled','sync_observation_reference_use_unthrottled',
                           'list_reference_library_feed','record_reference_client_capabilities',
                           'reference_set_withheld_from_v1_readers','reference_use_withheld_from_v1_readers',
                           'fork_withheld_from_v1_readers','set_withheld_from_v1_readers','use_withheld_from_v1_readers',
                           'reference_creation_blocked_by_older_client',
                           'reference_older_client_active','reference_record_client_device',
                           'reference_client_device_id','reference_client_snapshot_versions')
      UNION ALL
      SELECT 'policy ' || tablename || ' ' || policyname || ' ' || permissive || ' ' || cmd || ' '
             || md5(coalesce(qual,'') || '|' || coalesce(with_check,''))
        FROM pg_policies WHERE schemaname='public'
         AND tablename IN ('reference_measurement_sets','observation_reference_uses','reference_client_devices',
                           'reference_curated_forks')
      UNION ALL
      SELECT 'table ' || c.oid::regclass::text || ' ' || coalesce(c.relacl::text,'-')
        FROM pg_class c WHERE c.oid IN (to_regclass('public.reference_client_devices'),
                                         to_regclass('public.reference_measurement_sets'),
                                         to_regclass('public.observation_reference_uses'),
                                         to_regclass('public.reference_curated_forks'))
      UNION ALL
      SELECT 'schema ' || nspname || ' ' || coalesce(nspacl::text,'-') FROM pg_namespace WHERE nspname = 'reference_rls'
    ) s"
}
stage_test_errors() {
  docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=0 -v ON_ERROR_ROLLBACK=on -qAt \
    < "$STAGE_TEST" 2>&1 | grep -c '^ERROR' || true
}

if [[ "${1:-}" == "--print-fingerprint" ]]; then fingerprint; exit 0; fi

[[ "$(stage_test_errors)" == "0" ]] || fail "forward: Stage M SQL test does not pass"
FORWARD_FP="$(fingerprint)"

P < "$ROLLBACK"
[[ "$(fingerprint)" == "$PRE_STAGE" ]] || { diff <(echo "$PRE_STAGE") <(fingerprint) >&2 || true; fail "rollback state differs from pre-stage"; }
n="$(stage_test_errors)"
[[ "$n" -ge 6 ]] || fail "rollback: Stage M SQL test should fail in its blocks (errors: $n)"

P -1 < "$FORWARD"
[[ "$(fingerprint)" == "$FORWARD_FP" ]] || fail "re-applied forward state differs"
[[ "$(stage_test_errors)" == "0" ]] || fail "re-applied: Stage M SQL test does not pass"
echo "ok: rollback equals pre-stage; forward re-apply identical (rollback errors: $n)"
