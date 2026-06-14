create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_username text;
  candidate_display_name text;
begin
  candidate_username := coalesce(
    nullif(btrim(new.raw_user_meta_data->>'username'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), '')
  );

  candidate_display_name := coalesce(
    nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
    candidate_username,
    new.email,
    new.id::text
  );

  if candidate_username is not null
     and exists (
       select 1
       from public.profiles p
       where lower(p.username) = lower(candidate_username)
     ) then
    candidate_username :=
      candidate_username || '_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    candidate_username,
    candidate_display_name
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

alter function public.handle_new_user() owner to postgres;

notify pgrst, 'reload schema';