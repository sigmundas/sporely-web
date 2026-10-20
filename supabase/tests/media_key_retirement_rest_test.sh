#!/usr/bin/env bash
# Real /rest/v1/rpc calls against the LOCAL stack for 20261020120000 (Stage 0a
# acceptance: release, media_key_is_retired, claim and sweep are allowed or
# refused exactly as granted, for anon, authenticated and service_role keys),
# plus a desktop-shaped release (python-requests User-Agent, sync identity 3)
# that must pass the brake.
#
# Local defaults only (supabase-demo keys); never point it at production.
#   supabase db reset --local
#   eval "$(supabase status -o env)"   # API_URL, ANON_KEY, SERVICE_ROLE_KEY, JWT_SECRET
#   bash supabase/tests/media_key_retirement_rest_test.sh
# Fixtures are committed: run against a freshly reset local database.
set -euo pipefail

DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
API_URL="${API_URL:-http://127.0.0.1:54321}"
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing non-local API_URL $API_URL" >&2; exit 2 ;; esac
: "${ANON_KEY:?}" "${SERVICE_ROLE_KEY:?}" "${JWT_SECRET:?}"
P() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
A_UID=00000000-0000-4000-8000-0000006d0a01

# An authenticated user JWT signed with the local secret.
USER_JWT=$(A_UID="$A_UID" JWT_SECRET="$JWT_SECRET" node -e '
const c = require("node:crypto")
const b = o => Buffer.from(JSON.stringify(o)).toString("base64url")
const h = b({ alg: "HS256", typ: "JWT" })
const p = b({ sub: process.env.A_UID, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 })
const s = c.createHmac("sha256", process.env.JWT_SECRET).update(h + "." + p).digest("base64url")
process.stdout.write(h + "." + p + "." + s)')

IDS=$(P <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
VALUES ('$A_UID','authenticated','authenticated','mkr-rest@example.invalid','{}',now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(id,username,is_banned) VALUES ('$A_UID','mkr_rest',false) ON CONFLICT DO NOTHING;
WITH o AS (INSERT INTO public.observations(user_id,date,visibility,is_draft) VALUES ('$A_UID',current_date,'public',false) RETURNING id),
     i AS (INSERT INTO public.observation_images(observation_id,user_id,storage_path,image_type)
           SELECT id,'$A_UID','$A_UID/rest/f.webp','microscope' FROM o RETURNING id),
     o2 AS (INSERT INTO public.observations(user_id,date,visibility,is_draft) VALUES ('$A_UID',current_date,'public',false) RETURNING id),
     t AS (INSERT INTO public.observation_images(observation_id,user_id,storage_path,image_type,deleted_at)
           SELECT id,'$A_UID','$A_UID/rest/t.webp','microscope',now()-interval '40 days' FROM o2 RETURNING id)
SELECT (SELECT id FROM i) || ' ' || (SELECT id FROM t);
SQL
)
IMG=${IDS% *}; TOMB=${IDS#* }

# rpc <key> <fn> <json body> [extra curl args...] -> "<http status> <body>"
rpc() {
  local key=$1 fn=$2 body=$3; shift 3
  curl -sS -o ${TMPDIR:-/tmp}/mkr_rest_body.$$ -w '%{http_code}' -X POST "$API_URL/rest/v1/rpc/$fn" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' "$@" -d "$body"
  printf ' '; cat ${TMPDIR:-/tmp}/mkr_rest_body.$$; rm -f ${TMPDIR:-/tmp}/mkr_rest_body.$$
}
expect() { # <label> <status> <body substring> <actual>
  case "$4" in "$2 "*"$3"*) echo "ok $1" ;; *) fail "$1: expected HTTP $2 with '$3', got: $4" ;; esac
}

REL="{\"p_release_id\":\"6d0a0000-0000-4000-8000-000000000001\",\"p_image_id\":$IMG,\"p_expected_storage_path\":\"$A_UID/rest/f.webp\",\"p_expected_original\":null,\"p_metadata_purpose\":\"owner_sync\"}"
expect "anon release refused" 401 "42501" "$(rpc "$ANON_KEY" release_observation_image_bytes "$REL")"
expect "service_role release refused" 403 "42501" "$(rpc "$SERVICE_ROLE_KEY" release_observation_image_bytes "$REL")"
expect "old desktop release braked" 400 "sporely_upgrade_required" \
  "$(rpc "$USER_JWT" release_observation_image_bytes "$REL" -H 'User-Agent: python-requests/2.32.3')"
expect "identity-3 desktop release" 200 '"status": "released"' \
  "$(rpc "$USER_JWT" release_observation_image_bytes "$REL" -H 'User-Agent: python-requests/2.32.3' -H 'x-sporely-sync-identity: 3')"
expect "release replay" 200 '"replayed": true' "$(rpc "$USER_JWT" release_observation_image_bytes "$REL")"

RET="{\"p_user\":\"$A_UID\",\"p_key\":\"$A_UID/rest/thumb_f.webp\"}"
expect "anon is_retired refused" 401 "42501" "$(rpc "$ANON_KEY" media_key_is_retired "$RET")"
expect "authenticated is_retired refused" 403 "42501" "$(rpc "$USER_JWT" media_key_is_retired "$RET")"
expect "service is_retired" 200 "true" "$(rpc "$SERVICE_ROLE_KEY" media_key_is_retired "$RET")"

CLAIM="{\"p_claim_id\":\"6d0a0000-0000-4000-8000-0000000000c1\",\"p_image_id\":$TOMB}"
expect "anon claim refused" 401 "42501" "$(rpc "$ANON_KEY" claim_tombstoned_image_purge "$CLAIM")"
expect "authenticated claim refused" 403 "42501" "$(rpc "$USER_JWT" claim_tombstoned_image_purge "$CLAIM")"
expect "service claim" 200 '"status": "claimed"' "$(rpc "$SERVICE_ROLE_KEY" claim_tombstoned_image_purge "$CLAIM")"

expect "anon sweep refused" 401 "42501" "$(rpc "$ANON_KEY" claim_retired_key_sweep '{"p_limit":10}')"
expect "authenticated sweep refused" 403 "42501" "$(rpc "$USER_JWT" claim_retired_key_sweep '{"p_limit":10}')"
SWEEP=$(rpc "$SERVICE_ROLE_KEY" claim_retired_key_sweep '{"p_limit":10}')
expect "service sweep" 200 '"status":"ok"' "$SWEEP"
expect "authenticated record refused" 403 "42501" "$(rpc "$USER_JWT" record_retired_key_sweep '{"p_retirement_ids":[1]}')"
expect "service record" 200 "" "$(rpc "$SERVICE_ROLE_KEY" record_retired_key_sweep "{\"p_retirement_ids\":[$(P -c "select string_agg(id::text, ',') from private.media_key_retirements")]}")"

# The registry is not exposed through the Data API (schema private).
code=$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/media_key_retirements" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Accept-Profile: private')
[ "$code" != 200 ] || fail "registry readable through the Data API"
echo "ok registry not exposed through the Data API (HTTP $code)"

# A REST attachment of a released key is refused.
code=$(curl -sS -o ${TMPDIR:-/tmp}/mkr_rest_patch.$$ -w '%{http_code}' -X PATCH "$API_URL/rest/v1/observation_images?id=eq.$IMG" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" -H 'Content-Type: application/json' \
  -d "{\"storage_path\":\"$A_UID/rest/small_f.webp\"}")
grep -q sporely_media_key_released ${TMPDIR:-/tmp}/mkr_rest_patch.$$ || { cat ${TMPDIR:-/tmp}/mkr_rest_patch.$$; rm -f ${TMPDIR:-/tmp}/mkr_rest_patch.$$; fail "REST PATCH of a released key not refused (HTTP $code)"; }
rm -f ${TMPDIR:-/tmp}/mkr_rest_patch.$$
echo "ok REST PATCH of a released key refused (HTTP $code)"
echo "PASS: media_key_retirement_rest_test"
