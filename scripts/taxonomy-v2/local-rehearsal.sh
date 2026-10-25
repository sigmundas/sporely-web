#!/usr/bin/env bash
# Disposable LOCAL rehearsal of a taxonomy-v2 release import. Never touches
# production: it starts its own container from a LOCAL Supabase Postgres image
# (refuses to download), restores a schema-only dump, loads the baseline
# taxonomy and legacy rows, seeds synthetic observations at production scale,
# and runs a local-rehearsal SQL payload (prepare-production-release-import.mjs
# --local-rehearsal) through each scenario. Every scenario asserts its outcome
# and the exit status of every session; the script exits non-zero on the first
# failed assertion.
#
# Inputs (produced separately, read-only; see the release's rehearsal README):
#   --sql FILE          local-rehearsal import SQL
#   --release-id ID     release in the SQL (e.g. tax-2026.10.23-11)
#   --baseline-id ID    release active in the baseline (e.g. tax-2026.10.07-01)
#   --schema FILE       pg_dump --schema-only of public, taxonomy_v3, private, reference_rls
#   --baseline-dir DIR  <table>.tsv copies of the taxonomy_v2_* tables; optional
#                       legacy_taxa.tsv / legacy_taxa_vernacular.tsv
#   --checks FILE       expectations (shell fragment): EXPECT_TAXA, NB_NAMES,
#                       COL_IDS, STALE_ID, OBSERVATIONS (synthetic row count)
#   --log-dir DIR       where to keep logs
#   [--image IMAGE]     default public.ecr.aws/supabase/postgres:17.6.1.084
#   [--keep]            keep the container afterwards
set -euo pipefail

IMAGE=public.ecr.aws/supabase/postgres:17.6.1.084
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sql) SQL=$2; shift 2;; --release-id) REL=$2; shift 2;; --baseline-id) BASE=$2; shift 2;;
    --schema) SCHEMA=$2; shift 2;; --baseline-dir) BASEDIR=$2; shift 2;; --checks) CHECKS=$2; shift 2;;
    --log-dir) LOG=$2; shift 2;; --image) IMAGE=$2; shift 2;; --keep) KEEP=1; shift;;
    *) echo "unknown argument $1" >&2; exit 2;;
  esac
done
# shellcheck source=/dev/null
source "$CHECKS"
OBSERVATIONS=${OBSERVATIONS:-782}
mkdir -p "$LOG"; : > "$LOG/summary.txt"
C=sporely-taxonomy-rehearsal-$$
UID_A=11111111-1111-1111-1111-111111111111
OBS=999999001
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE is not available locally; refusing to download" >&2; exit 2; }
cleanup() { [ "$KEEP" = 1 ] || docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASS=0
now() { python3 -c 'import time;print(f"{time.time():.3f}")'; }
since() { python3 -c "print(f'{$(now)-$1:.2f}')"; }
pass() { PASS=$((PASS+1)); echo "PASS $*" | tee -a "$LOG/summary.txt"; }
fail() { echo "FAIL $*" | tee -a "$LOG/summary.txt"; exit 1; }
note() { echo "     $*" | tee -a "$LOG/summary.txt"; }
psqlc() { docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -At -v ON_ERROR_STOP=1 "$@"; }
q() { psqlc -c "$1"; }
state() { q "select coalesce((select release_id from public.taxonomy_v2_releases where status='active'),'-')||'|'||(select count(*) from public.taxonomy_v2_releases where release_id='$REL')||'|'||(select count(*) from public.taxonomy_v2_taxa where release_id='$REL')||'|'||(select count(*) from public.taxonomy_v2_import_runs where release_id='$REL')"; }
# run_import NAME: runs the payload, records its exit status in $LOG/NAME.rc
run_import() { set +e; docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -f /tmp/import.sql > "$LOG/$1.log" 2>&1; echo $? > "$LOG/$1.rc"; set -e; }
rc() { cat "$LOG/$1.rc"; }
expect_clean_failure() {  # $1 scenario, $2 expected error text
  [ "$(rc "$1")" = 3 ] || fail "$1: psql exit status $(rc "$1"), expected 3 (script error)"
  grep -q "$2" "$LOG/$1.log" || fail "$1: expected error '$2'"
  [ "$(state)" = "$BASE|0|0|0" ] || fail "$1: post-failure state $(state), expected $BASE|0|0|0"
  pass "$1: exit 3 with '$2'; $BASE still active, no $REL release/taxa/import-run rows"
}
# wait_for NAME SQL: poll until SQL returns t (max 20 s)
wait_for() { for _ in $(seq 200); do [ "$(q "$2")" = t ] && return 0; sleep 0.1; done; fail "timed out waiting for $1"; }
pid_of() { q "select coalesce(max(pid)::text,'') from pg_stat_activity where application_name='$1'"; }
waiting_on_releases() { echo "select exists (select 1 from pg_locks l where l.pid=$1 and not l.granted and l.relation='public.taxonomy_v2_releases'::regclass)"; }
holds_release_ae() { echo "select exists (select 1 from pg_locks l where l.pid=$1 and l.granted and l.mode='AccessExclusiveLock' and l.relation='public.taxonomy_v2_releases'::regclass)"; }
reset_to_baseline() {
  q "set session_replication_role=replica; begin;
     delete from public.taxonomy_v2_redlist where release_id='$REL'; delete from public.taxonomy_v2_external_ids where release_id='$REL';
     delete from public.taxonomy_v2_legacy_external_ids where release_id='$REL'; delete from public.taxonomy_v2_vernacular_names where release_id='$REL';
     delete from public.taxonomy_v2_scientific_names where release_id='$REL'; delete from public.taxonomy_v2_taxa where release_id='$REL';
     delete from public.taxonomy_v2_import_runs where release_id='$REL'; delete from public.taxonomy_v2_releases where release_id='$REL';
     update public.taxonomy_v2_releases set status='ready' where release_id='$BASE' and status='retired';
     select public.taxonomy_v2_activate_release('$BASE') where (select status from public.taxonomy_v2_releases where release_id='$BASE')='ready';
     update public.observations set selected_sporely_taxon_id=null, taxon_identity_state=null where id=$OBS; commit;" >/dev/null
  [ "$(state)" = "$BASE|0|0|0" ] || fail "reset: state $(state)"
}
# The real selection RPC, called as the authenticated owner (RLS and triggers active).
rpc_select() {  # $1 taxon id, $2 application_name
  docker exec -e PGAPPNAME="$2" "$C" psql -U postgres -h 127.0.0.1 -X -q -At -v ON_ERROR_STOP=1 -c "
    select set_config('request.jwt.claim.sub','$UID_A',false), set_config('request.jwt.claims','{\"sub\":\"$UID_A\",\"role\":\"authenticated\"}',false);
    set role authenticated;
    select public.set_observation_identification_v2($OBS,$1,'sporely_v2',null,null,null,null,false,null,null,null);"
}

T0=$(now)
echo "== setup $C ($IMAGE)" | tee -a "$LOG/summary.txt"
docker run -d --name "$C" -e POSTGRES_PASSWORD=rehearsal "$IMAGE" >/dev/null
for _ in $(seq 60); do docker exec "$C" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 2; done
sleep 5
docker cp "$SCHEMA" "$C:/tmp/schema.sql"; docker cp "$BASEDIR" "$C:/tmp/base"; docker cp "$SQL" "$C:/tmp/import.sql"
docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -f /tmp/schema.sql > "$LOG/schema-restore.log" 2>&1 || true
# Only the image's pre-existing public schema may fail; anything else (e.g. dropped policies) fails the run.
UNEXPECTED=$(grep "ERROR" "$LOG/schema-restore.log" | grep -v 'schema "public" already exists' || true)
[ -z "$UNEXPECTED" ] || fail "schema restore errors: $(echo "$UNEXPECTED" | head -3)"
pass "schema restore: no errors besides the image's existing public schema ($(q "select count(*) from pg_policies") policies)"
for t in taxonomy_v2_releases taxonomy_v2_concepts taxonomy_v2_taxa taxonomy_v2_scientific_names taxonomy_v2_vernacular_names taxonomy_v2_external_ids taxonomy_v2_redlist; do
  psqlc -c "set session_replication_role=replica" -c "\\copy public.$t from /tmp/base/$t.tsv" >/dev/null
done
# Configuration singleton the selection RPC's rate-limit trigger reads (no personal data).
[ -f "$BASEDIR/private_shared_reference_production_policy.tsv" ] && psqlc -c "\\copy private.shared_reference_production_policy from /tmp/base/private_shared_reference_production_policy.tsv" >/dev/null
for t in taxa taxa_vernacular; do
  [ -f "$BASEDIR/legacy_$t.tsv" ] && psqlc -c "set session_replication_role=replica" -c "\\copy public.$t from /tmp/base/legacy_$t.tsv" >/dev/null
done
[ "$(q "select public.taxonomy_v2_validate_release('$BASE')->>'ok'")" = true ] || fail "baseline $BASE does not validate"
q "insert into auth.users(id,email,aud,role) values ('$UID_A','rehearsal@example.invalid','authenticated','authenticated')" >/dev/null
q "set session_replication_role=replica;
   insert into public.observations(id,user_id,date) overriding system value values ($OBS,'$UID_A',current_date);
   insert into public.observations(id,user_id,date) overriding system value
     select 999000000+g,'$UID_A',current_date from generate_series(1,$OBSERVATIONS-1) g;" >/dev/null
NONCE=$(grep -o "(release_id, nonce) = ('$REL', '[0-9a-f]*')" "$SQL" | grep -o "[0-9a-f]\{64\}")
[ -n "$NONCE" ] || fail "no rehearsal nonce in the SQL (not a local-rehearsal payload?)"
pass "setup: baseline $BASE active and valid; legacy taxa $(q "select count(*) from public.taxa"), vernacular $(q "select count(*) from public.taxa_vernacular"), observations $(q "select count(*) from public.observations") (synthetic); $(since $T0) s"

# 1. Guard: the marker relation alone, or a marker row for another export, is not enough.
q "create table public.sporely_local_rehearsal_marker(release_id text, nonce text)"
q "insert into public.sporely_local_rehearsal_marker values ('$REL', repeat('0',64))"
run_import guard-wrong-nonce
expect_clean_failure guard-wrong-nonce "no marker row for this release and export"
q "insert into public.sporely_local_rehearsal_marker values ('$REL', '$NONCE')"
q "create table public.rehearsal_gate(open boolean); insert into public.rehearsal_gate values (false)"

# 2. Late-commit race A: a writer validates against the baseline, then holds its
#    transaction open; the import reaches the cutover and must wait for it; the
#    writer commits the stale id; the post-activation check must abort the import.
set +e
docker exec -e PGAPPNAME=race_a_writer "$C" psql -U postgres -h 127.0.0.1 -X -q -v ON_ERROR_STOP=1 > "$LOG/race-a-writer.log" 2>&1 -c "
  begin;
  do \$\$ begin if not exists (select 1 from public.taxonomy_v2_releases r join public.taxonomy_v2_taxa t on t.release_id=r.release_id
     where r.status='active' and t.sporely_taxon_id=$STALE_ID) then raise exception 'writer: % not in active release', $STALE_ID; end if;
     while not (select open from public.rehearsal_gate) loop perform pg_sleep(0.05); end loop; end \$\$;
  update public.observations set selected_sporely_taxon_id=$STALE_ID where id=$OBS; commit;" &
WRITER=$!
set -e
wait_for "race A writer to validate" "select exists (select 1 from pg_stat_activity where application_name='race_a_writer' and query like '%rehearsal_gate%')"
WPID=$(pid_of race_a_writer)
( PGAPP=race_a_import; set +e; docker exec -e PGAPPNAME=race_a_import "$C" psql -U postgres -h 127.0.0.1 -X -q -f /tmp/import.sql > "$LOG/race-a-import.log" 2>&1; echo $? > "$LOG/race-a-import.rc" ) &
IMPORT=$!
wait_for "race A import to reach the cutover" "select exists (select 1 from pg_stat_activity where application_name='race_a_import')"
IPID=$(pid_of race_a_import)
wait_for "race A import waiting on the release table" "$(waiting_on_releases "$IPID")"
[ "$(q "select exists (select 1 from pg_locks where pid=$WPID and granted and relation='public.taxonomy_v2_releases'::regclass)")" = t ] || fail "race A: writer does not hold its release-table read lock"
pass "race A overlap: import (pid $IPID) is waiting on taxonomy_v2_releases while the validated writer (pid $WPID) holds it"
q "update public.rehearsal_gate set open=true"
wait $WRITER; WRC=$?
wait $IMPORT || true
[ "$WRC" = 0 ] || fail "race A: writer exit $WRC, expected 0 (it committed against $BASE)"
[ "$(q "select selected_sporely_taxon_id from public.observations where id=$OBS")" = "$STALE_ID" ] || fail "race A: writer did not commit"
expect_clean_failure race-a-import "an observation selects a concept absent from the new active release"
reset_to_baseline
q "update public.rehearsal_gate set open=false"

# 3. Late-commit race B through the real RPC: the import holds the cutover locks
#    (a local-only trigger stretches activation to 3 s); the RPC, called as the
#    authenticated owner, must wait on the release table, then validate against
#    the new release and be rejected.
q "create or replace function public.rehearsal_slow() returns trigger language plpgsql as \$\$ begin if new.status='active' then perform pg_sleep(3); end if; return new; end \$\$;
   create trigger rehearsal_slow_trg before update on public.taxonomy_v2_releases for each row execute function public.rehearsal_slow();"
( set +e; docker exec -e PGAPPNAME=race_b_import "$C" psql -U postgres -h 127.0.0.1 -X -q -f /tmp/import.sql > "$LOG/race-b-import.log" 2>&1; echo $? > "$LOG/race-b-import.rc" ) &
IMPORT=$!
wait_for "race B import to start" "select exists (select 1 from pg_stat_activity where application_name='race_b_import')"
IPID=$(pid_of race_b_import)
wait_for "race B import to hold the cutover lock" "$(holds_release_ae "$IPID")"
( set +e; rpc_select "$STALE_ID" race_b_rpc > "$LOG/race-b-rpc.log" 2>&1; echo $? > "$LOG/race-b-rpc.rc" ) &
RPC=$!
wait_for "race B RPC to start" "select exists (select 1 from pg_stat_activity where application_name='race_b_rpc')"
RPID=$(pid_of race_b_rpc)
wait_for "race B RPC waiting on the release table" "$(waiting_on_releases "$RPID")"
pass "race B overlap: RPC (pid $RPID, role authenticated) is waiting on taxonomy_v2_releases held by the import (pid $IPID)"
wait $IMPORT || true; wait $RPC || true
q "drop trigger rehearsal_slow_trg on public.taxonomy_v2_releases; drop function public.rehearsal_slow()"
[ "$(rc race-b-import)" = 0 ] || fail "race B: import exit $(rc race-b-import), expected 0"
[ "$(cat "$LOG/race-b-rpc.rc")" != 0 ] && grep -q "missing from the active taxonomy-v2 release" "$LOG/race-b-rpc.log" || fail "race B: RPC was not rejected against $REL"
[ -z "$(q "select selected_sporely_taxon_id from public.observations where id=$OBS")" ] || fail "race B: stale id stored"
pass "race B: import exit 0; RPC exit $(cat "$LOG/race-b-rpc.rc"), rejected after waiting ('missing from the active taxonomy-v2 release'); no stale id stored"
reset_to_baseline

# 4. Timed import with a poller measuring how long the cutover lock is held.
psqlc -c "create table public.rehearsal_lock_samples(t timestamptz, held boolean)" >/dev/null
( docker exec -e PGAPPNAME=poller "$C" psql -U postgres -h 127.0.0.1 -X -q -v ON_ERROR_STOP=1 -c "
  do \$\$ declare t0 timestamptz := clock_timestamp(); seen boolean := false; running boolean; begin
    -- Reads only pg_locks/pg_stat_activity: it must hold no lock on the release table.
    while clock_timestamp() < t0 + interval '300 s' loop
      perform pg_stat_clear_snapshot();  -- pg_stat_activity is otherwise frozen for the transaction
      running := exists (select 1 from pg_stat_activity where application_name='timed_import');
      seen := seen or running;
      exit when seen and not running;
      insert into public.rehearsal_lock_samples select clock_timestamp(), exists (select 1 from pg_locks l join pg_stat_activity a using (pid)
        where a.application_name='timed_import' and l.granted and l.mode='AccessExclusiveLock' and l.relation='public.taxonomy_v2_releases'::regclass::oid);
      perform pg_sleep(0.01);
    end loop; end \$\$;" > "$LOG/poller.log" 2>&1 ) &
POLLER=$!
TI=$(now)
set +e; docker exec -e PGAPPNAME=timed_import "$C" psql -U postgres -h 127.0.0.1 -X -q -f /tmp/import.sql > "$LOG/import.log" 2>&1; echo $? > "$LOG/import.rc"; set -e
TOTAL=$(since "$TI")
wait $POLLER || true
[ "$(rc import)" = 0 ] || fail "import: exit $(rc import)"
CUT=$(q "select coalesce(round(extract(epoch from max(t)-min(t))::numeric,3)::text,'n/a') from public.rehearsal_lock_samples where held")
SAMPLES=$(q "select count(*) from public.rehearsal_lock_samples")
[ "$(state)" = "$REL|1|$EXPECT_TAXA|1" ] || fail "import: state $(state)"
[ "$(q "select public.taxonomy_v2_validate_release('$REL')->>'ok'")" = true ] || fail "import: $REL does not validate"
[ "$(q "select status from public.taxonomy_v2_releases where release_id='$BASE'")" = retired ] || fail "import: $BASE not retired"
pass "import+activation: exit 0; $REL active, $EXPECT_TAXA taxa, validates; $BASE retired"
note "timing: total import ${TOTAL} s; cutover (ACCESS EXCLUSIVE on taxonomy_v2_releases held) ${CUT} s (from $SAMPLES lock samples)"

for entry in "${NB_NAMES[@]}"; do
  name=${entry%%:*}; id=${entry##*:}
  [ "$(q "select taxon_id from public.search_taxa_v2('$name','no',5) limit 1")" = "$id" ] || fail "search '$name' expected $id"
done
pass "search_taxa_v2: ${#NB_NAMES[@]} Norwegian names return their concepts"
for entry in "${COL_IDS[@]}"; do
  col=${entry%%:*}; id=${entry##*:}
  got=$(q "select coalesce(string_agg(r.taxon_id::text,','),'none') from public.resolve_taxon_external_id_v2('col_xr','col_usage_id','$col') r")
  [ "$got" = "$id" ] || fail "resolve COL $col expected $id got $got"
done
pass "resolve_taxon_external_id_v2: ${#COL_IDS[@]} COL ids resolve as expected"
set +e; rpc_select "$STALE_ID" post_rpc > "$LOG/post-rpc-stale.log" 2>&1; S1=$?; set -e
[ $S1 != 0 ] || fail "RPC accepted $STALE_ID after activation"
VALID=$(q "select sporely_taxon_id from public.taxonomy_v2_taxa where release_id='$REL' order by sporely_taxon_id limit 1")
set +e; rpc_select "$VALID" post_rpc > "$LOG/post-rpc-valid.log" 2>&1; S2=$?; set -e
[ $S2 = 0 ] && [ "$(q "select selected_sporely_taxon_id from public.observations where id=$OBS")" = "$VALID" ] || fail "RPC rejected a concept of $REL"
pass "RPC after activation: rejects $STALE_ID (exit $S1), accepts $VALID from $REL (exit 0)"
q "set session_replication_role=replica; update public.observations set selected_sporely_taxon_id=null where id=$OBS" >/dev/null

# 5. Replay refused, state unchanged.
run_import replay
[ "$(rc replay)" = 3 ] && grep -q "safe replay stopped" "$LOG/replay.log" || fail "replay: exit $(rc replay), not refused"
[ "$(state)" = "$REL|1|$EXPECT_TAXA|1" ] || fail "replay: state changed $(state)"
pass "replay: exit 3, refused; state unchanged"

# 6. Rollback to the baseline release (runbook SQL); the release is retired, not deleted.
q "BEGIN; UPDATE public.taxonomy_v2_releases SET status='ready' WHERE release_id='$BASE' AND status='retired'; SELECT public.taxonomy_v2_activate_release('$BASE'); COMMIT;" >/dev/null
[ "$(q "select string_agg(release_id||':'||status,',' order by release_id) from public.taxonomy_v2_releases where release_id in ('$BASE','$REL')")" = "$BASE:active,$REL:retired" ] || fail "rollback: wrong statuses"
[ "$(q "select count(*) from public.taxonomy_v2_taxa where release_id='$REL'")" = "$EXPECT_TAXA" ] || fail "rollback: $REL rows changed"
[ "$(q "select count(*) from public.search_taxa_v2('kantareller','no',5)")" -gt 0 ] || fail "rollback: search broken"
pass "rollback: $BASE active again, $REL retired with its rows kept, search answers"
echo "ALL $PASS CHECKS PASSED in $(since $T0) s" | tee -a "$LOG/summary.txt"
