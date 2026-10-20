#!/usr/bin/env bash
# Two-session races for 20261020120000_media_key_retirement.sql (Stage 0a of
# docs/plans/active/2026-10-20-media-key-retirement-and-cloud-copy-delete.md,
# "media_key_retirement_concurrency_test.sh").
#
# Pattern of shared_reference_consent_concurrency_test.sh: session A runs one
# operation and holds its transaction open (pg_sleep); session B then runs the
# other and must be observed WAITING in pg_stat_activity before A commits.
# Every pair runs in both orders. Cases (plan numbering):
#   1  release vs PATCH of the same image's storage_path
#   2  release vs the visibility cascade on the same observation
#   3  image -> observation touch vs release, with a test-only barrier trigger
#      that pauses the PATCH between the image update and the child touch
#      (the documented pre-existing inversion; a 40P01 is retried)
#   5  purge claim vs owner restore vs a second claim
#   6  two pre-seeded rows sharing a key: both releases refused, no registry row
#   7  lost-response retry: the same UUID replays the stored keys without
#      writes; a different UUID after a promotion gives row_changed
#   8  cross-row attachment for every guarded column (observation_images
#      storage_path / original_storage_path / INSERT, spore_measurements
#      image_key / thumb_key, observations cover, mosaics storage_key,
#      calibrations image_storage_path), against a release AND a purge claim:
#      B must wait on the advisory key lock
#   4/9 a foreign-owned measurement attaching the key (service role; the
#      authenticated RLS path was closed by 20260925160000)
#   10 forged claim through a test-only RPC that sets sporely.purge_claim
#   11 REPEATABLE READ / SERIALIZABLE sessions get sporely_requires_read_committed
# A race fails on any error other than the expected refusal, a 40P01/55P03
# that the bounded retry (3 attempts, 100-400 ms jitter) does not resolve,
# when B did not wait, or when the final reference/registry state is wrong.
#
# The test-only schema test_barriers (seed helper, barrier trigger, forged-claim
# RPC) is installed here, only into this local database, and dropped on exit.
# The migration never creates it; a probe asserts it is absent afterwards.
#
# Fixtures are COMMITTED, so run it only against a freshly reset LOCAL database:
#   supabase db reset --local && bash supabase/tests/media_key_retirement_concurrency_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
LOG="${TMPDIR:-/tmp}/media_key_retirement_race"
A_UID=00000000-0000-4000-8000-0000006c0a01
B_UID=00000000-0000-4000-8000-0000006c0a02

[ "$(P -c "select count(*) from private.media_key_retirements")" = 0 ] \
  || fail "retirements exist; run against a freshly reset local database"
[ "$(P -c "select count(*) from pg_namespace where nspname='test_barriers'")" = 0 ] \
  || fail "test_barriers already exists"

cleanup() {
  P -c "DROP SCHEMA IF EXISTS test_barriers CASCADE" >/dev/null 2>&1 || true
  P -c "SELECT pg_advisory_unlock_all()" >/dev/null 2>&1 || true
}
trap cleanup EXIT

P <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
  ('$A_UID','authenticated','authenticated','mkr-race-a@example.invalid','{}',now(),now()),
  ('$B_UID','authenticated','authenticated','mkr-race-b@example.invalid','{}',now(),now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles(id,username,is_banned) VALUES ('$A_UID','mkr_race_a',false),('$B_UID','mkr_race_b',false)
ON CONFLICT (id) DO NOTHING;

CREATE SCHEMA test_barriers;
GRANT USAGE ON SCHEMA test_barriers TO authenticated, service_role;

-- Seed one race: obs1/img1 (released or claimed), obs2 with img2/meas2/
-- mosaic2 and a calibration (attachment targets on DIFFERENT rows), and a
-- 40-day tombstone imgT on obs3. Keys live under $A_UID/rc<k>/.
CREATE FUNCTION test_barriers.seed(p_k int) RETURNS jsonb LANGUAGE plpgsql AS \$\$
DECLARE
  a uuid := '$A_UID';
  d text := '$A_UID/rc' || p_k;
  o1 bigint; i1 bigint; o2 bigint; i2 bigint; m2 bigint; s2 bigint; c bigint; o3 bigint; t bigint; i1b bigint;
BEGIN
  INSERT INTO public.observations(user_id,date,visibility,is_draft,spore_data_visibility) VALUES (a,current_date,'public',false,'public') RETURNING id INTO o1;
  INSERT INTO public.observation_images(observation_id,user_id,storage_path,image_type,stored_bytes) VALUES (o1,a,d||'/f.webp','microscope',10) RETURNING id INTO i1;
  INSERT INTO public.observations(user_id,date,visibility,is_draft,spore_data_visibility) VALUES (a,current_date,'public',false,'public') RETURNING id INTO o2;
  INSERT INTO public.observation_images(observation_id,user_id,storage_path,image_type) VALUES (o2,a,d||'/other.webp','microscope') RETURNING id INTO i2;
  INSERT INTO public.spore_measurements(image_id,user_id,length_um) VALUES (i2,a,1) RETURNING id INTO m2;
  INSERT INTO public.spore_measurement_mosaics(observation_id,user_id,storage_key,width_px,height_px,tile_size_px,version)
    VALUES (o2,a,d||'/spore_mosaic_v1_00.webp',1,1,1,1) RETURNING id INTO s2;
  INSERT INTO public.calibrations(user_id,objective_key,calibration_date,microns_per_pixel) VALUES (a,'rc'||p_k,current_date,1) RETURNING id INTO c;
  INSERT INTO public.observations(user_id,date,visibility,is_draft,spore_data_visibility) VALUES (a,current_date,'public',false,'public') RETURNING id INTO o3;
  INSERT INTO public.observation_images(observation_id,user_id,storage_path,image_type,deleted_at)
    VALUES (o3,a,d||'/t.webp','microscope',now()-interval '40 days') RETURNING id INTO t;
  RETURN jsonb_build_object('o1',o1,'i1',i1,'o2',o2,'i2',i2,'m2',m2,'s2',s2,'c',c,'o3',o3,'t',t,'d',d);
END \$\$;

-- Barrier: AFTER UPDATE on observation_images, sorting before the child
-- touch trigger. When the session sets test_barriers.pause=on it waits on
-- the harness-held advisory lock 7311777 between the image update and the
-- observation touch.
CREATE FUNCTION test_barriers.pause() RETURNS trigger LANGUAGE plpgsql AS \$\$
BEGIN
  IF current_setting('test_barriers.pause', true) = 'on' THEN
    PERFORM pg_advisory_xact_lock_shared(7311777);
  END IF;
  RETURN NULL;
END \$\$;
CREATE TRIGGER trg_0_test_barrier AFTER UPDATE ON public.observation_images
  FOR EACH ROW EXECUTE FUNCTION test_barriers.pause();

-- Forged claim: sets the diagnostics GUC, then writes the claim column.
CREATE FUNCTION test_barriers.forge_claim(p_image bigint) RETURNS text LANGUAGE plpgsql AS \$\$
BEGIN
  PERFORM set_config('sporely.purge_claim', gen_random_uuid()::text, true);
  UPDATE public.observation_images SET purge_claimed_at = now() WHERE id = p_image;
  RETURN 'forged';
END \$\$;
GRANT EXECUTE ON FUNCTION test_barriers.forge_claim(bigint) TO authenticated, service_role;
SQL

as_owner="SELECT set_config('request.jwt.claims','{\"sub\":\"$A_UID\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated;"
as_service="SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true); SET LOCAL ROLE service_role;"

# Seeded ids per race, cached in files (macOS ships bash 3.2: no assoc arrays).
FXDIR=$(mktemp -d "${TMPDIR:-/tmp}/media_key_race_fx.XXXXXX")
seed() {
  local k=$1
  P -c "select key || '=' || value from jsonb_each_text(test_barriers.seed($k))" | while IFS='=' read -r f v; do
    printf '%s' "$v" > "$FXDIR/$k.$f"
  done
}
fx() { cat "$FXDIR/$1.$2"; }

uuid_for() { printf '6c0a0000-0000-4000-8000-%012d' "$1"; }

# op <name> <k>: SQL for one operation (one transaction body, no BEGIN/COMMIT).
op() {
  local name=$1 k=$2 d; d=$(fx "$2" d)
  case "$name" in
    release) echo "$as_owner SELECT 'rel-status', public.release_observation_image_bytes('$(uuid_for "$k")', $(fx $k i1), '$d/f.webp', NULL, 'owner_sync')->>'status'; RESET ROLE;" ;;
    release2) echo "$as_owner SELECT 'rel2-status', public.release_observation_image_bytes(gen_random_uuid(), $(fx $k i2), '$d/thumb_f.webp', NULL, 'owner_sync')->>'status'; RESET ROLE;" ;;
    claim) echo "$as_service SELECT 'claim-status', public.claim_tombstoned_image_purge('$(uuid_for "$k")', $(fx $k t))->>'status'; RESET ROLE;" ;;
    claim2) echo "$as_service SELECT 'claim2-status', public.claim_tombstoned_image_purge(gen_random_uuid(), $(fx $k t))->>'status'; RESET ROLE;" ;;
    restore) echo "$as_owner UPDATE public.observation_images SET deleted_at = NULL WHERE id = $(fx $k t); RESET ROLE;" ;;
    patch_same) echo "$as_owner UPDATE public.observation_images SET storage_path = '$d/f_n0nce.webp' WHERE id = $(fx $k i1); RESET ROLE;" ;;
    visibility) echo "$as_owner UPDATE public.observations SET visibility = 'private' WHERE id = $(fx $k o1); RESET ROLE;" ;;
    touch_paused) echo "SET LOCAL test_barriers.pause = 'on'; $as_owner UPDATE public.observation_images SET notes = 'touched' WHERE id = $(fx $k i1); RESET ROLE;" ;;
    # Cross-row attachments of a family key ($d/thumb_f.webp or $d/thumb_t.webp).
    att_img_storage) echo "$as_owner UPDATE public.observation_images SET storage_path = '$d/thumb_${3:-f}.webp' WHERE id = $(fx $k i2); RESET ROLE;" ;;
    att_img_original) echo "$as_owner UPDATE public.observation_images SET original_storage_path = '$d/small_${3:-f}.webp' WHERE id = $(fx $k i2); RESET ROLE;" ;;
    att_img_insert) echo "$as_owner INSERT INTO public.observation_images(observation_id,user_id,storage_path,image_type) VALUES ($(fx $k o2),'$A_UID','$d/medium_${3:-f}.webp','microscope'); RESET ROLE;" ;;
    att_meas_image) echo "$as_owner UPDATE public.spore_measurements SET image_key = '$d/thumb_small_${3:-f}.webp' WHERE id = $(fx $k m2); RESET ROLE;" ;;
    att_meas_thumb) echo "$as_owner UPDATE public.spore_measurements SET thumb_key = '$d/thumb_${3:-f}.webp' WHERE id = $(fx $k m2); RESET ROLE;" ;;
    att_cover) echo "$as_owner UPDATE public.observations SET image_key = '$d/${3:-f}.webp', thumb_key = '$d/thumb_${3:-f}.webp' WHERE id = $(fx $k o2); RESET ROLE;" ;;
    att_mosaic) echo "$as_owner UPDATE public.spore_measurement_mosaics SET storage_key = '$d/cards_${3:-f}.webp' WHERE id = $(fx $k s2); RESET ROLE;" ;;
    att_calibration) echo "$as_owner UPDATE public.calibrations SET image_storage_path = '$d/preview_${3:-f}.webp' WHERE id = $(fx $k c); RESET ROLE;" ;;
    att_foreign_meas) echo "$as_service INSERT INTO public.spore_measurements(image_id,user_id,length_um,image_key) VALUES ($(fx $k i1),'$B_UID',2,'$d/thumb_${3:-f}.webp'); RESET ROLE;" ;;
    *) fail "unknown op $name" ;;
  esac
}

# run_session <file> <sql>: run with the bounded retry on 40P01/40001/55P03.
run_session() {
  local out=$1 sql=$2 attempt
  for attempt in 1 2 3; do
    if P -c "$sql" > "$out" 2>&1; then return 0; fi
    if grep -q "40P01\|deadlock detected\|55P03\|lock timeout\|40001\|could not serialize" "$out"; then
      cp "$out" "$out.attempt$attempt"
      sleep "0.$((RANDOM % 4 + 1))"
      continue
    fi
    return 1
  done
  return 1
}

# race <k> <opA> <opB> <wait_kind: advisory|lock> [arg]
race() {
  local k=$1 first=$2 second=$3 wait_kind=$4 arg=${5:-}
  local sql_a sql_b
  sql_a="BEGIN; $(op "$first" "$k" "$arg") SELECT 'race-$k-A-holding', pg_sleep(2); COMMIT;"
  sql_b="BEGIN; SELECT 'race-$k-B'; $(op "$second" "$k" "$arg") COMMIT;"
  rm -f "$LOG.$k".*
  run_session "$LOG.$k.a" "$sql_a" &
  local pid_a=$!
  for _ in $(seq 1 50); do
    [ "$(P -c "select count(*) from pg_stat_activity where query like '%race-$k-A-holding%' and wait_event='PgSleep' and pid <> pg_backend_pid()")" -ge 1 ] && break
    sleep 0.1
  done
  run_session "$LOG.$k.b" "$sql_b" &
  local pid_b=$!
  local waited=no cond
  if [ "$wait_kind" = advisory ]; then cond="wait_event_type='Lock' and wait_event='advisory'"; else cond="wait_event_type='Lock'"; fi
  for _ in $(seq 1 30); do
    if [ "$(P -c "select count(*) from pg_stat_activity where query like '%race-$k-B%' and $cond and pid <> pg_backend_pid()")" -ge 1 ]; then
      waited=yes; break
    fi
    sleep 0.1
  done
  local rc_a=0 rc_b=0
  wait "$pid_a" || rc_a=$?
  wait "$pid_b" || rc_b=$?
  [ "$rc_a" = 0 ] || { cat "$LOG.$k.a"; fail "race $k ($first then $second): session A failed"; }
  [ "$rc_b" = 0 ] || [ "${EXPECT_B_ERROR:-}" != "" ] || { cat "$LOG.$k.b"; fail "race $k ($first then $second): session B failed"; }
  if [ -n "${EXPECT_B_ERROR:-}" ]; then
    grep -q "$EXPECT_B_ERROR" "$LOG.$k.b" || { cat "$LOG.$k.b"; fail "race $k ($first then $second): B did not fail with $EXPECT_B_ERROR"; }
  fi
  [ "$waited" = yes ] || fail "race $k ($first then $second): session B did not wait ($wait_kind)"
}

out_has() { grep -q "$2" "$LOG.$1.$3" || { cat "$LOG.$1.$3"; fail "race $1: session $3 lacks '$2'"; }; }
retirements() { P -c "select count(*) from private.media_key_retirements where image_id = $1"; }
q() { P -c "$1"; }

k=0
# --- Case 1: release vs PATCH of the same image's storage_path.
k=$((k+1)); seed $k; race $k release patch_same lock
out_has $k "rel-status|released" a
[ "$(q "select storage_path from public.observation_images where id=$(fx $k i1)")" = "$(fx $k d)/f_n0nce.webp" ] || fail "case 1a: promotion after release not applied"
[ "$(retirements $(fx $k i1))" = 1 ] || fail "case 1a: registry"
echo "ok case 1: release then PATCH -> released, then promoted to a new key"
k=$((k+1)); seed $k; race $k patch_same release lock
out_has $k "rel-status|row_changed" b
[ "$(retirements $(fx $k i1))" = 0 ] || fail "case 1b: registry"
echo "ok case 1: PATCH then release -> row_changed, no registry row"

# --- Case 2: release vs the visibility cascade (observation -> lock 42 -> images).
k=$((k+1)); seed $k; race $k release visibility lock
out_has $k "rel-status|released" a
[ "$(q "select visibility from public.observations where id=$(fx $k o1)")" = private ] || fail "case 2a"
echo "ok case 2: release then visibility cascade"
k=$((k+1)); seed $k; race $k visibility release lock
out_has $k "rel-status|released" b
echo "ok case 2: visibility cascade then release"

# --- Case 3: image PATCH paused between the image update and the child touch,
# vs release (observation -> image). Barrier held by a third session.
for order in patch_first release_first; do
  k=$((k+1)); seed $k
  P -c "SELECT pg_advisory_lock(7311777); SELECT 'barrier-holder-$k', pg_sleep(4); SELECT pg_advisory_unlock(7311777);" > "$LOG.$k.h" 2>&1 &
  pid_h=$!
  for _ in $(seq 1 50); do
    [ "$(P -c "select count(*) from pg_stat_activity where query like '%barrier-holder-$k%' and wait_event='PgSleep' and pid <> pg_backend_pid()")" -ge 1 ] && break
    sleep 0.1
  done
  if [ $order = patch_first ]; then
    run_session "$LOG.$k.a" "BEGIN; $(op touch_paused $k) COMMIT;" & pid_a=$!
    sleep 0.5
    run_session "$LOG.$k.b" "BEGIN; $(op release $k) COMMIT;" & pid_b=$!
  else
    run_session "$LOG.$k.b" "BEGIN; $(op release $k) SELECT pg_sleep(1); COMMIT;" & pid_b=$!
    sleep 0.3
    run_session "$LOG.$k.a" "BEGIN; $(op touch_paused $k) COMMIT;" & pid_a=$!
  fi
  wait $pid_h || true
  wait $pid_a || { cat "$LOG.$k.a"; fail "case 3 ($order): PATCH failed after retries"; }
  wait $pid_b || { cat "$LOG.$k.b"; fail "case 3 ($order): release failed after retries"; }
  grep -q "rel-status|released" "$LOG.$k.b" || { cat "$LOG.$k.b"; fail "case 3 ($order): release status"; }
  [ "$(q "select notes from public.observation_images where id=$(fx $k i1)")" = touched ] || fail "case 3 ($order): PATCH lost"
  [ "$(retirements $(fx $k i1))" = 1 ] || fail "case 3 ($order): registry"
  retried=$( (ls "$LOG.$k".*.attempt* 2>/dev/null || true) | wc -l | tr -d ' ')
  echo "ok case 3 ($order): both effects applied (retried attempts: $retried)"
done

# --- Case 5: purge claim vs owner restore vs a second claim.
k=$((k+1)); seed $k; EXPECT_B_ERROR=sporely_purge_claimed race $k claim restore lock
out_has $k "claim-status|claimed" a
[ "$(q "select deleted_at is not null and purge_claimed_at is not null from public.observation_images where id=$(fx $k t)")" = t ] || fail "case 5a"
echo "ok case 5: claim then restore -> restore refused (sporely_purge_claimed)"
k=$((k+1)); seed $k; race $k restore claim lock
out_has $k "claim-status|not_eligible" b
[ "$(retirements $(fx $k t))" = 0 ] || fail "case 5b: registry"
echo "ok case 5: restore then claim -> not_eligible, no registry row"
k=$((k+1)); seed $k; race $k claim claim2 lock
out_has $k "claim-status|claimed" a; out_has $k "claim2-status|already_claimed" b
[ "$(retirements $(fx $k t))" = 1 ] || fail "case 5c: registry"
echo "ok case 5: claim then second claim -> already_claimed, one record"

# --- Case 6: two pre-seeded rows sharing a family: both releases refused.
k=$((k+1)); seed $k
P -c "UPDATE public.observation_images SET storage_path='$(fx $k d)/thumb_f.webp' WHERE id=$(fx $k i2)" >/dev/null
race $k release release2 advisory
out_has $k "rel-status|media_key_shared" a; out_has $k "rel2-status|media_key_shared" b
[ "$(retirements $(fx $k i1))$(retirements $(fx $k i2))" = 00 ] || fail "case 6: registry"
echo "ok case 6: shared family -> both media_key_shared, no registry rows"

# --- Case 7: lost-response retry by the same UUID; new UUID after promotion.
k=$((k+1)); seed $k; race $k release release lock
out_has $k "rel-status|released" a; out_has $k "rel-status|released" b
[ "$(retirements $(fx $k i1))" = 1 ] || fail "case 7: one record"
before=$(q "select updated_at from public.observation_images where id=$(fx $k i1)")
replay=$(P -c "BEGIN; $as_owner SELECT public.release_observation_image_bytes('$(uuid_for $k)', $(fx $k i1), '$(fx $k d)/f.webp', NULL, 'owner_sync'); RESET ROLE; COMMIT;" | grep replayed)
echo "$replay" | grep -q '"replayed": true' || fail "case 7: replay flag ($replay)"
[ "$(echo "$replay" | sed 's/^.*"delete_keys": \(\[[^]]*\]\).*$/\1/')" = "$(q "select to_jsonb(delete_keys)::text from private.media_key_retirements where operation_id='$(uuid_for $k)'")" ] \
  || fail "case 7: replay keys differ from the stored keys"
[ "$(q "select updated_at from public.observation_images where id=$(fx $k i1)")" = "$before" ] || fail "case 7: replay wrote"
P -c "BEGIN; $as_owner UPDATE public.observation_images SET storage_path='$(fx $k d)/g_n0nce.webp' WHERE id=$(fx $k i1); RESET ROLE; COMMIT;" >/dev/null
P -c "BEGIN; $as_owner SELECT 'new-status', public.release_observation_image_bytes(gen_random_uuid(), $(fx $k i1), '$(fx $k d)/f.webp', NULL, 'owner_sync')->>'status'; RESET ROLE; COMMIT;" | grep -q "new-status|row_changed" \
  || fail "case 7: new UUID after promotion is not row_changed"
echo "ok case 7: concurrent same-UUID replay, stored keys, no writes; new UUID -> row_changed"

# --- Case 8 / 9: cross-row attachment for every guarded column, both orders,
# against a release (family of f) and against a purge claim (family of t).
for target in release claim; do
  fam=f; [ $target = claim ] && fam=t
  for att in att_img_storage att_img_original att_img_insert att_meas_image att_meas_thumb att_cover att_mosaic att_calibration att_foreign_meas; do
    [ $target = claim ] && [ $att = att_foreign_meas ] && continue
    img_key=i1; [ $target = claim ] && img_key=t
    # retire first: the attach waits on the advisory key lock and is refused.
    k=$((k+1)); seed $k
    EXPECT_B_ERROR=sporely_media_key_released race $k "$target" "$att" advisory "$fam"
    [ "$(retirements $(fx $k $img_key))" = 1 ] || fail "case 8 $target/$att: registry missing"
    # attach first: the retirement waits on the advisory key lock and refuses.
    k=$((k+1)); seed $k
    # (A foreign measurement on the released image also touches its
    # observation, so the release then waits on that row, not the key lock.)
    wk=advisory; [ $att = att_foreign_meas ] && wk=lock
    race $k "$att" "$target" $wk "$fam"
    if [ $target = release ]; then out_has $k "rel-status|media_key_shared" b; else out_has $k "claim-status|media_key_shared" b; fi
    [ "$(retirements $(fx $k $img_key))" = 0 ] || fail "case 8 $target/$att: registry row after refusal"
    echo "ok case 8: $target vs $att, both orders"
  done
done

# --- Case 10: forged claim through a test-only RPC that sets the GUC.
k=$((k+1)); seed $k
for role_sql in "$as_owner" "$as_service"; do
  out=$(P -c "BEGIN; $role_sql SELECT test_barriers.forge_claim($(fx $k t)); COMMIT;" 2>&1 || true)
  echo "$out" | grep -q sporely_purge_claimed || { echo "$out"; fail "case 10: forged claim not refused"; }
done
out=$(P -c "BEGIN; $as_service SELECT * FROM public.finalize_observation_image_purge($(fx $k t), now(), 1); COMMIT;" 2>&1 || true)
echo "$out" | grep -q sporely_purge_not_claimed || { echo "$out"; fail "case 10: finalize without claim not refused"; }
[ "$(q "select purge_claimed_at is null and purged_at is null from public.observation_images where id=$(fx $k t)")" = t ] || fail "case 10: state changed"
echo "ok case 10: forged claim and finalize refused"

# --- Case 11: non-READ-COMMITTED sessions.
k=$((k+1)); seed $k
for lvl in "REPEATABLE READ" "SERIALIZABLE"; do
  for sql in "$(op release $k)" "$(op claim $k)" "$(op att_cover $k g)"; do
    out=$(P -c "BEGIN ISOLATION LEVEL $lvl; $sql COMMIT;" 2>&1 || true)
    echo "$out" | grep -q sporely_requires_read_committed || { echo "$out"; fail "case 11 ($lvl): not refused: $sql"; }
  done
done
echo "ok case 11: REPEATABLE READ / SERIALIZABLE refused"

# Every retirement's roots are indexed, and nothing references a retired root
# except a claimed tombstone of its own purge record.
[ "$(q "select count(*) from private.media_key_retirements r where not exists (select 1 from private.retired_media_key_roots x where x.retirement_id = r.id) and cardinality(r.delete_keys) > 0")" = 0 ] \
  || fail "a retirement without indexed roots"
[ "$(q "select count(*) from private.retired_media_key_roots x join private.media_key_retirements r on r.id = x.retirement_id, private.media_key_references(array[x.key_root]) ref where not (r.reason='purge' and ref.tbl='observation_images' and ref.row_id=r.image_id and ref.is_purge_claimed)")" = 0 ] \
  || fail "a retired root is still referenced"

cleanup
trap - EXIT
[ "$(P -c "select count(*) from pg_namespace where nspname='test_barriers'")" = 0 ] || fail "test_barriers left behind"
echo "PASS: $k races/cases, both orders, final reference and registry state verified"
