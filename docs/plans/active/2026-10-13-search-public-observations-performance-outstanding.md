# Outstanding requirements: `search_public_observations` performance plan

Companion to `2026-10-13-search-public-observations-performance.md`. The
plan's intake on 2026-10-13 (reviewed tip `21cffd4`) had no blocking
findings. The owner approved running Stage 1a only, and accepted three
recommendations as requirements. Each must be resolved in the plan, and the
revised plan re-run through intake, before the stage named below starts.
Stage 1a does not implement any of them.

| # | Requirement | Resolve before | Input needed |
|---|---|---|---|
| 1 | **Seed scale.** Define the growth factor used to round the seed up, and whether "1×" in Stages 1b and 3 means the observed production counts or the rounded seed, so threshold scales are reproducible. | Stage 1b | The production aggregate counts from the Stage 1a probe |
| 2 | **SHA and hash tracking.** Define how the `sporely-security-reviewer` APPROVE on the exact Stage 2 SHA, and the migration's SHA-256, carry through later documentation commits and the merge to `main`. Define which changes need a new security review. | Stage 2 | — |
| 3 | **Production resource limits and window order.** Set explicit time and resource limits for the Stage 4 production checks, including the full-table input fingerprints. Define the statistics windows' length and order relative to the push. | Stage 4 | — |
