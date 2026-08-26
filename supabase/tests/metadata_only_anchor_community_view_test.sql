-- Regression coverage for metadata-only image filtering in
-- observation_images_community_view.
--
-- The view must retain normal byte-backed image rows while excluding both
-- NULL-path metadata anchors and whitespace-only paths.

BEGIN;

DO $$
DECLARE
  owner_id       uuid := '00000000-0000-4000-8000-00000000df01';
  observation_id bigint;
  normal_image_id bigint;
  null_anchor_id  bigint;
  blank_anchor_id bigint;
  visible_count   bigint;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    owner_id,
    'authenticated',
    'authenticated',
    'metadata-anchor-view-owner@example.test',
    '{}'::jsonb,
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES (owner_id, 'metadata_anchor_view_owner', 'Metadata Anchor View Owner', false)
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    is_banned = false;

  INSERT INTO public.observations (user_id, date, visibility, is_draft)
  VALUES (owner_id, current_date, 'public', false)
  RETURNING id INTO observation_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, sort_order
  )
  VALUES (
    observation_id, owner_id, owner_id::text || '/normal-image.webp', 'field', 0
  )
  RETURNING id INTO normal_image_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, sort_order
  )
  VALUES (observation_id, owner_id, NULL, 'microscope', 1)
  RETURNING id INTO null_anchor_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, sort_order
  )
  VALUES (observation_id, owner_id, '   ', 'microscope', 2)
  RETURNING id INTO blank_anchor_id;

  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT count(*) INTO visible_count
  FROM public.observation_images_community_view
  WHERE id = normal_image_id;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'normal byte-backed image should be visible, got % rows', visible_count;
  END IF;

  SELECT count(*) INTO visible_count
  FROM public.observation_images_community_view
  WHERE id IN (null_anchor_id, blank_anchor_id);
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'metadata-only or blank-path anchors leaked into community view: % rows', visible_count;
  END IF;

  RESET ROLE;
  RAISE NOTICE 'metadata_only_anchor_community_view_test passed';
END
$$;

ROLLBACK;
