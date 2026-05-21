ALTER TABLE public.observation_identifications
  ADD COLUMN IF NOT EXISTS top_species_url text;

ALTER TABLE public.observation_identifications
  ADD COLUMN IF NOT EXISTS top_redlist_category text;

ALTER TABLE public.observation_identifications
  ADD COLUMN IF NOT EXISTS top_redlist_status text;

ALTER TABLE public.observation_identifications
  ADD COLUMN IF NOT EXISTS top_redlist_source text;
