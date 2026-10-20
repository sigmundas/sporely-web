#!/usr/bin/env bash
# §K cross-language fixture, SQL side (20261020120000_media_key_retirement.sql).
#
# Reads supabase/tests/fixtures/media_key_family_fixture.json and asserts, for
# every case, that private.media_key_root and private.media_key_family return
# exactly the fixture's root and family, that root is a fixed point, that every
# family member has the same root as the key (originals excepted: their family
# is the key itself), and that the root is in the family.
# The Worker (JS) and desktop (Python) implementations read the same file in
# Stage 0b / Stage 1; supabase/tests/js/media-key-fixture.test.js
# already checks today's Worker deriveThumbKey against it.
#
#   supabase db reset --local && bash supabase/tests/media_key_family_fixture_test.sh
set -euo pipefail
DB="${SUPABASE_DB_CONTAINER:-supabase_db_zkpjklzfwzefhjluvhfw}"
FIXTURE="$(cd "$(dirname "$0")" && pwd)/fixtures/media_key_family_fixture.json"
docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qAt -v fixture="$(cat "$FIXTURE")" <<'SQL'
SELECT set_config('fixture.json', :'fixture', false) IS NOT NULL AS loaded \gset
DO $$
DECLARE
  c jsonb;
  v_key text;
  v_root text;
  v_family text[];
  v_expected_family text[];
  n int := 0;
BEGIN
  FOR c IN SELECT jsonb_array_elements(current_setting('fixture.json')::jsonb -> 'cases') LOOP
    v_key := c ->> 'key';
    v_root := private.media_key_root(v_key);
    v_family := private.media_key_family(v_key);
    v_expected_family := ARRAY(SELECT jsonb_array_elements_text(c -> 'family'));
    IF v_root IS DISTINCT FROM (c ->> 'root') THEN
      RAISE EXCEPTION 'root(%) = %, fixture %', v_key, v_root, c ->> 'root';
    END IF;
    IF v_family IS DISTINCT FROM v_expected_family THEN
      RAISE EXCEPTION 'family(%) = %, fixture %', v_key, v_family, v_expected_family;
    END IF;
    IF v_root IS DISTINCT FROM (SELECT CASE
          WHEN private.media_key_normalize(v_key) IS NULL THEN NULL
          WHEN 'originals' = ANY (string_to_array(private.media_key_normalize(v_key), '/')) THEN private.media_key_normalize(v_key)
          WHEN strpos(private.media_key_normalize(v_key), '/') = 0 THEN private.media_key_strip_variant_prefixes(private.media_key_normalize(v_key))
          ELSE regexp_replace(private.media_key_normalize(v_key), '/[^/]*$', '') || '/'
               || private.media_key_strip_variant_prefixes(regexp_replace(private.media_key_normalize(v_key), '^.*/', ''))
        END) THEN
      RAISE EXCEPTION 'root(%) disagrees with normalize + strip_variant_prefixes', v_key;
    END IF;
    IF private.media_key_root(v_root) IS DISTINCT FROM v_root THEN
      RAISE EXCEPTION 'root is not a fixed point for %', v_key;
    END IF;
    IF v_root IS NOT NULL AND NOT (v_root = ANY (v_family)) THEN
      RAISE EXCEPTION 'root % not in family of %', v_root, v_key;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_family) f WHERE private.media_key_root(f) IS DISTINCT FROM v_root) THEN
      RAISE EXCEPTION 'family of % has a member with a different root', v_key;
    END IF;
    n := n + 1;
  END LOOP;
  IF n < 20 THEN RAISE EXCEPTION 'fixture too small (% cases)', n; END IF;
  RAISE NOTICE 'ok: % §K fixture cases', n;
END $$;
SQL
echo "PASS: media_key_family_fixture_test"
