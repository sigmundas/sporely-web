-- Client roles consume these community projections read-only. Preserve the
-- existing service_role ACL while removing unnecessary client DML privileges.

BEGIN;

REVOKE ALL ON TABLE public.comments_community_view
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.observation_identifications_community_view
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.comments_community_view
  TO anon, authenticated;
GRANT SELECT ON TABLE public.observation_identifications_community_view
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
