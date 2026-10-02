#!/usr/bin/env bash
# Test of supabase/reference-client-devices-clear-stale.sql (Stage M operator
# procedure): guard blocks -> script clears -> creation allowed -> script again
# is a no-op -> an old-desktop (undeclared) write re-registers -> guard blocks
# again; another account's records are untouched; unset/invalid/nil/unknown
# user_id is refused without changes.
#
# COMMITS fixture rows (removed at the end), so run it only against a LOCAL
# database with 20261002120000 applied:
#   supabase db reset --local && bash supabase/tests/reference_client_devices_clear_stale_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$HERE/reference-client-devices-clear-stale.sql"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; cleanup; exit 1; }
A=00000000-0000-4000-8000-0000000c4001
B=00000000-0000-4000-8000-0000000c4002
TR=72000000-0000-4000-8000-0000000c4001
CAP='{"reference_snapshot_versions":[1,2],"device_id":"5e000000-0000-4000-8000-0000000c4001","client":"desktop_app"}'
QAV='{"schema_version":1,"metrics":{"q":{"mean_interval":{"lower":1.6,"upper":2,"kind":"reported_range"}}}}'

cleanup() { P -c "DELETE FROM auth.users WHERE id IN ('$A','$B')" >/dev/null 2>&1 || true; }
run_script() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@" < "$SCRIPT"; }
# sync_reference_measurement_set as the given user; prints the status
sync_as() {  # user payload expected caps
  P <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true) \gset
SET LOCAL ROLE authenticated;
SELECT public.sync_reference_measurement_set('$2'::jsonb, $3, $4)->>'status';
COMMIT;
SQL
}
legacy_payload() { echo "{\"id\":\"$1\",\"taxon_treatment_id\":\"$2\",\"character\":\"spore_size\",\"data_kind\":\"range\",\"raw_text\":\"8-10 um\",\"revision\":1}"; }
enhanced_payload() { echo "{\"id\":\"$1\",\"taxon_treatment_id\":\"$TR\",\"character\":\"spore_size\",\"data_kind\":\"range\",\"raw_text\":\"Qav 1.6-2\",\"revision\":1,\"measurement_details_json\":$QAV,\"q_core_min\":null,\"q_core_max\":null}"; }
count_dev() { P -c "SELECT count(*) FROM public.reference_client_devices WHERE user_id='$1' AND NOT (2 = ANY(reference_snapshot_versions))"; }

cleanup
P <<SQL >/dev/null
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
  ('$A','authenticated','authenticated','clear-a@example.invalid','{}',now(),now()),
  ('$B','authenticated','authenticated','clear-b@example.invalid','{}',now(),now());
INSERT INTO public.profiles(id,username,is_banned) VALUES ('$A','clear_a',false),('$B','clear_b',false);
INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision) VALUES
  ('$A','71000000-0000-4000-8000-0000000c4001','article','[{"family":"Op"}]','Ops',2026,'Op 2026',1),
  ('$B','71000000-0000-4000-8000-0000000c4002','article','[{"family":"Op"}]','Ops',2026,'Op 2026',1);
INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision) VALUES
  ('$A','$TR','71000000-0000-4000-8000-0000000c4001','q','Inocybe operatoria',1),
  ('$B','72000000-0000-4000-8000-0000000c4002','71000000-0000-4000-8000-0000000c4002','q','Inocybe operatoria',1);
SQL

# old desktops of both accounts write (undeclared) -> pseudo-device recorded
[[ "$(sync_as $A "$(legacy_payload 73000000-0000-4000-8000-0000000c4001 $TR)" 0 NULL)" == created ]] || fail "legacy write A"
[[ "$(sync_as $B "$(legacy_payload 73000000-0000-4000-8000-0000000c4101 72000000-0000-4000-8000-0000000c4002)" 0 NULL)" == created ]] || fail "legacy write B"
[[ "$(count_dev $A)" == 1 && "$(count_dev $B)" == 1 ]] || fail "pseudo-devices not recorded"

# 1. guard blocks
[[ "$(sync_as $A "$(enhanced_payload 73000000-0000-4000-8000-0000000c4002)" 0 "'$CAP'")" == older_client_active ]] || fail "guard should block"

# refusals change nothing
run_script >/dev/null 2>&1 && fail "unset user_id accepted"
run_script -v user_id=not-a-uuid >/dev/null 2>&1 && fail "invalid user_id accepted"
run_script -v user_id=00000000-0000-0000-0000-000000000000 >/dev/null 2>&1 && fail "nil user_id accepted"
run_script -v user_id=00000000-0000-4000-8000-0000000c4999 >/dev/null 2>&1 && fail "unknown account accepted"
[[ "$(count_dev $A)" == 1 && "$(count_dev $B)" == 1 ]] || fail "a refused run changed rows"

# 2. script clears A only
out="$(run_script -v user_id=$A)"
grep -q '^removed|1$' <<<"$out" || fail "first run should remove 1: $out"
grep -q '^remaining|5e000000-0000-4000-8000-0000000c4001|' <<<"$out" || fail "capable device should remain: $out"
[[ "$(count_dev $A)" == 0 && "$(count_dev $B)" == 1 ]] || fail "scope: A cleared, B untouched"

# 3. creation allowed
[[ "$(sync_as $A "$(enhanced_payload 73000000-0000-4000-8000-0000000c4002)" 0 "'$CAP'")" == created ]] || fail "creation should be allowed"

# 4. second run is a no-op
out="$(run_script -v user_id=$A)"
grep -q '^removed|0$' <<<"$out" || fail "second run should remove 0: $out"

# 5. an old desktop writes again -> re-registers -> guard blocks again
[[ "$(sync_as $A "$(legacy_payload 73000000-0000-4000-8000-0000000c4003 $TR)" 0 NULL)" == created ]] || fail "legacy write A again"
[[ "$(count_dev $A)" == 1 ]] || fail "old desktop did not re-register"
[[ "$(sync_as $A "$(enhanced_payload 73000000-0000-4000-8000-0000000c4004)" 0 "'$CAP'")" == older_client_active ]] || fail "guard should block again"

# reference data untouched by the script
[[ "$(P -c "SELECT count(*) FROM public.reference_measurement_sets WHERE user_id IN ('$A','$B')")" == 4 ]] || fail "reference rows changed"

cleanup
echo "ok: clear-stale script scoped, idempotent, re-registration restores the guard"
