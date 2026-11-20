-- Harden the legacy search_taxa RPC.
--
-- search_taxa is SECURITY DEFINER and executable by anon, but it had no pinned
-- search_path and passed the caller's `lim` straight to LIMIT, so
-- `lim => NULL` (LIMIT ALL) or a huge value returned the whole taxonomy in one
-- call. The web client only calls it as a fallback when search_taxa_v2 is
-- missing, and both clients cap their own requests at 50.
--
-- The body is unchanged apart from the clamp, which matches search_taxa_v2:
-- greatest(1, least(coalesce(lim, 20), 50)). CREATE OR REPLACE keeps the
-- existing owner and EXECUTE grants.

BEGIN;

CREATE OR REPLACE FUNCTION public.search_taxa(q text, lang text DEFAULT 'no'::text, lim integer DEFAULT 20)
 RETURNS TABLE(taxon_id integer, genus text, specific_epithet text, canonical_scientific_name text, family text, vernacular_name text, norwegian_taxon_id integer, swedish_taxon_id integer, inaturalist_taxon_id integer, artportalen_taxon_id integer, match_type text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_catalog
AS $function$
  WITH candidates AS (
    SELECT DISTINCT t.taxon_id, t.genus, t.specific_epithet,
      CASE WHEN EXISTS (
        SELECT 1 FROM public.taxa_vernacular mv
        WHERE mv.taxon_id = t.taxon_id
          AND mv.vernacular_name ILIKE q || '%'
      ) THEN 0 ELSE 1 END AS score
    FROM public.taxa t
    WHERE
      EXISTS (
        SELECT 1 FROM public.taxa_vernacular mv
        WHERE mv.taxon_id = t.taxon_id
          AND mv.vernacular_name ILIKE q || '%'
      )
      OR t.canonical_scientific_name ILIKE q || '%'
      OR (t.genus || ' ' || t.specific_epithet) ILIKE q || '%'
      OR t.genus ILIKE q || '%'
    ORDER BY score, t.genus, t.specific_epithet
    LIMIT greatest(1, least(coalesce(lim, 20), 50))
  )
  SELECT
    t.taxon_id,
    t.genus,
    t.specific_epithet,
    t.canonical_scientific_name,
    t.family,
    pv.vernacular_name,
    t.norwegian_taxon_id,
    t.swedish_taxon_id,
    t.inaturalist_taxon_id,
    t.artportalen_taxon_id,
    CASE WHEN c.score = 0 THEN 'vernacular' ELSE 'scientific' END AS match_type
  FROM candidates c
  JOIN public.taxa t ON t.taxon_id = c.taxon_id
  LEFT JOIN public.taxa_vernacular pv
    ON pv.taxon_id = t.taxon_id
   AND pv.language_code = lang
   AND pv.is_preferred = true
  ORDER BY c.score, t.genus, t.specific_epithet
$function$;

COMMIT;
