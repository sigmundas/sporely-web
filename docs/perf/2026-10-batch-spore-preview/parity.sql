-- Parity over every seeded fixture (eligible and decoy), as anon: the batch,
-- in chunks of at most 60 ids, against get_public_observation reduced to the
-- card keys (points) and minus url (mosaic). LOCAL ONLY; seed.sql first.
--   docker exec -i <db-container> psql -U postgres -X -At -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-batch-spore-preview/parity.sql
SELECT string_agg(ids::text, '|') AS chunks FROM (
  SELECT array_agg(observation_id ORDER BY observation_id) AS ids
  FROM (SELECT observation_id, (row_number() OVER (ORDER BY observation_id) - 1) / 60 AS chunk FROM perf_bsp.obs) s
  GROUP BY chunk
) c \gset
SET ROLE anon;
WITH batch AS (
  SELECT b.*
  FROM regexp_split_to_table(:'chunks', '\|') c(ids)
  CROSS JOIN LATERAL public.get_public_observation_spore_previews(c.ids::bigint[]) b
),
single AS (
  SELECT g.id AS observation_id,
         CASE WHEN g."sporePoints" IS NULL THEN NULL ELSE (
           SELECT coalesce(jsonb_agg((
             SELECT coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
             FROM jsonb_each(pt.value) kv
             WHERE kv.key IN ('id', 'lengthUm', 'widthUm', 'cropUrl', 'mosaicX', 'mosaicY', 'mosaicW', 'mosaicH',
                              'contrastMethod', 'mountReagent', 'sampleType', 'sampleSource')
           ) ORDER BY pt.ord), '[]'::jsonb)
           FROM jsonb_array_elements(g."sporePoints") WITH ORDINALITY pt(value, ord)) END AS points,
         g."sporeMosaic" - 'url' AS spore_mosaic
  FROM regexp_split_to_table(:'chunks', '\|') c(ids)
  CROSS JOIN LATERAL unnest(c.ids::bigint[]) i
  CROSS JOIN LATERAL public.get_public_observation(i) g
)
SELECT 'rows batch/single', (SELECT count(*) FROM batch), (SELECT count(*) FROM single),
       'points', (SELECT coalesce(sum(jsonb_array_length(points)), 0) FROM batch),
       'mismatches', (SELECT count(*) FROM batch b FULL JOIN single s USING (observation_id)
                      WHERE b.observation_id IS NULL OR s.observation_id IS NULL
                         OR b.points IS DISTINCT FROM s.points
                         OR b.spore_mosaic IS DISTINCT FROM s.spore_mosaic);
