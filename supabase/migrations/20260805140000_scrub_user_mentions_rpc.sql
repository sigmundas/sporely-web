-- SQL-safe helper for account deletion: strips a single uuid from every
-- comments.mentioned_user_ids array without disturbing co-mentioned uuids.
--
-- Called by the `delete-account` Edge Function from the service-role admin
-- client. Exposed as an RPC so the function can invoke it without needing
-- to construct raw SQL from user input.
--
-- Uses `security definer` because the deleted user does not (necessarily)
-- own the comments where their uuid is mentioned. The service role invokes
-- this in the Edge Function; grant EXECUTE only to service_role so a
-- normal authenticated client cannot call it to blank out other users'
-- mention arrays.

create or replace function public.scrub_user_mentions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.comments
     set mentioned_user_ids = array_remove(mentioned_user_ids, p_user_id)
   where p_user_id = any(mentioned_user_ids);
  get diagnostics affected = row_count;
  return coalesce(affected, 0);
end;
$$;

alter function public.scrub_user_mentions(uuid) owner to postgres;
revoke all on function public.scrub_user_mentions(uuid) from public;
revoke all on function public.scrub_user_mentions(uuid) from anon;
revoke all on function public.scrub_user_mentions(uuid) from authenticated;
grant execute on function public.scrub_user_mentions(uuid) to service_role;

notify pgrst, 'reload schema';
