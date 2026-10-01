-- Read-only production preflight for
-- supabase/migrations/20261001113007_share_references_by_default.sql
-- (Stage 2d, docs/plans/active/2026-10-01-reference-sharing-default-on.md).
--
-- Runs BEFORE the migration, so the migration's new predicates do not exist
-- yet; each section replicates the post-migration rule it names, against the
-- pre-migration schema. Show the counts and rows to the owner before deploy.
--
--   psql "$PROD_URL" -v ON_ERROR_STOP=1 -f supabase/reference-sharing-default-on-preflight.sql
--
-- Expected on 2026-10-01 (plan "Exposure at deploy"): 0 backfill opt-outs;
-- 30 served uses on 21 observations, 1 owner; deploy refresh 1 create and
-- 1 re-share; no hidden sets.

BEGIN TRANSACTION READ ONLY;

-- 0. The constraints the migration drops by name (expect all four).
SELECT '0-constraints' AS section, conname
  FROM pg_constraint
 WHERE conname IN ('shared_reference_contributions_shared_iff_consented',
                   'shared_reference_consent_events_event_check',
                   'shared_reference_consent_events_check',
                   'shared_reference_consent_events_reason_check')
 ORDER BY conname;
SELECT '0-constraints-missing' AS section, n AS name
  FROM unnest(ARRAY['shared_reference_contributions_shared_iff_consented',
                    'shared_reference_consent_events_event_check',
                    'shared_reference_consent_events_check',
                    'shared_reference_consent_events_reason_check']) n
 WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = n);
SELECT '0-shared-rows' AS section, count(*) AS shared_rows
  FROM private.shared_reference_contributions WHERE status = 'shared';

-- The CTEs below replicate, before the migration:
--   pf_backfill  migration step 13 (the backfill): withdrawn rows with no
--                withdrawn_by_system event, or whose latest withdrawal is
--                the owner's;
--   pf_hidden    private.reference_set_has_hidden_contribution;
--   pf_served    private.observation_reference_use_is_served (anon caller);
--   pf_refresh   the deploy refresh's keys under the core's rules.

-- (a) withdrawn rows the backfill opts out.
WITH pf_backfill AS (
  SELECT c.owner_id, c.source_measurement_set_id, c.id AS contribution_id,
         c.sporely_taxon_id, c.withdrawn_at
    FROM private.shared_reference_contributions c
   WHERE c.status = 'withdrawn'
     AND c.owner_id IS NOT NULL
     AND (
       NOT EXISTS (
         SELECT 1 FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id AND e.event = 'withdrawn_by_system'
       )
       OR (
         SELECT e.event FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id
            AND e.event IN ('withdrawn_by_owner','withdrawn_by_system')
          ORDER BY e.id DESC LIMIT 1
       ) = 'withdrawn_by_owner'
     )
)
SELECT '(a)-backfill-count' AS section, count(*) AS rows,
       count(DISTINCT (owner_id, source_measurement_set_id)) AS opt_outs
  FROM pf_backfill;
WITH pf_backfill AS (
  SELECT c.owner_id, c.source_measurement_set_id, c.id AS contribution_id,
         c.sporely_taxon_id, c.withdrawn_at
    FROM private.shared_reference_contributions c
   WHERE c.status = 'withdrawn'
     AND c.owner_id IS NOT NULL
     AND (
       NOT EXISTS (
         SELECT 1 FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id AND e.event = 'withdrawn_by_system'
       )
       OR (
         SELECT e.event FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id
            AND e.event IN ('withdrawn_by_owner','withdrawn_by_system')
          ORDER BY e.id DESC LIMIT 1
       ) = 'withdrawn_by_owner'
     )
)
SELECT '(a)-backfill' AS section, owner_id, source_measurement_set_id,
       contribution_id, sporely_taxon_id, withdrawn_at
  FROM pf_backfill ORDER BY owner_id, source_measurement_set_id, contribution_id;

-- (b) every use private.observation_reference_use_is_served would serve
-- (anonymous caller), including taxon-less observations. Opt-outs are the
-- backfill's (none exist before the migration).

WITH pf_backfill AS (
  SELECT c.owner_id, c.source_measurement_set_id, c.id AS contribution_id,
         c.sporely_taxon_id, c.withdrawn_at
    FROM private.shared_reference_contributions c
   WHERE c.status = 'withdrawn'
     AND c.owner_id IS NOT NULL
     AND (
       NOT EXISTS (
         SELECT 1 FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id AND e.event = 'withdrawn_by_system'
       )
       OR (
         SELECT e.event FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id
            AND e.event IN ('withdrawn_by_owner','withdrawn_by_system')
          ORDER BY e.id DESC LIMIT 1
       ) = 'withdrawn_by_owner'
     )
),
pf_hidden AS (
  SELECT DISTINCT c.owner_id, c.source_measurement_set_id
    FROM private.shared_reference_contributions c
   WHERE c.owner_id IS NOT NULL AND c.hidden_at IS NOT NULL
),
pf_served AS (
  SELECT u.user_id AS owner_id, u.reference_measurement_set_id, u.observation_id, u.id AS use_id,
         u.role, coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id) AS taxon_id,
         rc.rank AS taxon_rank
    FROM public.observation_reference_uses u
    JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
    JOIN public.profiles p ON p.id = u.user_id AND p.is_banned IS FALSE
    JOIN public.reference_measurement_sets m ON m.user_id = u.user_id AND m.id = u.reference_measurement_set_id
    JOIN public.reference_taxon_treatments t ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id = t.user_id AND w.id = t.reference_work_id
    LEFT JOIN taxonomy_v3.registry_concept rc
      ON rc.sporely_taxon_id = coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
   WHERE u.deleted_at IS NULL
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
     AND o.visibility = 'public' AND o.is_draft IS FALSE
     AND o.spore_data_visibility = 'public'
     AND NOT EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = u.user_id)
     AND NOT EXISTS (SELECT 1 FROM pf_backfill b
                      WHERE b.owner_id = u.user_id AND b.source_measurement_set_id = u.reference_measurement_set_id)
     AND NOT EXISTS (SELECT 1 FROM pf_hidden h
                      WHERE h.owner_id = u.user_id AND h.source_measurement_set_id = u.reference_measurement_set_id)
     AND private.public_reference_snapshot(u.snapshot_json, u.reference_measurement_set_id, u.reference_revision) IS NOT NULL
)
SELECT '(b)-served-count' AS section, count(*) AS uses, count(DISTINCT observation_id) AS observations,
       count(DISTINCT owner_id) AS owners,
       count(*) FILTER (WHERE taxon_id IS NULL) AS taxon_less_uses,
       count(*) FILTER (WHERE taxon_id IS NOT NULL AND taxon_rank IS DISTINCT FROM 'species') AS non_registry_species_uses,
       count(DISTINCT role) AS roles
  FROM pf_served;
WITH pf_backfill AS (
  SELECT c.owner_id, c.source_measurement_set_id, c.id AS contribution_id,
         c.sporely_taxon_id, c.withdrawn_at
    FROM private.shared_reference_contributions c
   WHERE c.status = 'withdrawn'
     AND c.owner_id IS NOT NULL
     AND (
       NOT EXISTS (
         SELECT 1 FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id AND e.event = 'withdrawn_by_system'
       )
       OR (
         SELECT e.event FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id
            AND e.event IN ('withdrawn_by_owner','withdrawn_by_system')
          ORDER BY e.id DESC LIMIT 1
       ) = 'withdrawn_by_owner'
     )
),
pf_hidden AS (
  SELECT DISTINCT c.owner_id, c.source_measurement_set_id
    FROM private.shared_reference_contributions c
   WHERE c.owner_id IS NOT NULL AND c.hidden_at IS NOT NULL
),
pf_served AS (
  SELECT u.user_id AS owner_id, u.reference_measurement_set_id, u.observation_id, u.id AS use_id,
         u.role, coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id) AS taxon_id,
         rc.rank AS taxon_rank
    FROM public.observation_reference_uses u
    JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
    JOIN public.profiles p ON p.id = u.user_id AND p.is_banned IS FALSE
    JOIN public.reference_measurement_sets m ON m.user_id = u.user_id AND m.id = u.reference_measurement_set_id
    JOIN public.reference_taxon_treatments t ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id = t.user_id AND w.id = t.reference_work_id
    LEFT JOIN taxonomy_v3.registry_concept rc
      ON rc.sporely_taxon_id = coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
   WHERE u.deleted_at IS NULL
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
     AND o.visibility = 'public' AND o.is_draft IS FALSE
     AND o.spore_data_visibility = 'public'
     AND NOT EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = u.user_id)
     AND NOT EXISTS (SELECT 1 FROM pf_backfill b
                      WHERE b.owner_id = u.user_id AND b.source_measurement_set_id = u.reference_measurement_set_id)
     AND NOT EXISTS (SELECT 1 FROM pf_hidden h
                      WHERE h.owner_id = u.user_id AND h.source_measurement_set_id = u.reference_measurement_set_id)
     AND private.public_reference_snapshot(u.snapshot_json, u.reference_measurement_set_id, u.reference_revision) IS NOT NULL
)
SELECT '(b)-served' AS section, owner_id, reference_measurement_set_id, observation_id, use_id,
       role, taxon_id, taxon_rank
  FROM pf_served ORDER BY owner_id, reference_measurement_set_id, observation_id, use_id;

-- (c) keys the deploy refresh creates / re-shares, by the core's rules:
-- qualifying use of a registry species (canonical name present), live
-- source, owner not banned or deleting, no opt-out (backfill), no hidden
-- contribution of the set. The core's source bounds and projection checks
-- (source_out_of_bounds) are not replicated: a key listed here may still
-- answer source_out_of_bounds and stay unshared.

WITH pf_backfill AS (
  SELECT c.owner_id, c.source_measurement_set_id, c.id AS contribution_id,
         c.sporely_taxon_id, c.withdrawn_at
    FROM private.shared_reference_contributions c
   WHERE c.status = 'withdrawn'
     AND c.owner_id IS NOT NULL
     AND (
       NOT EXISTS (
         SELECT 1 FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id AND e.event = 'withdrawn_by_system'
       )
       OR (
         SELECT e.event FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id
            AND e.event IN ('withdrawn_by_owner','withdrawn_by_system')
          ORDER BY e.id DESC LIMIT 1
       ) = 'withdrawn_by_owner'
     )
),
pf_hidden AS (
  SELECT DISTINCT c.owner_id, c.source_measurement_set_id
    FROM private.shared_reference_contributions c
   WHERE c.owner_id IS NOT NULL AND c.hidden_at IS NOT NULL
),
pf_refresh AS (
  SELECT DISTINCT u.user_id AS owner_id, u.reference_measurement_set_id,
         coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer AS taxon_id
    FROM public.observation_reference_uses u
    JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
    JOIN taxonomy_v3.registry_concept rc
      ON rc.sporely_taxon_id = coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
     AND rc.rank = 'species'
     AND nullif(btrim(rc.canonical_name), '') IS NOT NULL
     AND char_length(rc.canonical_name) <= 1024
    JOIN public.profiles p ON p.id = u.user_id AND p.is_banned IS FALSE
    JOIN public.reference_measurement_sets m ON m.user_id = u.user_id AND m.id = u.reference_measurement_set_id
    JOIN public.reference_taxon_treatments t ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id = t.user_id AND w.id = t.reference_work_id
   WHERE u.deleted_at IS NULL
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
     AND o.visibility = 'public' AND o.is_draft IS FALSE AND o.spore_data_visibility = 'public'
     AND NOT EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = u.user_id)
     AND NOT EXISTS (SELECT 1 FROM pf_backfill b
                      WHERE b.owner_id = u.user_id AND b.source_measurement_set_id = u.reference_measurement_set_id)
     AND NOT EXISTS (SELECT 1 FROM pf_hidden h
                      WHERE h.owner_id = u.user_id AND h.source_measurement_set_id = u.reference_measurement_set_id)
)
SELECT '(c)-refresh-count' AS section,
       count(*) FILTER (WHERE c.id IS NULL) AS creates,
       count(*) FILTER (WHERE c.status = 'withdrawn') AS reshares,
       count(*) FILTER (WHERE c.status = 'shared') AS already_shared
  FROM pf_refresh k
  LEFT JOIN private.shared_reference_contributions c
    ON c.owner_id = k.owner_id AND c.source_measurement_set_id = k.reference_measurement_set_id
   AND c.sporely_taxon_id = k.taxon_id;
WITH pf_backfill AS (
  SELECT c.owner_id, c.source_measurement_set_id, c.id AS contribution_id,
         c.sporely_taxon_id, c.withdrawn_at
    FROM private.shared_reference_contributions c
   WHERE c.status = 'withdrawn'
     AND c.owner_id IS NOT NULL
     AND (
       NOT EXISTS (
         SELECT 1 FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id AND e.event = 'withdrawn_by_system'
       )
       OR (
         SELECT e.event FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = c.id
            AND e.event IN ('withdrawn_by_owner','withdrawn_by_system')
          ORDER BY e.id DESC LIMIT 1
       ) = 'withdrawn_by_owner'
     )
),
pf_hidden AS (
  SELECT DISTINCT c.owner_id, c.source_measurement_set_id
    FROM private.shared_reference_contributions c
   WHERE c.owner_id IS NOT NULL AND c.hidden_at IS NOT NULL
),
pf_refresh AS (
  SELECT DISTINCT u.user_id AS owner_id, u.reference_measurement_set_id,
         coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer AS taxon_id
    FROM public.observation_reference_uses u
    JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
    JOIN taxonomy_v3.registry_concept rc
      ON rc.sporely_taxon_id = coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
     AND rc.rank = 'species'
     AND nullif(btrim(rc.canonical_name), '') IS NOT NULL
     AND char_length(rc.canonical_name) <= 1024
    JOIN public.profiles p ON p.id = u.user_id AND p.is_banned IS FALSE
    JOIN public.reference_measurement_sets m ON m.user_id = u.user_id AND m.id = u.reference_measurement_set_id
    JOIN public.reference_taxon_treatments t ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id = t.user_id AND w.id = t.reference_work_id
   WHERE u.deleted_at IS NULL
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
     AND o.visibility = 'public' AND o.is_draft IS FALSE AND o.spore_data_visibility = 'public'
     AND NOT EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = u.user_id)
     AND NOT EXISTS (SELECT 1 FROM pf_backfill b
                      WHERE b.owner_id = u.user_id AND b.source_measurement_set_id = u.reference_measurement_set_id)
     AND NOT EXISTS (SELECT 1 FROM pf_hidden h
                      WHERE h.owner_id = u.user_id AND h.source_measurement_set_id = u.reference_measurement_set_id)
)
SELECT '(c)-refresh' AS section, k.owner_id, k.reference_measurement_set_id, k.taxon_id,
       CASE WHEN c.id IS NULL THEN 'create' WHEN c.status = 'withdrawn' THEN 'reshare' ELSE 'refresh' END AS outcome,
       c.id AS contribution_id
  FROM pf_refresh k
  LEFT JOIN private.shared_reference_contributions c
    ON c.owner_id = k.owner_id AND c.source_measurement_set_id = k.reference_measurement_set_id
   AND c.sporely_taxon_id = k.taxon_id
 ORDER BY 2, 3, 4;

-- (d) sets with a hidden contribution (served nowhere after the migration).
WITH pf_hidden AS (
  SELECT DISTINCT c.owner_id, c.source_measurement_set_id
    FROM private.shared_reference_contributions c
   WHERE c.owner_id IS NOT NULL AND c.hidden_at IS NOT NULL
)
SELECT '(d)-hidden-count' AS section, count(*) AS sets FROM pf_hidden;
WITH pf_hidden AS (
  SELECT DISTINCT c.owner_id, c.source_measurement_set_id
    FROM private.shared_reference_contributions c
   WHERE c.owner_id IS NOT NULL AND c.hidden_at IS NOT NULL
)
SELECT '(d)-hidden' AS section, h.owner_id, h.source_measurement_set_id,
       c.id AS contribution_id, c.sporely_taxon_id, c.status, c.hidden_reason
  FROM pf_hidden h
  JOIN private.shared_reference_contributions c
    ON c.owner_id = h.owner_id AND c.source_measurement_set_id = h.source_measurement_set_id
 ORDER BY 2, 3, 4;

ROLLBACK;
