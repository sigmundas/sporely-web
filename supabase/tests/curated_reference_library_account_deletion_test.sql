-- Account deletion removes authority and attribution, never curated evidence.

BEGIN;

DO $$
DECLARE
  actor_id constant uuid := '00000000-0000-4000-8000-000000006a03';
  member_id constant uuid := '00000000-0000-4000-8000-000000006a04';
  taxon_id constant integer := 2100000020;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (actor_id, 'authenticated', 'authenticated', 'stage6a-delete@example.invalid', '{}'::jsonb, now(), now()),
    (member_id, 'authenticated', 'authenticated', 'stage6a-member@example.invalid', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, username)
  VALUES (actor_id, 'stage6a_delete'), (member_id, 'stage6a_member')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO taxonomy_v3.registry_concept
    (sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release)
  VALUES (taxon_id, 'Deletion species', 'species', 'include', 'in_cache', 'stage6a-test')
  ON CONFLICT (sporely_taxon_id) DO NOTHING;

  INSERT INTO private.reference_curator_memberships
    (user_id, role, granted_by, reason)
  VALUES
    (actor_id, 'reference_publisher', actor_id, 'Account deletion test'),
    (member_id, 'reference_reviewer', actor_id, 'Grantor deletion test');
  INSERT INTO private.curated_reference_works
    (id, type, title, short_label, revision, created_by, updated_by)
  VALUES ('61000000-0000-4000-8000-000000000301', 'book', 'Retained work', 'Retained', 1,
    actor_id, actor_id);
  INSERT INTO private.curated_reference_taxon_treatments
    (id, reference_work_id, name_as_published, revision, created_by, updated_by)
  VALUES ('62000000-0000-4000-8000-000000000301',
    '61000000-0000-4000-8000-000000000301', 'Deletion species', 1, actor_id, actor_id);
  INSERT INTO private.curated_reference_measurement_sets
    (id, taxon_treatment_id, character, data_kind, revision, created_by, updated_by)
  VALUES ('63000000-0000-4000-8000-000000000301',
    '62000000-0000-4000-8000-000000000301', 'spore_size', 'range', 1, actor_id, actor_id);
  INSERT INTO private.curated_reference_publications (
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash, published_by
  ) VALUES (
    '63000000-0000-4000-8000-000000000301', 1,
    '62000000-0000-4000-8000-000000000301',
    '61000000-0000-4000-8000-000000000301', 1, 1, 1,
    1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1}'::jsonb,
    repeat('b', 64), actor_id
  );
  INSERT INTO private.curated_reference_publication_taxa
    (curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name)
  VALUES ('63000000-0000-4000-8000-000000000301', 1, taxon_id, 'Deletion species');
  INSERT INTO private.reference_curation_events
    (id, actor_user_id, action, target_type, target_id, bundle_revision,
     outcome, reason, after_content_hash)
  VALUES ('65000000-0000-4000-8000-000000000301', actor_id, 'publish',
    'publication', '63000000-0000-4000-8000-000000000301', 1,
    'succeeded', 'Account deletion test', repeat('b', 64));

  DELETE FROM public.profiles WHERE id = actor_id;

  IF EXISTS (SELECT 1 FROM private.reference_curator_memberships WHERE user_id = actor_id) THEN
    RAISE EXCEPTION 'membership survived profile deletion';
  END IF;
  IF (SELECT granted_by FROM private.reference_curator_memberships WHERE user_id = member_id) IS NOT NULL THEN
    RAISE EXCEPTION 'surviving membership retained a deleted grantor';
  END IF;
  IF (SELECT actor_user_id FROM private.reference_curation_events
      WHERE id = '65000000-0000-4000-8000-000000000301') IS NOT NULL THEN
    RAISE EXCEPTION 'event actor was not anonymized';
  END IF;
  IF (SELECT published_by FROM private.curated_reference_publications
      WHERE curated_measurement_set_id = '63000000-0000-4000-8000-000000000301'
        AND bundle_revision = 1) IS NOT NULL THEN
    RAISE EXCEPTION 'publication actor was not anonymized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.curated_reference_works
                 WHERE id = '61000000-0000-4000-8000-000000000301')
     OR NOT EXISTS (SELECT 1 FROM private.curated_reference_publications
                    WHERE curated_measurement_set_id = '63000000-0000-4000-8000-000000000301'
                      AND bundle_revision = 1) THEN
    RAISE EXCEPTION 'curated evidence was deleted with the account';
  END IF;

  DELETE FROM auth.users WHERE id = actor_id;
  IF NOT EXISTS (SELECT 1 FROM private.curated_reference_publications
                 WHERE curated_measurement_set_id = '63000000-0000-4000-8000-000000000301'
                   AND bundle_revision = 1) THEN
    RAISE EXCEPTION 'curated evidence was deleted with the auth account';
  END IF;
END
$$;

ROLLBACK;
