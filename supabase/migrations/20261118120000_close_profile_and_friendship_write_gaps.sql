-- Close two client write paths that bypassed server-owned state.
--
-- 1. profiles: the owner policy covered ALL commands and `authenticated` held
--    INSERT and DELETE. trg_profiles_protect_privileged_fields only fires
--    BEFORE UPDATE, so a user could delete their own profile row and insert a
--    replacement with is_admin = true (or Pro/quota/unbanned values).
--    Clients only ever UPDATE their own row: profiles are created by the
--    on_auth_user_created trigger (SECURITY DEFINER, owned by postgres) and
--    deleted by the delete-account Edge Function (service role). Both bypass
--    RLS and these grants, so they keep working.
--
-- 2. friendships: the requester could insert a row that was already
--    'accepted', and either party could update any column, so a user could
--    make themselves a friend of anyone without consent. Clients only insert
--    'pending' requests (people.js, find_detail.js) and the addressee only
--    sets status to 'accepted' (profile.js, home.js). Either party may still
--    delete the row (decline, cancel, unfriend).
--
-- Existing rows are not changed.

BEGIN;

-- profiles ------------------------------------------------------------------

DROP POLICY IF EXISTS "profiles: owner read-write" ON public.profiles;
DROP POLICY IF EXISTS "profiles: owner read" ON public.profiles;
DROP POLICY IF EXISTS "profiles: owner update" ON public.profiles;

CREATE POLICY "profiles: owner read"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "profiles: owner update"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

REVOKE INSERT, DELETE ON TABLE public.profiles FROM authenticated;

-- friendships ---------------------------------------------------------------

DROP POLICY IF EXISTS "friendships: requester can insert" ON public.friendships;
DROP POLICY IF EXISTS "friendships: requester can insert pending" ON public.friendships;
DROP POLICY IF EXISTS "friendships: parties can update" ON public.friendships;
DROP POLICY IF EXISTS "friendships: addressee can accept" ON public.friendships;

CREATE POLICY "friendships: requester can insert pending"
  ON public.friendships
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = requester_id
    AND requester_id <> addressee_id
    AND status = 'pending'
  );

CREATE POLICY "friendships: addressee can accept"
  ON public.friendships
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = addressee_id AND status = 'pending')
  WITH CHECK (auth.uid() = addressee_id AND status = 'accepted');

-- Only `status` is client-writable on UPDATE, so participants and timestamps
-- cannot be rewritten (trg_friendships_updated_at still sets updated_at).
-- anon never had a working friendships path (every policy needs auth.uid()).
REVOKE ALL ON TABLE public.friendships FROM anon;
REVOKE ALL ON TABLE public.friendships FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.friendships TO authenticated;
GRANT UPDATE (status) ON TABLE public.friendships TO authenticated;

COMMIT;
