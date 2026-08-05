-- Stage 2a — media_authorize_delivery matrix test.
--
-- Verifies the invariants established by
-- `20260805120000_media_authorization.sql`:
--
--   1. `media_authorize_delivery` returns the correct decision for every
--      combination of caller × observation state × image state.
--   2. The RPC is NOT callable by anon or ordinary authenticated users; only
--      `service_role` holds EXECUTE.
--   3. The version-bump triggers fire on the observation/image/profile
--      state transitions that would deny access.
--   4. The `build_worker_media_url` helper emits the expected URL shape.
--
-- Run locally:
--   supabase db reset --local
--   docker cp supabase/tests/media_authorization_test.sql \
--     supabase_db_<slug>:/tmp/t.sql
--   docker exec supabase_db_<slug> psql -U postgres -d postgres -f /tmp/t.sql

DO $$
DECLARE
  owner_id    uuid := '00000000-0000-4000-8000-00000000cc01';
  stranger_id uuid := '00000000-0000-4000-8000-00000000cc02';
  friend_id   uuid := '00000000-0000-4000-8000-00000000cc03';

  obs_public       bigint;
  obs_friends      bigint;
  obs_private      bigint;
  obs_draft        bigint;
  obs_public_ban   bigint;  -- owned by soon-to-be-banned user

  img_public       bigint;
  img_friends      bigint;
  img_private      bigint;
  img_draft        bigint;
  img_tombstoned   bigint;
  img_purged       bigint;
  img_metadata     bigint;  -- storage_path NULL
  img_public_banow bigint;  -- on obs_public_ban

  bad_user   uuid := '00000000-0000-4000-8000-00000000cc09';

  decision   record;
  v1         bigint;
  v2         bigint;
  fail_msgs  text[] := ARRAY[]::text[];

  probe_allowed  boolean;
BEGIN
  ------------------------------------------------------------------
  -- Fixture setup (runs as postgres — bypasses RLS on inserts).
  ------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,    'authenticated', 'authenticated', 'ma-owner@example.test',    '{}'::jsonb, now(), now()),
    (stranger_id, 'authenticated', 'authenticated', 'ma-stranger@example.test', '{}'::jsonb, now(), now()),
    (friend_id,   'authenticated', 'authenticated', 'ma-friend@example.test',   '{}'::jsonb, now(), now()),
    (bad_user,    'authenticated', 'authenticated', 'ma-bad@example.test',      '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_pro)
  VALUES
    (owner_id,    'ma_owner',    'MA Owner',    true),
    (stranger_id, 'ma_stranger', 'MA Stranger', true),
    (friend_id,   'ma_friend',   'MA Friend',   true),
    (bad_user,    'ma_bad',      'MA Bad',      true)
  ON CONFLICT (id) DO UPDATE SET is_pro = true, is_banned = false;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (owner_id, friend_id, 'accepted')
  ON CONFLICT DO NOTHING;

  -- Observations: full precision × visibility × draft × ban matrix.
  INSERT INTO public.observations
    (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-08-05', 'public',  false, 'exact', 'public')
  RETURNING id INTO obs_public;

  INSERT INTO public.observations
    (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-08-05', 'friends', false, 'exact', 'friends')
  RETURNING id INTO obs_friends;

  INSERT INTO public.observations
    (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-08-05', 'private', false, 'exact', 'private')
  RETURNING id INTO obs_private;

  INSERT INTO public.observations
    (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-08-05', 'public',  true,  'exact', 'public')
  RETURNING id INTO obs_draft;

  INSERT INTO public.observations
    (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (bad_user, '2026-08-05', 'public',  false, 'exact', 'public')
  RETURNING id INTO obs_public_ban;

  -- Images.
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, sort_order)
  VALUES (obs_public,  owner_id, owner_id::text || '/public.webp',  0)
  RETURNING id INTO img_public;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, sort_order)
  VALUES (obs_friends, owner_id, owner_id::text || '/friends.webp', 0)
  RETURNING id INTO img_friends;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, sort_order)
  VALUES (obs_private, owner_id, owner_id::text || '/private.webp', 0)
  RETURNING id INTO img_private;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, sort_order)
  VALUES (obs_draft,   owner_id, owner_id::text || '/draft.webp',   0)
  RETURNING id INTO img_draft;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, sort_order, deleted_at)
  VALUES (obs_public,  owner_id, owner_id::text || '/tomb.webp',    1, now())
  RETURNING id INTO img_tombstoned;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, sort_order, deleted_at, purged_at)
  VALUES (obs_public,  owner_id, owner_id::text || '/purged.webp',  2, now(), now())
  RETURNING id INTO img_purged;

  -- Metadata-only microscope row: storage_path IS NULL.
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_public,  owner_id, NULL, 'microscope')
  RETURNING id INTO img_metadata;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, sort_order)
  VALUES (obs_public_ban, bad_user, bad_user::text || '/banowned.webp', 0)
  RETURNING id INTO img_public_banow;

  ------------------------------------------------------------------
  -- Section A: privilege guards — the RPC is service_role-only.
  ------------------------------------------------------------------
  IF has_function_privilege(
       'anon',
       'public.media_authorize_delivery(bigint, text, uuid)',
       'EXECUTE') THEN
    fail_msgs := array_append(fail_msgs,
      'A: anon still holds EXECUTE on media_authorize_delivery');
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public.media_authorize_delivery(bigint, text, uuid)',
       'EXECUTE') THEN
    fail_msgs := array_append(fail_msgs,
      'A: authenticated still holds EXECUTE on media_authorize_delivery');
  END IF;
  IF NOT has_function_privilege(
       'service_role',
       'public.media_authorize_delivery(bigint, text, uuid)',
       'EXECUTE') THEN
    fail_msgs := array_append(fail_msgs,
      'A: service_role lacks EXECUTE on media_authorize_delivery (regression)');
  END IF;

  -- Runtime confirmation: attempting to call as anon must raise
  -- insufficient_privilege.
  DECLARE
    anon_call_succeeded boolean := false;
  BEGIN
    BEGIN
      SET LOCAL ROLE anon;
      PERFORM * FROM public.media_authorize_delivery(img_public, 'thumb', NULL);
      anon_call_succeeded := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    IF anon_call_succeeded THEN
      fail_msgs := array_append(fail_msgs,
        'A: anon successfully invoked media_authorize_delivery (privilege leak)');
    END IF;
  END;

  ------------------------------------------------------------------
  -- Section B: authorization matrix (called as service_role).
  ------------------------------------------------------------------
  SET LOCAL ROLE service_role;

  -- B1: public image, various callers.
  SELECT * INTO decision FROM public.media_authorize_delivery(img_public, 'thumb', NULL);
  IF NOT decision.allowed OR decision.cache_class <> 'public' OR decision.storage_path IS NULL THEN
    fail_msgs := array_append(fail_msgs,
      format('B1/anon: expected allowed+public, got allowed=%s cache_class=%s reason=%s',
             decision.allowed, decision.cache_class, decision.reason));
  END IF;

  SELECT * INTO decision FROM public.media_authorize_delivery(img_public, 'thumb', stranger_id);
  IF NOT decision.allowed OR decision.cache_class <> 'public' THEN
    fail_msgs := array_append(fail_msgs,
      format('B1/stranger: expected allowed+public, got allowed=%s cache_class=%s',
             decision.allowed, decision.cache_class));
  END IF;

  SELECT * INTO decision FROM public.media_authorize_delivery(img_public, 'thumb', friend_id);
  IF NOT decision.allowed OR decision.cache_class <> 'public' THEN
    fail_msgs := array_append(fail_msgs,
      'B1/friend on public: expected allowed+public');
  END IF;

  SELECT * INTO decision FROM public.media_authorize_delivery(img_public, 'thumb', owner_id);
  IF NOT decision.allowed OR decision.cache_class <> 'private-short' OR decision.reason <> 'owner' THEN
    fail_msgs := array_append(fail_msgs,
      format('B1/owner: expected private-short+owner, got %s/%s/%s',
             decision.allowed, decision.cache_class, decision.reason));
  END IF;

  -- B2: friends-visibility image.
  SELECT * INTO decision FROM public.media_authorize_delivery(img_friends, 'thumb', NULL);
  IF decision.allowed OR decision.cache_class <> 'deny' THEN
    fail_msgs := array_append(fail_msgs,
      'B2/anon on friends: expected denied');
  END IF;
  SELECT * INTO decision FROM public.media_authorize_delivery(img_friends, 'thumb', stranger_id);
  IF decision.allowed OR decision.cache_class <> 'deny' THEN
    fail_msgs := array_append(fail_msgs,
      'B2/stranger on friends: expected denied');
  END IF;
  SELECT * INTO decision FROM public.media_authorize_delivery(img_friends, 'thumb', friend_id);
  IF NOT decision.allowed OR decision.cache_class <> 'private-short' OR decision.reason <> 'friend' THEN
    fail_msgs := array_append(fail_msgs,
      format('B2/friend on friends: expected allowed/private-short/friend, got %s/%s/%s',
             decision.allowed, decision.cache_class, decision.reason));
  END IF;
  SELECT * INTO decision FROM public.media_authorize_delivery(img_friends, 'thumb', owner_id);
  IF NOT decision.allowed OR decision.reason <> 'owner' THEN
    fail_msgs := array_append(fail_msgs, 'B2/owner on friends: expected allowed/owner');
  END IF;

  -- B3: private image — owner only.
  FOR decision IN
    SELECT * FROM (VALUES (NULL::uuid), (stranger_id), (friend_id)) AS c(caller_uid),
    LATERAL (SELECT * FROM public.media_authorize_delivery(img_private, 'thumb', c.caller_uid)) x
  LOOP
    IF decision.allowed THEN
      fail_msgs := array_append(fail_msgs,
        format('B3/non-owner on private: leaked (reason=%s)', decision.reason));
    END IF;
  END LOOP;
  SELECT * INTO decision FROM public.media_authorize_delivery(img_private, 'thumb', owner_id);
  IF NOT decision.allowed OR decision.reason <> 'owner' THEN
    fail_msgs := array_append(fail_msgs, 'B3/owner on private: expected allowed');
  END IF;

  -- B4: draft image — owner only.
  FOR decision IN
    SELECT * FROM (VALUES (NULL::uuid), (stranger_id), (friend_id)) AS c(caller_uid),
    LATERAL (SELECT * FROM public.media_authorize_delivery(img_draft, 'thumb', c.caller_uid)) x
  LOOP
    IF decision.allowed THEN
      fail_msgs := array_append(fail_msgs,
        format('B4/non-owner on draft: leaked (reason=%s)', decision.reason));
    END IF;
  END LOOP;
  SELECT * INTO decision FROM public.media_authorize_delivery(img_draft, 'thumb', owner_id);
  IF NOT decision.allowed OR decision.reason <> 'owner' THEN
    fail_msgs := array_append(fail_msgs, 'B4/owner on draft: expected allowed');
  END IF;

  -- B5: tombstoned image — denied to EVERYONE including owner.
  FOR decision IN
    SELECT * FROM (VALUES (NULL::uuid), (stranger_id), (friend_id), (owner_id)) AS c(caller_uid),
    LATERAL (SELECT * FROM public.media_authorize_delivery(img_tombstoned, 'thumb', c.caller_uid)) x
  LOOP
    IF decision.allowed OR decision.reason <> 'deleted' THEN
      fail_msgs := array_append(fail_msgs,
        format('B5/tombstoned: expected denied+deleted, got %s/%s',
               decision.allowed, decision.reason));
    END IF;
  END LOOP;

  -- B6: purged image — denied to EVERYONE.
  FOR decision IN
    SELECT * FROM (VALUES (NULL::uuid), (owner_id)) AS c(caller_uid),
    LATERAL (SELECT * FROM public.media_authorize_delivery(img_purged, 'thumb', c.caller_uid)) x
  LOOP
    IF decision.allowed OR decision.reason NOT IN ('purged', 'deleted') THEN
      fail_msgs := array_append(fail_msgs,
        format('B6/purged: expected denied, got %s/%s',
               decision.allowed, decision.reason));
    END IF;
  END LOOP;

  -- B7: metadata-only row (storage_path NULL) — denied.
  FOR decision IN
    SELECT * FROM (VALUES (NULL::uuid), (owner_id)) AS c(caller_uid),
    LATERAL (SELECT * FROM public.media_authorize_delivery(img_metadata, 'thumb', c.caller_uid)) x
  LOOP
    IF decision.allowed OR decision.reason <> 'metadata_only' THEN
      fail_msgs := array_append(fail_msgs,
        format('B7/metadata-only: expected denied+metadata_only, got %s/%s',
               decision.allowed, decision.reason));
    END IF;
  END LOOP;

  -- B8: nonexistent image_id — denied+not_found.
  SELECT * INTO decision FROM public.media_authorize_delivery(999999999, 'thumb', NULL);
  IF decision.allowed OR decision.reason <> 'not_found' THEN
    fail_msgs := array_append(fail_msgs,
      format('B8/nonexistent: expected denied+not_found, got %s/%s',
             decision.allowed, decision.reason));
  END IF;

  -- B9: banned owner — public image becomes deny to non-owner.
  UPDATE public.profiles SET is_banned = true WHERE id = bad_user;
  SELECT * INTO decision FROM public.media_authorize_delivery(img_public_banow, 'thumb', NULL);
  IF decision.allowed OR decision.reason <> 'owner_banned' THEN
    fail_msgs := array_append(fail_msgs,
      format('B9/banned-owner: expected denied+owner_banned, got %s/%s',
             decision.allowed, decision.reason));
  END IF;

  -- B10: blocked relationship — public image denied to blocker.
  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (stranger_id, owner_id)
  ON CONFLICT DO NOTHING;
  SELECT * INTO decision FROM public.media_authorize_delivery(img_public, 'thumb', stranger_id);
  IF decision.allowed OR decision.reason <> 'blocked' THEN
    fail_msgs := array_append(fail_msgs,
      format('B10/blocked: expected denied+blocked, got %s/%s',
             decision.allowed, decision.reason));
  END IF;
  DELETE FROM public.user_blocks WHERE blocker_id = stranger_id AND blocked_id = owner_id;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section C: version-bump triggers on state changes that revoke.
  ------------------------------------------------------------------
  -- Snapshot version before the state change.
  SELECT media_version INTO v1 FROM public.observation_images WHERE id = img_public;

  -- Flip observation to private → image's version must bump.
  UPDATE public.observations SET visibility = 'private' WHERE id = obs_public;
  SELECT media_version INTO v2 FROM public.observation_images WHERE id = img_public;
  IF v2 <= v1 THEN
    fail_msgs := array_append(fail_msgs,
      format('C/visibility-flip: media_version did not bump (was %s, now %s)', v1, v2));
  END IF;

  -- Restore visibility for subsequent checks.
  UPDATE public.observations SET visibility = 'public' WHERE id = obs_public;

  -- Tombstoning an image bumps its version.
  SELECT media_version INTO v1 FROM public.observation_images WHERE id = img_friends;
  UPDATE public.observation_images SET deleted_at = now() WHERE id = img_friends;
  SELECT media_version INTO v2 FROM public.observation_images WHERE id = img_friends;
  IF v2 <= v1 THEN
    fail_msgs := array_append(fail_msgs,
      format('C/tombstone: media_version did not bump (was %s, now %s)', v1, v2));
  END IF;
  UPDATE public.observation_images SET deleted_at = NULL WHERE id = img_friends;

  -- Banning an owner bumps every one of their images.
  SELECT media_version INTO v1 FROM public.observation_images WHERE id = img_public;
  UPDATE public.profiles SET is_banned = false WHERE id = owner_id;  -- ensure fresh state
  UPDATE public.profiles SET is_banned = true  WHERE id = owner_id;
  SELECT media_version INTO v2 FROM public.observation_images WHERE id = img_public;
  IF v2 <= v1 THEN
    fail_msgs := array_append(fail_msgs,
      format('C/owner-ban: media_version did not bump (was %s, now %s)', v1, v2));
  END IF;
  UPDATE public.profiles SET is_banned = false WHERE id = owner_id;

  ------------------------------------------------------------------
  -- Section D: build_worker_media_url shape.
  ------------------------------------------------------------------
  DECLARE
    u1 text;
    u2 text;
  BEGIN
    u1 := public.build_worker_media_url(42, 'thumb', 7);
    u2 := public.build_worker_media_url(NULL, 'thumb', 7);
    IF u1 IS NULL OR u1 NOT LIKE 'https://%/m/42/thumb?v=7' THEN
      fail_msgs := array_append(fail_msgs,
        format('D: build_worker_media_url(42,thumb,7) unexpected: %L', u1));
    END IF;
    IF u2 IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('D: build_worker_media_url(NULL,…) should yield NULL, got %L', u2));
    END IF;
  END;

  -- Ensure build_worker_media_url is EXECUTE-callable by anon and
  -- authenticated (it's a pure formatter — no data lookup).
  IF NOT has_function_privilege(
       'anon',
       'public.build_worker_media_url(bigint, text, bigint)',
       'EXECUTE') THEN
    fail_msgs := array_append(fail_msgs,
      'D: anon lacks EXECUTE on build_worker_media_url');
  END IF;
  IF NOT has_function_privilege(
       'authenticated',
       'public.build_worker_media_url(bigint, text, bigint)',
       'EXECUTE') THEN
    fail_msgs := array_append(fail_msgs,
      'D: authenticated lacks EXECUTE on build_worker_media_url');
  END IF;

  ------------------------------------------------------------------
  -- Section E: server-owned field guard (20260805130000).
  ------------------------------------------------------------------
  -- E1: authenticated owner cannot modify canonical_bucket via UPDATE.
  DECLARE
    guard_bypassed boolean := false;
  BEGIN
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      UPDATE public.observation_images SET canonical_bucket = 'private' WHERE id = img_public;
      guard_bypassed := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    IF guard_bypassed THEN
      fail_msgs := array_append(fail_msgs,
        'E1: authenticated owner successfully set canonical_bucket (guard bypass)');
    END IF;
  END;

  -- E2: authenticated owner cannot set media_version.
  DECLARE
    guard_bypassed boolean := false;
  BEGIN
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      UPDATE public.observation_images SET media_version = 999 WHERE id = img_public;
      guard_bypassed := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    IF guard_bypassed THEN
      fail_msgs := array_append(fail_msgs,
        'E2: authenticated owner successfully set media_version (guard bypass)');
    END IF;
  END;

  -- E3: authenticated owner CAN still update legitimate user-editable fields
  --     (e.g. sort_order). This proves the guard is field-scoped.
  DECLARE
    legit_ok boolean := false;
  BEGIN
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      UPDATE public.observation_images SET sort_order = 99 WHERE id = img_public;
      legit_ok := FOUND;
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RESET ROLE;
    IF NOT legit_ok THEN
      fail_msgs := array_append(fail_msgs,
        'E3: authenticated owner UPDATE of sort_order failed (guard is over-broad)');
    END IF;
  END;

  -- E4: service_role CAN transition canonical_bucket legacy → private.
  -- Trust-signal note: the guards use `auth.uid() IS NULL` to identify
  -- trusted contexts. When switching to service_role we must therefore
  -- clear any JWT claim set by an earlier authenticated section.
  DECLARE
    trusted_ok boolean := false;
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    UPDATE public.observation_images SET canonical_bucket = 'private' WHERE id = img_public;
    trusted_ok := FOUND;
    UPDATE public.observation_images SET canonical_bucket = 'legacy' WHERE id = img_public;
    RESET ROLE;
    IF NOT trusted_ok THEN
      fail_msgs := array_append(fail_msgs,
        'E4: service_role UPDATE of canonical_bucket failed (regression)');
    END IF;
  END;

  -- E5: trigger-driven cascade still works (visibility change bumps image
  --     media_version even though the guard is in place).
  DECLARE
    v_before bigint;
    v_after  bigint;
  BEGIN
    SELECT media_version INTO v_before FROM public.observation_images WHERE id = img_public;
    UPDATE public.observations SET visibility = 'friends' WHERE id = obs_public;
    SELECT media_version INTO v_after FROM public.observation_images WHERE id = img_public;
    UPDATE public.observations SET visibility = 'public' WHERE id = obs_public;
    IF v_after <= v_before THEN
      fail_msgs := array_append(fail_msgs,
        format('E5: trigger cascade regressed (was %s, now %s)', v_before, v_after));
    END IF;
  END;

  -- E6: authenticated owner cannot seed non-default values on INSERT.
  DECLARE
    seed_bypassed boolean := false;
  BEGIN
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      INSERT INTO public.observation_images
        (observation_id, user_id, storage_path, canonical_bucket)
      VALUES (obs_public, owner_id, owner_id::text||'/seed-test.webp', 'private');
      seed_bypassed := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
             WHEN OTHERS               THEN NULL; END;
    RESET ROLE;
    IF seed_bypassed THEN
      fail_msgs := array_append(fail_msgs,
        'E6: authenticated INSERT seeded canonical_bucket=private (guard bypass)');
      -- Cleanup the accidentally-inserted row so subsequent probes don't drift.
      SET LOCAL ROLE service_role;
      DELETE FROM public.observation_images
        WHERE user_id = owner_id AND storage_path = owner_id::text||'/seed-test.webp';
      RESET ROLE;
    END IF;
  END;

  ------------------------------------------------------------------
  -- Section F: variant allowlist + version validation.
  ------------------------------------------------------------------
  SET LOCAL ROLE service_role;

  -- F1: unsupported variants return deny + reason='unsupported_variant'.
  FOR decision IN
    SELECT * FROM public.media_authorize_delivery(img_public, 'not_a_variant', NULL)
  LOOP
    IF decision.allowed OR decision.reason <> 'unsupported_variant' THEN
      fail_msgs := array_append(fail_msgs,
        format('F1: unsupported variant leaked: allowed=%s reason=%s',
               decision.allowed, decision.reason));
    END IF;
  END LOOP;

  -- F2: build_worker_media_url returns NULL for unsupported variant.
  IF public.build_worker_media_url(42, 'not_a_variant', 7) IS NOT NULL THEN
    fail_msgs := array_append(fail_msgs,
      'F2: build_worker_media_url returned non-NULL for unsupported variant');
  END IF;

  -- F3: build_worker_media_url volatility must be STABLE (not IMMUTABLE)
  --     because it reads a GUC.
  DECLARE
    v_volatility char;
  BEGIN
    SELECT provolatile INTO v_volatility
    FROM pg_proc
    WHERE oid = 'public.build_worker_media_url(bigint, text, bigint)'::regprocedure;
    IF v_volatility <> 's' THEN
      fail_msgs := array_append(fail_msgs,
        format('F3: build_worker_media_url volatility is %s (expected s / STABLE)', v_volatility));
    END IF;
  END;

  -- F4: negative image_id / negative version → NULL URL.
  IF public.build_worker_media_url(0, 'thumb', 7) IS NOT NULL THEN
    fail_msgs := array_append(fail_msgs, 'F4a: URL for image_id=0 not NULL');
  END IF;
  IF public.build_worker_media_url(1, 'thumb', 0) IS NOT NULL THEN
    fail_msgs := array_append(fail_msgs, 'F4b: URL for version=0 not NULL');
  END IF;
  IF public.build_worker_media_url(-1, 'thumb', 1) IS NOT NULL THEN
    fail_msgs := array_append(fail_msgs, 'F4c: URL for negative image_id not NULL');
  END IF;

  -- F5: happy-path URL shape.
  IF public.build_worker_media_url(42, 'thumb', 7) NOT LIKE '%/m/42/thumb?v=7' THEN
    fail_msgs := array_append(fail_msgs,
      format('F5: URL shape wrong: %L', public.build_worker_media_url(42, 'thumb', 7)));
  END IF;

  -- F6: version bump on storage_path change (extended trigger).
  DECLARE
    v_before bigint;
    v_after  bigint;
  BEGIN
    SELECT media_version INTO v_before FROM public.observation_images WHERE id = img_public;
    UPDATE public.observation_images SET storage_path = storage_path || '.v2' WHERE id = img_public;
    SELECT media_version INTO v_after FROM public.observation_images WHERE id = img_public;
    UPDATE public.observation_images SET storage_path = regexp_replace(storage_path, '\.v2$', '') WHERE id = img_public;
    IF v_after <= v_before THEN
      fail_msgs := array_append(fail_msgs,
        format('F6: storage_path change did not bump media_version (was %s, now %s)', v_before, v_after));
    END IF;
  END;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section G: variant-specific authorization matrix
  --   (20260805140000 amendment).
  --
  --   * `original` is owner-only regardless of observation visibility.
  --   * `mosaic` requires BOTH observation-visibility AND
  --     spore_data_visibility permission.
  --   * `full` / `thumb` follow observation-visibility rules.
  ------------------------------------------------------------------
  -- Backfill an original_storage_path so 'original' can be resolved.
  SET LOCAL ROLE service_role;
  UPDATE public.observation_images
     SET original_storage_path = owner_id::text || '/public.orig.webp'
   WHERE id = img_public;
  UPDATE public.observation_images
     SET original_storage_path = owner_id::text || '/friends.orig.webp'
   WHERE id = img_friends;
  UPDATE public.observation_images
     SET original_storage_path = owner_id::text || '/private.orig.webp'
   WHERE id = img_private;
  RESET ROLE;

  SET LOCAL ROLE service_role;

  -- G1: `original` — anon/stranger/friend on PUBLIC row → denied.
  FOR decision IN
    SELECT * FROM (VALUES (NULL::uuid, 'anon'), (stranger_id, 'stranger'), (friend_id, 'friend'))
      AS c(caller_uid, label),
    LATERAL (SELECT * FROM public.media_authorize_delivery(img_public, 'original', c.caller_uid)) x
  LOOP
    IF decision.allowed OR decision.reason <> 'original_owner_only' THEN
      fail_msgs := array_append(fail_msgs,
        format('G1/%s: original on public row not owner-restricted (allowed=%s reason=%s)',
               decision.reason, decision.allowed, decision.reason));
    END IF;
  END LOOP;

  -- G2: `original` — anon/stranger/friend on FRIENDS row → denied.
  FOR decision IN
    SELECT * FROM (VALUES (NULL::uuid), (stranger_id), (friend_id)) AS c(caller_uid),
    LATERAL (SELECT * FROM public.media_authorize_delivery(img_friends, 'original', c.caller_uid)) x
  LOOP
    IF decision.allowed THEN
      fail_msgs := array_append(fail_msgs,
        format('G2: original on friends row leaked (caller=%s reason=%s)',
               c.caller_uid, decision.reason));
    END IF;
  END LOOP;

  -- G3: `original` — owner on any visibility → allowed with 'owner_original'.
  FOR decision IN
    SELECT * FROM (VALUES (img_public), (img_friends), (img_private)) AS c(img_id),
    LATERAL (SELECT * FROM public.media_authorize_delivery(c.img_id, 'original', owner_id)) x
  LOOP
    IF NOT decision.allowed OR decision.reason <> 'owner_original' THEN
      fail_msgs := array_append(fail_msgs,
        format('G3/owner: original denied to owner (img=%s reason=%s)',
               c.img_id, decision.reason));
    END IF;
  END LOOP;

  -- G4: `original` on metadata-only row → denied.
  FOR decision IN
    SELECT * FROM public.media_authorize_delivery(img_metadata, 'original', owner_id)
  LOOP
    IF decision.allowed OR decision.reason NOT IN ('metadata_only','original_owner_only') THEN
      fail_msgs := array_append(fail_msgs,
        format('G4: original on metadata-only row unexpected: allowed=%s reason=%s',
               decision.allowed, decision.reason));
    END IF;
  END LOOP;

  -- G5: `mosaic` is NOT a valid image variant (round-3 amendment).
  --     Any call with p_variant='mosaic' must be denied with
  --     reason='unsupported_variant'. Mosaic authorization moved to
  --     `media_authorize_mosaic_delivery`; see Section K.
  FOR decision IN
    SELECT * FROM public.media_authorize_delivery(img_public, 'mosaic', owner_id)
  LOOP
    IF decision.allowed OR decision.reason <> 'unsupported_variant' THEN
      fail_msgs := array_append(fail_msgs,
        format('G5: mosaic must not be an image variant (allowed=%s reason=%s)',
               decision.allowed, decision.reason));
    END IF;
  END LOOP;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section H: key-aliasing exploit regression.
  --   Attacker owns a public observation + image; tries to alias its
  --   original_storage_path (or storage_path) to a victim's key.
  ------------------------------------------------------------------
  DECLARE
    victim_id   uuid := '00000000-0000-4000-8000-00000000cc06';
    attacker_id uuid := '00000000-0000-4000-8000-00000000cc07';
    attacker_obs bigint;
    attacker_img bigint;
    victim_obs bigint;
    victim_img bigint;
    victim_original_key text;
    attacker_tried_alias boolean := false;
  BEGIN
    INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES
      (victim_id,   'authenticated','authenticated','h-victim@example.test','{}'::jsonb, now(), now()),
      (attacker_id, 'authenticated','authenticated','h-attacker@example.test','{}'::jsonb, now(), now())
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id, username, is_pro)
    VALUES (victim_id, 'h_victim', true), (attacker_id, 'h_attacker', true)
    ON CONFLICT (id) DO UPDATE SET is_pro=true;

    -- Victim: private observation with an original.
    INSERT INTO public.observations
      (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (victim_id, '2026-08-05','private',false,'exact','private')
    RETURNING id INTO victim_obs;
    victim_original_key := victim_id::text || '/victim-secret.orig.webp';
    INSERT INTO public.observation_images
      (observation_id, user_id, storage_path, original_storage_path)
    VALUES (victim_obs, victim_id,
            victim_id::text || '/victim-secret.webp',
            victim_original_key)
    RETURNING id INTO victim_img;

    -- Attacker's own public observation + image (legitimate).
    INSERT INTO public.observations
      (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (attacker_id, '2026-08-05','public',false,'exact','public')
    RETURNING id INTO attacker_obs;
    INSERT INTO public.observation_images
      (observation_id, user_id, storage_path)
    VALUES (attacker_obs, attacker_id, attacker_id::text || '/attacker.webp')
    RETURNING id INTO attacker_img;

    -- H1: attacker (authenticated as attacker_id) attempts UPDATE to
    --     alias original_storage_path to victim's key. Must be rejected.
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', attacker_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', attacker_id::text, true);
      UPDATE public.observation_images
         SET original_storage_path = victim_original_key
       WHERE id = attacker_img;
      attacker_tried_alias := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
             WHEN OTHERS               THEN NULL; END;
    RESET ROLE;
    IF attacker_tried_alias THEN
      fail_msgs := array_append(fail_msgs,
        'H1: attacker aliased original_storage_path to victim key (UPDATE)');
    END IF;

    -- H2: same via INSERT with a new row.
    attacker_tried_alias := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', attacker_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', attacker_id::text, true);
      INSERT INTO public.observation_images
        (observation_id, user_id, storage_path, original_storage_path)
      VALUES (attacker_obs, attacker_id,
              attacker_id::text || '/attacker2.webp',
              victim_original_key);
      attacker_tried_alias := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
             WHEN OTHERS               THEN NULL; END;
    RESET ROLE;
    IF attacker_tried_alias THEN
      fail_msgs := array_append(fail_msgs,
        'H2: attacker aliased original_storage_path via INSERT');
    END IF;

    -- H3: attempt to alias storage_path to victim key.
    attacker_tried_alias := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', attacker_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', attacker_id::text, true);
      UPDATE public.observation_images
         SET storage_path = victim_id::text || '/victim-secret.webp'
       WHERE id = attacker_img;
      attacker_tried_alias := true;
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RESET ROLE;
    IF attacker_tried_alias THEN
      fail_msgs := array_append(fail_msgs,
        'H3: attacker aliased storage_path to victim key');
    END IF;

    -- H4: attempt to repoint the observation_id to victim's observation.
    attacker_tried_alias := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', attacker_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', attacker_id::text, true);
      UPDATE public.observation_images
         SET observation_id = victim_obs
       WHERE id = attacker_img;
      attacker_tried_alias := true;
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RESET ROLE;
    IF attacker_tried_alias THEN
      fail_msgs := array_append(fail_msgs,
        'H4: attacker repointed observation_id to victim observation');
    END IF;

    -- Cleanup H fixtures (auth.users deletion runs as the outer
    -- postgres role, not service_role — service_role cannot delete
    -- from auth.users).
    RESET ROLE;
    DELETE FROM public.observation_images WHERE user_id IN (victim_id, attacker_id);
    DELETE FROM public.observations       WHERE user_id IN (victim_id, attacker_id);
    DELETE FROM public.profiles           WHERE id      IN (victim_id, attacker_id);
    DELETE FROM auth.users                WHERE id      IN (victim_id, attacker_id);
  END;

  ------------------------------------------------------------------
  -- Section I: tightened server-owned-field guard.
  --   * Trusted-role increments/decrements/resets allowed.
  --   * Nested-trigger contexts may ONLY do OLD+1.
  --   * Untrusted direct writes always rejected.
  ------------------------------------------------------------------
  -- Fixture: fresh single image for guard probing.
  DECLARE
    guard_img bigint;
    v0        bigint;
    v1        bigint;
    saw_error boolean;
  BEGIN
    SET LOCAL ROLE service_role;
    INSERT INTO public.observation_images
      (observation_id, user_id, storage_path)
    VALUES (obs_public, owner_id, owner_id::text || '/guard.webp')
    RETURNING id INTO guard_img;
    SELECT media_version INTO v0 FROM public.observation_images WHERE id = guard_img;

    -- I1: authenticated direct decrement → rejected.
    saw_error := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      UPDATE public.observation_images SET media_version = v0 - 1 WHERE id = guard_img;
    EXCEPTION WHEN insufficient_privilege THEN saw_error := true;
             WHEN OTHERS               THEN saw_error := true; END;
    RESET ROLE;
    IF NOT saw_error THEN
      fail_msgs := array_append(fail_msgs, 'I1: authenticated decrement was permitted');
    END IF;

    -- I2: authenticated direct reset (from higher current value) → rejected.
    -- First raise the current version via service_role so `1` is a real reset.
    SET LOCAL ROLE service_role;
    UPDATE public.observation_images SET media_version = 8 WHERE id = guard_img;
    RESET ROLE;
    saw_error := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      UPDATE public.observation_images SET media_version = 1 WHERE id = guard_img;
    EXCEPTION WHEN OTHERS THEN saw_error := true; END;
    RESET ROLE;
    IF NOT saw_error THEN
      fail_msgs := array_append(fail_msgs, 'I2: authenticated reset was permitted');
    END IF;

    -- I3: trusted service_role reset → permitted (constraint enforces ≥ 1).
    SET LOCAL ROLE service_role;
    UPDATE public.observation_images SET media_version = 5 WHERE id = guard_img;
    UPDATE public.observation_images SET media_version = 1 WHERE id = guard_img;
    RESET ROLE;

    -- I4: nested-trigger cascade must still increment by exactly one.
    --     Firing the observation visibility trigger should cascade a
    --     +1 bump to every image on obs_public — no arbitrary jump.
    SET LOCAL ROLE service_role;
    UPDATE public.observation_images SET media_version = 10 WHERE id = guard_img;
    RESET ROLE;
    SELECT media_version INTO v0 FROM public.observation_images WHERE id = guard_img;
    UPDATE public.observations SET visibility = 'friends' WHERE id = obs_public;
    SELECT media_version INTO v1 FROM public.observation_images WHERE id = guard_img;
    UPDATE public.observations SET visibility = 'public' WHERE id = obs_public;
    IF v1 - v0 <> 1 THEN
      fail_msgs := array_append(fail_msgs,
        format('I4: cascade did not increment by exactly 1 (was %s, now %s)', v0, v1));
    END IF;

    -- I5: attempting a nested arbitrary jump — simulated by explicitly
    --     setting media_version inside a trigger context that is NOT
    --     a version-bump trigger. We can't easily inject a rogue
    --     trigger inside this test; instead verify the guard rejects
    --     a manual `SET media_version = OLD + 5` inside a trusted
    --     wrapper that pretends to be a nested trigger by depth. We
    --     rely on the direct-untrusted path to prove the rule.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
    saw_error := false;
    BEGIN
      UPDATE public.observation_images SET media_version = media_version + 5 WHERE id = guard_img;
    EXCEPTION WHEN OTHERS THEN saw_error := true; END;
    RESET ROLE;
    IF NOT saw_error THEN
      fail_msgs := array_append(fail_msgs, 'I5: authenticated jump was permitted');
    END IF;

    -- Cleanup.
    SET LOCAL ROLE service_role;
    DELETE FROM public.observation_images WHERE id = guard_img;
    RESET ROLE;
  END;

  ------------------------------------------------------------------
  -- Section J: URL builder configuration safety.
  --   Anonymous / authenticated callers must not be able to redirect
  --   the emitted Worker origin via `SET app.settings.…` or any other
  --   session-writable configuration.
  ------------------------------------------------------------------
  DECLARE
    baseline_url text;
    attempted_url text;
  BEGIN
    -- Baseline (whatever _media_worker_config currently holds).
    baseline_url := public.build_worker_media_url(42, 'thumb', 7);

    -- J1: anon attempts to influence via the (no-longer-consulted) GUC.
    SET LOCAL ROLE anon;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('app.settings.media_worker_base_url', 'https://evil.example', true);
    attempted_url := public.build_worker_media_url(42, 'thumb', 7);
    RESET ROLE;
    IF attempted_url IS DISTINCT FROM baseline_url THEN
      fail_msgs := array_append(fail_msgs,
        format('J1: anon influenced URL host via GUC — baseline=%L, got=%L',
               baseline_url, attempted_url));
    END IF;
    IF attempted_url LIKE '%evil.example%' THEN
      fail_msgs := array_append(fail_msgs, 'J1: anon emitted evil.example host');
    END IF;

    -- J2: authenticated attempts likewise.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
    PERFORM set_config('app.settings.media_worker_base_url', 'https://evil.example', true);
    attempted_url := public.build_worker_media_url(42, 'thumb', 7);
    RESET ROLE;
    IF attempted_url IS DISTINCT FROM baseline_url THEN
      fail_msgs := array_append(fail_msgs,
        format('J2: authenticated influenced URL host via GUC — baseline=%L, got=%L',
               baseline_url, attempted_url));
    END IF;

    -- J3: _media_worker_config table is not directly readable by anon
    --     or authenticated.
    DECLARE
      unauthorized_read boolean := false;
    BEGIN
      BEGIN
        SET LOCAL ROLE anon;
        PERFORM * FROM public._media_worker_config;
        unauthorized_read := true;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
               WHEN OTHERS               THEN NULL; END;
      RESET ROLE;
      IF unauthorized_read THEN
        fail_msgs := array_append(fail_msgs,
          'J3: anon successfully SELECTed from _media_worker_config');
      END IF;
    END;
  END;

  ------------------------------------------------------------------
  -- Section K: mosaic authorization matrix (round-3 amendment).
  --   Uses `media_authorize_mosaic_delivery` — mosaics are not an
  --   image variant anymore.
  ------------------------------------------------------------------
  DECLARE
    mosaic_pub_pub bigint;
    mosaic_pub_friends bigint;
    mosaic_pub_priv bigint;
    mosaic_priv bigint;
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    -- Fixture: mosaics on each spore_data_visibility flavour.
    UPDATE public.observations SET spore_data_visibility = 'public' WHERE id = obs_public;
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs_public, owner_id, owner_id::text||'/mosaic-pub.webp', 256, 128, 128, 1)
    RETURNING id INTO mosaic_pub_pub;

    UPDATE public.observations SET spore_data_visibility = 'friends' WHERE id = obs_public;
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs_public, owner_id, owner_id::text||'/mosaic-pub-friends.webp', 256, 128, 128, 2)
    RETURNING id INTO mosaic_pub_friends;

    UPDATE public.observations SET spore_data_visibility = 'private' WHERE id = obs_public;
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs_public, owner_id, owner_id::text||'/mosaic-pub-priv.webp', 256, 128, 128, 3)
    RETURNING id INTO mosaic_pub_priv;

    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs_private, owner_id, owner_id::text||'/mosaic-priv.webp', 256, 128, 128, 1)
    RETURNING id INTO mosaic_priv;
    UPDATE public.observations SET spore_data_visibility = 'public' WHERE id = obs_public;

    -- K1: mosaic on public obs + spore_public → all callers allowed.
    FOR decision IN
      SELECT * FROM (VALUES (NULL::uuid), (stranger_id), (friend_id), (owner_id)) AS c(caller_uid),
      LATERAL (SELECT * FROM public.media_authorize_mosaic_delivery(mosaic_pub_pub, c.caller_uid)) x
    LOOP
      IF NOT decision.allowed THEN
        fail_msgs := array_append(fail_msgs,
          format('K1: mosaic denied for spore_public unexpectedly (reason=%s)', decision.reason));
      END IF;
    END LOOP;

    -- K2: mosaic on public obs + spore_friends → anon/stranger denied,
    --     friend/owner allowed.
    -- Reset spore_data_visibility to friends for the target obs.
    UPDATE public.observations SET spore_data_visibility = 'friends' WHERE id = obs_public;
    FOR decision IN
      SELECT * FROM (VALUES (NULL::uuid, 'anon'), (stranger_id, 'stranger')) AS c(caller_uid, label),
      LATERAL (SELECT * FROM public.media_authorize_mosaic_delivery(mosaic_pub_friends, c.caller_uid)) x
    LOOP
      IF decision.allowed OR decision.reason <> 'spore_data_denied' THEN
        fail_msgs := array_append(fail_msgs,
          format('K2/%s: mosaic+spore_friends leaked (allowed=%s reason=%s)',
                 c.label, decision.allowed, decision.reason));
      END IF;
    END LOOP;
    FOR decision IN
      SELECT * FROM public.media_authorize_mosaic_delivery(mosaic_pub_friends, friend_id)
    LOOP
      IF NOT decision.allowed THEN
        fail_msgs := array_append(fail_msgs,
          format('K2/friend: mosaic+spore_friends denied (reason=%s)', decision.reason));
      END IF;
    END LOOP;

    -- K3: mosaic + spore_private → only owner.
    UPDATE public.observations SET spore_data_visibility = 'private' WHERE id = obs_public;
    FOR decision IN
      SELECT * FROM (VALUES (NULL::uuid), (stranger_id), (friend_id)) AS c(caller_uid),
      LATERAL (SELECT * FROM public.media_authorize_mosaic_delivery(mosaic_pub_priv, c.caller_uid)) x
    LOOP
      IF decision.allowed THEN
        fail_msgs := array_append(fail_msgs,
          format('K3: mosaic+spore_private leaked (caller=%s reason=%s)',
                 c.caller_uid, decision.reason));
      END IF;
    END LOOP;
    FOR decision IN
      SELECT * FROM public.media_authorize_mosaic_delivery(mosaic_pub_priv, owner_id)
    LOOP
      IF NOT decision.allowed THEN
        fail_msgs := array_append(fail_msgs,
          format('K3/owner: mosaic on own row denied (reason=%s)', decision.reason));
      END IF;
    END LOOP;

    -- K4: mosaic on PRIVATE observation → owner only, regardless of
    --     spore_data_visibility.
    FOR decision IN
      SELECT * FROM (VALUES (NULL::uuid), (stranger_id), (friend_id)) AS c(caller_uid),
      LATERAL (SELECT * FROM public.media_authorize_mosaic_delivery(mosaic_priv, c.caller_uid)) x
    LOOP
      IF decision.allowed THEN
        fail_msgs := array_append(fail_msgs,
          format('K4: mosaic on PRIVATE obs leaked (caller=%s)', c.caller_uid));
      END IF;
    END LOOP;

    -- K5: privilege — anon and authenticated must NOT hold EXECUTE.
    IF has_function_privilege('anon',
         'public.media_authorize_mosaic_delivery(bigint, uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated',
         'public.media_authorize_mosaic_delivery(bigint, uuid)', 'EXECUTE') THEN
      fail_msgs := array_append(fail_msgs,
        'K5: mosaic RPC EXECUTE leaked to client role');
    END IF;

    -- K6: version bump on storage_key change.
    DECLARE
      v0 bigint; v1 bigint;
    BEGIN
      SELECT media_version INTO v0 FROM public.spore_measurement_mosaics WHERE id = mosaic_pub_pub;
      UPDATE public.spore_measurement_mosaics SET storage_key = storage_key || '.v2' WHERE id = mosaic_pub_pub;
      SELECT media_version INTO v1 FROM public.spore_measurement_mosaics WHERE id = mosaic_pub_pub;
      UPDATE public.spore_measurement_mosaics SET storage_key = regexp_replace(storage_key,'\.v2$','') WHERE id = mosaic_pub_pub;
      IF v1 <= v0 THEN
        fail_msgs := array_append(fail_msgs,
          format('K6: mosaic media_version did not bump on storage_key change (was %s, now %s)', v0, v1));
      END IF;
    END;

    -- Cleanup mosaic fixtures.
    DELETE FROM public.spore_measurement_mosaics
      WHERE id IN (mosaic_pub_pub, mosaic_pub_friends, mosaic_pub_priv, mosaic_priv);
    UPDATE public.observations SET spore_data_visibility = 'public' WHERE id = obs_public;
    RESET ROLE;
  END;

  ------------------------------------------------------------------
  -- Section L: variant NULL / whitespace / mixed-case rejection.
  ------------------------------------------------------------------
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  DECLARE
    bad_variants text[] := ARRAY[NULL, '', ' ', '  thumb', 'THUMB', 'Full', 'mosaic', 'THUMB_', 'thumb '];
    v text;
  BEGIN
    FOREACH v IN ARRAY bad_variants LOOP
      FOR decision IN
        SELECT * FROM public.media_authorize_delivery(img_public, v, NULL)
      LOOP
        IF decision.allowed OR decision.reason <> 'unsupported_variant' THEN
          fail_msgs := array_append(fail_msgs,
            format('L: variant %L was not rejected (allowed=%s reason=%s)',
                   v, decision.allowed, decision.reason));
        END IF;
      END LOOP;
    END LOOP;
  END;

  -- Positive: exact-case variants remain accepted.
  FOR decision IN
    SELECT * FROM (VALUES ('full'), ('thumb'), ('original')) AS c(v),
    LATERAL (SELECT * FROM public.media_authorize_delivery(img_public, c.v, owner_id)) x
  LOOP
    IF NOT decision.allowed THEN
      fail_msgs := array_append(fail_msgs,
        format('L/positive: variant %s denied unexpectedly (reason=%s)',
               decision.reason, decision.reason));
    END IF;
  END LOOP;
  RESET ROLE;

  ------------------------------------------------------------------
  -- Section M: rogue-trigger + final-state guard.
  --   Create a temporary BEFORE UPDATE trigger inside the transaction
  --   that attempts to jump `media_version` by +5. The AFTER
  --   final-state guard should reject.
  ------------------------------------------------------------------
  DECLARE
    rogue_img bigint;
    saw_error boolean;
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO public.observation_images
      (observation_id, user_id, storage_path)
    VALUES (obs_public, owner_id, owner_id::text||'/rogue.webp')
    RETURNING id INTO rogue_img;
    RESET ROLE;

    -- Install a temporary BEFORE UPDATE trigger that adds 5 to
    -- media_version (a legit sort_order UPDATE by an authenticated
    -- user should still succeed because the transition is 0 → 0 on
    -- media_version; but if we simulate a rogue path, the AFTER guard
    -- fires).
    CREATE OR REPLACE FUNCTION public._rogue_bump()
      RETURNS TRIGGER LANGUAGE plpgsql AS $rogue$
    BEGIN
      NEW.media_version := COALESCE(OLD.media_version, 0) + 5;
      RETURN NEW;
    END $rogue$;
    CREATE TRIGGER trg_rogue_before_update
      BEFORE UPDATE ON public.observation_images
      FOR EACH ROW EXECUTE FUNCTION public._rogue_bump();

    saw_error := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      UPDATE public.observation_images SET sort_order = 99 WHERE id = rogue_img;
    EXCEPTION WHEN insufficient_privilege THEN saw_error := true; END;
    RESET ROLE;

    IF NOT saw_error THEN
      fail_msgs := array_append(fail_msgs,
        'M: rogue BEFORE-trigger +5 was NOT rejected by the AFTER final-state guard');
    END IF;

    -- Verify the row's committed media_version did not jump — an
    -- exception-raising trigger rolls back the statement, so the row
    -- should be unchanged.
    DECLARE
      v_now bigint;
    BEGIN
      SELECT media_version INTO v_now FROM public.observation_images WHERE id = rogue_img;
      IF v_now <> 1 THEN
        fail_msgs := array_append(fail_msgs,
          format('M: media_version drifted to %s after rejected rogue-trigger update', v_now));
      END IF;
    END;

    -- Clean up rogue trigger.
    DROP TRIGGER IF EXISTS trg_rogue_before_update ON public.observation_images;
    DROP FUNCTION IF EXISTS public._rogue_bump();
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    DELETE FROM public.observation_images WHERE id = rogue_img;
    RESET ROLE;
  END;

  ------------------------------------------------------------------
  -- Section N: read-time integrity — service_role-inserted malformed
  -- rows must be denied by `media_authorize_delivery`.
  --
  -- Trusted-role INSERTs bypass the write guard by design (migration
  -- + admin paths need this flexibility). The RPC therefore MUST
  -- fail closed on malformed rows.
  ------------------------------------------------------------------
  DECLARE
    victim_id uuid := '00000000-0000-4000-8000-00000000cc10';
    victim_obs bigint;
    bad_owner_img bigint;
    bad_ns_img bigint;
    bad_orig_ns_img bigint;
  BEGIN
    RESET ROLE;  -- run as postgres for the auth.users insert
    INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (victim_id,'authenticated','authenticated','n-victim@example.test','{}'::jsonb,now(),now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, username, is_pro) VALUES (victim_id, 'n_victim', true)
    ON CONFLICT (id) DO UPDATE SET is_pro=true;

    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    INSERT INTO public.observations
      (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (victim_id,'2026-08-05','public',false,'exact','public')
    RETURNING id INTO victim_obs;

    -- Malformed row: image user_id differs from observation owner.
    -- This uses service_role which bypasses the write guard.
    INSERT INTO public.observation_images
      (observation_id, user_id, storage_path)
    VALUES (victim_obs, owner_id, owner_id::text||'/mismatch.webp')
    RETURNING id INTO bad_owner_img;

    -- Malformed row: storage_path outside the owner namespace.
    INSERT INTO public.observation_images
      (observation_id, user_id, storage_path)
    VALUES (victim_obs, victim_id, 'foreign/ns.webp')
    RETURNING id INTO bad_ns_img;

    -- Malformed row: original_storage_path outside owner namespace.
    INSERT INTO public.observation_images
      (observation_id, user_id, storage_path, original_storage_path)
    VALUES (victim_obs, victim_id, victim_id::text||'/legit.webp', 'foreign/orig.webp')
    RETURNING id INTO bad_orig_ns_img;

    -- N1: RPC denies owner-mismatched row with reason 'owner_mismatch'.
    FOR decision IN
      SELECT * FROM public.media_authorize_delivery(bad_owner_img, 'full', NULL)
    LOOP
      IF decision.allowed OR decision.reason <> 'owner_mismatch' THEN
        fail_msgs := array_append(fail_msgs,
          format('N1: owner-mismatched row not denied (allowed=%s reason=%s)',
                 decision.allowed, decision.reason));
      END IF;
    END LOOP;

    -- N2: RPC denies foreign-namespace storage_path.
    FOR decision IN
      SELECT * FROM public.media_authorize_delivery(bad_ns_img, 'full', NULL)
    LOOP
      IF decision.allowed OR decision.reason <> 'invalid_storage_namespace' THEN
        fail_msgs := array_append(fail_msgs,
          format('N2: foreign-namespace storage_path not denied (allowed=%s reason=%s)',
                 decision.allowed, decision.reason));
      END IF;
    END LOOP;

    -- N3: RPC denies foreign-namespace original_storage_path for owner.
    FOR decision IN
      SELECT * FROM public.media_authorize_delivery(bad_orig_ns_img, 'original', victim_id)
    LOOP
      IF decision.allowed OR decision.reason <> 'invalid_original_namespace' THEN
        fail_msgs := array_append(fail_msgs,
          format('N3: foreign-namespace original not denied (allowed=%s reason=%s)',
                 decision.allowed, decision.reason));
      END IF;
    END LOOP;

    -- Cleanup N fixtures.
    DELETE FROM public.observation_images
      WHERE id IN (bad_owner_img, bad_ns_img, bad_orig_ns_img);
    DELETE FROM public.observations WHERE id = victim_obs;
    RESET ROLE;
    DELETE FROM public.profiles WHERE id = victim_id;
    DELETE FROM auth.users     WHERE id = victim_id;
  END;

  ------------------------------------------------------------------
  -- Section O: write guard — auth.uid() = user_id, cross-user
  -- attachment, foreign user_id.
  ------------------------------------------------------------------
  DECLARE
    other_id uuid := '00000000-0000-4000-8000-00000000cc20';
    other_obs bigint;
    saw_priv_err boolean;
  BEGIN
    RESET ROLE;
    INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (other_id,'authenticated','authenticated','o-other@example.test','{}'::jsonb,now(),now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, username, is_pro) VALUES (other_id, 'o_other', true)
    ON CONFLICT (id) DO UPDATE SET is_pro=true;

    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO public.observations
      (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (other_id,'2026-08-05','public',false,'exact','public')
    RETURNING id INTO other_obs;
    RESET ROLE;

    -- O1: authenticated tries to set user_id to a different user →
    -- rejected with insufficient_privilege by the RLS WITH CHECK
    -- (user_id = auth.uid() in phase7_observation_images_insert_own)
    -- BEFORE our trigger even fires. The rejection is what matters.
    saw_priv_err := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      INSERT INTO public.observation_images
        (observation_id, user_id, storage_path)
      VALUES (obs_public, other_id, other_id::text||'/foreign.webp');
    EXCEPTION WHEN insufficient_privilege THEN saw_priv_err := true; END;
    RESET ROLE;
    IF NOT saw_priv_err THEN
      fail_msgs := array_append(fail_msgs,
        'O1: authenticated INSERT with foreign user_id was permitted');
    END IF;

    -- O2: authenticated attaches image to another user's observation.
    saw_priv_err := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
      INSERT INTO public.observation_images
        (observation_id, user_id, storage_path)
      VALUES (other_obs, owner_id, owner_id::text||'/mine-on-others-obs.webp');
    EXCEPTION WHEN insufficient_privilege THEN saw_priv_err := true; END;
    RESET ROLE;
    IF NOT saw_priv_err THEN
      fail_msgs := array_append(fail_msgs,
        'O2: authenticated attached image to another user''s observation');
    END IF;

    -- Cleanup O fixtures.
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    DELETE FROM public.observation_images WHERE user_id = other_id;
    DELETE FROM public.observations WHERE id = other_obs;
    RESET ROLE;
    DELETE FROM public.profiles WHERE id = other_id;
    DELETE FROM auth.users     WHERE id = other_id;
  END;

  ------------------------------------------------------------------
  -- Section P: RLS-bypass helper is NOT client-callable.
  ------------------------------------------------------------------
  IF has_function_privilege('anon',
       'public._media_get_observation_user_id(bigint)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public._media_get_observation_user_id(bigint)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public._media_get_observation_user_id(bigint)', 'EXECUTE') THEN
    fail_msgs := array_append(fail_msgs,
      'P: _media_get_observation_user_id EXECUTE leaked to a client/service role');
  END IF;

  ------------------------------------------------------------------
  -- Cleanup fixtures.
  ------------------------------------------------------------------
  DELETE FROM public.user_blocks WHERE blocker_id IN (owner_id, stranger_id, friend_id, bad_user)
                                    OR blocked_id IN (owner_id, stranger_id, friend_id, bad_user);
  DELETE FROM public.observation_images WHERE user_id IN (owner_id, bad_user);
  DELETE FROM public.observations       WHERE user_id IN (owner_id, bad_user);
  DELETE FROM public.friendships
    WHERE requester_id IN (owner_id, stranger_id, friend_id, bad_user)
       OR addressee_id IN (owner_id, stranger_id, friend_id, bad_user);
  DELETE FROM public.profiles WHERE id IN (owner_id, stranger_id, friend_id, bad_user);
  DELETE FROM auth.users     WHERE id IN (owner_id, stranger_id, friend_id, bad_user);

  ------------------------------------------------------------------
  -- Verdict.
  ------------------------------------------------------------------
  IF array_length(fail_msgs, 1) IS NOT NULL THEN
    RAISE EXCEPTION E'media_authorization_test FAILED:\n  - %',
      array_to_string(fail_msgs, E'\n  - ');
  END IF;
  RAISE NOTICE 'media_authorization_test: OK';
END $$;
