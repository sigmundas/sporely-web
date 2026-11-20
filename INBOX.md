# Inbox

- Add a tooltip to the species badge explaining what it means.
- "What's new" after an update: the first time the app opens on a new
  version, show a very short list (2–4 bullets) of what changed, in plain,
  non-technical language (e.g. "You can now compare two finds side by
  side"). Dismiss once; remember the last version seen locally. Needs
  translated text for no/sv/en/de per release. Skip it on a fresh install.
- "Update available" prompt with a link to Google Play when the installed
  app is older than the live one. Play review takes 1–5 days, so don't
  compare against our own latest build number. Ask Play what's actually
  live, using the Play In-App Updates API (e.g. the
  `@capawesome/capacitor-app-update` plugin: `getAppUpdateInfo()` →
  `updateAvailability`, then `openAppStore()` or a flexible in-app update).
  Only works for Play installs; sideloaded/Obtanium/GitHub APKs need a
  separate check or no prompt. Don't nag: show at most once per version.
- **Search name in Species Fungorum** (2026-10-24; proposed, not yet approved for implementation). From a species/taxon detail view, offer an external action labelled **Search in Species Fungorum** (surface: the web and Android taxon detail UI).
  - Search by the taxon's scientific name only, never the Norwegian vernacular name or a Sporely/COL identifier (a COL taxon id is not a Species Fungorum record id). It should also help with synonyms and historic names.
  - Investigate before implementing: does Species Fungorum (https://www.speciesfungorum.org/names/Names.asp) support a reliable URL that accepts a full scientific name? A genus-search URL with the `strGenus` parameter is known to be in use, but do not assume it handles full binomials correctly without testing.
  - If no reliable name deep link exists, fall back to the official search page with the name easily copyable. If a verified Species Fungorum record ID is available, a direct record link may be preferable.
  - External research aid only: no automatic taxonomy reconciliation or identification, and it must not alter Sporely IDs, taxonomic approvals or observations.
  - Context: Species Fungorum (Kew) is the source of the COL Base fungal backbone (Species Fungorum Plus, version April 2024 in COL releases 2024-10 to 2026-09); the live site may be newer. Index Fungorum (https://www.indexfungorum.org/) is nomenclatural and not interchangeable.
- **Open findings from the November 2026 agent security review** (2026-11-20; Astra, Fable and Kimi reviewed `30eaa68`, followed by a Codex challenge). Fixed and deployed so far: #56, #57, #58 and #59. Each item below was checked against the code; none is approved for implementation yet.
  - Security and privacy:
    - `media.sporely.no` serves R2 directly, so it gets neither the Worker's `nosniff`/sandbox CSP headers nor `/m/` authorization. Private and friends-only media stay fetchable by bare URL until the private-bucket cutover (`MEDIA_STORAGE_MODE = "legacy"`). Short term: a Cloudflare response-header rule on that domain.
    - Legacy Supabase Storage bucket `observation-images`: 1,047 objects (newest 2026-05-29), and 21 image rows still have an object at the same key. `src/images.js` (~line 1268) still falls back to downloading from it after Worker failures. Confirm R2 has every object, then remove the fallback and gate or empty the bucket.
    - Parallel uploads can exceed a storage quota: the Worker checks the quota, writes, and only then adds the bytes (`apply_profile_storage_delta` is unconditional). This only matters once `FREE_STORAGE_QUOTA_BYTES` or a per-user quota is set; today it is `0` (no limit).
    - Users can still edit their own activity fields on `profiles` (`last_app_version`, `last_client`, `last_client_seen_at`, `profile_completed_at`); the server-owned-column trigger does not cover them, so admin activity stats can be spoofed.
    - Blocked or banned users can still send friend requests (accepting still needs the addressee).
    - The debug dashboard records full iNaturalist OAuth response bodies, tokens included (`src/inaturalist.js` → `recordDebugJsonResponse`), when a debug flag is on. Redact before recording.
    - `public/_headers` CSP still allows `'unsafe-inline'`.
    - The repo does not define the `on_auth_user_created` trigger that creates profiles.
  - Reliability:
    - Account deletion is not resumable. The largest account (5,535 images) needs about 22,000 Worker DELETEs; they now run 16 at a time, but a timeout still restarts from scratch.
    - The offline sync queue stays blocked after an account switch.
    - Race between saving and clearing the review draft.
    - Account-isolation residuals from #58: drafts lost after a failed cold-start purge followed by storage recovery; an already-started stalled purge can clear a newer account's drafts; a stale rollback can erase a newer iNaturalist link.
    - Pro entitlement keeps one `billing_payment_id` per profile, so with two paid purchases a refund of the older one is not matched (and the reverse).
  - Performance and correctness:
    - Home's species count downloads every named observation (`src/screens/home.js` ~line 1117) and is capped at PostgREST's 1,000 rows, so the count is wrong for large accounts. Use a server-side distinct count.
    - All screens are imported and initialized at startup; only the map is lazy.
    - The media cache reads every record on each write (`src/media-cache.js`), and its cache key ignores `media_version`, so a replaced image at the same key keeps showing the old bytes.
    - `src/sync-queue.js` opens a new IndexedDB connection per operation and never closes it.
    - Legacy `search_taxa` limits distinct taxa, but returns a taxon once per preferred vernacular name in the language, so results can exceed the limit.
  - Stale code: committed `.pyc` files, dead exports, Deno `.ts` tests that CI never runs, and documentation drift.
