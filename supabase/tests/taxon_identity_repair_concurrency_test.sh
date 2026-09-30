#!/usr/bin/env bash
# Two-session regression for the Taxonomy v3 Stage 1B repair (20260930193000):
# a concurrent owner edit must not leave a public shared-reference
# contribution under a taxon no live use carries any more.
#
# Session 1 (owner) changes co-user B from taxon X to Z and edits co-user B2's
# notes without changing its taxon, then holds its transaction open. Session 2
# (operator) runs dry run + apply, promoting candidates A (set S1, with B) and
# A2 (set S2, with B2) from X to Y. Apply must wait for session 1, then:
#   * S1: X withdrawn (neither A nor B carries X any more), Y shared;
#   * S2: X still shared (B2 genuinely still carries X), Y shared.
# Z differs from Y on purpose: if B moved to Y, the share helper's advisory
# lock on (S1, Y) would serialize the sessions by accident. Without the graph
# locks, session 2 reads B as X, records kept_by_other_use, and S1's X
# contribution stays shared although neither A (Y) nor B (Z) carries X.
#
# Fixtures are COMMITTED (two sessions cannot share a transaction), so run it
# only against a freshly reset LOCAL database:
#   supabase db reset --local && bash supabase/tests/taxon_identity_repair_concurrency_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

[ "$(P -c "select count(*) from public.taxonomy_v2_releases where status = 'active'")" = 0 ] \
  || fail "an active release exists; run against a freshly reset local database"
[ "$(P -c "select count(*) from public.observations where id between 953000001 and 953000099")" = 0 ] \
  || fail "fixtures already present; reset the local database first"

OWNER=00000000-0000-4000-8000-00000001c001
S1=83000000-0000-4000-8000-00000001c001
S2=83000000-0000-4000-8000-00000001c002
X=2099000013
Y=620390
Z=2099000014

P <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
VALUES ('$OWNER','authenticated','authenticated','repair-race@example.invalid','{}',now(),now());
INSERT INTO public.profiles(id,username,is_banned) VALUES ('$OWNER','repair_race',false);
INSERT INTO public.taxonomy_v2_releases(
  release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,
  exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,
  whole_export_sha256,manifest_sha256,generated_at,status,row_counts,
  authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,
  dangling_parent_report,source_manifest
) VALUES ('tax-2099.09.02-01',2,1,1,'test','test',repeat('5',64),repeat('6',64),
  repeat('7',64),repeat('8',64),now(),'active','{}','{}','{}',0,'{}','{}');
INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id) VALUES
  ($Y,'tax-2099.09.02-01'),($X,'tax-2099.09.02-01'),($Z,'tax-2099.09.02-01');
INSERT INTO public.taxonomy_v2_taxa(
  release_id,sporely_taxon_id,genus,specific_epithet,canonical_scientific_name,
  taxon_rank,canonical_source_system,canonical_external_id
) VALUES
  ('tax-2099.09.02-01',$Y,'Crepidotus','cesatii','Crepidotus cesatii','species','col_xr','ZDXW'),
  ('tax-2099.09.02-01',$X,'Fixtura','delta','Fixtura delta','species','col_xr','RACE1'),
  ('tax-2099.09.02-01',$Z,'Fixtura','epsilon','Fixtura epsilon','species','col_xr','RACE2');
INSERT INTO public.taxonomy_v2_external_ids(
  release_id,sporely_taxon_id,source_system,namespace,external_id,id_role,is_preferred
) VALUES ('tax-2099.09.02-01',$Y,'nortaxa','nortaxa_taxon_id','53057','accepted',true);
INSERT INTO taxonomy_v3.registry_concept(
  sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
) VALUES
  ($Y,'Crepidotus cesatii','species','include','in_cache','tax-2099.09.02-01'),
  ($X,'Fixtura delta','species','include','in_cache','tax-2099.09.02-01'),
  ($Z,'Fixtura epsilon','species','include','in_cache','tax-2099.09.02-01');
-- A, A2: candidates. B, B2: co-users of S1, S2 under X.
INSERT INTO public.observations(
  id,user_id,date,visibility,is_draft,genus,species,resolved_sporely_taxon_id,
  taxon_identity_state,taxon_identity_source_system,taxon_identity_namespace,
  taxon_identity_external_id,taxon_identity_raw_external_id
) OVERRIDING SYSTEM VALUE VALUES
  (953000001,'$OWNER',current_date,'private',false,'Crepidotus','cesatii',$X,
   'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057'),
  (953000002,'$OWNER',current_date,'private',false,'Fixtura','delta',$X,NULL,NULL,NULL,NULL,NULL),
  (953000003,'$OWNER',current_date,'private',false,'Crepidotus','cesatii',$X,
   'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057'),
  (953000004,'$OWNER',current_date,'private',false,'Fixtura','delta',$X,NULL,NULL,NULL,NULL,NULL);
INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
VALUES ('$OWNER','81000000-0000-4000-8000-00000001c001','article','[{"family":"Test"}]','Race regression',2026,'Test 2026',1);
INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
VALUES ('$OWNER','82000000-0000-4000-8000-00000001c001','81000000-0000-4000-8000-00000001c001','local-a','Fixtura delta',1);
INSERT INTO public.reference_measurement_sets(
  user_id,id,taxon_treatment_id,character,raw_text,data_kind,
  length_core_min,length_core_max,width_core_min,width_core_max,revision
) VALUES
  ('$OWNER','$S1','82000000-0000-4000-8000-00000001c001','spore_size','8-10 x 5-6 um','range',8,10,5,6,1),
  ('$OWNER','$S2','82000000-0000-4000-8000-00000001c001','spore_size','9-11 x 5-6 um','range',9,11,5,6,1);
INSERT INTO public.observation_reference_uses(
  user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json
) VALUES
  ('$OWNER','84000000-0000-4000-8000-00000001c001',953000001,'$S1','compared',1,'{}'),
  ('$OWNER','84000000-0000-4000-8000-00000001c002',953000002,'$S1','compared',1,'{}'),
  ('$OWNER','84000000-0000-4000-8000-00000001c003',953000003,'$S2','compared',1,'{}'),
  ('$OWNER','84000000-0000-4000-8000-00000001c004',953000004,'$S2','compared',1,'{}');
DO \$\$
BEGIN
  IF (private.share_reference_contribution_for_owner('$OWNER','$S1',$X,1,1,1)->>'status') NOT IN ('created','updated','no_change')
     OR (private.share_reference_contribution_for_owner('$OWNER','$S2',$X,1,1,1)->>'status') NOT IN ('created','updated','no_change') THEN
    RAISE EXCEPTION 'seed: could not share the X contributions';
  END IF;
END
\$\$;
SQL

status() { P -c "select coalesce((select status from private.shared_reference_contributions where owner_id='$OWNER' and source_measurement_set_id='$1' and sporely_taxon_id=$2),'none')"; }
[ "$(status $S1 $X)" = shared ] && [ "$(status $S2 $X)" = shared ] || fail "seed contributions not shared"

HASH=$(P -c "select private.taxon_identity_repair_dry_run()->>'plan_sha256'")
[ -n "$HASH" ] || fail "no dry-run hash"

# Session 1: owner edits, held open.
P > /tmp/repair_race_s1.log 2>&1 <<SQL &
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub','$OWNER','role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT public.set_observation_selected_taxon_v2(953000002, $Z);
RESET ROLE;
UPDATE public.observations SET notes = 'edited concurrently' WHERE id = 953000004;
SELECT 'repair-race-s1-holding', pg_sleep(6);
COMMIT;
SQL
S1_PID=$!

for _ in $(seq 1 50); do
  [ "$(P -c "select count(*) from pg_stat_activity where query like '%repair-race-s1-holding%' and pid <> pg_backend_pid()")" -ge 1 ] && break
  sleep 0.2
done

# Session 2: operator apply, must wait on session 1's row locks.
P -c "select private.taxon_identity_repair_apply('$HASH')" > /tmp/repair_race_s2.log 2>&1 &
S2_PID=$!

WAITED=no
for _ in $(seq 1 25); do
  if [ "$(P -c "select count(*) from pg_stat_activity where query like '%taxon_identity_repair_apply%' and wait_event_type = 'Lock' and pid <> pg_backend_pid()")" -ge 1 ]; then
    WAITED=yes; break
  fi
  sleep 0.2
done

wait "$S1_PID" || { cat /tmp/repair_race_s1.log; fail "owner session failed"; }
wait "$S2_PID" || { cat /tmp/repair_race_s2.log; fail "apply failed"; }

[ "$(P -c "select taxon_identity_state from public.observations where id = 953000001")" = sporely_v2 ] || fail "A not promoted"
[ "$(P -c "select taxon_identity_state from public.observations where id = 953000003")" = sporely_v2 ] || fail "A2 not promoted"
[ "$(status $S1 $X)" = withdrawn ] || fail "S1 contribution under X is '$(status $S1 $X)', expected withdrawn (no live use carries X)"
[ "$(status $S1 $Y)" = shared ] || fail "S1 contribution under Y is '$(status $S1 $Y)', expected shared"
[ "$(status $S1 $Z)" = shared ] || fail "S1 contribution under Z is '$(status $S1 $Z)', expected shared (owner path)"
[ "$(status $S2 $X)" = shared ] || fail "S2 contribution under X is '$(status $S2 $X)', expected shared (B2 still carries X)"
[ "$(status $S2 $Y)" = shared ] || fail "S2 contribution under Y is '$(status $S2 $Y)', expected shared"
[ "$WAITED" = yes ] || fail "apply did not wait for the concurrent owner transaction"
echo "PASS: apply waited for the owner transaction; S1/X withdrawn, S2/X kept, Y shared for both, S1/Z shared"
