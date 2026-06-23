CREATE TABLE IF NOT EXISTS public.admin_action_log (
  id bigserial PRIMARY KEY,
  admin_user_id uuid,
  admin_email text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text,
  request_payload jsonb,
  before_snapshot jsonb,
  result_snapshot jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE public.admin_action_log OWNER TO postgres;
ALTER TABLE public.admin_action_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_action_log FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_action_log FROM anon;
REVOKE ALL ON TABLE public.admin_action_log FROM authenticated;
GRANT ALL ON TABLE public.admin_action_log TO service_role;

REVOKE ALL ON SEQUENCE public.admin_action_log_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.admin_action_log_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.admin_action_log_id_seq FROM authenticated;
GRANT ALL ON SEQUENCE public.admin_action_log_id_seq TO service_role;

CREATE TABLE IF NOT EXISTS public.comment_moderation (
  comment_id bigint PRIMARY KEY REFERENCES public.comments(id) ON DELETE CASCADE,
  report_id uuid,
  hidden_at timestamptz DEFAULT now() NOT NULL,
  hidden_by uuid,
  hidden_reason text,
  created_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE public.comment_moderation OWNER TO postgres;
ALTER TABLE public.comment_moderation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.comment_moderation FROM PUBLIC;
REVOKE ALL ON TABLE public.comment_moderation FROM anon;
REVOKE ALL ON TABLE public.comment_moderation FROM authenticated;
GRANT ALL ON TABLE public.comment_moderation TO service_role;

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS resolution text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by uuid,
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_by uuid;

ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_status_check;

ALTER TABLE public.reports
  ADD CONSTRAINT reports_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'resolved'::text, 'dismissed'::text]));

ALTER TABLE public.observation_images
  ADD COLUMN IF NOT EXISTS purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_error text;

CREATE INDEX IF NOT EXISTS idx_observation_images_deleted_purged_at
  ON public.observation_images (deleted_at, purged_at);

ALTER POLICY "comments_select" ON public.comments
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = comments.observation_id
        AND (
          o.user_id = auth.uid()
          OR o.visibility = 'public'::text
          OR (
            o.visibility = 'friends'::text
            AND EXISTS (
              SELECT 1
              FROM public.friendships f
              WHERE f.status = 'accepted'::text
                AND (
                  (f.requester_id = auth.uid() AND f.addressee_id = o.user_id)
                  OR (f.addressee_id = auth.uid() AND f.requester_id = o.user_id)
                )
            )
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.comment_moderation cm
      WHERE cm.comment_id = comments.id
        AND cm.hidden_at IS NOT NULL
    )
  );

ALTER POLICY "phase7_comments_read" ON public.comments
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = comments.observation_id
        AND public.can_read_observation(o.user_id, o.visibility)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.comment_moderation cm
      WHERE cm.comment_id = comments.id
        AND cm.hidden_at IS NOT NULL
    )
  );
