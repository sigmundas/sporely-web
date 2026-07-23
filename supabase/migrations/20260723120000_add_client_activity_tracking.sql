-- Lightweight client-activity tracking. This is NOT signup attribution — every
-- authenticated session (post sign-in, app foreground, boot with existing
-- session) calls record_client_activity, which:
--   1) upserts one row per (user, UTC date, client, app_version) into
--      public.client_activity_daily, updating last_seen_at
--   2) refreshes profiles.last_client / last_app_version / last_client_seen_at
--
-- We intentionally do NOT store user agents, IPs, hardware identifiers, or any
-- device fingerprint — only the coarse client bucket and the app version.

alter table public.profiles
  add column if not exists last_client text,
  add column if not exists last_app_version text,
  add column if not exists last_client_seen_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_last_client_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_last_client_check
      check (
        last_client is null
        or last_client in (
          'android_app',
          'ios_app',
          'web_pwa',
          'web_browser',
          'desktop_app',
          'unknown'
        )
      );
  end if;
end$$;

create table if not exists public.client_activity_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_date date not null,
  client text not null,
  -- Empty string (not NULL) when the client cannot report a version, so the
  -- primary key stays usable without partial-index gymnastics.
  app_version text not null default '',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, activity_date, client, app_version),
  constraint client_activity_daily_client_check check (
    client in (
      'android_app',
      'ios_app',
      'web_pwa',
      'web_browser',
      'desktop_app',
      'unknown'
    )
  ),
  constraint client_activity_daily_app_version_len check (
    char_length(app_version) <= 32
  )
);

alter table public.client_activity_daily enable row level security;

-- Explicit privilege posture: no direct table access for anon; authenticated
-- gets SELECT only (filtered further by the owner policy below). Writes are
-- funneled through record_client_activity(), which runs SECURITY DEFINER.
revoke all on table public.client_activity_daily from public;
revoke all on table public.client_activity_daily from anon;
revoke all on table public.client_activity_daily from authenticated;
grant select on table public.client_activity_daily to authenticated;

-- Owner can read their own activity rows. Writes happen only through the
-- SECURITY DEFINER RPC below — no INSERT/UPDATE/DELETE policies.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'client_activity_daily'
      and policyname = 'client_activity_daily_owner_select'
  ) then
    create policy client_activity_daily_owner_select
      on public.client_activity_daily
      for select
      using (auth.uid() = user_id);
  end if;
end$$;

create index if not exists client_activity_daily_date_idx
  on public.client_activity_daily (activity_date);

create or replace function public.record_client_activity(
  p_client text,
  p_app_version text default null
)
returns void
language plpgsql
security definer
-- Empty search_path forces every reference below to be schema-qualified, so
-- no attacker-controlled schema on the caller's search_path can shadow a
-- function or table we resolve here.
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_version text;
  -- clock_timestamp() reads the actual wall clock. now() would return the
  -- transaction start time, so two calls inside one transaction would stamp
  -- identical last_seen_at and the monotonic-advance guard on the upsert
  -- (last_seen_at < excluded.last_seen_at) would silently skip the second
  -- update. v_today is derived from the same instant for consistency.
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

  -- Length-limit the caller-supplied version. We accept a truncated string
  -- rather than erroring, so a client with an unexpectedly long version tag
  -- (dev suffix, build metadata) still gets its activity counted.
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
