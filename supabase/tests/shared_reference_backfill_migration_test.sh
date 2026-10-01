#!/usr/bin/env bash
# The opt-out backfill of 20261001113007_share_references_by_default.sql,
# exercised through the migration itself: resets the LOCAL database to the
# previous migration (20261001091940), inserts withdrawn contributions in the
# pre-migration schema, applies the real migration file with
# `supabase migration up --local`, and checks the opt-outs it wrote:
#   opted out:  pre-2a owner withdrawal (no events); event-less Stage 1B
#               repair withdrawal (with its repair action); a row whose latest
#               withdrawal event is the owner's;
#   not:        a system withdrawal (withdrawn_by_system); a row whose latest
#               withdrawal is the system's after an earlier owner one; an
#               anonymised row.
# It also checks the backfill ran before the deploy refresh: an opted-out set
# with a qualifying use is not re-shared, a system-withdrawn one is.
#
# LOCAL only; it resets the database itself. Reset again afterwards:
#   bash supabase/tests/shared_reference_backfill_migration_test.sh && supabase db reset --local
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cd "$(dirname "$0")/../.."

supabase db reset --local --version 20261001091940 > /dev/null 2>&1 || fail "reset to 20261001091940 failed"
[ "$(P -c "select max(version) from supabase_migrations.schema_migrations")" = 20261001091940 ] || fail "not at 20261001091940"
[ "$(P -c "select to_regclass('private.reference_share_opt_outs') is null")" = t ] || fail "the opt-out table already exists"

O=00000000-0000-4000-8000-0000000bf001
T=2100000996
T2=2100000997
s() { printf '73000000-0000-4000-8000-0000000bf%03d' "$1"; }
P <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
VALUES ('$O','authenticated','authenticated','backfill-mig@example.invalid','{}',now(),now());
INSERT INTO public.profiles(id,username,is_banned) VALUES ('$O','backfill_mig',false);
INSERT INTO taxonomy_v3.registry_concept(sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release)
VALUES ($T,'Amanita migrata','species','include','in_cache','bf'),($T2,'Amanita altera','species','include','in_cache','bf');
INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
OVERRIDING SYSTEM VALUE SELECT 986000000+n,'$O',current_date,'public',false,'public',$T FROM generate_series(1,6) n;
INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
VALUES ('$O','71000000-0000-4000-8000-0000000bf001','article','[{"family":"Mig"}]','Backfill',2026,'Mig 2026',1);
INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
VALUES ('$O','72000000-0000-4000-8000-0000000bf001','71000000-0000-4000-8000-0000000bf001','b','Amanita migrata',1);
INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
SELECT '$O',('73000000-0000-4000-8000-0000000bf'||lpad(n::text,3,'0'))::uuid,'72000000-0000-4000-8000-0000000bf001','spore_size','range','8-10 um',1
  FROM generate_series(1,6) n;
-- Every set has a qualifying use (written without a session: nothing shares).
INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
SELECT '$O',gen_random_uuid(),986000000+n,('73000000-0000-4000-8000-0000000bf'||lpad(n::text,3,'0'))::uuid,'compared',1,
       private.reference_canonical_snapshot('$O',('73000000-0000-4000-8000-0000000bf'||lpad(n::text,3,'0'))::uuid)
  FROM generate_series(1,6) n;

CREATE TEMP TABLE ids(k int, id uuid);
-- 1 pre-2a owner withdrawal: no events.
WITH c AS (INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,withdrawn_at)
  VALUES ('$O','$(s 1)',$T,'withdrawn',now()-interval '40 days') RETURNING id) INSERT INTO ids SELECT 1,id FROM c;
-- 2 system withdrawal.
WITH c AS (INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,withdrawn_at)
  VALUES ('$O','$(s 2)',$T,'withdrawn',now()) RETURNING id) INSERT INTO ids SELECT 2,id FROM c;
INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason) SELECT id,'withdrawn_by_system','consent_missing' FROM ids WHERE k=2;
-- 3 event-less repair withdrawal, with its repair action (old taxon T2).
WITH c AS (INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,withdrawn_at)
  VALUES ('$O','$(s 3)',$T2,'withdrawn',now()-interval '20 days') RETURNING id) INSERT INTO ids SELECT 3,id FROM c;
INSERT INTO public.taxonomy_v2_releases(
  release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,
  exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,
  whole_export_sha256,manifest_sha256,generated_at,status,row_counts,
  authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,
  dangling_parent_report,source_manifest
) VALUES ('tax-2099.12.01-01',2,1,1,'test','test',repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),
   now(),'retired','{}','{}','{}',0,'{}','{}');
WITH r AS (INSERT INTO private.taxon_identity_repair_runs(release_id,plan_sha256,candidate_count,promoted_count,outcome_counts)
  VALUES ('tax-2099.12.01-01',repeat('2',64),1,1,'{}') RETURNING run_id)
INSERT INTO private.taxon_identity_repair_reference_actions(run_id,observation_id,reference_measurement_set_id,
  old_sporely_taxon_id,new_sporely_taxon_id,old_contribution,new_contribution)
SELECT run_id,986000003,'$(s 3)',$T2,$T,'withdrawn','shared' FROM r;
-- 4 latest withdrawal is the owner's (after a system one).
WITH c AS (INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,withdrawn_at)
  VALUES ('$O','$(s 4)',$T,'withdrawn',now()) RETURNING id) INSERT INTO ids SELECT 4,id FROM c;
INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason) SELECT id,'withdrawn_by_system','consent_missing' FROM ids WHERE k=4;
INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason) SELECT id,'withdrawn_by_owner','owner' FROM ids WHERE k=4;
-- 5 latest withdrawal is the system's (after an owner one).
WITH c AS (INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,withdrawn_at)
  VALUES ('$O','$(s 5)',$T,'withdrawn',now()) RETURNING id) INSERT INTO ids SELECT 5,id FROM c;
INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason) SELECT id,'withdrawn_by_owner','owner' FROM ids WHERE k=5;
INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason) SELECT id,'withdrawn_by_system','consent_missing' FROM ids WHERE k=5;
-- 6 never shared. Plus an anonymised (deleted account) row.
INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,withdrawn_at)
VALUES (NULL,NULL,$T,'withdrawn',now());
SQL

supabase migration up --local > /dev/null 2>&1 || fail "migration up failed"
[ "$(P -c "select max(version) from supabase_migrations.schema_migrations")" = 20261001113007 ] || fail "migration not applied"

GOT=$(P -c "select string_agg(right(source_measurement_set_id::text,3),',' order by source_measurement_set_id) from private.reference_share_opt_outs")
[ "$GOT" = "001,003,004" ] || fail "backfill opted out '$GOT', expected '001,003,004'"
[ "$(P -c "select opted_out_at < now()-interval '39 days' from private.reference_share_opt_outs where source_measurement_set_id='$(s 1)'")" = t ] \
  || fail "the opt-out did not keep the withdrawal time"
# Backfill before the deploy refresh: opted-out sets stay withdrawn, the rest
# with a qualifying use are shared.
st() { P -c "select coalesce(string_agg(status,',' order by sporely_taxon_id),'none') from private.shared_reference_contributions where owner_id='$O' and source_measurement_set_id='$(s "$1")'"; }
[ "$(st 1)" = withdrawn ] && [ "$(st 3)" = withdrawn ] && [ "$(st 4)" = withdrawn ] || fail "an opted-out set was re-shared by the deploy refresh: $(st 1) $(st 3) $(st 4)"
[ "$(st 2)" = shared ] && [ "$(st 5)" = shared ] && [ "$(st 6)" = shared ] || fail "deploy refresh did not share: $(st 2) $(st 5) $(st 6)"
echo "PASS: the migration's backfill opted out exactly 001,003,004 before the deploy refresh"
