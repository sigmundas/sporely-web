#!/usr/bin/env bash
# Test of supabase/ingestion-location-provenance-probe.sql: the applied and
# absent assertions pass on a correct target and fail on each tampered one.
#
# Expected output: eleven "ok" lines, then PASS.
#
# Each case feeds the real probe to psql after a prefix that opens an outer
# transaction and adds a fixture or a defect. The probe's own BEGIN then only
# warns (the outer transaction stays open), and its ROLLBACK ends the outer
# transaction, so every fixture row, policy, grant, view and DROP below is
# rolled back. Nothing is committed.
#
# Run only against a LOCAL database where 20261012105630 is applied and
# recorded in supabase_migrations.schema_migrations (for example after
# `supabase db reset --local`):
#   SUPABASE_DB_CONTAINER=supabase_db_<project> bash supabase/tests/ingestion_location_provenance_probe_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROBE="$HERE/ingestion-location-provenance-probe.sql"
OWNER=00000000-0000-4000-8000-0000000ca751
FAILURES=0

# One public observation with one image, so neither Part C base-table check is
# vacuous on an empty database.
FIXTURE="
INSERT INTO auth.users (id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES ('$OWNER','authenticated','authenticated','ilp-probe-owner@example.test','{}',now(),now());
INSERT INTO public.profiles (id,display_name,is_banned) VALUES ('$OWNER','ILP Probe Owner',false)
  ON CONFLICT (id) DO UPDATE SET is_banned=false;
INSERT INTO public.observations
  (id,user_id,date,genus,species,visibility,is_draft,spore_data_visibility,location_precision)
  OVERRIDING SYSTEM VALUE
  VALUES (-107501,'$OWNER','2026-10-16','Probetestus','fixture','public',false,'public','exact');
INSERT INTO public.observation_images (id,observation_id,user_id,image_type,storage_path,sort_order)
  OVERRIDING SYSTEM VALUE
  VALUES (-107502,-107501,'$OWNER','field','$OWNER/-107501/test.webp',0);
"

# The migration's objects removed, as on a target where it was never applied.
UNAPPLY="
DROP TRIGGER trg_location_provenance_invalidate ON public.observations;
DROP FUNCTION public._invalidate_changed_location_provenance();
DROP FUNCTION public.set_observation_location(bigint,double precision,double precision,real,real,text,text);
ALTER TABLE public.observations DROP COLUMN location_source, DROP COLUMN location_status;
ALTER TABLE public.observation_images DROP COLUMN ingest_method;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261012105630';
"

run() {  # expect prefix-sql
  { printf 'BEGIN;\n%s\n' "$2"; cat "$PROBE"; } \
    | docker exec -i "$DB" psql -U postgres -X -v ON_ERROR_STOP=1 \
        -v since=2000-01-01T00:00:00Z -v expect="$1" 2>&1
}

check() {  # name pass|fail expect prefix-sql required-output
  local name="$1" want="$2" out rc
  if out=$(run "$3" "$4"); then rc=0; else rc=$?; fi
  if { [ "$want" = pass ] && [ "$rc" -eq 0 ]; } || { [ "$want" = fail ] && [ "$rc" -ne 0 ]; }; then
    if grep -qF -- "$5" <<<"$out"; then
      echo "ok   $name (exit $rc)"
      return
    fi
  fi
  echo "FAIL $name: wanted $want with '$5', got exit $rc" >&2
  printf '%s\n' "$out" | tail -n 25 >&2
  FAILURES=$((FAILURES + 1))
}

check applied-ready pass applied "$FIXTURE" 'ilp_probe: READY (applied)'
check permissive-read-policy fail applied "$FIXTURE
CREATE POLICY ilp_probe_negative ON public.observations FOR SELECT TO authenticated USING (true);" \
  'ilp_probe: access check failed'
check permissive-image-read-policy fail applied "$FIXTURE
CREATE POLICY ilp_probe_negative ON public.observation_images FOR SELECT TO authenticated USING (true);" \
  'ilp_probe: access check failed'
# No image rows at all: the image check would be vacuous, so it must not pass.
check no-image-rows fail applied "$FIXTURE
TRUNCATE public.observation_images CASCADE;" \
  'ilp_probe: access check failed'
check anon-rpc-grant fail applied "$FIXTURE
GRANT EXECUTE ON FUNCTION public.set_observation_location(bigint,double precision,double precision,real,real,text,text) TO anon;" \
  'ilp_probe: readiness failed'
check exposing-view fail applied "$FIXTURE
CREATE VIEW public.ilp_probe_negative AS SELECT id, location_source FROM public.observations;" \
  'ilp_probe: readiness failed'
check disabled-trigger fail applied "$FIXTURE
ALTER TABLE public.observations DISABLE TRIGGER trg_location_provenance_invalidate;" \
  'ilp_probe: readiness failed'
check absent-ready pass absent "$FIXTURE$UNAPPLY" 'ilp_probe: READY (absent, pre-apply)'
check absent-on-applied fail absent "$FIXTURE" 'ilp_probe: target is not in the expected pre-apply state'
check applied-on-absent fail applied "$FIXTURE$UNAPPLY" 'ilp_probe: readiness failed'
check absent-permissive-read-policy fail absent "$FIXTURE$UNAPPLY
CREATE POLICY ilp_probe_negative ON public.observations FOR SELECT TO authenticated USING (true);" \
  'ilp_probe: access check failed'

if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: $FAILURES case(s)" >&2
  exit 1
fi
echo 'PASS: ingestion-location-provenance probe assertions'
