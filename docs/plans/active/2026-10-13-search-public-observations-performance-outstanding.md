# Outstanding requirements: `search_public_observations` performance plan

Companion to `2026-10-13-search-public-observations-performance.md`. The
plan's intake on 2026-10-13 (reviewed tip `21cffd4`) had no blocking
findings. The owner approved running Stage 1a only, and accepted three
recommendations as requirements, and later added a fourth (#4). Each must be resolved in the plan, and the
revised plan re-run through intake, before the stage named below starts.
Stage 1a does not implement any of them.

| # | Requirement | Resolve before | Input needed |
|---|---|---|---|
| 1 | **Seed scale.** Define the growth factor used to round the seed up, and whether "1×" in Stages 1b and 3 means the observed production counts or the rounded seed, so threshold scales are reproducible. | Stage 1b | The production aggregate counts from the Stage 1a probe |
| 2 | **SHA and hash tracking.** Define how the `sporely-security-reviewer` APPROVE on the exact Stage 2 SHA, and the migration's SHA-256, carry through later documentation commits and the merge to `main`. Define which changes need a new security review. | Stage 2 | — |
| 4 | **Reference function hash.** Derive the expected `functiondef_sha256` from an isolated local database built from `origin/main` at `f92d560`, not the stale local `main` at `65dff7f`. Never use the shared local database. Compare it with the production probe's `functiondef_sha256`. **Stop if they differ.** The production probe may run without the optional `-v main_sha256`; its `matches_main` is then NULL. Added by owner decision on 2026-10-13. | Stage 1b, before any other Stage 1b work | The production probe output |
| 3 | **Production resource limits and window order.** Set explicit time and resource limits for the Stage 4 production checks, including the full-table input fingerprints. Define the statistics windows' length and order relative to the push. | Stage 4 | — |
