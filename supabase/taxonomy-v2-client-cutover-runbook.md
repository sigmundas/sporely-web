# Taxonomy-v2 web/Android client cutover

This rollout changes only the client search and adds an owner-controlled identity link. It does not alter the installed taxonomy release, the legacy search RPC, provider identifiers, or the 369 taxonomy-v3 historical resolution rows.

## Contracts and identifier semantics

| Surface | Before | After |
|---|---|---|
| User taxon search | `public.search_taxa` (legacy NorTaxa-oriented tables) | `public.search_taxa_v2` (the single active global release) |
| Search identity | Generic legacy `taxon_id`; provider convenience fields | Explicit `sporelyTaxonId`, separate namespaced external IDs, and `identityCapability = sporely-taxonomy-v2` |
| User selection | Text snapshot only | Text snapshot plus `observations.selected_sporely_taxon_id` through the guarded RPC |
| Historical resolution | `resolved_sporely_taxon_id`, service-role controlled | Unchanged |

`sporely_taxon_id` is an immutable internal concept identity allocated by Sporely. It is not a NorTaxa, Artsdatabanken, Artportalen, iNaturalist, Mushroom Observer, COL, or desktop ID. `colUsageId` and `nortaxaTaxonId` remain separate normalized values. The adapter never exposes a Sporely ID as `taxonId` or `norwegianTaxonId`.

Existing fields retain these meanings:

- `genus`, `species`, `common_name`, and `species_guess` are submitted textual snapshots.
- `artsdata_id`, `artportalen_id`, `inaturalist_id`, `mushroomobserver_id`, and `desktop_id` are provider/device-specific legacy identifiers and never receive a Sporely ID.
- `ai_selected_taxon_id` is the selected AI provider's own identifier, namespaced by `ai_selected_service`; taxonomy-v2 search does not populate it.
- `resolved_sporely_taxon_id` is trusted historical taxonomy-v3 reconciliation and remains blocked to clients.
- `selected_sporely_taxon_id` is the observation owner's explicit taxonomy-v2 choice. It is additive and does not claim that historical reconciliation produced the choice.

Manual free text has no identity capability and clears an existing user-selected link without changing trusted historical resolution. Genus results retain a NULL/empty species snapshot. COL-only taxa store the Sporely link and scientific text while all NorTaxa/Artsdatabanken fields stay NULL.

## Persistence and compatibility

Migration `20260802130000_add_taxonomy_v2_client_selection.sql` adds the nullable selected link, a direct-write guard, and `set_observation_selected_taxon_v2(bigint,bigint)`. The SECURITY DEFINER function has a fixed search path, requires `auth.uid()` ownership, validates non-NULL IDs against the active release, changes only the selected link, and permits an explicit NULL clear. `public` and `anon` cannot execute it; `authenticated` and `service_role` can.

Capture and import records keep the selection as client-only queue metadata. The queue strips that metadata before its ordinary observation insert, then calls the narrow RPC after obtaining the observation ID. If the RPC rejects, the remote observation ID and selection remain queued so retry does not duplicate the observation. Pre-upgrade queue records contain no selection metadata and continue through the legacy text-only path.

The client falls back to `public.search_taxa` only when `search_taxa_v2` is genuinely unavailable (`PGRST202`, PostgreSQL `42883`, or the equivalent schema-cache message). An empty v2 result never triggers fallback. Fallback results carry `identityCapability = legacy-provider-taxonomy` and cannot create a Sporely link.

## Deployment order

1. Review and back up production using the operator's normal process.
2. Apply the additive migration. Do not modify the active release or taxonomy-v3 data.
3. Run the SQL verification below.
4. Deploy the reviewed web bundle.
5. Verify search, COL-only capture/save, genus save, manual entry, edit, and offline retry in the web client.
6. Rebuild and release Android. A pre-existing APK contains the old JavaScript and will continue using legacy search until rebuilt.

Old clients remain readable and writable because no legacy column or RPC is removed. They simply do not set `selected_sporely_taxon_id`. New clients tolerate pre-migration/version-skew search only through the explicit legacy capability fallback; deploy the migration before the client to enable persistence.

## Rollback / feature disable

Roll back the client deployment to the prior web bundle and Android release. Old clients continue using `search_taxa`; do not drop it. Leave the additive nullable column and RPC installed so already-selected links remain readable and queued upgraded clients do not fail destructively. If an emergency disable is required, revoke `set_observation_selected_taxon_v2` from `authenticated` after rolling clients back. Do not clear `resolved_sporely_taxon_id`, rewrite snapshots, or change the active release. Use a reviewed forward migration for any schema correction.

## Production verification (human operator only)

Run read-only checks first:

```sql
select release_id, status
from public.taxonomy_v2_releases
where status = 'active';
-- exactly: tax-2026.08.01-01 | active

select taxon_id as sporely_taxon_id, canonical_scientific_name,
       col_usage_id, nortaxa_taxon_id, match_type
from public.search_taxa_v2('Crystallocystidium albescens', 'no', 20)
where taxon_id = 167;
-- col_usage_id = 323XQ; nortaxa_taxon_id IS NULL

select count(*) as historical_rows,
       count(*) filter (where resolved_sporely_taxon_id is not null) as resolved_rows,
       count(*) filter (where resolved_sporely_taxon_id is null) as null_rows
from taxonomy_v3.resolution_link;
-- 369 | 311 | 58
```

For a disposable observation owned by the signed-in verification user, select the COL-only result in the UI, save it, substitute its ID below, and verify:

```sql
select id, selected_sporely_taxon_id, resolved_sporely_taxon_id,
       genus, species, common_name,
       artsdata_id, artportalen_id, inaturalist_id,
       mushroomobserver_id, desktop_id
from public.observations
where id = :test_observation_id;
-- selected_sporely_taxon_id = 167
-- genus/species = Crystallocystidium/albescens
-- every provider ID remains NULL; resolved_sporely_taxon_id is not changed

select count(*) as provider_overloads
from public.observations
where id = :test_observation_id
  and 167 = any(array[artsdata_id, artportalen_id, inaturalist_id,
                      mushroomobserver_id, desktop_id]);
-- 0

select count(*) as historical_rows,
       count(*) filter (where resolved_sporely_taxon_id is not null) as resolved_rows,
       count(*) filter (where resolved_sporely_taxon_id is null) as null_rows
from taxonomy_v3.resolution_link;
-- still 369 | 311 | 58
```

UI checks should cover canonical prefix (`Crystallocystidium albescens`), genus (`Crystallocystidium`), alias (`Ustilago maydis`), Norwegian vernacular (`grå torvvokssopp`, `nb`), the COL-only result above, a manual string, editing a legacy observation, airplane-mode queueing, and retry after reconnect.

## Android operator commands after review

Use Node 22+, set the production Vite variables (including `VITE_GOOGLE_WEB_CLIENT_ID`), then:

```bash
# Update package version/versionName and increment versionCode once.
npm run release:version:patch

# Build, verify, and copy the production web bundle into Android.
npm run android:sync

# Install an inspectable debug build on a connected device.
cd android && ./gradlew :app:installDebug && cd ..

# Build the signed release bundle after local signing is configured.
cd android && ./gradlew :app:bundleRelease && cd ..
```

The AAB is written under `android/app/build/outputs/bundle/release/`. Inspect and test the artifact, then upload it through the team's Google Play release process. Do not commit keystores or signing properties. The reviewed implementation phase must not run the version bump, signing, upload, or publication steps.
