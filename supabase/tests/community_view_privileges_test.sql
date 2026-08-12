-- Regression coverage for read-only client privileges on community views.

BEGIN;

DO $$
DECLARE
  role_name text;
  view_name text;
  update_column text;
  write_denied boolean;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    FOREACH view_name IN ARRAY ARRAY[
      'comments_community_view',
      'observation_identifications_community_view'
    ]
    LOOP
      IF NOT has_table_privilege(
        role_name,
        format('public.%I', view_name),
        'SELECT'
      ) THEN
        RAISE EXCEPTION '% lacks SELECT on public.%', role_name, view_name;
      END IF;

      IF has_table_privilege(
        role_name,
        format('public.%I', view_name),
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) THEN
        RAISE EXCEPTION '% retains a write privilege on public.%', role_name, view_name;
      END IF;

      EXECUTE format('SET LOCAL ROLE %I', role_name);
      EXECUTE format('SELECT 1 FROM public.%I LIMIT 0', view_name);

      write_denied := false;
      BEGIN
        EXECUTE format('INSERT INTO public.%I DEFAULT VALUES', view_name);
      EXCEPTION
        WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN
        write_denied := true;
      END;
      IF NOT write_denied THEN
        RAISE EXCEPTION '% inserted through public.%', role_name, view_name;
      END IF;

      update_column := CASE view_name
        WHEN 'comments_community_view' THEN 'body'
        ELSE 'status'
      END;

      write_denied := false;
      BEGIN
        EXECUTE format(
          'UPDATE public.%I SET %I = %I WHERE false',
          view_name,
          update_column,
          update_column
        );
      EXCEPTION
        WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN
        write_denied := true;
      END;
      IF NOT write_denied THEN
        RAISE EXCEPTION '% updated through public.%', role_name, view_name;
      END IF;

      write_denied := false;
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE false', view_name);
      EXCEPTION
        WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN
        write_denied := true;
      END;
      IF NOT write_denied THEN
        RAISE EXCEPTION '% deleted through public.%', role_name, view_name;
      END IF;

      RESET ROLE;
    END LOOP;
  END LOOP;

  IF NOT has_table_privilege(
    'service_role',
    'public.comments_community_view',
    'SELECT'
  ) OR NOT has_table_privilege(
    'service_role',
    'public.observation_identifications_community_view',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'service_role SELECT requirement was not preserved';
  END IF;

  RAISE NOTICE 'community_view_privileges_test passed';
END
$$;

ROLLBACK;
