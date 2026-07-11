-- Persist the AI-selection red-list category on the observation row so
-- it survives cloud round-trips into desktop clients (sporely-py) and
-- can be read back without another identification run.
--
-- red_list_category stores the "top" category code (e.g. "LC", "VU").
-- red_list_categories_json stores the full country → code map, matching
-- the shape emitted by artsdatabanken (e.g. {"NO": "LC"}).

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS red_list_category text;

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS red_list_categories_json jsonb;

-- Guard: the map must be a JSON object (e.g. {"NO": "LC"}), never an
-- array/string/number/boolean. IF NOT EXISTS keeps the migration
-- idempotent on re-runs.
ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_red_list_categories_json_object_chk;

ALTER TABLE public.observations
  ADD CONSTRAINT observations_red_list_categories_json_object_chk
  CHECK (
    red_list_categories_json IS NULL
    OR jsonb_typeof(red_list_categories_json) = 'object'
  );

-- Ensure PostgREST picks up the new columns immediately so the web
-- app can write red_list_category / red_list_categories_json right
-- after deployment without hitting the stale schema cache.
NOTIFY pgrst, 'reload schema';
