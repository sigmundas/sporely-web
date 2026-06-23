CREATE OR REPLACE VIEW public.comments_community_view AS
SELECT
  c.id,
  c.observation_id,
  c.user_id,
  c.body,
  c.created_at,
  c.mentioned_user_ids
FROM public.comments c
JOIN public.observations o ON o.id = c.observation_id
WHERE public.can_read_observation(o.user_id, o.visibility)
  AND NOT public.is_blocked_between(auth.uid(), c.user_id)
  AND NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = c.user_id
      AND p.is_banned = true
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.comment_moderation cm
    WHERE cm.comment_id = c.id
      AND cm.hidden_at IS NOT NULL
  );

ALTER VIEW public.comments_community_view OWNER TO postgres;

REVOKE ALL ON TABLE public.comments_community_view FROM PUBLIC;
GRANT ALL ON TABLE public.comments_community_view TO anon;
GRANT ALL ON TABLE public.comments_community_view TO authenticated;
GRANT ALL ON TABLE public.comments_community_view TO service_role;

NOTIFY pgrst, 'reload schema';
