#!/usr/bin/env bash
# Disposable LOCAL rehearsal of a taxonomy-v2 release import. Never touches
# production: it starts its own container from a local Supabase Postgres image,
# restores a schema-only dump, loads the baseline taxonomy rows, and runs a
# local-rehearsal SQL payload (prepare-production-release-import.mjs
# --local-rehearsal) through each scenario. Every scenario asserts its outcome;
# the script exits non-zero on the first failed assertion.
#
# Inputs (produced separately, read-only, see the release's rehearsal README):
#   --sql FILE          local-rehearsal import SQL
#   --release-id ID     release in the SQL (e.g. tax-2026.10.23-11)
#   --baseline-id ID    release active in the baseline (e.g. tax-2026.10.07-01)
#   --schema FILE       pg_dump --schema-only of public, taxonomy_v3, private
#   --baseline-dir DIR  <table>.tsv copies of the taxonomy_v2_* tables
#   --checks FILE       scenario expectations (shell fragment, see below)
#   --log-dir DIR       where to keep logs
#   [--image IMAGE]     default public.ecr.aws/supabase/postgres:17.6.1.084 (must be local)
#   [--keep]            keep the container afterwards
#
# --checks defines: EXPECT_TAXA, NB_NAMES (array of "name:taxon_id"),
# COL_IDS (array of "col_id:taxon_id|none"), STALE_ID (an id active in the
# baseline but absent from the release).
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
mkdir -p "$LOG"
C=sporely-taxonomy-rehearsal-$$
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE is not available locally; refusing to download" >&2; exit 2; }
cleanup() { [ "$KEEP" = 1 ] || docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASS=0
pass() { PASS=$((PASS+1)); echo "PASS $*" | tee -a "$LOG/summary.txt"; }
fail() { echo "FAIL $*" | tee -a "$LOG/summary.txt"; exit 1; }
q() { docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }
run_sql() { docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -f /tmp/import.sql > "$LOG/$1.log" 2>&1; }
state() { q "select coalesce((select release_id from public.taxonomy_v2_releases where status='active'),'-')||'|'||(select count(*) from public.taxonomy_v2_releases where release_id='$REL')||'|'||(select count(*) from public.taxonomy_v2_taxa where release_id='$REL')||'|'||(select count(*) from public.taxonomy_v2_import_runs where release_id='$REL')"; }
expect_clean_failure() {  # $1 scenario, $2 expected error text
  grep -q "$2" "$LOG/$1.log" || fail "$1: expected error '$2'"
  [ "$(state)" = "$BASE|0|0|0" ] || fail "$1: post-failure state $(state), expected $BASE|0|0|0"
  pass "$1: refused ('$2'); $BASE still active, no $REL rows"
}
reset_to_baseline() {
  q "set session_replication_role=replica; begin;
     delete from public.taxonomy_v2_redlist where release_id='$REL'; delete from public.taxonomy_v2_external_ids where release_id='$REL';
     delete from public.taxonomy_v2_legacy_external_ids where release_id='$REL'; delete from public.taxonomy_v2_vernacular_names where release_id='$REL';
     delete from public.taxonomy_v2_scientific_names where release_id='$REL'; delete from public.taxonomy_v2_taxa where release_id='$REL';
     delete from public.taxonomy_v2_import_runs where release_id='$REL'; delete from public.taxonomy_v2_releases where release_id='$REL';
     update public.taxonomy_v2_releases set status='ready' where release_id='$BASE' and status='retired';
     select public.taxonomy_v2_activate_release('$BASE') where (select status from public.taxonomy_v2_releases where release_id='$BASE')='ready';
     update public.observations set selected_sporely_taxon_id=null where id=999999001; commit;" >/dev/null
  [ "$(state)" = "$BASE|0|0|0" ] || fail "reset: state $(state)"
}

echo "== setup $C ($IMAGE)" | tee "$LOG/summary.txt"
docker run -d --name "$C" -e POSTGRES_PASSWORD=rehearsal "$IMAGE" >/dev/null
for _ in $(seq 60); do docker exec "$C" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 2; done
sleep 5
docker cp "$SCHEMA" "$C:/tmp/schema.sql"; docker cp "$BASEDIR" "$C:/tmp/base"; docker cp "$SQL" "$C:/tmp/import.sql"
docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -f /tmp/schema.sql > "$LOG/schema-restore.log" 2>&1 || true
for t in taxonomy_v2_releases taxonomy_v2_concepts taxonomy_v2_taxa taxonomy_v2_scientific_names taxonomy_v2_vernacular_names taxonomy_v2_external_ids taxonomy_v2_redlist; do
  docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -v ON_ERROR_STOP=1 -c "set session_replication_role=replica" -c "\\copy public.$t from /tmp/base/$t.tsv" >/dev/null
done
[ "$(q "select public.taxonomy_v2_validate_release('$BASE')->>'ok'")" = true ] || fail "baseline $BASE does not validate"
q "set session_replication_role=replica; insert into public.observations(id,user_id,date) overriding system value values (999999001, gen_random_uuid(), current_date)" >/dev/null
NONCE=$(grep -o "(release_id, nonce) = ('$REL', '[0-9a-f]*')" "$SQL" | grep -o "[0-9a-f]\{64\}")
[ -n "$NONCE" ] || fail "no rehearsal nonce in the SQL (not a local-rehearsal payload?)"
pass "setup: schema restored, baseline $BASE active and valid"

# 1. Guard: marker relation without the bound row.
q "create table public.sporely_local_rehearsal_marker(release_id text, nonce text)"
q "insert into public.sporely_local_rehearsal_marker values ('$REL', repeat('0',64))"
run_sql guard-wrong-nonce || true
expect_clean_failure guard-wrong-nonce "no marker row for this release and export"
q "insert into public.sporely_local_rehearsal_marker values ('$REL', '$NONCE')"

# 2. Failed import: an observation changes while the import holds no write lock yet
#    is impossible now (writers wait); force a failure instead with an invalid
#    selection that the post-activation check must catch (late-commit race, case A).
#    Writer validates against the baseline, sleeps, writes the stale id, commits;
#    the import starts while the writer sleeps.
docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -v ON_ERROR_STOP=1 > "$LOG/race-a-writer.log" 2>&1 -c "
  set session_replication_role=replica; begin;
  do \$\$ begin if not exists (select 1 from public.taxonomy_v2_releases r join public.taxonomy_v2_taxa t on t.release_id=r.release_id
     where r.status='active' and t.sporely_taxon_id=$STALE_ID) then raise exception 'writer: % not in active release', $STALE_ID; end if; end \$\$;
  select pg_sleep(4);
  update public.observations set selected_sporely_taxon_id=$STALE_ID where id=999999001; commit;" &
WRITER=$!; sleep 1
run_sql race-a-import || true
wait $WRITER || fail "race A: writer should have validated against $BASE and committed first"
[ "$(q "select selected_sporely_taxon_id from public.observations where id=999999001")" = "$STALE_ID" ] || fail "race A: writer did not commit"
expect_clean_failure race-a-import "an observation selects a concept absent from the new active release"
reset_to_baseline

# 3. Late-commit race, case B: writer starts validating after the import holds its locks.
run_sql_bg() { docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -f /tmp/import.sql > "$LOG/$1.log" 2>&1; }
q "create or replace function public.rehearsal_slow() returns trigger language plpgsql as \$\$ begin perform pg_sleep(3); return new; end \$\$;
   create trigger rehearsal_slow_trg before insert on public.taxonomy_v2_releases for each row execute function public.rehearsal_slow();"
run_sql_bg race-b-import & IMPORT=$!; sleep 1.5
set +e
docker exec "$C" psql -U postgres -h 127.0.0.1 -X -q -v ON_ERROR_STOP=1 > "$LOG/race-b-writer.log" 2>&1 -c "
  set session_replication_role=replica; begin;
  do \$\$ begin if not exists (select 1 from public.taxonomy_v2_releases r join public.taxonomy_v2_taxa t on t.release_id=r.release_id
     where r.status='active' and t.sporely_taxon_id=$STALE_ID) then raise exception 'writer: % not in active release', $STALE_ID; end if; end \$\$;
  update public.observations set selected_sporely_taxon_id=$STALE_ID where id=999999001; commit;"
WRC=$?; set -e
wait $IMPORT || fail "race B: import failed (see race-b-import.log)"
q "drop trigger rehearsal_slow_trg on public.taxonomy_v2_releases; drop function public.rehearsal_slow()"
[ $WRC -ne 0 ] && grep -q "not in active release" "$LOG/race-b-writer.log" || fail "race B: writer was not rejected against $REL"
[ -z "$(q "select selected_sporely_taxon_id from public.observations where id=999999001")" ] || fail "race B: stale id stored"
pass "race B: writer waited for the import, then validated against $REL and was rejected; no stale id stored"

# 4. Import + activation (race B's import is the successful import).
[ "$(state)" = "$REL|1|$EXPECT_TAXA|1" ] || fail "import: state $(state)"
[ "$(q "select public.taxonomy_v2_validate_release('$REL')->>'ok'")" = true ] || fail "import: $REL does not validate"
[ "$(q "select status from public.taxonomy_v2_releases where release_id='$BASE'")" = retired ] || fail "import: $BASE not retired"
pass "import+activation: $REL active, $EXPECT_TAXA taxa, validates; $BASE retired"
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

# 5. Replay refused, state unchanged.
run_sql replay || true
grep -q "safe replay stopped" "$LOG/replay.log" || fail "replay: not refused"
[ "$(state)" = "$REL|1|$EXPECT_TAXA|1" ] || fail "replay: state changed $(state)"
pass "replay: refused, state unchanged"

# 6. Rollback to the baseline release (runbook SQL), then the release is retired, not deleted.
q "BEGIN; UPDATE public.taxonomy_v2_releases SET status='ready' WHERE release_id='$BASE' AND status='retired'; SELECT public.taxonomy_v2_activate_release('$BASE'); COMMIT;" >/dev/null
[ "$(q "select string_agg(release_id||':'||status,',' order by release_id) from public.taxonomy_v2_releases where release_id in ('$BASE','$REL')")" = "$BASE:active,$REL:retired" ] || fail "rollback: wrong statuses"
[ "$(q "select count(*) from public.taxonomy_v2_taxa where release_id='$REL'")" = "$EXPECT_TAXA" ] || fail "rollback: $REL rows changed"
pass "rollback: $BASE active again, $REL retired with its rows kept"
echo "ALL $PASS CHECKS PASSED" | tee -a "$LOG/summary.txt"
