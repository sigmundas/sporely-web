#!/usr/bin/env bash
# Both-ways test of supabase/rollbacks/20261001213000_rollback.sql (Stage A,
# version-aware public reference reads):
#   1. forward state (after reset): the Stage A SQL test passes;
#   2. rollback applied as is (its own transaction): the Stage A functions
#      are gone, the prior signatures are back with their prior owner and
#      ACLs, and the Stage A SQL test fails in every block that depends on
#      Stage A (fixture ok, read/share blocks fail);
#   3. the forward migration re-applied as is: the function fingerprint is
#      identical to step 1 and the Stage A SQL test passes again.
# The rollback state must equal PRE_STAGE exactly: the fingerprint of a
# reset without 20261001213000 (taken 2026-10-01 at base 8afc74f +
# 20261001195524). Update it only if an earlier migration legitimately
# redefines one of these functions.
#
# DDL is COMMITTED, so run it only against a freshly reset LOCAL database,
# and reset afterwards:
#   supabase db reset --local && bash supabase/tests/reference_snapshot_version_rollback_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FORWARD="$HERE/migrations/20261001213000_version_aware_public_reference_reads.sql"
ROLLBACK="$HERE/rollbacks/20261001213000_rollback.sql"
STAGE_TEST="$HERE/tests/reference_snapshot_version_public_reads_test.sql"

PRE_STAGE='get_public_observation_references(bigint) postgres {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres} true 5779e59c604705e3f6b8273ffedaa1c4
get_public_reference_contribution_v2(uuid,integer) postgres {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres} true 5a73cd99178ab24e265005a4f96b2f3b
private._taxon_identity_repair_reconcile_references(bigint,bigint) postgres {postgres=X/postgres} false 838bccb93ed14e83db75c2900cb293a6
private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) postgres {postgres=X/postgres} false ddcb5d6fabf40c31967c4501e8539f89
private.withdraw_shared_reference_contribution(uuid,text) postgres {postgres=X/postgres} false 4174c741e202e2b49c3b52b823a6f82c
search_public_observation_references(bigint[]) postgres {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres} true 4b67896a97fbaf0d5e860865a95fc0b5
search_public_reference_contributions_v2(integer,integer,timestamp with time zone,uuid) postgres {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres} true 99ac4cb9b1241c9a7b01d72c6f2a6c3e
constraint reason_check 408425d04a2aedab89e548b9425e0b54'

fingerprint() {
  P -c "
    SELECT string_agg(p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' '
                      || coalesce(p.proacl::text,'-') || ' ' || p.prosecdef || ' '
                      || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p
     WHERE p.proname IN ('search_public_reference_contributions_v2','get_public_reference_contribution_v2',
                         'search_public_observation_references','get_public_observation_references',
                         'reference_contribution_share_core','_taxon_identity_repair_reconcile_references',
                         'reference_accepts_snapshot_v2','reference_public_snapshot_project_v1',
                         'reference_public_item_for_versions','reference_automatic_share_scope',
                         'withdraw_shared_reference_contribution')
    UNION ALL
    SELECT 'constraint reason_check ' || md5(pg_get_constraintdef(oid))
      FROM pg_constraint WHERE conname = 'shared_reference_consent_events_reason_check'"
}
stage_test_errors() {
  docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=0 -v ON_ERROR_ROLLBACK=on -qAt \
    < "$STAGE_TEST" 2>&1 | grep -c '^ERROR' || true
}

[ "$(P -c "select count(*) from supabase_migrations.schema_migrations where version='20261001213000'")" = 1 ] \
  || fail "forward migration not applied; reset the local database first"

P < "$STAGE_TEST" > /dev/null || fail "forward: Stage A SQL test fails"
FWD="$(fingerprint)"

P < "$ROLLBACK" > /dev/null
OLD="$(fingerprint)"
[ "$OLD" = "$PRE_STAGE" ] || { diff <(echo "$PRE_STAGE") <(echo "$OLD") >&2 || true; fail "rollback state differs from the pre-stage fingerprint"; }
ERRS="$(stage_test_errors)"
[ "$ERRS" -ge 7 ] || fail "rollback: the Stage A test should fail in its Stage A blocks (got $ERRS errors)"

P < "$FORWARD" > /dev/null
[ "$(fingerprint)" = "$FWD" ] || fail "forward re-apply differs from the original forward state"
P < "$STAGE_TEST" > /dev/null || fail "forward re-applied: Stage A SQL test fails"
echo "PASS: rollback restores the prior surface; forward re-applies identically"
