# Shared-reference eligibility for species outside the taxonomy-v3 registry

Status: proposed, reviewed (general and security review of `758478b`, both
"needs changes"; this revision incorporates them). Not started. The owner
decisions under "Open questions" come first. Nothing here has been applied to
production.

## Problem

The 2026-09-30 Stage 1B apply promoted observation identities to two species
that are in the active release but cannot carry a shared reference
contribution: 617026 *Conocybe vexans* and 55368 *Psilocybe semilanceata*. The
four reference actions it logged (3 for 617026, 1 for 55368) all ended
`new_contribution = 'not_species'`. Both concepts are rank `species` in
`tax-2026.09.30-01`; neither is in `taxonomy_v3.registry_concept`.

## Findings

### Where eligibility is decided

Sharing requires the effective taxon
(`coalesce(selected_sporely_taxon_id, resolved_sporely_taxon_id)`) to be a
`species` row in `taxonomy_v3.registry_concept`:

| Site | Predicate |
|---|---|
| `private.share_reference_contribution_for_owner` (`20260830183210_add_shared_reference_contributions.sql:240-248`) | registry `rank = 'species'`, else `invalid_taxon`. Runs **before** the use check (`:249-260`) |
| `private.shared_reference_contributions.sporely_taxon_id` (same file, `:13-14`) | FK to `registry_concept`, `ON DELETE RESTRICT` |
| `private.refresh_shared_references_for_observation_taxon()` (same file, `:880-885`) | registry species pre-check before re-sharing on a taxon change |
| Historical backfill (`20260831150330_…:53-58`) | same join, applied once |
| Stage 1B repair (`20260930193000_…:352-358`) | same predicate, labelled `not_species` |
| Curated library (`20260829141735_add_curated_reference_library.sql:125,176`, `curated_require_species_taxon` `:392-410`), publication lifecycle (`20260829190945_…:497,536,629`), workspace reads (`20260829202939_…:152`) | FK / species checks against `registry_concept` |
| Public curated reads (`20260829220943_add_public_curated_reference_reads.sql:59,481`) | `JOIN registry_concept … rank = 'species'` |

There are two entry points:
- **Automatic:** the `observation_reference_uses` trigger calls
  `refresh_shared_reference_for_use_row` whenever an owner syncs an active use.
- **Explicit:** `public.share_reference_contribution`, granted to
  `authenticated` (`:996`). The desktop client calls it
  (`sporely-py/utils/cloud_sync.py:16461`).

No `src/` or landing-site code checks the registry. Neither path checks the
observation's `visibility` or `is_draft`. The share path doesn't check release
membership either, so all 103 registry species rows are shareable.

### Registry versus release

- `taxonomy_v3.registry_concept` (209 rows) is a sparse, append-only anchor
  set. Its rows come only from reviewed paths:
  - the historical reconciliation manifest (`20260802120000_add_taxonomy_v3_core.sql:296-414`);
  - supplement anchors;
  - the hash-checked retired-concept repair (`20260930202803`, audited in
    `retired_resolution_repair_registry_additions`).

  It is the FK target of `observations.resolved_sporely_taxon_id` and
  `taxonomy_v3.resolution_link`. `canonical_name` and `rank` may be NULL (102
  unranked anchors). The installer fills in NULLs but never changes existing
  `scope_state` or `cache_state` (`:305-311,396-401`).
- `public.taxonomy_v2_concepts` is cumulative and stable: `bigint` primary key
  (`20260724130000_…:58-61`), and only a test script deletes from it.
  `observations.selected_sporely_taxon_id` references it
  (`20260802130000_…:4-5`). Owners pick from the active release in
  `taxonomy_v2_taxa` (`taxon_rank`, `canonical_scientific_name`; 52,917
  concepts, 49,557 species).

### Intentional or legacy

- **Intentional:** keying contributions and curated work to a stable,
  release-independent id with `ON DELETE RESTRICT`. The contract
  (`docs/supabase-sync-contract.md:5-11`) requires "an exact stable species
  identity".
- **Legacy gap:** using the v3 registry as that id.
  - Shared contributions (`0a50364`, 2026-08-30) reused the curated-library
    schema (`11637a4`, 2026-08-29), which keys everything to the registry.
    Both came four weeks after clients cut over to v2 selection (`6297d3c`,
    2026-08-02).
  - No plan or contract excludes owner-selected release species.
  - The Stage 1B label `not_species` is wrong for these cases: the concept is
    a species, just not anchored.

### What sharing publishes

Each shared contribution is readable by anyone, signed in or not
(`:999-1000`). It carries:
- the contributor's stable account id and username, or "Sporely user" when
  the username is blank or contains `@` (`:141-151,175-178`);
- the full citation (work, authors, editors, publisher) and exports;
- the measurement set, including projected raw points;
- the species it is filed under.

Revisions are immutable and kept indefinitely. Withdrawal, moderation and
account deletion still apply (`:437,469,516,570-579`; `owner_id ON DELETE SET
NULL`).

Because visibility is never checked, a contribution publicly reveals, under
the owner's name, that they hold an observation identified as that species,
even when the observation is private or a draft. I found no owner-facing
text in `src/` or `sporely-py/ui` saying that attaching or plotting a
reference publishes it. **This is an existing privacy issue at today's
eligibility** (2 owners). Widening eligibility would multiply it.

### Production today (read-only, 2026-09-30)

| Observations with live reference uses | Count | Taxa |
|---|---:|---:|
| No effective taxon | 28 | — |
| Registry species (eligible) | 2 | 1 |
| Release species not in registry (blocked) | 2 | 2 (617026, 55368) |

- **Contributions:** 2 shared, both under one taxon.
- **Registry:** 103 species rows (98 also in the release), 4 genus, and 102
  unranked NorTaxa-derived anchors.
- **Out of scope:** the 28 observations without any taxon id are a separate
  gap.

## Options

**C. Keep the gate (recommended now).** Fix the misleading Stage 1B label
(`not_species` → `not_registry_species`) and make no change to exposure.
Anchor individual species only through reviewed operator steps.

**A′. Widen through on-demand anchors, but only after consent.** Option A,
corrected per review:
- **Materialise only at the last step:** create the registry row inside
  `share_reference_contribution_for_owner`, immediately before the
  contribution insert, after the use, snapshot and revision checks have all
  passed. A refused share must leave no row. Never create rows from the
  explicit RPC before those checks, nor from the taxon-change trigger.
- **Trigger:** replace the `:880-885` pre-check with a read-only "species in
  active release, or registry species" lookup.
- **Row values:** name and rank come only from the active release. Add an
  origin marker (for example `first_materialized_from_release =
  'shared-reference:<release>'` or a new column) and an audit table like
  `retired_resolution_repair_registry_additions` (taxon, release, time; no
  owner id).
- **Conflicts:** never modify an existing row. An existing row with NULL rank
  or a different name is not eligible, fails closed and is logged.
- **Stage 1B:** record the refusal as an outcome; never let `invalid_taxon`
  reach the `RAISE` branch (`20260930193000_…:388-391`).
- **Installer:** define a reviewed rename path for rows with the new origin,
  so a later release that renames such a species doesn't fail with an
  identity conflict.
- **Execution surface:** `REVOKE ALL … FROM PUBLIC, anon, authenticated,
  service_role` on the new helper, `search_path = ''`, postgres-owned.
- **Consent gate (required):**
  - an in-app notice before the first automatic share;
  - a server-side per-account opt-in, or at least an opt-out, checked in
    `share_reference_contribution_for_owner`;
  - an owner decision on whether private and draft observations may share at
    all.

**B. Retarget FKs to `taxonomy_v2_concepts`.** Viable, since v2 concepts are
cumulative. But it changes FKs on contributions and curated tables
(`integer` to `bigint`), the public read joins and the backfill semantics,
and it splits curated identity across two taxonomies. Not recommended.

**Recommendation:**
1. Now: do C.
2. Separately, and first: fix the existing visibility/consent gap for today's
   eligibility.
3. Only after that, and only if the owner wants wider sharing: implement A′.

## Plan

### Stage 1 (C, small)

- **Migration:** `CREATE OR REPLACE` the Stage 1B helper so the unanchored
  case records `not_registry_species` and a genuine non-species keeps
  `not_species`. Deploy via the deploy tree.
- **Tests:** `taxon_identity_repair_test.sql` (both labels).

### Stage 2 (privacy baseline, before any widening)

Needs owner decisions 1 and 2. Once decided:
- add the consent flag and notice (web `src/` and desktop `sporely-py`);
- apply the visibility rule in `share_reference_contribution_for_owner` and
  the backfill semantics;
- decide what happens to the 2 existing contributions under the new rule.

Its own plan and security review.

### Stage 3 (A′, optional)

As specified above. Tests in `supabase/tests/shared_reference_contributions_test.sql`:
- a release species not in the registry shares and creates exactly one row,
  with origin and audit;
- the explicit RPC with no matching use creates **no** registry row;
- genus, variety, a concept outside the active release, an existing NULL-rank
  anchor and a name mismatch all refuse and leave no row;
- `search_public_reference_contributions` returns the new contribution;
- banned owner, withdrawal and account deletion are unchanged.

Also:
- a two-owner race for the same new species (pattern of
  `taxon_identity_repair_concurrency_test.sh`);
- `retired_resolution_repair_test.sql`: its plain INSERT when the survivor row
  already exists;
- `taxon_identity_repair_test.sql`: a promotion to an unanchored species
  shares, and a refusal is an outcome, not an abort;
- installer tests for the rename path.

Curated creation and publication become possible for materialised species;
state this in `docs/taxonomy-v2-cloud-contract.md`.

### Release checks

Retiring-concept checks are per-release files
(`supabase/taxonomy-v3-tax-2026.09.30-01-retiring-concept-check.sql:153-158`).
The next one should also count `private.shared_reference_contributions` and
the curated tables. The gap already applies to all 209 anchors, whichever
option is chosen.

### The two blocked cases

Waiting for the owners' next sync does not help: an unchanged payload returns
`no_change`, and the taxon trigger skips unchanged ids (`:848-851`). They stay
private until the owner edits them or a reviewed operator step shares them. Do
that only after Stage 2 and the owner's decision.

### Rollback

- **Stage 1:** revert the label.
- **Stage 3:** restore the previous function bodies. Materialised rows stay
  (they're FK targets and publicly readable, so a row is a lasting hint that
  someone once shared under that species). Contributions can be withdrawn.

## Worked examples

| | 617026 *Conocybe vexans* | 55368 *Psilocybe semilanceata* |
|---|---|---|
| Identity | `selected_sporely_taxon_id` set by Stage 1B run 1 (NorTaxa 58766, 2 observations) | set by Stage 1B run 1 (NorTaxa 55311, 1 observation) |
| Release | species in `tax-2026.09.30-01` (display *Pholiotina vexans* in `no`) | species in `tax-2026.09.30-01` |
| Registry | absent | absent |
| Today | Stage 1B's pre-check logged 3 × `not_species` and never called the share path; no contribution | 1 × `not_species`; no contribution |
| After C | label becomes `not_registry_species` in future runs; still private | same |
| After A′ (with consent) | an operator step (or the owner's next edit) creates row (617026, "Conocybe vexans", species, origin shared-reference, `tax-2026.09.30-01`) plus audit, then an attributed public contribution under *Conocybe vexans* | same for 55368. This is a sensitive species, and publishing it under the owner's name is exactly the exposure the consent gate must cover |

## Open questions for the owner

1. **Wider sharing:** should automatic, attributed public sharing reach
   species beyond the reviewed registry at all? This decides C versus A′.
2. **Consent and visibility:** opt-in, opt-out or notice only? And may private
   or draft observations share? This applies today, whatever the answer to
   question 1.
3. **Row values (A′ only):** scope state for materialised rows:
   `not_evaluated`, `review`, or NULL (which the installer can still fill in
   later)? These values are permanent.
4. **The two blocked cases:** anchor and share them through a reviewed
   operator step after Stage 2, or leave them private?
