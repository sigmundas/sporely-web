ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS ai_selected_service text,
  ADD COLUMN IF NOT EXISTS ai_selected_taxon_id text,
  ADD COLUMN IF NOT EXISTS ai_selected_scientific_name text,
  ADD COLUMN IF NOT EXISTS ai_selected_probability numeric,
  ADD COLUMN IF NOT EXISTS ai_selected_at timestamptz;
