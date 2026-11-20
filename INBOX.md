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
