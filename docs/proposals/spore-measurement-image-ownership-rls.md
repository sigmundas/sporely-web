# Proposal: spore measurement writes must own their image

Status: proposal only — not implemented, needs approval. Found during the
security review of `20260925120000_owner_sync_metadata_parents.sql`.

## Gap

`spore_measurements` write policies (from
`20260803120000_lock_down_observation_sync_tables.sql`) check only the row's
own `user_id`:

```sql
CREATE POLICY "spore_measurements_owner_insert" ON public.spore_measurements
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "spore_measurements_owner_update" ON public.spore_measurements
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
```

Nothing requires the caller to own `image_id`. The foreign key to
`observation_images` is checked without RLS, so any signed-in user who knows
(or enumerates) an image id can attach measurements to another user's image.

## Impact today

Public SECURITY DEFINER RPCs count every measurement on an eligible image
whose type passes the spore filter, without checking who wrote it. A foreign
user can therefore inject points, counts and summary values into another
user's public observation. Surfaces that read `spore_measurements` joined to
public images include `_get_public_observation_stage2a` (sporeMeasurementCount,
sporeSummary, sporePoints), `search_public_observations`,
`_search_public_species_stage2a`, `_get_public_species_stage2a`,
`get_public_species_spore_summary`, `get_public_map_points`,
`get_public_species_distribution_summary`, `get_public_spore_comparison_set`,
`get_observation_microscopy_presentations`, the spore-mosaic RPCs, and the
community spore dataset functions (`get_community_spore_dataset`,
`search_community_spore_datasets`, `community_spore_taxon_summary`,
`get_person_stats`).

The owner-sync migration already closes the one path this gap would open
there — its helpers count only `m.user_id = i.user_id` as evidence — but the
general injection predates it.

## Proposed fix (new migration)

```sql
ALTER POLICY "spore_measurements_owner_insert" ON public.spore_measurements
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.observation_images i
      WHERE i.id = spore_measurements.image_id
        AND i.user_id = auth.uid()
    )
  );

ALTER POLICY "spore_measurements_owner_update" ON public.spore_measurements
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.observation_images i
      WHERE i.id = spore_measurements.image_id
        AND i.user_id = auth.uid()
    )
  );
```

Before applying:

1. Audit existing rows: `SELECT count(*) FROM spore_measurements m JOIN
   observation_images i ON i.id = m.image_id WHERE m.user_id <> i.user_id;`
   Decide separately what to do with any hits (report, hide, delete); do not
   delete automatically.
2. Confirm no legitimate client writes measurements on another user's image
   (desktop and web both write only their owner's rows).
3. Consider also filtering `m.user_id = i.user_id` in the public RPCs, as
   defence in depth for rows that predate the policy change.
4. Add RLS tests for a foreign insert and a foreign re-parenting update.
