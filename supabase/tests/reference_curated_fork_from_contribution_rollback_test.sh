#!/usr/bin/env bash
# Rollback test (section R) of supabase/rollbacks/20261002150000_rollback.sql.
# Every step runs in ONE transaction that is rolled back, so it is safe on a
# shared local stack. Works whether or not 20261002150000 is applied locally
# (re-applies the current forward migration inside the transaction;
# contribution-sourced fork rows are deleted only inside the transaction).
#   R1. rollback applied: source_kind and the generated columns are gone, the
#       original publication FK is back with its exact definition,
#       sync_reference_curated_fork's body equals 20260830120000 verbatim
#       with the same owner/ACL/SECURITY DEFINER/search_path, and the legacy
#       fork test passes;
#   R2. after the rollback the contribution fork test FAILS;
#   R3. the rollback refuses (55000) while a contribution-sourced fork exists.
# Usage: bash supabase/tests/reference_curated_fork_from_contribution_rollback_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FORWARD="$HERE/migrations/20261002150000_fork_from_shared_reference_contribution.sql"
ROLLBACK="$HERE/rollbacks/20261002150000_rollback.sql"
LEGACY_MIGRATION="$HERE/migrations/20260830120000_add_owner_private_curated_fork_provenance.sql"
NEW_TEST="$HERE/tests/reference_curated_fork_from_contribution_test.sql"
LEGACY_TEST="$HERE/tests/reference_curated_fork_provenance_test.sql"

psqlx() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -q; }
fail() { echo "FAIL: $*" >&2; exit 1; }
strip() { sed '/^BEGIN;$/d;/^ROLLBACK;$/d;/^COMMIT;$/d' "$1"; }

applied="$(docker exec "$DB" psql -U postgres -Atc "SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public' AND table_name='reference_curated_forks' AND column_name='source_kind'")"
# Always the CURRENT forward migration: when some version of it is already
# applied locally, roll it back first (inside the transaction).
forward_state() {
  echo "BEGIN;"
  if [ "$applied" = 1 ]; then
    echo "DELETE FROM public.reference_curated_forks WHERE source_kind = 'shared_contribution';"
    strip "$ROLLBACK"
  fi
  strip "$FORWARD"
}

# The original function body, verbatim from 20260830120000.
LEGACY_BODY="$(awk '/^CREATE FUNCTION public.sync_reference_curated_fork\(/{f=1} f&&/^AS \$\$$/{b=1;next} b&&/^\$\$;$/{exit} b{print}' "$LEGACY_MIGRATION")"
[ -n "$LEGACY_BODY" ] || fail "could not extract the legacy function body"

# R1
{
  forward_state
  echo "DELETE FROM public.reference_curated_forks WHERE source_kind = 'shared_contribution';"
  strip "$ROLLBACK"
  cat <<SQL
DO \$r1\$
DECLARE v_fn oid := 'public.sync_reference_curated_fork(jsonb,bigint)'::regprocedure;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
              AND table_name='reference_curated_forks'
              AND column_name IN ('source_kind','curated_publication_set_id','shared_contribution_id')) THEN
    RAISE EXCEPTION 'R1: forward columns remain';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.reference_curated_forks'::regclass
         AND conname='reference_curated_forks_curated_measurement_set_id_bundle__fkey')
     IS DISTINCT FROM 'FOREIGN KEY (curated_measurement_set_id, bundle_revision, sporely_taxon_id) REFERENCES private.curated_reference_publication_taxa(curated_measurement_set_id, bundle_revision, sporely_taxon_id) ON DELETE RESTRICT' THEN
    RAISE EXCEPTION 'R1: original publication FK not restored';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.reference_curated_forks'::regclass
              AND conname IN ('reference_curated_forks_publication_source_fkey',
                              'reference_curated_forks_contribution_source_fkey')) THEN
    RAISE EXCEPTION 'R1: forward FKs remain';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='reference_curated_forks'
              AND policyname='reference_curated_forks_contribution_reader_select') THEN
    RAISE EXCEPTION 'R1: contribution reader policy remains';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid=v_fn) IS DISTINCT FROM E'\n' || \$legacy\$${LEGACY_BODY}\$legacy\$ || E'\n' THEN
    RAISE EXCEPTION 'R1: function body differs from 20260830120000';
  END IF;
  IF (SELECT pg_get_userbyid(proowner) || ' ' || proacl::text || ' ' || prosecdef || ' ' || proconfig::text
        FROM pg_proc WHERE oid=v_fn)
     IS DISTINCT FROM 'postgres {postgres=X/postgres,authenticated=X/postgres} true {"search_path=\"\""}' THEN
    RAISE EXCEPTION 'R1: owner/ACL/security/search_path differ: %',
      (SELECT pg_get_userbyid(proowner) || ' ' || proacl::text || ' ' || prosecdef || ' ' || proconfig::text
         FROM pg_proc WHERE oid=v_fn);
  END IF;
END
\$r1\$;
SQL
  strip "$LEGACY_TEST"
  echo "ROLLBACK;"
} | psqlx >/dev/null || fail "R1: rollback state or legacy test"
echo "R1 ok: rollback restores the legacy schema and function; legacy fork test passes"

# R2
out="$({
  forward_state
  echo "DELETE FROM public.reference_curated_forks WHERE source_kind = 'shared_contribution';"
  strip "$ROLLBACK"
  strip "$NEW_TEST"
  echo "ROLLBACK;"
} | psqlx 2>&1 || true)"
echo "$out" | grep -q "FAILED: A: served contribution fork (with contributor) is created (got invalid_source)" \
  && echo "$out" | grep -q "ERROR:  reference_curated_fork_from_contribution_test: [0-9]* check(s) failed" \
  || fail "R2: expected the contribution test to fail with invalid_source: $out"
echo "R2 ok: contribution fork test fails after the rollback"

# R3
out="$({
  forward_state
  echo "SET LOCAL session_replication_role = replica;"
  echo "INSERT INTO public.reference_curated_forks(user_id,curated_measurement_set_id,bundle_revision,sporely_taxon_id,reference_work_id,taxon_treatment_id,reference_measurement_set_id,source_sha256,source_envelope_json,source_kind) VALUES (gen_random_uuid(),gen_random_uuid(),1,1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),repeat('a',64),'{}','shared_contribution');"
  echo "SET LOCAL session_replication_role = origin;"
  strip "$ROLLBACK"
  echo "ROLLBACK;"
} | psqlx 2>&1 || true)"
echo "$out" | grep -q "rollback refused: contribution-sourced curated forks exist" \
  || fail "R3: rollback did not refuse: $out"
echo "R3 ok: rollback refuses while contribution forks exist"
