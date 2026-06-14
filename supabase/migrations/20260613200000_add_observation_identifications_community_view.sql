CREATE OR REPLACE VIEW public.observation_identifications_community_view AS
 SELECT oi.*
   FROM public.observation_identifications oi
   JOIN public.observations o ON o.id = oi.observation_id
  WHERE public.can_read_observation(o.user_id, o.visibility)
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

ALTER VIEW public.observation_identifications_community_view OWNER TO postgres;

REVOKE ALL ON TABLE public.observation_identifications_community_view FROM PUBLIC;
GRANT ALL ON TABLE public.observation_identifications_community_view TO anon;
GRANT ALL ON TABLE public.observation_identifications_community_view TO authenticated;
GRANT ALL ON TABLE public.observation_identifications_community_view TO service_role;

NOTIFY pgrst, 'reload schema';
