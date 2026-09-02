-- Stage 6g additive stable taxonomy identity on existing species reads.

BEGIN;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-000000006701';
  owner_b constant uuid := '00000000-0000-4000-8000-000000006702';
  owner_banned constant uuid := '00000000-0000-4000-8000-000000006703';
  viewer constant uuid := '00000000-0000-4000-8000-000000006704';
  species_a constant integer := 2100000071;
  species_b constant integer := 2100000072;
  genus_taxon constant integer := 2100000073;
  blank_species constant integer := 2100000074;
  identity jsonb;
  observed_count bigint;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES
    (owner_a,'authenticated','authenticated','stage6g-a@example.invalid','{}',now(),now()),
    (owner_b,'authenticated','authenticated','stage6g-b@example.invalid','{}',now(),now()),
    (owner_banned,'authenticated','authenticated','stage6g-ban@example.invalid','{}',now(),now()),
    (viewer,'authenticated','authenticated','stage6g-viewer@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (owner_a,'stage6g_a',false),(owner_b,'stage6g_b',false),
    (owner_banned,'stage6g_banned',true),(viewer,'stage6g_viewer',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,
    first_materialized_from_release
  ) VALUES
    (species_a,'Russula exacta','species','include','in_cache','stage6g-test'),
    (species_b,'Russula altera','species','include','in_cache','stage6g-test'),
    (genus_taxon,'Russula','genus','include','in_cache','stage6g-test'),
    (blank_species,'   ','species','include','in_cache','stage6g-test');

  INSERT INTO public.observations(
    user_id,date,genus,species,visibility,is_draft,resolved_sporely_taxon_id
  ) VALUES
    (owner_a,current_date,'Russula','exacta','public',false,species_a),
    (owner_a,current_date,'Russula','exacta','public',false,NULL),
    (owner_a,current_date,'Russula','ambigua','public',false,species_a),
    (owner_b,current_date,'Russula','ambigua','public',false,species_b),
    (owner_a,current_date,'Russula','unresolved','public',false,NULL),
    (owner_a,current_date,'Russula','nongenus','public',false,genus_taxon),
    (owner_a,current_date,'Russula','blankname','public',false,blank_species),
    (owner_a,current_date,'Russula','visibility','public',false,species_a),
    (owner_b,current_date,'Russula','visibility','private',false,species_b),
    (owner_b,current_date,'Russula','visibility','public',true,species_b),
    (owner_banned,current_date,'Russula','visibility','public',false,species_b),
    (owner_a,current_date,'Russula','blocked','public',false,species_a),
    (owner_b,current_date,'Russula','blocked','public',false,species_b);

  SELECT s."taxonIdentity",s."observationCount"
    INTO identity,observed_count
    FROM public.get_public_species('russula-exacta') s;
  IF identity <> jsonb_build_object(
       'sporelyTaxonId',species_a,
       'canonicalScientificName','Russula exacta'
     ) OR observed_count <> 2 THEN
    RAISE EXCEPTION 'exact species identity/additive detail mismatch: %, %',
      identity,observed_count;
  END IF;
  IF (SELECT pg_catalog.to_jsonb(s) - 'taxonIdentity'
        FROM public.get_public_species('russula-exacta') s)
     IS DISTINCT FROM
     (SELECT pg_catalog.to_jsonb(legacy)
        FROM public._get_public_species_stage6f('russula-exacta') legacy) THEN
    RAISE EXCEPTION 'additive detail wrapper changed an existing species field';
  END IF;
  IF (SELECT s."taxonIdentity" FROM public.get_public_species('russula-ambigua') s)
       IS NOT NULL
     OR (SELECT s."taxonIdentity" FROM public.get_public_species('russula-unresolved') s)
       IS NOT NULL
     OR (SELECT s."taxonIdentity" FROM public.get_public_species('russula-nongenus') s)
       IS NOT NULL
     OR (SELECT s."taxonIdentity" FROM public.get_public_species('russula-blankname') s)
       IS NOT NULL THEN
    RAISE EXCEPTION 'ambiguous/unresolved/ineligible identity did not fail closed';
  END IF;
  IF (SELECT s."taxonIdentity" FROM public.get_public_species('russula-visibility') s)
       ->>'sporelyTaxonId' <> species_a::text THEN
    RAISE EXCEPTION 'private/draft/banned observation influenced stable identity';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.search_public_species(50,0,'Russula',NULL) s
     WHERE s."speciesSlug"='russula-exacta'
       AND s."taxonIdentity"=jsonb_build_object(
         'sporelyTaxonId',species_a,
         'canonicalScientificName','Russula exacta'
       )
  ) OR EXISTS (
    SELECT 1 FROM public.search_public_species(50,0,'Russula',NULL) s
     WHERE s."speciesSlug"='russula-ambigua' AND s."taxonIdentity" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'species search identity did not match detail semantics';
  END IF;
  IF (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) - 'taxonIdentity')
        FROM public.search_public_species(50,0,'Russula',NULL) s)
     IS DISTINCT FROM
     (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(legacy))
        FROM public._search_public_species_stage6f(50,0,'Russula',NULL) legacy) THEN
    RAISE EXCEPTION 'additive search wrapper changed an existing species field/order';
  END IF;

  INSERT INTO public.user_blocks(blocker_id,blocked_id) VALUES(viewer,owner_b);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub',viewer::text,'role','authenticated')::text,
    true
  );
  SELECT s."taxonIdentity",s."observationCount"
    INTO identity,observed_count
    FROM public.get_public_species('russula-blocked') s;
  IF identity->>'sporelyTaxonId' <> species_a::text OR observed_count <> 1 THEN
    RAISE EXCEPTION 'blocked observation influenced caller-specific identity: %, %',
      identity,observed_count;
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claims','{"role":"anon"}',true);
  SET LOCAL ROLE anon;
  IF (SELECT s."taxonIdentity" FROM public.get_public_species('russula-ambigua') s)
       IS NOT NULL THEN
    RAISE EXCEPTION 'anonymous ambiguous identity did not fail closed';
  END IF;
  RESET ROLE;
END
$$;

ROLLBACK;
