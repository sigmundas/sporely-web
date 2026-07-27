-- Corrective, additive migration for public.record_client_activity(text, text).
--
-- The original migration 20260723120000 has already been applied to the linked
-- Supabase project and MUST NOT be modified in place — Supabase tracks
-- migrations by timestamp, so an in-place edit would never re-run against
-- production. This file replaces the function definition additively.
--
-- Defects being corrected:
--   * now() returns the transaction start time. Two RPC calls issued inside
--     the same transaction stamped identical last_seen_at, so the upsert's
--     monotonic-advance guard (`where cad.last_seen_at < excluded.last_seen_at`)
--     silently skipped the second update. Switch to clock_timestamp() and
--     derive v_today from the same captured instant so activity_date and
--     last_seen_at agree.
--   * SECURITY DEFINER hygiene: set search_path = '' with every relation and
--     catalog function schema-qualified (public.*, pg_catalog.*, auth.uid()),
--     then explicitly revoke from PUBLIC and anon before granting to
--     authenticated only.
--
-- Behavioural contract is preserved verbatim: same signature, same default,
-- same return type, same client allow-list, same 32-char version truncation,
-- same upsert with monotonic guard, same profile last-client update.

create or replace function public.record_client_activity(
  p_client text,
  p_app_version text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_version text;
  v_now timestamptz := clock_timestamp();
  v_today date := (v_now at time zone 'utc')::date;
begin
  if v_user is null then
    raise exception 'record_client_activity requires an authenticated user';
  end if;

  if p_client is null
    or p_client not in (
      'android_app', 'ios_app', 'web_pwa', 'web_browser', 'desktop_app', 'unknown'
    )
  then
    raise exception 'invalid client: %', p_client;
  end if;

  v_version := coalesce(p_app_version, '');
  if pg_catalog.char_length(v_version) > 32 then
    v_version := pg_catalog.substr(v_version, 1, 32);
  end if;

  insert into public.client_activity_daily as cad (
    user_id, activity_date, client, app_version, first_seen_at, last_seen_at
  )
  values (v_user, v_today, p_client, v_version, v_now, v_now)
  on conflict (user_id, activity_date, client, app_version)
  do update set last_seen_at = excluded.last_seen_at
    where cad.last_seen_at < excluded.last_seen_at;

  update public.profiles p
     set last_client = p_client,
         last_app_version = nullif(v_version, ''),
         last_client_seen_at = v_now
   where p.id = v_user;
end;
$$;

alter function public.record_client_activity(text, text) owner to postgres;

revoke all on function public.record_client_activity(text, text)
  from public, anon;
grant execute on function public.record_client_activity(text, text)
  to authenticated;
