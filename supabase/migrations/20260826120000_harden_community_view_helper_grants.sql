-- Tighten EXECUTE surface for the authorization helper used by the six
-- SECURITY DEFINER community views. Views, view SELECT grants, and base-table
-- RLS are untouched.
--
-- Rationale (see helper security audit, 2026-08): public.can_read_observation
-- was granted to PUBLIC, which is broader than every other identity helper in
-- the codebase. Narrow to the explicit role list used elsewhere, and harden
-- search_path to '' (body already schema-qualifies auth.uid(), public.profiles,
-- public.is_blocked_between, public.are_friends).
--
-- The two internal underscore helpers _stage2b_observation_primary_media and
-- _media_worker_base_url remain reachable from anon/authenticated. Postgres
-- checks function EXECUTE against the query caller for functions referenced
-- inside a view body, so revoking those grants breaks the SECURITY DEFINER
-- view call chain. Hiding those helpers requires a separate refactor (wrap
-- build_worker_media_url as SECURITY DEFINER, or fold the internals) and is
-- deliberately deferred.

REVOKE EXECUTE ON FUNCTION public.can_read_observation(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.can_read_observation(uuid, text)
  TO anon, authenticated, service_role;

ALTER FUNCTION public.can_read_observation(uuid, text) SET search_path TO '';
