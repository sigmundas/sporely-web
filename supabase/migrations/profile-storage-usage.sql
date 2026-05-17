alter table public.profiles
  add column if not exists cloud_plan text default 'free',
  add column if not exists full_res_storage_enabled boolean default false,
  add column if not exists storage_quota_bytes bigint,
  add column if not exists total_storage_bytes bigint not null default 0,
  add column if not exists storage_used_bytes bigint not null default 0,
  add column if not exists image_count integer not null default 0;

-- Optional example free-tier quota:
-- update public.profiles set storage_quota_bytes = 104857600 where cloud_plan = 'free';

create or replace function public.apply_profile_storage_delta(
  p_user_id uuid,
  p_storage_delta bigint,
  p_image_delta integer
)
returns table(total_storage_bytes bigint, storage_used_bytes bigint, image_count integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.profiles
  set
    total_storage_bytes = greatest(0, coalesce(profiles.total_storage_bytes, 0) + coalesce(p_storage_delta, 0)),
    storage_used_bytes = greatest(0, coalesce(profiles.storage_used_bytes, 0) + coalesce(p_storage_delta, 0)),
    image_count = greatest(0, coalesce(profiles.image_count, 0) + coalesce(p_image_delta, 0))
  where profiles.id = p_user_id
  returning profiles.total_storage_bytes, profiles.storage_used_bytes, profiles.image_count;
end;
$$;
