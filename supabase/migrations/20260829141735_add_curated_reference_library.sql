-- Dormant curated-reference catalogue foundation.
--
-- This migration intentionally exposes no public RPC, policy, or application
-- behavior. Curated drafts and immutable publication bundles remain in the
-- unexposed private schema until later Stage 6 slices add reviewed boundaries.

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE TABLE private.curated_reference_works (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('book', 'article', 'chapter', 'website', 'dataset', 'other')),
  citation_key text CHECK (citation_key IS NULL OR (btrim(citation_key) <> '' AND char_length(citation_key) <= 128)),
  authors_json jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(authors_json) = 'array' AND octet_length(authors_json::text) <= 65536),
  editors_json jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(editors_json) = 'array' AND octet_length(editors_json::text) <= 65536),
  title text NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 2048),
  container_title text CHECK (container_title IS NULL OR char_length(container_title) <= 2048),
  year integer CHECK (year IS NULL OR year BETWEEN 1 AND 9999),
  edition text CHECK (edition IS NULL OR char_length(edition) <= 256),
  publisher text CHECK (publisher IS NULL OR char_length(publisher) <= 1024),
  place text CHECK (place IS NULL OR char_length(place) <= 1024),
  volume text CHECK (volume IS NULL OR char_length(volume) <= 128),
  issue text CHECK (issue IS NULL OR char_length(issue) <= 128),
  pages text CHECK (pages IS NULL OR char_length(pages) <= 256),
  doi text CHECK (doi IS NULL OR (btrim(doi) <> '' AND char_length(doi) <= 255)),
  isbn text CHECK (isbn IS NULL OR (btrim(isbn) <> '' AND char_length(isbn) <= 64)),
  url text CHECK (url IS NULL OR (char_length(url) <= 2048 AND url ~* '^https?://')),
  language text CHECK (language IS NULL OR char_length(language) <= 64),
  short_label text NOT NULL CHECK (btrim(short_label) <> '' AND char_length(short_label) <= 512),
  citation_override text CHECK (citation_override IS NULL OR char_length(citation_override) <= 8192),
  revision integer NOT NULL CHECK (revision >= 1),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private.curated_reference_taxon_treatments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_work_id uuid NOT NULL REFERENCES private.curated_reference_works(id) ON DELETE RESTRICT,
  name_as_published text NOT NULL CHECK (btrim(name_as_published) <> '' AND char_length(name_as_published) <= 1024),
  page_from integer CHECK (page_from IS NULL OR page_from >= 1),
  page_to integer CHECK (page_to IS NULL OR page_to >= 1),
  locator_text text CHECK (locator_text IS NULL OR char_length(locator_text) <= 1024),
  treatment_notes text CHECK (treatment_notes IS NULL OR char_length(treatment_notes) <= 8192),
  revision integer NOT NULL CHECK (revision >= 1),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, reference_work_id),
  CHECK (page_from IS NULL OR page_to IS NULL OR page_to >= page_from)
);

CREATE TABLE private.curated_reference_measurement_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taxon_treatment_id uuid NOT NULL REFERENCES private.curated_reference_taxon_treatments(id) ON DELETE RESTRICT,
  character text NOT NULL CHECK (character = 'spore_size'),
  raw_text text CHECK (raw_text IS NULL OR char_length(raw_text) <= 8192),
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
  mount_medium text CHECK (mount_medium IS NULL OR char_length(mount_medium) <= 1024),
  stain text CHECK (stain IS NULL OR char_length(stain) <= 1024),
  preparation text CHECK (preparation IS NULL OR char_length(preparation) <= 2048),
  measurement_method text CHECK (measurement_method IS NULL OR char_length(measurement_method) <= 2048),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 8192),
  raw_points_json jsonb CHECK (
    raw_points_json IS NULL OR (
      jsonb_typeof(raw_points_json) = 'array'
      AND octet_length(raw_points_json::text) <= 65536
    )
  ),
  supersedes_id uuid REFERENCES private.curated_reference_measurement_sets(id) ON DELETE RESTRICT,
  catalogue_status text NOT NULL DEFAULT 'draft'
    CHECK (catalogue_status IN ('draft', 'published', 'deprecated', 'withdrawn')),
  latest_bundle_revision integer CHECK (latest_bundle_revision IS NULL OR latest_bundle_revision >= 1),
  published_at timestamptz,
  deprecated_at timestamptz,
  withdrawn_at timestamptz,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL CHECK (revision >= 1),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, taxon_treatment_id),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (
    (catalogue_status = 'draft' AND latest_bundle_revision IS NULL
      AND published_at IS NULL AND deprecated_at IS NULL AND withdrawn_at IS NULL)
    OR (catalogue_status = 'published' AND latest_bundle_revision IS NOT NULL
      AND published_at IS NOT NULL AND deprecated_at IS NULL AND withdrawn_at IS NULL)
    OR (catalogue_status = 'deprecated' AND latest_bundle_revision IS NOT NULL
      AND published_at IS NOT NULL AND deprecated_at IS NOT NULL AND withdrawn_at IS NULL)
    OR (catalogue_status = 'withdrawn' AND latest_bundle_revision IS NOT NULL
      AND published_at IS NOT NULL AND withdrawn_at IS NOT NULL)
  )
);

CREATE TABLE private.curated_reference_treatment_taxa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taxon_treatment_id uuid NOT NULL REFERENCES private.curated_reference_taxon_treatments(id) ON DELETE RESTRICT,
  sporely_taxon_id integer NOT NULL REFERENCES taxonomy_v3.registry_concept(sporely_taxon_id) ON DELETE RESTRICT
    CHECK (sporely_taxon_id > 0),
  assignment_reason text NOT NULL CHECK (btrim(assignment_reason) <> '' AND char_length(assignment_reason) <= 2048),
  revision integer NOT NULL CHECK (revision >= 1),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (taxon_treatment_id, sporely_taxon_id)
);

CREATE TABLE private.curated_reference_publications (
  curated_measurement_set_id uuid NOT NULL,
  bundle_revision integer NOT NULL CHECK (bundle_revision >= 1),
  curated_taxon_treatment_id uuid NOT NULL,
  curated_work_id uuid NOT NULL,
  measurement_set_revision integer NOT NULL CHECK (measurement_set_revision >= 1),
  treatment_revision integer NOT NULL CHECK (treatment_revision >= 1),
  work_revision integer NOT NULL CHECK (work_revision >= 1),
  snapshot_schema_version integer NOT NULL CHECK (snapshot_schema_version = 1),
  snapshot_json jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot_json) = 'object'
    AND snapshot_json->>'schema_version' = snapshot_schema_version::text
    AND octet_length(snapshot_json::text) <= 65536
  ),
  citation_schema_version integer NOT NULL CHECK (citation_schema_version = 1),
  citation_json jsonb NOT NULL CHECK (
    jsonb_typeof(citation_json) = 'object'
    AND citation_json->>'schema_version' = citation_schema_version::text
    AND octet_length(citation_json::text) <= 65536
  ),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (curated_measurement_set_id, bundle_revision),
  FOREIGN KEY (curated_measurement_set_id, curated_taxon_treatment_id)
    REFERENCES private.curated_reference_measurement_sets(id, taxon_treatment_id) ON DELETE RESTRICT,
  FOREIGN KEY (curated_taxon_treatment_id, curated_work_id)
    REFERENCES private.curated_reference_taxon_treatments(id, reference_work_id) ON DELETE RESTRICT
);

ALTER TABLE private.curated_reference_measurement_sets
  ADD CONSTRAINT curated_reference_measurement_sets_latest_publication_fkey
  FOREIGN KEY (id, latest_bundle_revision)
  REFERENCES private.curated_reference_publications(curated_measurement_set_id, bundle_revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE private.curated_reference_publication_taxa (
  curated_measurement_set_id uuid NOT NULL,
  bundle_revision integer NOT NULL,
  sporely_taxon_id integer NOT NULL REFERENCES taxonomy_v3.registry_concept(sporely_taxon_id) ON DELETE RESTRICT
    CHECK (sporely_taxon_id > 0),
  canonical_name text NOT NULL CHECK (btrim(canonical_name) <> '' AND char_length(canonical_name) <= 1024),
  PRIMARY KEY (curated_measurement_set_id, bundle_revision, sporely_taxon_id),
  FOREIGN KEY (curated_measurement_set_id, bundle_revision)
    REFERENCES private.curated_reference_publications(curated_measurement_set_id, bundle_revision) ON DELETE RESTRICT
);

CREATE TABLE private.reference_curator_memberships (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('reference_reviewer', 'reference_publisher')),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (btrim(reason) <> '' AND char_length(reason) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private.reference_curation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'claim', 'request_changes', 'resubmit', 'reject', 'accept', 'edit_draft',
    'publish', 'deprecate', 'supersede', 'withdraw', 'role_change',
    'submit', 'report', 'resolve_report'
  )),
  target_type text NOT NULL CHECK (target_type IN (
    'submission', 'curated_work', 'curated_treatment',
    'curated_measurement_set', 'publication', 'membership', 'report'
  )),
  target_id uuid NOT NULL,
  bundle_revision integer CHECK (bundle_revision IS NULL OR bundle_revision >= 1),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'conflict', 'failed')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 4000),
  before_content_hash text CHECK (before_content_hash IS NULL OR before_content_hash ~ '^[0-9a-f]{64}$'),
  after_content_hash text CHECK (after_content_hash IS NULL OR after_content_hash ~ '^[0-9a-f]{64}$'),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata_json) = 'object'
    AND octet_length(metadata_json::text) <= 65536
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX curated_reference_works_citation_key_key
  ON private.curated_reference_works (lower(btrim(citation_key)))
  WHERE citation_key IS NOT NULL;
CREATE INDEX curated_reference_works_created_by_idx
  ON private.curated_reference_works (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX curated_reference_works_updated_by_idx
  ON private.curated_reference_works (updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX curated_reference_taxon_treatments_work_idx
  ON private.curated_reference_taxon_treatments (reference_work_id);
CREATE INDEX curated_reference_taxon_treatments_created_by_idx
  ON private.curated_reference_taxon_treatments (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX curated_reference_taxon_treatments_updated_by_idx
  ON private.curated_reference_taxon_treatments (updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX curated_reference_measurement_sets_treatment_idx
  ON private.curated_reference_measurement_sets (taxon_treatment_id);
CREATE INDEX curated_reference_measurement_sets_catalogue_idx
  ON private.curated_reference_measurement_sets (catalogue_status, published_at DESC, id);
CREATE INDEX curated_reference_measurement_sets_latest_publication_idx
  ON private.curated_reference_measurement_sets (id, latest_bundle_revision)
  WHERE latest_bundle_revision IS NOT NULL;
CREATE UNIQUE INDEX curated_reference_measurement_sets_one_live_successor_key
  ON private.curated_reference_measurement_sets (supersedes_id)
  WHERE supersedes_id IS NOT NULL AND catalogue_status <> 'withdrawn';
CREATE INDEX curated_reference_measurement_sets_created_by_idx
  ON private.curated_reference_measurement_sets (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX curated_reference_measurement_sets_updated_by_idx
  ON private.curated_reference_measurement_sets (updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX curated_reference_treatment_taxa_lookup_idx
  ON private.curated_reference_treatment_taxa (sporely_taxon_id, taxon_treatment_id);
CREATE INDEX curated_reference_treatment_taxa_created_by_idx
  ON private.curated_reference_treatment_taxa (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX curated_reference_treatment_taxa_updated_by_idx
  ON private.curated_reference_treatment_taxa (updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX curated_reference_publications_published_idx
  ON private.curated_reference_publications (published_at DESC, curated_measurement_set_id);
CREATE INDEX curated_reference_publications_content_hash_idx
  ON private.curated_reference_publications (curated_measurement_set_id, content_hash);
CREATE INDEX curated_reference_publications_set_treatment_idx
  ON private.curated_reference_publications (curated_measurement_set_id, curated_taxon_treatment_id);
CREATE INDEX curated_reference_publications_treatment_idx
  ON private.curated_reference_publications (curated_taxon_treatment_id, curated_work_id, treatment_revision);
CREATE INDEX curated_reference_publications_work_idx
  ON private.curated_reference_publications (curated_work_id, work_revision);
CREATE INDEX curated_reference_publications_published_by_idx
  ON private.curated_reference_publications (published_by) WHERE published_by IS NOT NULL;
CREATE INDEX curated_reference_publication_taxa_lookup_idx
  ON private.curated_reference_publication_taxa (sporely_taxon_id, curated_measurement_set_id, bundle_revision);
CREATE INDEX reference_curator_memberships_role_idx
  ON private.reference_curator_memberships (role, user_id);
CREATE INDEX reference_curator_memberships_granted_by_idx
  ON private.reference_curator_memberships (granted_by) WHERE granted_by IS NOT NULL;
CREATE INDEX reference_curation_events_target_idx
  ON private.reference_curation_events (target_type, target_id, created_at DESC, id);
CREATE INDEX reference_curation_events_actor_idx
  ON private.reference_curation_events (actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL;

CREATE FUNCTION private.curated_require_cas_increment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_excluded text[] := ARRAY[
    'id', 'revision', 'row_version', 'created_by', 'updated_by',
    'created_at', 'updated_at'
  ];
  v_content_changed boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'curated identity and creation provenance are immutable'
      USING ERRCODE = '25006';
  END IF;
  IF NEW.row_version = OLD.row_version
     AND to_jsonb(NEW) - ARRAY['created_by', 'updated_by']
         = to_jsonb(OLD) - ARRAY['created_by', 'updated_by']
     AND (NEW.created_by IS NULL OR NEW.created_by = OLD.created_by)
     AND (NEW.updated_by IS NULL OR NEW.updated_by = OLD.updated_by) THEN
    RETURN NEW;
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'curated mutation must increment row_version exactly once'
      USING ERRCODE = '40001';
  END IF;

  IF TG_TABLE_NAME = 'curated_reference_measurement_sets' THEN
    v_excluded := v_excluded || ARRAY[
      'supersedes_id', 'catalogue_status', 'latest_bundle_revision',
      'published_at', 'deprecated_at', 'withdrawn_at', 'status_changed_at'
    ];
  END IF;
  v_content_changed := (to_jsonb(NEW) - v_excluded)
                       IS DISTINCT FROM (to_jsonb(OLD) - v_excluded);
  IF v_content_changed AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'curated content mutation must increment semantic revision exactly once'
      USING ERRCODE = '23514';
  ELSIF NOT v_content_changed AND NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'curated semantic revision may change only with curated content'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION private.curated_require_membership_cas_increment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'curator membership identity and creation time are immutable'
      USING ERRCODE = '25006';
  END IF;
  IF OLD.granted_by IS NOT NULL
     AND NEW.granted_by IS NULL
     AND NEW.row_version = OLD.row_version
     AND to_jsonb(NEW) - 'granted_by' = to_jsonb(OLD) - 'granted_by' THEN
    RETURN NEW;
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'curator membership mutation must increment row_version exactly once'
      USING ERRCODE = '40001';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION private.curated_guard_catalogue_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.catalogue_status <> 'draft'
       OR NEW.latest_bundle_revision IS NOT NULL
       OR NEW.published_at IS NOT NULL
       OR NEW.deprecated_at IS NOT NULL
       OR NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'a curated measurement set must begin as a draft'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.catalogue_status = OLD.catalogue_status THEN
    RETURN NEW;
  END IF;
  IF OLD.catalogue_status = 'draft' AND NEW.catalogue_status = 'published' THEN
    RETURN NEW;
  END IF;
  IF OLD.catalogue_status = 'published'
     AND NEW.catalogue_status IN ('deprecated', 'withdrawn') THEN
    RETURN NEW;
  END IF;
  IF OLD.catalogue_status = 'deprecated' AND NEW.catalogue_status = 'withdrawn' THEN
    RETURN NEW;
  END IF;
  IF OLD.catalogue_status IN ('deprecated', 'withdrawn')
     AND NEW.catalogue_status = 'published'
     AND NEW.latest_bundle_revision > OLD.latest_bundle_revision THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid curated catalogue lifecycle transition: % -> %',
    OLD.catalogue_status, NEW.catalogue_status
    USING ERRCODE = '23514';
END
$$;

CREATE FUNCTION private.curated_require_species_taxon()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rank text;
  v_name text;
BEGIN
  SELECT c.rank, c.canonical_name INTO v_rank, v_name
    FROM taxonomy_v3.registry_concept c
   WHERE c.sporely_taxon_id = NEW.sporely_taxon_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown taxonomy-v3 concept: %', NEW.sporely_taxon_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.sporely_taxon_id <= 0
     OR v_rank IS DISTINCT FROM 'species'
     OR nullif(btrim(v_name), '') IS NULL THEN
    RAISE EXCEPTION 'curated taxon assignment requires a positive named taxonomy-v3 species: %', NEW.sporely_taxon_id
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'curated_reference_publication_taxa' THEN
    IF NEW.canonical_name IS DISTINCT FROM v_name THEN
      RAISE EXCEPTION 'published taxon name must match the taxonomy-v3 species name for %', NEW.sporely_taxon_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.curated_guard_supersession()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_parent_character text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('private.curated_reference_supersession', 0)
  );
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.supersedes_id = NEW.id THEN
    RAISE EXCEPTION 'a curated measurement set cannot supersede itself'
      USING ERRCODE = '23514';
  END IF;
  SELECT s.character INTO v_parent_character
    FROM private.curated_reference_measurement_sets s
   WHERE s.id = NEW.supersedes_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_parent_character <> NEW.character THEN
    RAISE EXCEPTION 'a curated measurement set may supersede only the same character'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(id, supersedes_id) AS (
      SELECT s.id, s.supersedes_id
        FROM private.curated_reference_measurement_sets s
       WHERE s.id = NEW.supersedes_id
      UNION ALL
      SELECT s.id, s.supersedes_id
        FROM private.curated_reference_measurement_sets s
        JOIN ancestors a ON s.id = a.supersedes_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'curated measurement-set supersession must be acyclic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.curated_check_supersession_taxa()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM private.curated_reference_measurement_sets successor
      JOIN private.curated_reference_measurement_sets predecessor
        ON predecessor.id = successor.supersedes_id
     WHERE NOT EXISTS (
         SELECT 1
           FROM private.curated_reference_treatment_taxa successor_taxon
           JOIN private.curated_reference_treatment_taxa predecessor_taxon
             ON predecessor_taxon.sporely_taxon_id = successor_taxon.sporely_taxon_id
          WHERE successor_taxon.taxon_treatment_id = successor.taxon_treatment_id
            AND predecessor_taxon.taxon_treatment_id = predecessor.taxon_treatment_id
       )
  ) THEN
    RAISE EXCEPTION 'superseding measurement sets require a compatible explicit taxon assignment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION private.curated_lock_supersession_graph()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('private.curated_reference_supersession', 0)
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.curated_guard_work_citation_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.citation_key IS DISTINCT FROM OLD.citation_key
     AND EXISTS (
       SELECT 1 FROM private.curated_reference_publications p
        WHERE p.curated_work_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'published curated citation keys are immutable'
      USING ERRCODE = '25006';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.curated_check_publication_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_set_id uuid;
  v_status text;
  v_latest integer;
  v_publication_count bigint;
  v_max_bundle integer;
BEGIN
  IF TG_TABLE_NAME = 'curated_reference_publications' THEN
    v_set_id := COALESCE(NEW.curated_measurement_set_id, OLD.curated_measurement_set_id);
  ELSE
    v_set_id := COALESCE(NEW.id, OLD.id);
  END IF;

  SELECT s.catalogue_status, s.latest_bundle_revision
    INTO v_status, v_latest
    FROM private.curated_reference_measurement_sets s
   WHERE s.id = v_set_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*), max(p.bundle_revision)
    INTO v_publication_count, v_max_bundle
    FROM private.curated_reference_publications p
   WHERE p.curated_measurement_set_id = v_set_id;

  IF (v_status = 'draft' AND v_publication_count <> 0)
     OR (v_status <> 'draft'
         AND (v_publication_count = 0 OR v_latest IS DISTINCT FROM v_max_bundle)) THEN
    RAISE EXCEPTION 'curated publication history and catalogue lifecycle disagree for %', v_set_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION private.curated_require_next_bundle_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_previous_revision integer;
  v_measurement_set_revision integer;
  v_treatment_id uuid;
  v_treatment_revision integer;
  v_work_id uuid;
  v_work_revision integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('private.curated_reference_supersession', 0)
  );
  SELECT s.revision, t.id, t.revision, w.id, w.revision
    INTO v_measurement_set_revision, v_treatment_id, v_treatment_revision,
         v_work_id, v_work_revision
    FROM private.curated_reference_measurement_sets s
    JOIN private.curated_reference_taxon_treatments t ON t.id = s.taxon_treatment_id
    JOIN private.curated_reference_works w ON w.id = t.reference_work_id
   WHERE s.id = NEW.curated_measurement_set_id
   FOR UPDATE OF s, t, w;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown curated measurement set: %', NEW.curated_measurement_set_id
      USING ERRCODE = '23503';
  END IF;

  SELECT COALESCE(max(p.bundle_revision), 0)
    INTO v_previous_revision
    FROM private.curated_reference_publications p
   WHERE p.curated_measurement_set_id = NEW.curated_measurement_set_id;
  IF NEW.bundle_revision <> v_previous_revision + 1 THEN
    RAISE EXCEPTION 'curated publication bundle revision must advance exactly once'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.curated_taxon_treatment_id IS DISTINCT FROM v_treatment_id
     OR NEW.curated_work_id IS DISTINCT FROM v_work_id
     OR NEW.measurement_set_revision IS DISTINCT FROM v_measurement_set_revision
     OR NEW.treatment_revision IS DISTINCT FROM v_treatment_revision
     OR NEW.work_revision IS DISTINCT FROM v_work_revision THEN
    RAISE EXCEPTION 'curated publication must bind the current exact graph revisions'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM private.curated_reference_treatment_taxa tt
    JOIN taxonomy_v3.registry_concept c
      ON c.sporely_taxon_id = tt.sporely_taxon_id
   WHERE tt.taxon_treatment_id = v_treatment_id
   FOR SHARE OF tt, c;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.curated_guard_publication_taxon_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_latest integer;
  v_max_bundle integer;
BEGIN
  SELECT s.latest_bundle_revision
    INTO v_latest
    FROM private.curated_reference_measurement_sets s
   WHERE s.id = NEW.curated_measurement_set_id;
  SELECT max(p.bundle_revision)
    INTO v_max_bundle
    FROM private.curated_reference_publications p
   WHERE p.curated_measurement_set_id = NEW.curated_measurement_set_id;
  IF NEW.bundle_revision IS DISTINCT FROM v_max_bundle
     OR v_latest IS NOT DISTINCT FROM NEW.bundle_revision THEN
    RAISE EXCEPTION 'published taxon assignments are sealed with their publication bundle'
      USING ERRCODE = '25006';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.curated_check_publication_taxa()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_set_id uuid;
  v_bundle_revision integer;
  v_treatment_id uuid;
BEGIN
  v_set_id := COALESCE(NEW.curated_measurement_set_id, OLD.curated_measurement_set_id);
  v_bundle_revision := COALESCE(NEW.bundle_revision, OLD.bundle_revision);
  SELECT p.curated_taxon_treatment_id
    INTO v_treatment_id
    FROM private.curated_reference_publications p
   WHERE p.curated_measurement_set_id = v_set_id
     AND p.bundle_revision = v_bundle_revision;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM private.curated_reference_publication_taxa pt
        WHERE pt.curated_measurement_set_id = v_set_id
          AND pt.bundle_revision = v_bundle_revision
     )
     OR EXISTS (
       SELECT tt.sporely_taxon_id
         FROM private.curated_reference_treatment_taxa tt
        WHERE tt.taxon_treatment_id = v_treatment_id
       EXCEPT
       SELECT pt.sporely_taxon_id
         FROM private.curated_reference_publication_taxa pt
        WHERE pt.curated_measurement_set_id = v_set_id
          AND pt.bundle_revision = v_bundle_revision
     )
     OR EXISTS (
       SELECT pt.sporely_taxon_id
         FROM private.curated_reference_publication_taxa pt
        WHERE pt.curated_measurement_set_id = v_set_id
          AND pt.bundle_revision = v_bundle_revision
       EXCEPT
       SELECT tt.sporely_taxon_id
         FROM private.curated_reference_treatment_taxa tt
        WHERE tt.taxon_treatment_id = v_treatment_id
     ) THEN
    RAISE EXCEPTION 'publication taxon assignments must exactly snapshot the treatment assignments'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION private.curated_reject_all_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'curated history is append-only'
    USING ERRCODE = '25006';
END
$$;

CREATE FUNCTION private.curated_guard_publication_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.published_by IS NOT NULL
     AND NEW.published_by IS NULL
     AND to_jsonb(NEW) - 'published_by' = to_jsonb(OLD) - 'published_by' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'curated publications are append-only'
    USING ERRCODE = '25006';
END
$$;

CREATE FUNCTION private.curated_guard_event_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.actor_user_id IS NOT NULL
     AND NEW.actor_user_id IS NULL
     AND to_jsonb(NEW) - 'actor_user_id' = to_jsonb(OLD) - 'actor_user_id' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'curation events are append-only'
    USING ERRCODE = '25006';
END
$$;

CREATE FUNCTION private.curated_require_unbanned_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND p.is_banned) THEN
    RAISE EXCEPTION 'a banned account cannot hold a curator role'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.granted_by IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.granted_by AND p.is_banned) THEN
    RAISE EXCEPTION 'a banned account cannot grant a curator role'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER curated_reference_works_cas_trg
  BEFORE UPDATE ON private.curated_reference_works
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_cas_increment();
CREATE TRIGGER curated_reference_works_citation_key_trg
  BEFORE UPDATE OF citation_key ON private.curated_reference_works
  FOR EACH ROW EXECUTE FUNCTION private.curated_guard_work_citation_key();
CREATE TRIGGER curated_reference_taxon_treatments_cas_trg
  BEFORE UPDATE ON private.curated_reference_taxon_treatments
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_cas_increment();
CREATE TRIGGER curated_reference_measurement_sets_cas_trg
  BEFORE UPDATE ON private.curated_reference_measurement_sets
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_cas_increment();
CREATE TRIGGER curated_reference_measurement_sets_lifecycle_trg
  BEFORE INSERT OR UPDATE OF catalogue_status ON private.curated_reference_measurement_sets
  FOR EACH ROW EXECUTE FUNCTION private.curated_guard_catalogue_lifecycle();
CREATE TRIGGER curated_reference_measurement_sets_supersession_trg
  BEFORE INSERT OR UPDATE OF supersedes_id, taxon_treatment_id ON private.curated_reference_measurement_sets
  FOR EACH ROW EXECUTE FUNCTION private.curated_guard_supersession();
CREATE CONSTRAINT TRIGGER curated_reference_measurement_sets_supersession_taxa_trg
  AFTER INSERT OR UPDATE OR DELETE ON private.curated_reference_measurement_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.curated_check_supersession_taxa();
CREATE TRIGGER curated_reference_treatment_taxa_cas_trg
  BEFORE UPDATE ON private.curated_reference_treatment_taxa
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_cas_increment();
CREATE TRIGGER curated_reference_treatment_taxa_supersession_lock_trg
  BEFORE INSERT OR UPDATE OR DELETE ON private.curated_reference_treatment_taxa
  FOR EACH ROW EXECUTE FUNCTION private.curated_lock_supersession_graph();
CREATE TRIGGER curated_reference_treatment_taxa_species_trg
  BEFORE INSERT OR UPDATE OF sporely_taxon_id ON private.curated_reference_treatment_taxa
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_species_taxon();
CREATE CONSTRAINT TRIGGER curated_reference_treatment_taxa_supersession_trg
  AFTER INSERT OR UPDATE OR DELETE ON private.curated_reference_treatment_taxa
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.curated_check_supersession_taxa();
CREATE TRIGGER curated_reference_publications_revision_trg
  BEFORE INSERT ON private.curated_reference_publications
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_next_bundle_revision();
CREATE TRIGGER curated_reference_publications_immutable_trg
  BEFORE UPDATE OR DELETE ON private.curated_reference_publications
  FOR EACH ROW EXECUTE FUNCTION private.curated_guard_publication_change();
CREATE CONSTRAINT TRIGGER curated_reference_publications_lifecycle_trg
  AFTER INSERT OR UPDATE OR DELETE ON private.curated_reference_publications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.curated_check_publication_lifecycle();
CREATE CONSTRAINT TRIGGER curated_reference_measurement_sets_publication_lifecycle_trg
  AFTER INSERT OR UPDATE OR DELETE ON private.curated_reference_measurement_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.curated_check_publication_lifecycle();
CREATE TRIGGER curated_reference_publication_taxa_species_trg
  BEFORE INSERT OR UPDATE OF sporely_taxon_id ON private.curated_reference_publication_taxa
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_species_taxon();
CREATE TRIGGER curated_reference_publication_taxa_insert_trg
  BEFORE INSERT ON private.curated_reference_publication_taxa
  FOR EACH ROW EXECUTE FUNCTION private.curated_guard_publication_taxon_insert();
CREATE TRIGGER curated_reference_publication_taxa_immutable_trg
  BEFORE UPDATE OR DELETE ON private.curated_reference_publication_taxa
  FOR EACH ROW EXECUTE FUNCTION private.curated_reject_all_changes();
CREATE CONSTRAINT TRIGGER curated_reference_publications_taxa_trg
  AFTER INSERT OR UPDATE OR DELETE ON private.curated_reference_publications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.curated_check_publication_taxa();
CREATE CONSTRAINT TRIGGER curated_reference_publication_taxa_complete_trg
  AFTER INSERT OR UPDATE OR DELETE ON private.curated_reference_publication_taxa
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.curated_check_publication_taxa();
CREATE TRIGGER reference_curator_memberships_cas_trg
  BEFORE UPDATE ON private.reference_curator_memberships
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_membership_cas_increment();
CREATE TRIGGER reference_curator_memberships_unbanned_trg
  BEFORE INSERT OR UPDATE OF user_id, granted_by ON private.reference_curator_memberships
  FOR EACH ROW EXECUTE FUNCTION private.curated_require_unbanned_membership();
CREATE TRIGGER reference_curation_events_immutable_trg
  BEFORE UPDATE OR DELETE ON private.reference_curation_events
  FOR EACH ROW EXECUTE FUNCTION private.curated_guard_event_change();

ALTER TABLE private.curated_reference_works ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.curated_reference_taxon_treatments ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.curated_reference_measurement_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.curated_reference_treatment_taxa ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.curated_reference_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.curated_reference_publication_taxa ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.reference_curator_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.reference_curation_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON private.curated_reference_works FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.curated_reference_taxon_treatments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.curated_reference_measurement_sets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.curated_reference_treatment_taxa FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.curated_reference_publications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.curated_reference_publication_taxa FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.reference_curator_memberships FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.reference_curation_events FROM PUBLIC, anon, authenticated;

GRANT ALL ON private.curated_reference_works TO service_role;
GRANT ALL ON private.curated_reference_taxon_treatments TO service_role;
GRANT ALL ON private.curated_reference_measurement_sets TO service_role;
GRANT ALL ON private.curated_reference_treatment_taxa TO service_role;
GRANT SELECT, INSERT ON private.curated_reference_publications TO service_role;
GRANT SELECT, INSERT ON private.curated_reference_publication_taxa TO service_role;
GRANT ALL ON private.reference_curator_memberships TO service_role;
GRANT SELECT, INSERT ON private.reference_curation_events TO service_role;

REVOKE ALL ON FUNCTION private.curated_require_cas_increment() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_require_membership_cas_increment() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_guard_catalogue_lifecycle() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_require_species_taxon() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_guard_supersession() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_check_supersession_taxa() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_lock_supersession_graph() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_guard_work_citation_key() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_check_publication_lifecycle() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_require_next_bundle_revision() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_guard_publication_taxon_insert() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_check_publication_taxa() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_reject_all_changes() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_guard_publication_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_guard_event_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.curated_require_unbanned_membership() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
