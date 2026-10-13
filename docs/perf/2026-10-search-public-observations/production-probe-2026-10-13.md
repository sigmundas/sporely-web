# Production statistics probe, 2026-10-13: provenance

- **File:** `production-probe-2026-10-13.txt` in this directory, byte-for-byte
  as the owner supplied it. The owner removed only the local terminal prompt
  before supplying it.
- **Probe:** `supabase/search-public-observations-stats-probe.sql` at
  `a4b9cb8`, the accepted Stage 1a candidate. Run without
  `-v main_sha256`, so `main_sha256` and `matches_main` are empty.
- **Run:** by the owner, once, against production, at 18:22:46 UTC on
  2026-10-13. This was the single collection authorized at the Stage 1a
  gate (`production_probe_decision`): already authorized and performed.
  This record does **not** authorize another run.
- **Result:** all seven result sets were returned, then `wrote_nothing = t`,
  then `ROLLBACK`.
- **Reference hash:** the `functiondef_sha256` (`84db51be…a9e28c2`) equals the
  hash from an isolated local stack built from `origin/main` `f92d560`. The
  plan's "Recorded before Stage 1b" section has the details.

## Terminal artifacts in the file (the values are unaffected)

- **Line 43.** The `observations_date_idx` row wraps after `USING btr`. It
  continues on the next line with `ee (date DESC)`, padding, then a line
  holding `idx_scan 3735` and `size_bytes 40960`. Full definition:
  `CREATE INDEX observations_date_idx ON public.observations USING btree (date DESC)`.
- **Line 46.** The `observations_desktop_id_user_unique` row wraps after
  `public.o`. It continues with `bservations USING btree (desktop_id, user_id)`,
  then `idx_scan 1860` and `size_bytes 65536`.
- **Line 51.** The `observations_user_id_idx` definition reads
  `USINGbtree (user_id)`, with the space lost in the terminal copy. The
  definition is `... USING btree (user_id)`.
- **Padding.** Several later index rows have shortened column padding,
  also from the terminal copy. Column order and values are intact.

## Notes for Stage 1b (observations, not conclusions)

- Every count is small:
  - 787 observations live in all, of which 228 are public and not drafts;
  - 5,585 images;
  - 8,982 spore measurements.
- Even so, the anon `search_public_observations` entries average about
  11,843 shared buffers hit per call (38,927,721 / 3,287), about 92 MB of
  buffer traffic per call at 8 kB pages. Stage 1b must explain this from
  local plans and helper-call counts.
- **Owner concentration:** observations per owner have p50 2, and p95 and
  maximum both 146. One owner holds most public observations, so the seed
  should reproduce that skew.
- `observations_date_idx` (`date DESC`) shows 3,735 scans.
  `observation_images_microscope_captured_at_idx` shows 0.
