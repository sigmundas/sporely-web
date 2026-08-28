-- Owner-private normalized reference library.
-- Public observation projection is intentionally deferred to the next Stage 3 slice.

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE private.reference_account_deletions (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.reference_account_deletions FROM PUBLIC, anon, authenticated;

CREATE UNIQUE INDEX IF NOT EXISTS observations_user_id_id_key
  ON public.observations (user_id, id);

CREATE TABLE public.reference_works (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('book', 'article', 'chapter', 'website', 'dataset', 'other')),
  citation_key text,
  authors_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(authors_json) = 'array'),
  editors_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(editors_json) = 'array'),
  title text NOT NULL CHECK (btrim(title) <> ''),
  container_title text,
  year integer,
  edition text,
  publisher text,
  place text,
  volume text,
  issue text,
  pages text,
  doi text,
  isbn text,
  url text,
  language text,
  short_label text NOT NULL,
  citation_override text,
  revision integer NOT NULL CHECK (revision >= 1),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE public.reference_taxon_treatments (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  reference_work_id uuid NOT NULL,
  taxon_id text,
  name_as_published text NOT NULL CHECK (btrim(name_as_published) <> ''),
  page_from integer,
  page_to integer,
  locator_text text,
  treatment_notes text,
  revision integer NOT NULL CHECK (revision >= 1),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, reference_work_id)
    REFERENCES public.reference_works(user_id, id) ON DELETE RESTRICT,
  CHECK (page_from IS NULL OR page_from >= 1),
  CHECK (page_to IS NULL OR page_to >= 1),
  CHECK (page_from IS NULL OR page_to IS NULL OR page_to >= page_from)
);

CREATE TABLE public.reference_measurement_sets (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  taxon_treatment_id uuid NOT NULL,
  character text NOT NULL CHECK (character IN ('spore_size')),
  raw_text text,
  data_kind text NOT NULL CHECK (data_kind IN ('range', 'summary', 'raw_points', 'parmasto')),
  length_min double precision,
  length_core_min double precision,
  length_core_max double precision,
  length_max double precision,
  width_min double precision,
  width_core_min double precision,
  width_core_max double precision,
  width_max double precision,
  q_min double precision,
  q_max double precision,
  q_mean double precision,
  length_mean double precision,
  width_mean double precision,
  sample_size integer CHECK (sample_size IS NULL OR sample_size >= 0),
  specimen_count integer CHECK (specimen_count IS NULL OR specimen_count >= 0),
  mount_medium text,
  stain text,
  preparation text,
  measurement_method text,
  notes text,
  raw_points_json jsonb CHECK (raw_points_json IS NULL OR jsonb_typeof(raw_points_json) = 'array'),
  supersedes_id uuid,
  revision integer NOT NULL CHECK (revision >= 1),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, taxon_treatment_id)
    REFERENCES public.reference_taxon_treatments(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, supersedes_id)
    REFERENCES public.reference_measurement_sets(user_id, id) ON DELETE RESTRICT,
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE TABLE public.observation_reference_uses (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  observation_id bigint NOT NULL,
  reference_measurement_set_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('compared', 'supports_identification', 'contradicts')),
  note text,
  selected_at timestamptz NOT NULL DEFAULT now(),
  reference_revision integer NOT NULL CHECK (reference_revision >= 1),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, observation_id, reference_measurement_set_id),
  FOREIGN KEY (user_id, observation_id)
    REFERENCES public.observations(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, reference_measurement_set_id)
    REFERENCES public.reference_measurement_sets(user_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX reference_works_user_citation_key_live_key
  ON public.reference_works (user_id, lower(btrim(citation_key)))
  WHERE deleted_at IS NULL AND nullif(btrim(citation_key), '') IS NOT NULL;
CREATE INDEX reference_works_user_doi_idx
  ON public.reference_works (user_id, lower(btrim(doi)))
  WHERE nullif(btrim(doi), '') IS NOT NULL;
CREATE INDEX reference_works_user_isbn_idx
  ON public.reference_works (user_id, regexp_replace(upper(isbn), '[^0-9X]', '', 'g'))
  WHERE nullif(btrim(isbn), '') IS NOT NULL;
CREATE INDEX reference_works_user_cursor_idx
  ON public.reference_works (user_id, updated_at, id);
CREATE INDEX reference_taxon_treatments_user_cursor_idx
  ON public.reference_taxon_treatments (user_id, updated_at, id);
CREATE INDEX reference_taxon_treatments_parent_idx
  ON public.reference_taxon_treatments (user_id, reference_work_id);
CREATE INDEX reference_measurement_sets_user_cursor_idx
  ON public.reference_measurement_sets (user_id, updated_at, id);
CREATE INDEX reference_measurement_sets_parent_idx
  ON public.reference_measurement_sets (user_id, taxon_treatment_id);
CREATE UNIQUE INDEX reference_measurement_sets_one_live_successor_key
  ON public.reference_measurement_sets (user_id, supersedes_id)
  WHERE deleted_at IS NULL AND supersedes_id IS NOT NULL;
CREATE INDEX observation_reference_uses_user_cursor_idx
  ON public.observation_reference_uses (user_id, updated_at, id);
CREATE INDEX observation_reference_uses_observation_idx
  ON public.observation_reference_uses (user_id, observation_id)
  WHERE deleted_at IS NULL;
CREATE INDEX observation_reference_uses_set_idx
  ON public.observation_reference_uses (user_id, reference_measurement_set_id)
  WHERE deleted_at IS NULL;

ALTER TABLE public.reference_works ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reference_taxon_treatments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reference_measurement_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observation_reference_uses ENABLE ROW LEVEL SECURITY;

CREATE POLICY reference_works_owner_select ON public.reference_works
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_works_owner_insert ON public.reference_works
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_works_owner_update ON public.reference_works
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_works_owner_delete ON public.reference_works
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE POLICY reference_taxon_treatments_owner_select ON public.reference_taxon_treatments
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_taxon_treatments_owner_insert ON public.reference_taxon_treatments
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_taxon_treatments_owner_update ON public.reference_taxon_treatments
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_taxon_treatments_owner_delete ON public.reference_taxon_treatments
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE POLICY reference_measurement_sets_owner_select ON public.reference_measurement_sets
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_measurement_sets_owner_insert ON public.reference_measurement_sets
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_measurement_sets_owner_update ON public.reference_measurement_sets
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY reference_measurement_sets_owner_delete ON public.reference_measurement_sets
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE POLICY observation_reference_uses_owner_select ON public.observation_reference_uses
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY observation_reference_uses_owner_insert ON public.observation_reference_uses
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY observation_reference_uses_owner_update ON public.observation_reference_uses
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY observation_reference_uses_owner_delete ON public.observation_reference_uses
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.reference_works FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.reference_taxon_treatments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.reference_measurement_sets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.observation_reference_uses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reference_works TO authenticated;
GRANT SELECT ON public.reference_taxon_treatments TO authenticated;
GRANT SELECT ON public.reference_measurement_sets TO authenticated;
GRANT SELECT ON public.observation_reference_uses TO authenticated;
GRANT ALL ON public.reference_works TO service_role;
GRANT ALL ON public.reference_taxon_treatments TO service_role;
GRANT ALL ON public.reference_measurement_sets TO service_role;
GRANT ALL ON public.observation_reference_uses TO service_role;

CREATE FUNCTION private.reference_result(p_status text, p_row jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object('status', p_status, 'row', p_row)
$$;

CREATE FUNCTION private.reference_payload_has_unknown_keys(p_payload jsonb, p_allowed text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_object_keys(p_payload) AS key
    WHERE NOT (key = ANY (p_allowed))
  )
$$;

CREATE FUNCTION private.reference_snapshot_valid(
  p_snapshot jsonb,
  p_work_id uuid,
  p_treatment_id uuid,
  p_set_id uuid,
  p_reference_revision integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_snapshot IS NOT NULL
    AND pg_catalog.jsonb_typeof(p_snapshot) = 'object'
    AND pg_catalog.octet_length(p_snapshot::text) <= 65536
    AND p_snapshot->>'schema_version' = '1'
    AND p_snapshot->>'reference_work_id' = p_work_id::text
    AND p_snapshot->>'reference_treatment_id' = p_treatment_id::text
    AND p_snapshot->>'reference_measurement_set_id' = p_set_id::text
    AND p_snapshot->>'reference_revision' = p_reference_revision::text
    AND NOT private.reference_payload_has_unknown_keys(p_snapshot, ARRAY[
      'schema_version','reference_work_id','reference_treatment_id','reference_measurement_set_id',
      'reference_revision','short_label','full_citation','work_type','year','doi','isbn','taxon_id',
      'name_as_published','locator_text','page_from','page_to','character','data_kind','raw_text',
      'measurements','method','raw_points'
    ])
    AND p_snapshot ?& ARRAY[
      'schema_version','reference_work_id','reference_treatment_id','reference_measurement_set_id',
      'reference_revision','short_label','full_citation','work_type','year','doi','isbn','taxon_id',
      'name_as_published','locator_text','page_from','page_to','character','data_kind','raw_text',
      'measurements','method','raw_points'
    ]
    AND pg_catalog.jsonb_typeof(p_snapshot->'measurements') = 'object'
    AND pg_catalog.jsonb_typeof(p_snapshot->'method') = 'object'
    AND NOT private.reference_payload_has_unknown_keys(p_snapshot->'measurements', ARRAY[
      'length_min','length_core_min','length_core_max','length_max','width_min','width_core_min',
      'width_core_max','width_max','q_min','q_max','q_mean','length_mean','width_mean','sample_size','specimen_count'
    ])
    AND (p_snapshot->'measurements') ?& ARRAY[
      'length_min','length_core_min','length_core_max','length_max','width_min','width_core_min',
      'width_core_max','width_max','q_min','q_max','q_mean','length_mean','width_mean','sample_size','specimen_count'
    ]
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot->'measurements') x WHERE pg_catalog.jsonb_typeof(x.value) NOT IN ('number','null'))
    AND NOT private.reference_payload_has_unknown_keys(p_snapshot->'method', ARRAY['mount_medium','stain','preparation','measurement_method'])
    AND (p_snapshot->'method') ?& ARRAY['mount_medium','stain','preparation','measurement_method']
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot->'method') x WHERE pg_catalog.jsonb_typeof(x.value) NOT IN ('string','null'))
    AND pg_catalog.jsonb_typeof(p_snapshot->'raw_points') IN ('array','null')
    AND pg_catalog.jsonb_typeof(p_snapshot->'schema_version') = 'number'
    AND pg_catalog.jsonb_typeof(p_snapshot->'reference_revision') = 'number'
    AND pg_catalog.jsonb_typeof(p_snapshot->'short_label') = 'string'
    AND pg_catalog.jsonb_typeof(p_snapshot->'full_citation') = 'string'
    AND btrim(p_snapshot->>'short_label') <> ''
    AND btrim(p_snapshot->>'full_citation') <> ''
    AND p_snapshot->>'work_type' IN ('book','article','chapter','website','dataset','other')
    AND nullif(btrim(p_snapshot->>'name_as_published'),'') IS NOT NULL
    AND p_snapshot->>'character' = 'spore_size'
    AND p_snapshot->>'data_kind' IN ('range','summary','raw_points','parmasto')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot) x
      WHERE x.key=ANY(ARRAY['reference_work_id','reference_treatment_id','reference_measurement_set_id','work_type','doi','isbn','taxon_id','name_as_published','locator_text','character','data_kind','raw_text'])
        AND pg_catalog.jsonb_typeof(x.value) NOT IN ('string','null')
    )
    AND CASE WHEN pg_catalog.jsonb_typeof(p_snapshot->'raw_points')='null' THEN true
      ELSE pg_catalog.jsonb_array_length(p_snapshot->'raw_points')>0 END
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot) x
      WHERE x.key=ANY(ARRAY['year','page_from','page_to'])
        AND (pg_catalog.jsonb_typeof(x.value) NOT IN ('number','null') OR
          (pg_catalog.jsonb_typeof(x.value)='number' AND (x.value#>>'{}')::numeric<>pg_catalog.trunc((x.value#>>'{}')::numeric)))
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot->'measurements') x
      WHERE x.key=ANY(ARRAY['sample_size','specimen_count']) AND pg_catalog.jsonb_typeof(x.value)='number'
        AND (x.value#>>'{}')::numeric<>pg_catalog.trunc((x.value#>>'{}')::numeric)
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(p_snapshot->'raw_points')='array' THEN p_snapshot->'raw_points' ELSE '[]'::jsonb END) point
      WHERE pg_catalog.jsonb_typeof(point) NOT IN ('number','boolean','object')
         OR (pg_catalog.jsonb_typeof(point)='object' AND (
           NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(point) v
             WHERE v.key=ANY(ARRAY['length','width','l','w']) AND pg_catalog.jsonb_typeof(v.value) IN ('number','boolean'))))
    )
$$;

CREATE FUNCTION private.reference_agent_list(p_agents jsonb, p_full boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_labels text[]; v_count integer;
BEGIN
  SELECT pg_catalog.array_agg(label ORDER BY ord) INTO v_labels
  FROM (
    SELECT ord, nullif(btrim(CASE WHEN pg_catalog.jsonb_typeof(a)='string' THEN a#>>'{}' WHEN p_full THEN
      CASE WHEN nullif(btrim(a->>'literal'),'') IS NOT NULL THEN btrim(a->>'literal')
        WHEN nullif(btrim(a->>'family'),'') IS NOT NULL AND nullif(btrim(a->>'given'),'') IS NOT NULL
          THEN btrim(a->>'family')||' '||pg_catalog.regexp_replace(btrim(a->>'given'),'(^|\\s)([^\\s])[^\\s]*','\\1\\2.','g')
        WHEN nullif(btrim(a->>'family'),'') IS NOT NULL THEN btrim(a->>'family') ELSE btrim(a->>'given') END
      ELSE coalesce(nullif(btrim(a->>'family'),''),nullif(btrim(a->>'literal'),''),btrim(a->>'given')) END),'') label
    FROM pg_catalog.jsonb_array_elements(coalesce(p_agents,'[]'::jsonb)) WITH ORDINALITY x(a,ord)
  ) labels WHERE label IS NOT NULL;
  v_count:=coalesce(pg_catalog.array_length(v_labels,1),0);
  IF v_count=0 THEN RETURN ''; ELSIF v_count=1 THEN RETURN v_labels[1];
  ELSIF NOT p_full AND v_count>2 THEN RETURN v_labels[1]||' et al.';
  ELSIF v_count=2 THEN RETURN v_labels[1]||' & '||v_labels[2];
  ELSE RETURN pg_catalog.array_to_string(v_labels[1:v_count-1],', ')||' & '||v_labels[v_count]; END IF;
END $$;

CREATE FUNCTION private.reference_full_citation(p_work public.reference_works)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_author text; v_parts text[] := ARRAY[]::text[]; v_container text[] := ARRAY[]::text[];
BEGIN
  v_author:=private.reference_agent_list(p_work.authors_json,true);
  IF v_author='' THEN
    v_author:=private.reference_agent_list(p_work.editors_json,true);
    IF v_author<>'' THEN v_author:=v_author||' (ed.)'; END IF;
  END IF;
  IF nullif(btrim(v_author),'') IS NOT NULL THEN v_parts := v_parts || v_author; END IF;
  IF p_work.year IS NOT NULL THEN v_parts := v_parts || ('('||p_work.year::text||')'); END IF;
  v_parts := v_parts || (btrim(p_work.title)||'.');
  IF nullif(btrim(p_work.container_title),'') IS NOT NULL THEN v_container := v_container || btrim(p_work.container_title); END IF;
  IF nullif(btrim(p_work.volume),'') IS NOT NULL THEN v_container := v_container || (btrim(p_work.volume)||CASE WHEN nullif(btrim(p_work.issue),'') IS NOT NULL THEN '('||btrim(p_work.issue)||')' ELSE '' END); END IF;
  IF nullif(btrim(p_work.pages),'') IS NOT NULL THEN v_container := v_container || btrim(p_work.pages); END IF;
  IF pg_catalog.array_length(v_container,1) IS NOT NULL THEN v_parts := v_parts || (pg_catalog.array_to_string(v_container,', ')||'.'); END IF;
  IF nullif(btrim(p_work.edition),'') IS NOT NULL THEN v_parts := v_parts || (btrim(p_work.edition)||'.'); END IF;
  IF nullif(btrim(p_work.publisher),'') IS NOT NULL OR nullif(btrim(p_work.place),'') IS NOT NULL THEN v_parts := v_parts || (concat_ws(', ',nullif(btrim(p_work.publisher),''),nullif(btrim(p_work.place),''))||'.'); END IF;
  IF nullif(btrim(p_work.doi),'') IS NOT NULL THEN v_parts := v_parts || ('https://doi.org/'||btrim(p_work.doi));
  ELSIF nullif(btrim(p_work.url),'') IS NOT NULL THEN v_parts := v_parts || btrim(p_work.url); END IF;
  RETURN coalesce(nullif(btrim(p_work.citation_override),''),pg_catalog.array_to_string(v_parts,' '));
END $$;

CREATE FUNCTION private.reference_canonical_snapshot(p_user_id uuid, p_set_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object(
    'schema_version',1,'reference_work_id',w.id,'reference_measurement_set_id',m.id,
    'reference_treatment_id',t.id,'reference_revision',m.revision,'short_label',
      coalesce(nullif(btrim(w.short_label),''),nullif(concat_ws(' ',nullif(private.reference_agent_list(w.authors_json,false),''),w.year::text),''),btrim(w.title)),
    'full_citation',private.reference_full_citation(w),'work_type',w.type,'year',w.year,'doi',w.doi,
    'isbn',w.isbn,'taxon_id',t.taxon_id,'name_as_published',t.name_as_published,
    'locator_text',t.locator_text,'page_from',t.page_from,'page_to',t.page_to,'character',m.character,
    'data_kind',m.data_kind,'raw_text',m.raw_text,
    'measurements',pg_catalog.jsonb_build_object(
      'length_min',m.length_min,'length_core_min',m.length_core_min,'length_core_max',m.length_core_max,
      'length_max',m.length_max,'width_min',m.width_min,'width_core_min',m.width_core_min,
      'width_core_max',m.width_core_max,'width_max',m.width_max,'q_min',m.q_min,'q_max',m.q_max,
      'q_mean',m.q_mean,'length_mean',m.length_mean,'width_mean',m.width_mean,
      'sample_size',m.sample_size,'specimen_count',m.specimen_count),
    'method',pg_catalog.jsonb_build_object('mount_medium',m.mount_medium,'stain',m.stain,
      'preparation',m.preparation,'measurement_method',m.measurement_method),
    'raw_points',m.raw_points_json)
  FROM public.reference_measurement_sets m
  JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
  JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id
  WHERE m.user_id=p_user_id AND m.id=p_set_id AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION private.reference_result(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_payload_has_unknown_keys(jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_snapshot_valid(jsonb, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_full_citation(public.reference_works) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_agent_list(jsonb,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_canonical_snapshot(uuid,uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.sync_reference_work(p_payload jsonb, p_expected_row_version bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_id uuid;
  v_current public.reference_works%ROWTYPE;
  v_next public.reference_works%ROWTYPE;
  v_deleted boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN RETURN private.reference_result('invalid_payload'); END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RETURN private.reference_result('invalid_payload');
  END IF;
  IF private.reference_payload_has_unknown_keys(p_payload, ARRAY[
    'id','type','citation_key','authors_json','editors_json','title','container_title','year',
    'edition','publisher','place','volume','issue','pages','doi','isbn','url','language',
    'short_label','citation_override','revision','deleted'
  ]) THEN RETURN private.reference_result('invalid_payload'); END IF;
  BEGIN v_id := (p_payload->>'id')::uuid; EXCEPTION WHEN OTHERS THEN RETURN private.reference_result('invalid_payload'); END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id=v_owner) THEN RETURN private.reference_result('account_deleting'); END IF;
  SELECT * INTO v_current FROM public.reference_works WHERE user_id = v_owner AND id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_row_version <> 0 THEN RETURN private.reference_result('conflict'); END IF;
    BEGIN
      INSERT INTO public.reference_works (
        user_id,id,type,citation_key,authors_json,editors_json,title,container_title,year,edition,
        publisher,place,volume,issue,pages,doi,isbn,url,language,short_label,citation_override,
        revision,deleted_at
      ) VALUES (
        v_owner,v_id,p_payload->>'type',p_payload->>'citation_key',
        coalesce(p_payload->'authors_json','[]'::jsonb),coalesce(p_payload->'editors_json','[]'::jsonb),
        p_payload->>'title',p_payload->>'container_title',(p_payload->>'year')::integer,
        p_payload->>'edition',p_payload->>'publisher',p_payload->>'place',p_payload->>'volume',
        p_payload->>'issue',p_payload->>'pages',p_payload->>'doi',p_payload->>'isbn',
        p_payload->>'url',p_payload->>'language',coalesce(p_payload->>'short_label',''),
        p_payload->>'citation_override',coalesce((p_payload->>'revision')::integer,1),
        CASE WHEN coalesce((p_payload->>'deleted')::boolean,false) THEN pg_catalog.clock_timestamp() END
      ) RETURNING * INTO v_current;
      RETURN private.reference_result('created', pg_catalog.to_jsonb(v_current));
    EXCEPTION WHEN unique_violation OR check_violation OR not_null_violation OR invalid_text_representation THEN
      RETURN private.reference_result('conflict');
    END;
  END IF;
  v_next := pg_catalog.jsonb_populate_record(v_current, p_payload - ARRAY['deleted']);
  v_next.user_id := v_owner; v_next.id := v_id; v_next.created_at := v_current.created_at;
  v_next.row_version := v_current.row_version; v_next.updated_at := v_current.updated_at;
  v_deleted := coalesce((p_payload->>'deleted')::boolean, v_current.deleted_at IS NOT NULL);
  v_next.deleted_at := CASE WHEN v_deleted THEN coalesce(v_current.deleted_at, pg_catalog.clock_timestamp()) ELSE NULL END;
  IF pg_catalog.to_jsonb(v_next) = pg_catalog.to_jsonb(v_current) THEN
    RETURN private.reference_result('no_change', pg_catalog.to_jsonb(v_current));
  END IF;
  IF p_expected_row_version <> v_current.row_version THEN RETURN private.reference_result('conflict', pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.revision < v_current.revision THEN RETURN private.reference_result('invalid_revision', pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.revision = v_current.revision
     AND (pg_catalog.to_jsonb(v_next) - ARRAY['revision','row_version','created_at','updated_at','deleted_at'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(v_current) - ARRAY['revision','row_version','created_at','updated_at','deleted_at'])
  THEN RETURN private.reference_result('invalid_revision', pg_catalog.to_jsonb(v_current)); END IF;
  IF pg_catalog.to_jsonb(v_next) = pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change', pg_catalog.to_jsonb(v_current)); END IF;
  IF v_current.deleted_at IS NULL AND v_next.deleted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.reference_taxon_treatments t
    WHERE t.user_id=v_owner AND t.reference_work_id=v_id AND t.deleted_at IS NULL
  ) THEN RETURN private.reference_result('blocked', pg_catalog.to_jsonb(v_current)); END IF;
  BEGIN
    UPDATE public.reference_works SET
      type=v_next.type,citation_key=v_next.citation_key,authors_json=v_next.authors_json,
      editors_json=v_next.editors_json,title=v_next.title,container_title=v_next.container_title,
      year=v_next.year,edition=v_next.edition,publisher=v_next.publisher,place=v_next.place,
      volume=v_next.volume,issue=v_next.issue,pages=v_next.pages,doi=v_next.doi,isbn=v_next.isbn,
      url=v_next.url,language=v_next.language,short_label=v_next.short_label,
      citation_override=v_next.citation_override,revision=v_next.revision,
      row_version=row_version+1,updated_at=pg_catalog.clock_timestamp(),deleted_at=v_next.deleted_at
    WHERE user_id=v_owner AND id=v_id AND row_version=p_expected_row_version
    RETURNING * INTO v_current;
  EXCEPTION WHEN unique_violation THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END;
  IF NOT FOUND THEN RETURN private.reference_result('conflict'); END IF;
  RETURN private.reference_result('updated', pg_catalog.to_jsonb(v_current));
END
$$;

CREATE FUNCTION public.sync_reference_taxon_treatment(p_payload jsonb, p_expected_row_version bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid(); v_id uuid; v_parent uuid;
  v_current public.reference_taxon_treatments%ROWTYPE; v_next public.reference_taxon_treatments%ROWTYPE;
  v_deleted boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN RETURN private.reference_result('invalid_payload'); END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' OR
     private.reference_payload_has_unknown_keys(p_payload, ARRAY['id','reference_work_id','taxon_id','name_as_published','page_from','page_to','locator_text','treatment_notes','revision','deleted'])
  THEN RETURN private.reference_result('invalid_payload'); END IF;
  BEGIN v_id := (p_payload->>'id')::uuid; v_parent := (p_payload->>'reference_work_id')::uuid;
  EXCEPTION WHEN OTHERS THEN RETURN private.reference_result('invalid_payload'); END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id=v_owner) THEN RETURN private.reference_result('account_deleting'); END IF;
  SELECT * INTO v_current FROM public.reference_taxon_treatments WHERE user_id=v_owner AND id=v_id FOR UPDATE;
  IF FOUND AND v_current.deleted_at IS NOT NULL AND coalesce((p_payload->>'deleted')::boolean,false) THEN
    RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reference_works WHERE user_id=v_owner AND id=v_parent AND deleted_at IS NULL) THEN
    RETURN private.reference_result('invalid_parent');
  END IF;
  SELECT * INTO v_current FROM public.reference_taxon_treatments WHERE user_id=v_owner AND id=v_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_row_version<>0 THEN RETURN private.reference_result('conflict'); END IF;
    BEGIN
      INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,page_from,page_to,locator_text,treatment_notes,revision,deleted_at)
      VALUES(v_owner,v_id,v_parent,p_payload->>'taxon_id',p_payload->>'name_as_published',(p_payload->>'page_from')::integer,(p_payload->>'page_to')::integer,p_payload->>'locator_text',p_payload->>'treatment_notes',coalesce((p_payload->>'revision')::integer,1),CASE WHEN coalesce((p_payload->>'deleted')::boolean,false) THEN pg_catalog.clock_timestamp() END)
      RETURNING * INTO v_current;
      RETURN private.reference_result('created',pg_catalog.to_jsonb(v_current));
    EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation OR not_null_violation OR invalid_text_representation THEN
      RETURN private.reference_result('conflict');
    END;
  END IF;
  v_next := pg_catalog.jsonb_populate_record(v_current,p_payload-ARRAY['deleted']);
  v_next.user_id:=v_owner; v_next.id:=v_id; v_next.created_at:=v_current.created_at;
  v_next.row_version:=v_current.row_version; v_next.updated_at:=v_current.updated_at;
  v_deleted:=coalesce((p_payload->>'deleted')::boolean,v_current.deleted_at IS NOT NULL);
  v_next.deleted_at:=CASE WHEN v_deleted THEN coalesce(v_current.deleted_at,pg_catalog.clock_timestamp()) ELSE NULL END;
  IF pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  IF p_expected_row_version<>v_current.row_version THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.revision<v_current.revision THEN RETURN private.reference_result('invalid_revision',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.revision=v_current.revision
     AND (pg_catalog.to_jsonb(v_next)-ARRAY['revision','row_version','created_at','updated_at','deleted_at'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(v_current)-ARRAY['revision','row_version','created_at','updated_at','deleted_at'])
  THEN RETURN private.reference_result('invalid_revision',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.reference_work_id<>v_current.reference_work_id THEN RETURN private.reference_result('invalid_parent',pg_catalog.to_jsonb(v_current)); END IF;
  IF pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_current.deleted_at IS NULL AND v_next.deleted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.reference_measurement_sets m WHERE m.user_id=v_owner AND m.taxon_treatment_id=v_id AND m.deleted_at IS NULL
  ) THEN RETURN private.reference_result('blocked',pg_catalog.to_jsonb(v_current)); END IF;
  UPDATE public.reference_taxon_treatments SET taxon_id=v_next.taxon_id,name_as_published=v_next.name_as_published,
    page_from=v_next.page_from,page_to=v_next.page_to,locator_text=v_next.locator_text,
    treatment_notes=v_next.treatment_notes,revision=v_next.revision,row_version=row_version+1,
    updated_at=pg_catalog.clock_timestamp(),deleted_at=v_next.deleted_at
  WHERE user_id=v_owner AND id=v_id AND row_version=p_expected_row_version RETURNING * INTO v_current;
  IF NOT FOUND THEN RETURN private.reference_result('conflict'); END IF;
  RETURN private.reference_result('updated',pg_catalog.to_jsonb(v_current));
END
$$;

CREATE FUNCTION public.sync_reference_measurement_set(p_payload jsonb, p_expected_row_version bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid:=auth.uid(); v_id uuid; v_parent uuid; v_supersedes uuid;
  v_current public.reference_measurement_sets%ROWTYPE; v_next public.reference_measurement_sets%ROWTYPE;
  v_deleted boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN RETURN private.reference_result('invalid_payload'); END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' OR
     private.reference_payload_has_unknown_keys(p_payload,ARRAY['id','taxon_treatment_id','character','raw_text','data_kind','length_min','length_core_min','length_core_max','length_max','width_min','width_core_min','width_core_max','width_max','q_min','q_max','q_mean','length_mean','width_mean','sample_size','specimen_count','mount_medium','stain','preparation','measurement_method','notes','raw_points_json','supersedes_id','revision','deleted'])
  THEN RETURN private.reference_result('invalid_payload'); END IF;
  BEGIN
    v_id:=(p_payload->>'id')::uuid; v_parent:=(p_payload->>'taxon_treatment_id')::uuid;
    v_supersedes:=nullif(p_payload->>'supersedes_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN RETURN private.reference_result('invalid_payload'); END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id=v_owner) THEN RETURN private.reference_result('account_deleting'); END IF;
  SELECT * INTO v_current FROM public.reference_measurement_sets WHERE user_id=v_owner AND id=v_id FOR UPDATE;
  IF FOUND AND v_current.deleted_at IS NOT NULL AND coalesce((p_payload->>'deleted')::boolean,false) THEN
    RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reference_taxon_treatments WHERE user_id=v_owner AND id=v_parent AND deleted_at IS NULL) THEN RETURN private.reference_result('invalid_parent'); END IF;
  IF v_supersedes IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.reference_measurement_sets WHERE user_id=v_owner AND id=v_supersedes AND deleted_at IS NULL) THEN RETURN private.reference_result('invalid_parent'); END IF;
  IF v_supersedes=v_id OR (v_supersedes IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT v_supersedes UNION ALL
      SELECT m.supersedes_id FROM public.reference_measurement_sets m JOIN ancestors a ON m.user_id=v_owner AND m.id=a.id WHERE m.supersedes_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=v_id
  )) THEN RETURN private.reference_result('invalid_successor'); END IF;
  SELECT * INTO v_current FROM public.reference_measurement_sets WHERE user_id=v_owner AND id=v_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_row_version<>0 THEN RETURN private.reference_result('conflict'); END IF;
    BEGIN
      INSERT INTO public.reference_measurement_sets(
        user_id,id,taxon_treatment_id,character,raw_text,data_kind,length_min,length_core_min,length_core_max,length_max,
        width_min,width_core_min,width_core_max,width_max,q_min,q_max,q_mean,length_mean,width_mean,sample_size,
        specimen_count,mount_medium,stain,preparation,measurement_method,notes,raw_points_json,supersedes_id,revision,deleted_at
      ) VALUES (
        v_owner,v_id,v_parent,p_payload->>'character',p_payload->>'raw_text',p_payload->>'data_kind',
        (p_payload->>'length_min')::double precision,(p_payload->>'length_core_min')::double precision,(p_payload->>'length_core_max')::double precision,(p_payload->>'length_max')::double precision,
        (p_payload->>'width_min')::double precision,(p_payload->>'width_core_min')::double precision,(p_payload->>'width_core_max')::double precision,(p_payload->>'width_max')::double precision,
        (p_payload->>'q_min')::double precision,(p_payload->>'q_max')::double precision,(p_payload->>'q_mean')::double precision,
        (p_payload->>'length_mean')::double precision,(p_payload->>'width_mean')::double precision,(p_payload->>'sample_size')::integer,
        (p_payload->>'specimen_count')::integer,p_payload->>'mount_medium',p_payload->>'stain',p_payload->>'preparation',
        p_payload->>'measurement_method',p_payload->>'notes',p_payload->'raw_points_json',v_supersedes,
        coalesce((p_payload->>'revision')::integer,1),CASE WHEN coalesce((p_payload->>'deleted')::boolean,false) THEN pg_catalog.clock_timestamp() END
      ) RETURNING * INTO v_current;
      RETURN private.reference_result('created',pg_catalog.to_jsonb(v_current));
    EXCEPTION WHEN unique_violation THEN RETURN private.reference_result('conflict');
      WHEN foreign_key_violation OR check_violation OR not_null_violation OR invalid_text_representation THEN RETURN private.reference_result('invalid_payload');
    END;
  END IF;
  v_next:=pg_catalog.jsonb_populate_record(v_current,p_payload-ARRAY['deleted']);
  v_next.user_id:=v_owner; v_next.id:=v_id; v_next.created_at:=v_current.created_at;
  v_next.row_version:=v_current.row_version; v_next.updated_at:=v_current.updated_at;
  v_deleted:=coalesce((p_payload->>'deleted')::boolean,v_current.deleted_at IS NOT NULL);
  v_next.deleted_at:=CASE WHEN v_deleted THEN coalesce(v_current.deleted_at,pg_catalog.clock_timestamp()) ELSE NULL END;
  IF pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  IF p_expected_row_version<>v_current.row_version THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.revision<v_current.revision THEN RETURN private.reference_result('invalid_revision',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.revision=v_current.revision
     AND (pg_catalog.to_jsonb(v_next)-ARRAY['revision','row_version','created_at','updated_at','deleted_at'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(v_current)-ARRAY['revision','row_version','created_at','updated_at','deleted_at'])
  THEN RETURN private.reference_result('invalid_revision',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.taxon_treatment_id<>v_current.taxon_treatment_id THEN RETURN private.reference_result('invalid_parent',pg_catalog.to_jsonb(v_current)); END IF;
  IF pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_current.deleted_at IS NULL AND v_next.deleted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.observation_reference_uses u WHERE u.user_id=v_owner AND u.reference_measurement_set_id=v_id AND u.deleted_at IS NULL
  ) THEN RETURN private.reference_result('blocked',pg_catalog.to_jsonb(v_current)); END IF;
  BEGIN
    UPDATE public.reference_measurement_sets SET character=v_next.character,raw_text=v_next.raw_text,data_kind=v_next.data_kind,
      length_min=v_next.length_min,length_core_min=v_next.length_core_min,length_core_max=v_next.length_core_max,length_max=v_next.length_max,
      width_min=v_next.width_min,width_core_min=v_next.width_core_min,width_core_max=v_next.width_core_max,width_max=v_next.width_max,
      q_min=v_next.q_min,q_max=v_next.q_max,q_mean=v_next.q_mean,length_mean=v_next.length_mean,width_mean=v_next.width_mean,
      sample_size=v_next.sample_size,specimen_count=v_next.specimen_count,mount_medium=v_next.mount_medium,stain=v_next.stain,
      preparation=v_next.preparation,measurement_method=v_next.measurement_method,notes=v_next.notes,raw_points_json=v_next.raw_points_json,
      supersedes_id=v_next.supersedes_id,revision=v_next.revision,row_version=row_version+1,
      updated_at=pg_catalog.clock_timestamp(),deleted_at=v_next.deleted_at
    WHERE user_id=v_owner AND id=v_id AND row_version=p_expected_row_version RETURNING * INTO v_current;
  EXCEPTION WHEN unique_violation THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END;
  IF NOT FOUND THEN RETURN private.reference_result('conflict'); END IF;
  RETURN private.reference_result('updated',pg_catalog.to_jsonb(v_current));
END
$$;

CREATE FUNCTION public.sync_observation_reference_use(
  p_payload jsonb,
  p_expected_row_version bigint,
  p_snapshot_mode text DEFAULT 'current'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid:=auth.uid(); v_id uuid; v_set_id uuid; v_observation_id bigint;
  v_work_id uuid; v_treatment_id uuid; v_source_revision integer;
  v_payload_reference_revision integer; v_snapshot jsonb;
  v_current public.observation_reference_uses%ROWTYPE; v_next public.observation_reference_uses%ROWTYPE;
  v_deleted boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN RETURN private.reference_result('invalid_payload'); END IF;
  IF p_snapshot_mode IS NULL OR p_snapshot_mode NOT IN ('current','historical_import') OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' OR
     private.reference_payload_has_unknown_keys(p_payload,ARRAY['id','observation_id','reference_measurement_set_id','role','note','selected_at','reference_revision','snapshot_json','deleted'])
  THEN RETURN private.reference_result('invalid_payload'); END IF;
  BEGIN
    v_id:=(p_payload->>'id')::uuid; v_set_id:=(p_payload->>'reference_measurement_set_id')::uuid;
    v_observation_id:=(p_payload->>'observation_id')::bigint;
    v_payload_reference_revision:=(p_payload->>'reference_revision')::integer;
    v_snapshot:=p_payload->'snapshot_json';
  EXCEPTION WHEN OTHERS THEN RETURN private.reference_result('invalid_payload'); END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,7301));
  IF NOT EXISTS (SELECT 1 FROM public.observations WHERE user_id=v_owner AND id=v_observation_id) THEN RETURN private.reference_result('invalid_parent'); END IF;
  SELECT t.reference_work_id,m.taxon_treatment_id,m.revision INTO v_work_id,v_treatment_id,v_source_revision
  FROM public.reference_measurement_sets m JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
  JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id
  WHERE m.user_id=v_owner AND m.id=v_set_id AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
  FOR UPDATE OF m,t,w;
  IF NOT FOUND THEN RETURN private.reference_result('invalid_parent'); END IF;
  SELECT * INTO v_current FROM public.observation_reference_uses WHERE user_id=v_owner AND id=v_id FOR UPDATE;
  v_deleted:=coalesce((p_payload->>'deleted')::boolean,false);
  IF NOT FOUND THEN
    IF p_expected_row_version<>0 THEN RETURN private.reference_result('conflict'); END IF;
    IF v_deleted
       OR v_payload_reference_revision < 1
       OR (p_snapshot_mode='current' AND v_payload_reference_revision<>v_source_revision)
       OR NOT private.reference_snapshot_valid(v_snapshot,v_work_id,v_treatment_id,v_set_id,v_payload_reference_revision)
    THEN RETURN private.reference_result('invalid_snapshot'); END IF;
    BEGIN
      INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,note,selected_at,reference_revision,snapshot_json)
      VALUES(v_owner,v_id,v_observation_id,v_set_id,p_payload->>'role',p_payload->>'note',coalesce((p_payload->>'selected_at')::timestamptz,pg_catalog.clock_timestamp()),v_payload_reference_revision,v_snapshot)
      RETURNING * INTO v_current;
      RETURN private.reference_result('created',pg_catalog.to_jsonb(v_current));
    EXCEPTION WHEN unique_violation THEN RETURN private.reference_result('conflict');
      WHEN foreign_key_violation OR check_violation OR not_null_violation OR invalid_text_representation THEN RETURN private.reference_result('invalid_payload');
    END;
  END IF;
  IF v_deleted THEN
    IF p_expected_row_version<>v_current.row_version THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END IF;
    IF v_current.deleted_at IS NOT NULL THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
    UPDATE public.observation_reference_uses SET deleted_at=pg_catalog.clock_timestamp(),row_version=row_version+1,updated_at=pg_catalog.clock_timestamp()
    WHERE user_id=v_owner AND id=v_id AND row_version=p_expected_row_version RETURNING * INTO v_current;
    IF NOT FOUND THEN RETURN private.reference_result('conflict'); END IF;
    RETURN private.reference_result('updated',pg_catalog.to_jsonb(v_current));
  END IF;
  IF v_observation_id<>v_current.observation_id THEN RETURN private.reference_result('invalid_parent',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_payload_reference_revision < 1
     OR (p_snapshot_mode='current' AND v_payload_reference_revision<>v_source_revision)
     OR NOT private.reference_snapshot_valid(v_snapshot,v_work_id,v_treatment_id,v_set_id,v_payload_reference_revision)
  THEN RETURN private.reference_result('invalid_snapshot',pg_catalog.to_jsonb(v_current)); END IF;
  v_next:=pg_catalog.jsonb_populate_record(v_current,p_payload-ARRAY['deleted']);
  v_next.user_id:=v_owner; v_next.id:=v_id; v_next.observation_id:=v_current.observation_id;
  v_next.created_at:=v_current.created_at; v_next.row_version:=v_current.row_version; v_next.updated_at:=v_current.updated_at;
  v_next.deleted_at:=NULL; v_next.reference_revision:=v_payload_reference_revision;
  IF p_expected_row_version=0 AND pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  IF p_expected_row_version<>v_current.row_version THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END IF;
  IF pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  UPDATE public.observation_reference_uses SET reference_measurement_set_id=v_next.reference_measurement_set_id,
    role=v_next.role,note=v_next.note,selected_at=v_next.selected_at,reference_revision=v_next.reference_revision,
    snapshot_json=v_next.snapshot_json,deleted_at=NULL,row_version=row_version+1,updated_at=pg_catalog.clock_timestamp()
  WHERE user_id=v_owner AND id=v_id AND row_version=p_expected_row_version RETURNING * INTO v_current;
  IF NOT FOUND THEN RETURN private.reference_result('conflict'); END IF;
  RETURN private.reference_result('updated',pg_catalog.to_jsonb(v_current));
END
$$;

-- The attachment mutation is deliberately stricter than the generic entity
-- mutations: current snapshots must be the server-derived public-safe value,
-- and an existing frozen snapshot can change only during an explicit refresh
-- or verified successor adoption.
CREATE OR REPLACE FUNCTION public.sync_observation_reference_use(
  p_payload jsonb, p_expected_row_version bigint, p_snapshot_mode text DEFAULT 'current'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner uuid:=auth.uid(); v_id uuid; v_set_id uuid; v_observation_id bigint;
  v_work_id uuid; v_treatment_id uuid; v_source_revision integer; v_terminal uuid;
  v_payload_reference_revision integer; v_snapshot jsonb; v_canonical jsonb;
  v_current public.observation_reference_uses%ROWTYPE; v_next public.observation_reference_uses%ROWTYPE;
  v_deleted boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN RETURN private.reference_result('invalid_payload'); END IF;
  IF p_snapshot_mode IS NULL OR p_snapshot_mode NOT IN ('current','historical_import') OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' OR
     private.reference_payload_has_unknown_keys(p_payload,ARRAY['id','observation_id','reference_measurement_set_id','role','note','selected_at','reference_revision','snapshot_json','deleted'])
  THEN RETURN private.reference_result('invalid_payload'); END IF;
  BEGIN
    v_id:=(p_payload->>'id')::uuid; v_set_id:=(p_payload->>'reference_measurement_set_id')::uuid;
    v_observation_id:=(p_payload->>'observation_id')::bigint;
    v_payload_reference_revision:=(p_payload->>'reference_revision')::integer;
    v_snapshot:=p_payload->'snapshot_json'; v_deleted:=coalesce((p_payload->>'deleted')::boolean,false);
  EXCEPTION WHEN OTHERS THEN RETURN private.reference_result('invalid_payload'); END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id=v_owner) THEN RETURN private.reference_result('account_deleting'); END IF;
  SELECT * INTO v_current FROM public.observation_reference_uses WHERE user_id=v_owner AND id=v_id FOR UPDATE;

  -- Detach and its retries never depend on the later state of the source graph.
  IF FOUND AND v_deleted THEN
    IF v_current.deleted_at IS NOT NULL THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
    IF p_expected_row_version<>v_current.row_version THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END IF;
    UPDATE public.observation_reference_uses SET deleted_at=pg_catalog.clock_timestamp(),row_version=row_version+1,
      updated_at=pg_catalog.clock_timestamp() WHERE user_id=v_owner AND id=v_id AND row_version=p_expected_row_version
      RETURNING * INTO v_current;
    RETURN private.reference_result('updated',pg_catalog.to_jsonb(v_current));
  END IF;
  IF v_deleted THEN RETURN private.reference_result('invalid_payload'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.observations WHERE user_id=v_owner AND id=v_observation_id) THEN RETURN private.reference_result('invalid_parent'); END IF;
  v_canonical:=private.reference_canonical_snapshot(v_owner,v_set_id);
  IF v_canonical IS NULL THEN RETURN private.reference_result('invalid_parent'); END IF;
  v_work_id:=(v_canonical->>'reference_work_id')::uuid; v_treatment_id:=(v_canonical->>'reference_treatment_id')::uuid;
  v_source_revision:=(v_canonical->>'reference_revision')::integer;
  IF private.reference_snapshot_valid(v_snapshot,v_work_id,v_treatment_id,v_set_id,v_payload_reference_revision) IS NOT TRUE THEN
    RETURN private.reference_result('invalid_snapshot',CASE WHEN FOUND THEN pg_catalog.to_jsonb(v_current) END);
  END IF;

  IF NOT FOUND THEN
    IF p_expected_row_version<>0 THEN RETURN private.reference_result('conflict'); END IF;
    IF p_snapshot_mode='current' AND (v_payload_reference_revision<>v_source_revision OR v_snapshot<>v_canonical) THEN RETURN private.reference_result('invalid_snapshot'); END IF;
    IF p_snapshot_mode='historical_import' AND v_payload_reference_revision>v_source_revision THEN RETURN private.reference_result('invalid_snapshot'); END IF;
    BEGIN
      INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,note,selected_at,reference_revision,snapshot_json)
      VALUES(v_owner,v_id,v_observation_id,v_set_id,p_payload->>'role',p_payload->>'note',coalesce((p_payload->>'selected_at')::timestamptz,pg_catalog.clock_timestamp()),v_payload_reference_revision,v_snapshot)
      RETURNING * INTO v_current;
      RETURN private.reference_result('created',pg_catalog.to_jsonb(v_current));
    EXCEPTION WHEN unique_violation THEN RETURN private.reference_result('conflict');
      WHEN foreign_key_violation OR check_violation OR not_null_violation OR invalid_text_representation THEN RETURN private.reference_result('invalid_payload');
    END;
  END IF;

  IF v_observation_id<>v_current.observation_id THEN RETURN private.reference_result('invalid_parent',pg_catalog.to_jsonb(v_current)); END IF;
  v_next:=pg_catalog.jsonb_populate_record(v_current,p_payload-ARRAY['deleted']);
  v_next.user_id:=v_owner; v_next.id:=v_id; v_next.observation_id:=v_current.observation_id;
  v_next.created_at:=v_current.created_at; v_next.row_version:=v_current.row_version; v_next.updated_at:=v_current.updated_at;
  v_next.deleted_at:=NULL;
  IF pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  IF p_snapshot_mode='historical_import' THEN RETURN private.reference_result('invalid_snapshot_mode',pg_catalog.to_jsonb(v_current)); END IF;
  IF p_expected_row_version<>v_current.row_version THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END IF;

  IF v_current.deleted_at IS NULL AND v_set_id=v_current.reference_measurement_set_id
     AND v_snapshot=v_current.snapshot_json AND v_payload_reference_revision=v_current.reference_revision
  THEN
    NULL; -- role/note/selected_at-only edit; preserve the frozen evidence.
  ELSE
    IF v_snapshot<>v_canonical OR v_payload_reference_revision<>v_source_revision THEN RETURN private.reference_result('invalid_snapshot',pg_catalog.to_jsonb(v_current)); END IF;
    IF v_set_id<>v_current.reference_measurement_set_id THEN
      WITH RECURSIVE chain(id,path) AS (
        SELECT v_current.reference_measurement_set_id,ARRAY[v_current.reference_measurement_set_id]
        UNION ALL
        SELECT child.id,c.path||child.id FROM chain c
        JOIN public.reference_measurement_sets child ON child.user_id=v_owner AND child.supersedes_id=c.id AND child.deleted_at IS NULL
        WHERE NOT child.id=ANY(c.path)
      )
      SELECT c.id INTO v_terminal FROM chain c
      WHERE NOT EXISTS (SELECT 1 FROM public.reference_measurement_sets n WHERE n.user_id=v_owner AND n.supersedes_id=c.id AND n.deleted_at IS NULL)
      ORDER BY pg_catalog.array_length(c.path,1) DESC LIMIT 1;
      IF v_terminal IS DISTINCT FROM v_set_id THEN RETURN private.reference_result('invalid_successor',pg_catalog.to_jsonb(v_current)); END IF;
    END IF;
  END IF;
  BEGIN
    UPDATE public.observation_reference_uses SET reference_measurement_set_id=v_next.reference_measurement_set_id,
      role=v_next.role,note=v_next.note,selected_at=v_next.selected_at,reference_revision=v_next.reference_revision,
      snapshot_json=v_next.snapshot_json,deleted_at=NULL,row_version=row_version+1,updated_at=pg_catalog.clock_timestamp()
    WHERE user_id=v_owner AND id=v_id AND row_version=p_expected_row_version RETURNING * INTO v_current;
  EXCEPTION WHEN unique_violation THEN RETURN private.reference_result('conflict'); END;
  IF NOT FOUND THEN RETURN private.reference_result('conflict'); END IF;
  RETURN private.reference_result('updated',pg_catalog.to_jsonb(v_current));
END $$;

CREATE FUNCTION public.delete_reference_library_for_account(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,7301));
  INSERT INTO private.reference_account_deletions(user_id) VALUES(p_user_id) ON CONFLICT (user_id) DO NOTHING;
  DELETE FROM public.observation_reference_uses WHERE user_id=p_user_id;
  DELETE FROM public.reference_measurement_sets WHERE user_id=p_user_id;
  DELETE FROM public.reference_taxon_treatments WHERE user_id=p_user_id;
  DELETE FROM public.reference_works WHERE user_id=p_user_id;
END $$;

ALTER FUNCTION public.sync_reference_work(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_reference_taxon_treatment(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_reference_measurement_set(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) OWNER TO postgres;
ALTER FUNCTION public.delete_reference_library_for_account(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_reference_work(jsonb,bigint) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.sync_reference_taxon_treatment(jsonb,bigint) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.delete_reference_library_for_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reference_work(jsonb,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reference_taxon_treatment(jsonb,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_reference_library_for_account(uuid) TO service_role;

COMMIT;
