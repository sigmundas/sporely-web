#!/usr/bin/env bash
# End-to-end test of supabase/rollbacks/20261001113007_rollback.sql (the
# Stage 2d rollback). Seeds an automatic share, a consented share and an
# opted-out set, applies the rollback file as is (its own transaction), then
# checks the fail-closed behaviour: no automatic row stays shared (reason
# rollback), the consented row is still served on both surfaces, opt-outs
# are kept, no automatic path or Share again shares without consent, the
# observation read needs a consented contribution again, and a second run
# changes nothing.
#
# Fixtures and the rollback are COMMITTED, so run it only against a freshly
# reset LOCAL database, and reset afterwards:
#   supabase db reset --local && bash supabase/tests/shared_reference_rollback_test.sh
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROLLBACK="$HERE/rollbacks/20261001113007_rollback.sql"

[ "$(P -c "select count(*) from private.shared_reference_contributions")" = 0 ] \
  || fail "contributions exist; run against a freshly reset local database"

O=00000000-0000-4000-8000-0000000ab001
T=2100000995
S_AUTO=73000000-0000-4000-8000-0000000ab001
S_CONS=73000000-0000-4000-8000-0000000ab002
S_OPT=73000000-0000-4000-8000-0000000ab003
AS_OWNER="SELECT set_config('request.jwt.claims','{\"sub\":\"$O\",\"role\":\"authenticated\"}',false);"

P <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
VALUES ('$O','authenticated','authenticated','rollback@example.invalid','{}',now(),now());
INSERT INTO public.profiles(id,username,is_banned) VALUES ('$O','rollback_owner',false);
INSERT INTO taxonomy_v3.registry_concept(sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release)
VALUES ($T,'Amanita revertens','species','include','in_cache','rollback-test');
INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
OVERRIDING SYSTEM VALUE VALUES (985000001,'$O',current_date,'public',false,'public',$T),
                               (985000002,'$O',current_date,'public',false,'public',$T),
                               (985000003,'$O',current_date,'public',false,'public',$T);
INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
VALUES ('$O','71000000-0000-4000-8000-0000000ab001','article','[{"family":"Back"}]','Rollback',2026,'Back 2026',1);
INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
VALUES ('$O','72000000-0000-4000-8000-0000000ab001','71000000-0000-4000-8000-0000000ab001','r','Amanita revertens',1);
INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
SELECT '$O',s,'72000000-0000-4000-8000-0000000ab001','spore_size','range','8-10 um',1
  FROM unnest(ARRAY['$S_AUTO','$S_CONS','$S_OPT']::uuid[]) s;
DELETE FROM private.reference_share_consent_texts;
INSERT INTO private.reference_share_consent_texts(version,locale,text,text_sha256,active,scope)
VALUES (1,'en','fixture consent text',encode(sha256(convert_to('fixture consent text','UTF8')),'hex'),true,
        '{"snapshot_schema_versions":[1,2],"data_kinds":["raw_points","free_text","measurement_details"]}');
-- Owner session: the use inserts share automatically.
$AS_OWNER
INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
SELECT '$O',gen_random_uuid(),x.obs,x.s,'compared',1,private.reference_canonical_snapshot('$O',x.s)
  FROM (VALUES (985000001::bigint,'$S_AUTO'::uuid),(985000002,'$S_CONS'),(985000003,'$S_OPT')) x(obs,s);
SELECT private.reference_contribution_share_core('grant','$O','$S_CONS',$T,1,1,1,1,'en','rollback-test');
SELECT private.stop_sharing_reference_set_for_owner('$O','$S_OPT');
SQL

basis() { P -c "select coalesce(string_agg(status||':'||coalesce(share_basis,'-'),','),'none') from private.shared_reference_contributions where owner_id='$O' and source_measurement_set_id='$1'"; }
refs() { P -c "select jsonb_array_length(public.get_public_observation_references($1))"; }
[ "$(basis $S_AUTO)" = shared:automatic ] || fail "seed: automatic share missing ($(basis $S_AUTO))"
[ "$(basis $S_CONS)" = shared:consented ] || fail "seed: consented share missing ($(basis $S_CONS))"
[ "$(basis $S_OPT)" = withdrawn:- ] || fail "seed: opted-out set not withdrawn"
[ "$(refs 985000001)" = 1 ] && [ "$(refs 985000002)" = 1 ] && [ "$(refs 985000003)" = 0 ] || fail "seed: observation reads"

P -f - < "$ROLLBACK" > /dev/null

[ "$(basis $S_AUTO)" = withdrawn:- ] || fail "automatic row not withdrawn ($(basis $S_AUTO))"
[ "$(P -c "select e.event||':'||e.reason from private.shared_reference_consent_events e join private.shared_reference_contributions c on c.id=e.contribution_id where c.source_measurement_set_id='$S_AUTO' order by e.id desc limit 1")" = withdrawn_by_system:rollback ] \
  || fail "automatic row not withdrawn with reason rollback"
[ "$(basis $S_CONS)" = shared:consented ] || fail "consented row was touched"
[ "$(P -c "select count(*) from private.reference_share_opt_outs where owner_id='$O'")" = 1 ] || fail "opt-out not kept"
CID=$(P -c "select id from private.shared_reference_contributions where source_measurement_set_id='$S_CONS'")
[ "$(P -c "select private.reference_contribution_is_served('$CID')")" = t ] || fail "consented row not served on the species page"
[ "$(refs 985000001)" = 0 ] || fail "the observation read still serves the unconsented set"
[ "$(refs 985000002)" = 1 ] || fail "the observation read lost the consented set"
[ "$(refs 985000003)" = 0 ] || fail "the observation read serves the opted-out set"

# No automatic path re-shares: owner source edit, use sync, republish.
P <<SQL > /dev/null
$AS_OWNER
UPDATE public.reference_measurement_sets SET raw_text='8-10.5 um',revision=revision+1,row_version=row_version+1 WHERE user_id='$O' AND id='$S_AUTO';
UPDATE public.observation_reference_uses SET snapshot_json=snapshot_json WHERE observation_id=985000001;
UPDATE public.observations SET is_draft=true WHERE id=985000001;
UPDATE public.observations SET is_draft=false WHERE id=985000001;
SQL
[ "$(basis $S_AUTO)" = withdrawn:- ] || fail "an automatic path re-shared after the rollback ($(basis $S_AUTO))"
[ "$(P -c "select private.share_reference_contribution_for_owner('$O','$S_AUTO',$T,null,null,null)->>'status'")" = consent_required ] \
  || fail "the refresh entry point did not answer consent_required"
# The consented row still refreshes.
P -c "$AS_OWNER UPDATE public.reference_measurement_sets SET raw_text='8-11 um',revision=revision+1,row_version=row_version+1 WHERE user_id='$O' AND id='$S_CONS';" > /dev/null
[ "$(P -c "select current_revision from private.shared_reference_contributions where id='$CID'")" = 2 ] || fail "consented row did not refresh"
# Share again clears the opt-out but shares nothing without consent.
[ "$(P -c "select private.share_reference_set_again_for_owner('$O','$S_OPT')")" = updated ] || fail "share again did not clear the opt-out"
[ "$(basis $S_OPT)" = withdrawn:- ] || fail "share again shared without consent"
[ "$(P -c "select count(*) from private.shared_reference_contributions where status='shared' and share_basis is distinct from 'consented'")" = 0 ] \
  || fail "a non-consented row is shared"

# Idempotent.
BEFORE=$(P -c "select md5(string_agg(to_jsonb(c)::text,'' order by id)) from private.shared_reference_contributions c")
P -f - < "$ROLLBACK" > /dev/null
[ "$(P -c "select md5(string_agg(to_jsonb(c)::text,'' order by id)) from private.shared_reference_contributions c")" = "$BEFORE" ] \
  || fail "a second rollback run changed something"
echo "PASS: rollback withdrew automatic rows (rollback), kept consented rows and opt-outs, fails closed"
