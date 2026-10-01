#!/usr/bin/env bash
# Two-session races for Stage 2a (20260930224506_fail_closed_reference_sharing_consent.sql).
#
# Each race gets its own owner, set, observation and use, with a consented
# contribution seeded through the core's grant mode. Session A runs one
# operation and holds its transaction open; session B then runs the other and
# must wait for A. Both orders are run for every pair:
#   detach / visibility flip / draft flip / taxon change  vs  refresh (source edit)
#   source edit  vs  use sync
#   owner withdraw  vs  refresh
# and, for Stage 2b (20260930232633), the public grant RPC:
#   grant  vs  owner withdraw / draft flip / account deletion / text revocation
# The account-deletion race holds the profile row first (as a profile delete
# does before its anonymise trigger takes the key locks), so a grant that
# took the key lock before the profile row would deadlock.
# A race fails on any error in either session (in particular a deadlock,
# 40P01), when B did not wait, when the contribution ends in the wrong state,
# or when any share survives without a qualifying use.
#
# Fixtures are COMMITTED, so run it only against a freshly reset LOCAL database:
#   supabase db reset --local && bash supabase/tests/shared_reference_consent_concurrency_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
LOG="${TMPDIR:-/tmp}/shared_reference_consent_race"

[ "$(P -c "select count(*) from private.shared_reference_contributions")" = 0 ] \
  || fail "contributions exist; run against a freshly reset local database"

T=2100000971
T2=2100000972

P <<SQL
INSERT INTO taxonomy_v3.registry_concept(
  sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
) VALUES ($T,'Amanita concurrens','species','include','in_cache','race-test'),
         ($T2,'Amanita altera','species','include','in_cache','race-test');
-- The fixture text replaces the shipped, inactive version-1 texts.
DELETE FROM private.reference_share_consent_texts;
INSERT INTO private.reference_share_consent_texts(version,locale,text,text_sha256,active,scope)
VALUES (1,'en','fixture consent text',encode(sha256(convert_to('fixture consent text','UTF8')),'hex'),true,
        '{"snapshot_schema_versions":[1,2],"data_kinds":["raw_points","free_text","measurement_details"]}');
SQL

owner() { printf '00000000-0000-4000-8000-0000000e%04d' "$1"; }
set_id() { printf '73000000-0000-4000-8000-0000000e%04d' "$1"; }
use_id() { printf '74000000-0000-4000-8000-0000000e%04d' "$1"; }
obs_id() { echo $((954000000 + $1)); }

seed() {
  local k=$1 granted=${2:-granted} o s u b
  o=$(owner "$k"); s=$(set_id "$k"); u=$(use_id "$k"); b=$(obs_id "$k")
  P <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
VALUES ('$o','authenticated','authenticated','race-$k@example.invalid','{}',now(),now());
INSERT INTO public.profiles(id,username,is_banned) VALUES ('$o','race_$k',false);
INSERT INTO public.observations(id,user_id,date,visibility,is_draft,resolved_sporely_taxon_id)
OVERRIDING SYSTEM VALUE VALUES ($b,'$o',current_date,'public',false,$T);
INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
VALUES ('$o','71000000-0000-4000-8000-0000000e0001','article','[{"family":"Race"}]','Race',2026,'Race 2026',1);
INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
VALUES ('$o','72000000-0000-4000-8000-0000000e0001','71000000-0000-4000-8000-0000000e0001','t','Amanita concurrens',1);
INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
VALUES ('$o','$s','72000000-0000-4000-8000-0000000e0001','spore_size','range','8-10 um',1);
INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
VALUES ('$o','$u',$b,'$s','compared',1,private.reference_canonical_snapshot('$o','$s'));
SQL
  [ "$granted" = granted ] || return 0
  P <<SQL
DO \$\$ BEGIN
  IF (private.reference_contribution_share_core('grant','$o','$s',$T,1,1,1,1,'en',NULL)->>'status') <> 'created' THEN
    RAISE EXCEPTION 'seed %: grant failed', $k;
  END IF;
END \$\$;
SQL
}

# op <name> <k>: prints the SQL (claims included) for one operation.
op() {
  local name=$1 k=$2 o s u b
  o=$(owner "$k"); s=$(set_id "$k"); u=$(use_id "$k"); b=$(obs_id "$k")
  local as_owner="SELECT set_config('request.jwt.claims','{\"sub\":\"$o\",\"role\":\"authenticated\"}',true);"
  local as_service="SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"
  case "$name" in
    refresh) echo "$as_owner UPDATE public.reference_measurement_sets SET raw_text=raw_text||'.',revision=revision+1,row_version=row_version+1 WHERE user_id='$o' AND id='$s';" ;;
    detach) echo "$as_service UPDATE public.observation_reference_uses SET deleted_at=now() WHERE user_id='$o' AND id='$u';" ;;
    visibility) echo "$as_owner UPDATE public.observations SET visibility='private' WHERE id=$b;" ;;
    draft) echo "$as_owner UPDATE public.observations SET is_draft=true WHERE id=$b;" ;;
    taxon) echo "$as_service UPDATE public.observations SET resolved_sporely_taxon_id=$T2 WHERE id=$b;" ;;
    usesync) echo "$as_owner UPDATE public.observation_reference_uses SET snapshot_json=private.reference_canonical_snapshot('$o','$s'),reference_revision=(SELECT revision FROM public.reference_measurement_sets WHERE user_id='$o' AND id='$s'),row_version=row_version+1 WHERE user_id='$o' AND id='$u';" ;;
    grant) echo "$as_owner SET LOCAL ROLE authenticated; SELECT 'grant-status', public.share_reference_contribution_with_consent('$s',$T,1,1,1,1,'en','race')->>'status'; RESET ROLE;" ;;
    revoke) echo "SELECT 'revoked', private.revoke_reference_share_consent_text(1,'en');" ;;
    deleteacct) echo "DELETE FROM public.profiles WHERE id='$o';" ;;
    lockdeleteacct) echo "SELECT 1 FROM public.profiles WHERE id='$o' FOR UPDATE;" ;;
    *) fail "unknown op $name" ;;
  esac
}

# The owner withdraw runs as authenticated, which cannot read the private
# table, so the contribution id is resolved up front.
op_resolved() {
  local name=$1 k=$2
  if [ "$name" = withdraw ]; then
    local o cid
    o=$(owner "$k")
    cid=$(P -c "select id from private.shared_reference_contributions where owner_id='$o'")
    echo "SELECT set_config('request.jwt.claims','{\"sub\":\"$o\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT public.withdraw_reference_contribution('$cid') IS NOT NULL; RESET ROLE;"
  else
    op "$name" "$k"
  fi
}

# After A's sleep: the account deletion completes its DELETE.
op_after() {
  if [ "$1" = lockdeleteacct ]; then op deleteacct "$2"; fi
}

race() {
  local k=$1 first=$2 second=$3 expect=$4 seeded=${5:-granted} o
  o=$(owner "$k")
  seed "$k" "$seeded"
  local sql_a sql_b
  sql_a="BEGIN; $(op_resolved "$first" "$k") SELECT 'race-$k-A-holding', pg_sleep(2); $(op_after "$first" "$k") COMMIT;"
  sql_b="BEGIN; SELECT 'race-$k-B'; $(op_resolved "$second" "$k") COMMIT;"
  P -c "$sql_a" > "$LOG.$k.a" 2>&1 &
  local pid_a=$!
  for _ in $(seq 1 50); do
    [ "$(P -c "select count(*) from pg_stat_activity where query like '%race-$k-A-holding%' and wait_event='PgSleep' and pid <> pg_backend_pid()")" -ge 1 ] && break
    sleep 0.1
  done
  P -c "$sql_b" > "$LOG.$k.b" 2>&1 &
  local pid_b=$!
  local waited=no
  for _ in $(seq 1 30); do
    if [ "$(P -c "select count(*) from pg_stat_activity where query like '%race-$k-B%' and wait_event_type='Lock' and pid <> pg_backend_pid()")" -ge 1 ]; then
      waited=yes; break
    fi
    sleep 0.1
  done
  local rc_a=0 rc_b=0
  wait "$pid_a" || rc_a=$?
  wait "$pid_b" || rc_b=$?
  if grep -q "40P01\|deadlock" "$LOG.$k.a" "$LOG.$k.b"; then
    cat "$LOG.$k.a" "$LOG.$k.b"; fail "race $k ($first then $second): deadlock"
  fi
  [ "$rc_a" = 0 ] || { cat "$LOG.$k.a"; fail "race $k ($first then $second): session A failed"; }
  [ "$rc_b" = 0 ] || { cat "$LOG.$k.b"; fail "race $k ($first then $second): session B failed"; }
  [ "$waited" = yes ] || fail "race $k ($first then $second): session B did not wait for session A"
  local got
  # An anonymised row (account deletion) has lost its owner; find it by the
  # account_deleted event of this race's taxon/key instead.
  local anon=false
  case "$first$second" in *deleteacct*) anon=true ;; esac
  got=$(P -c "select coalesce(string_agg(status,','),'none') from private.shared_reference_contributions c where c.owner_id='$o' or ($anon and c.owner_id is null and exists (select 1 from private.shared_reference_consent_events e where e.contribution_id=c.id and e.reason='account_deleted'))")
  [ "$got" = "$expect" ] || fail "race $k ($first then $second): contribution is '$got', expected '$expect'"
  [ "$(P -c "select count(*) from private.shared_reference_contributions c where c.status='shared' and not private.reference_set_has_qualifying_use(c.owner_id,c.source_measurement_set_id,c.sporely_taxon_id)")" = 0 ] \
    || fail "race $k ($first then $second): a share survived without a qualifying use"
  [ "$(P -c "select count(*) from private.shared_reference_contributions c where (c.status='shared') <> (c.consented_at is not null)")" = 0 ] \
    || fail "race $k: consent invariant broken"
  echo "ok race $k: $first then $second -> $got"
}

k=0
for loss in detach visibility draft taxon; do
  k=$((k+1)); race $k "$loss" refresh withdrawn
  k=$((k+1)); race $k refresh "$loss" withdrawn
done
k=$((k+1)); race $k refresh usesync shared
k=$((k+1)); race $k usesync refresh shared
k=$((k+1)); race $k withdraw refresh withdrawn
k=$((k+1)); race $k refresh withdraw withdrawn
# Stage 2b grant races.
k=$((k+1)); race $k withdraw grant shared
k=$((k+1)); race $k grant withdraw withdrawn
k=$((k+1)); race $k draft grant none ungranted
k=$((k+1)); race $k grant draft withdrawn ungranted
k=$((k+1)); race $k lockdeleteacct grant none ungranted
k=$((k+1)); race $k grant deleteacct withdrawn ungranted
grep -q "grant-status|account_unavailable" "$LOG.$((k-1)).b" \
  || { cat "$LOG.$((k-1)).b"; fail "grant after account deletion did not return account_unavailable"; }
grep -q "grant-status|created" "$LOG.$k.a" \
  || { cat "$LOG.$k.a"; fail "grant before account deletion did not create"; }
# Text revocation (operator step) against a grant, both orders; the text is
# restored between the two races.
k=$((k+1)); race $k grant revoke withdrawn ungranted
# (The revocation also withdraws the earlier races' shared rows; the race's
# own row is checked by race.)
grep -q "revoked|[1-9]" "$LOG.$k.b" || { cat "$LOG.$k.b"; fail "revocation withdrew nothing"; }
P -c "update private.reference_share_consent_texts set revoked=false, active=true where version=1 and locale='en'"
k=$((k+1)); race $k revoke grant none ungranted
grep -q "grant-status|consent_text_unavailable" "$LOG.$k.b" \
  || { cat "$LOG.$k.b"; fail "grant after revocation was not refused"; }

# Every withdrawn row ends with exactly one withdrawal after its last grant
# (the revocation races withdraw rows re-shared by earlier races again).
[ "$(P -c "select count(*) from private.shared_reference_contributions c where c.status='withdrawn' and (select count(*) from private.shared_reference_consent_events e where e.contribution_id=c.id and e.event<>'granted' and e.id > coalesce((select max(g.id) from private.shared_reference_consent_events g where g.contribution_id=c.id and g.event='granted'),0)) <> 1")" = 0 ] \
  || fail "a withdrawn contribution does not have exactly one withdrawal after its last grant"
echo "PASS: $k races, both orders, no deadlock, no surviving unqualified share"
