-- Admin-only aggregate view over public.client_activity_daily. Returns JSONB
-- with two summaries: DAU per (day, client) for the last p_days days, and
-- today's DAU broken down by (client, app_version). SECURITY DEFINER + explicit
-- profiles.is_admin check — no direct table grants needed for the caller.
--
-- The is_admin field on public.profiles is protected against self-promotion by
-- trg_profiles_protect_privileged_fields (see 20260530121500 /
-- 20260603120000), which clamps NEW.is_admin = OLD.is_admin whenever the
-- caller is not postgres/service_role. This function therefore trusts the
-- is_admin flag as an authorization signal, but relies on that trigger being
-- in place — do not remove it without adding an equivalent guard.

create or replace function public.admin_client_activity_summary(
  p_days integer default 30
)
returns jsonb
language plpgsql
security definer
-- Empty search_path is the safest posture for SECURITY DEFINER: forces every
-- reference below to be schema-qualified, so no attacker-controlled schema on
-- the caller's search_path can shadow a function or table we resolve here.
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_is_admin boolean;
  v_days integer;
  v_today date := (now() at time zone 'utc')::date;
  v_since date;
  v_by_day_client jsonb;
  v_by_version_today jsonb;
  v_totals jsonb;
begin
  if v_user is null then
    raise exception 'admin_client_activity_summary requires an authenticated user';
  end if;

  select p.is_admin into v_is_admin from public.profiles p where p.id = v_user;
  if coalesce(v_is_admin, false) is not true then
    raise exception 'admin_client_activity_summary requires an admin profile';
  end if;

  v_days := greatest(1, least(coalesce(p_days, 30), 365));
  v_since := v_today - (v_days - 1);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.row_to_json(t) order by t.activity_date desc, t.client), '[]'::jsonb)
    into v_by_day_client
    from (
      select cad.activity_date, cad.client, count(distinct cad.user_id)::int as users
        from public.client_activity_daily cad
       where cad.activity_date >= v_since
       group by cad.activity_date, cad.client
    ) t;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.row_to_json(t) order by t.users desc, t.client, t.app_version), '[]'::jsonb)
    into v_by_version_today
    from (
      select cad.client,
             nullif(cad.app_version, '') as app_version,
             count(distinct cad.user_id)::int as users
        from public.client_activity_daily cad
       where cad.activity_date = v_today
       group by cad.client, cad.app_version
    ) t;

  select pg_catalog.jsonb_build_object(
      'active_today', coalesce((
        select count(distinct cad.user_id) from public.client_activity_daily cad
         where cad.activity_date = v_today), 0),
      'active_window', coalesce((
        select count(distinct cad.user_id) from public.client_activity_daily cad
         where cad.activity_date >= v_since), 0),
      'rows_in_window', coalesce((
        select count(*) from public.client_activity_daily cad
         where cad.activity_date >= v_since), 0)
    ) into v_totals;

  return pg_catalog.jsonb_build_object(
    'generated_at', now(),
    'window_days', v_days,
    'since', v_since,
    'today', v_today,
    'totals', v_totals,
    'by_day_client', v_by_day_client,
    'by_version_today', v_by_version_today
  );
end;
$$;

alter function public.admin_client_activity_summary(integer) owner to postgres;

-- Explicit privilege posture. Belt and suspenders — revoke from PUBLIC (which
-- would grant everyone including anon) AND from anon explicitly, then grant to
-- authenticated only. The function still enforces admin-only at runtime.
revoke all on function public.admin_client_activity_summary(integer)
  from public, anon;
grant execute on function public.admin_client_activity_summary(integer)
  to authenticated;
