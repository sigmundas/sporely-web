# Shared-reference eligibility for species outside the taxonomy-v3 registry

Status: proposed, not started. Owner decisions in "Open questions" are needed
before implementation. Nothing here has been applied to production.

## Problem

The 2026-09-30 Stage 1B apply promoted two observation identities to species
that are in the active release but could not carry a shared reference
contribution: 617026 *Conocybe vexans* and 55368 *Psilocybe semilanceata*. All
four reference actions ended `new_contribution = 'not_species'`. Both concepts
are rank `species` in `tax-2026.09.30-01`; neither is in
`taxonomy_v3.registry_concept`.

## Findings

### Where eligibility is decided

Every sharing path requires the effective taxon
(`coalesce(selected_sporely_taxon_id, resolved_sporely_taxon_id)`) to be a
`species` row in `taxonomy_v3.registry_concept`:

| Site | Predicate |
|---|---|
| `private.share_reference_contribution_for_owner` (`20260830183210_add_shared_reference_contributions.sql:240-248`) | `registry_concept … rank = 'species'`, else `invalid_taxon` |
| `private.shared_reference_contributions.sporely_taxon_id` (same file, `:13-14`) | FK to `registry_concept`, `ON DELETE RESTRICT` |
| `private.refresh_shared_references_for_observation_taxon()` (same file, `:880-885`) | registry species pre-check before re-sharing on a taxon change |
| Historical backfill (`20260831150330_…:53-58`) | same join, applied once |
| Stage 1B repair (`20260930193000_…:352-358`) | same predicate, labelled `not_species`, "the same eligibility the owner path applies" |
| Curated library tables (`20260829141735_add_curated_reference_library.sql:125,176`) | FK to `registry_concept` |
| Public curated reads (`20260829220943_add_public_curated_reference_reads.sql:59,481`) | `JOIN registry_concept … rank = 'species'` for species pages and search |

No client (`src/`) or landing-site code checks the registry. The gate is
entirely server-side.

### Registry versus release

- `taxonomy_v3.registry_concept` (209 rows in production) is a sparse,
  append-only anchor set. Rows come only from reviewed paths: the historical
  reconciliation manifest (`20260802120000_add_taxonomy_v3_core.sql:296-414`),
  supplement anchors, and the hash-checked retired-concept repair
  (`20260930202803`). It is the FK target of
  `observations.resolved_sporely_taxon_id` and `taxonomy_v3.resolution_link`.
- `public.taxonomy_v2_concepts` is also cumulative and stable (keyed by
  `first_seen_release_id`; nothing but a test script deletes from it).
  `observations.selected_sporely_taxon_id` references it
  (`20260802130000_add_taxonomy_v2_client_selection.sql:4-5`). The active
  release (`taxonomy_v2_taxa`, 52,917 concepts, 49,557 species) is what owners
  pick from.

So an owner can select any release species, but only the ~98 registry species
that are also in the release can be shared.

### Intentional or legacy

Both, in different parts:

- **Intentional:** keying contributions and curated publications to a stable,
  release-independent id with `ON DELETE RESTRICT`. The contract
  (`docs/supabase-sync-contract.md:5-11`) requires "an exact stable species
  identity".
- **Legacy gap:** choosing the v3 registry as that id. Shared contributions
  (`0a50364`, 2026-08-30) reused the curated-library schema (`11637a4`,
  2026-08-29), which keys everything to the v3 registry. Both came four weeks
  after clients had cut over to v2 selection (`6297d3c`, 2026-08-02), so
  owner-selected identities were v2 concepts from the start. No plan or
  contract says owner-selected release species must be excluded; the
  contract's wording covers them. The Stage 1B label
  `not_species` is wrong for these cases: the concept is a species, it is just
  not anchored.

### Sharing is automatic

There is no per-contribution opt-in. The `observation_reference_uses` trigger
and `refresh_shared_reference_for_use_row` share whenever an owner syncs an
active reference use on an observation with an eligible species (contract:
"the server snapshots that source as an immutable, attributed
shared-contribution revision"; revisions are retained indefinitely). The
registry gate therefore also limits how many owners' reference sources become
public. Widening eligibility widens automatic, attributed, long-lived public
exposure. This is the main decision.

### Production today (read-only, 2026-09-30)

| Observations with live reference uses | Count | Taxa |
|---|---:|---:|
| No effective taxon | 28 | — |
| Registry species (eligible) | 2 | 1 |
| Release species not in registry (blocked) | 2 | 2 (617026, 55368) |

Shared contributions: 2, one taxon. Registry: 103 species rows (98 in the
release, 5 not), 4 genus, 102 unranked NorTaxa-derived anchors. The 28
observations without any taxon id are a separate gap and out of scope.

## Options

**A. Keep the registry as the anchor; materialise a registry row on demand.**
When the effective taxon is not in the registry but is `rank = 'species'` in
the active release, insert a sparse row from the release (canonical name,
rank, `scope_state = 'not_evaluated'`, `cache_state = 'out_of_cache'`,
`first_materialized_from_release` = active release), the same shape the
retired-concept repair wrote for 15 survivors. No FK changes.

**B. Retarget eligibility and FKs to `taxonomy_v2_concepts` + active-release
rank.** Viable, since v2 concepts are cumulative, but it touches FKs on
contributions and curated tables (with an `integer` to `bigint` type change),
the public read joins and the backfill semantics. Larger, and it splits
curated identity across two taxonomies.

**C. Keep the gate; fix only the label** (`not_species` →
`not_registry_species`) and add species to the registry through reviewed
operator steps. Least exposure change. Owners stay unable to share most
species.

**Recommendation: A**, only if the owner confirms that automatic sharing
should cover every species in the active release. Otherwise C.

## Plan for option A (one stage)

1. **Migration** (new, additive, via the deploy tree):
   - `private.ensure_registry_species_from_active_release(p_sporely_taxon_id)`:
     returns true when a registry `species` row exists or has just been
     inserted from the active release's `taxonomy_v2_taxa` (`rank =
     'species'`, non-blank canonical name). Returns false for non-species, for
     concepts missing from the active release, and when no release is active.
     Uses `INSERT … ON CONFLICT DO NOTHING`, then re-reads, and refuses when an
     existing row disagrees on name or rank (no silent overwrite).
   - `CREATE OR REPLACE` `share_reference_contribution_for_owner`, the trigger
     function at `:880-885`, and the Stage 1B helper to call it before their
     registry checks. Keep `rank = 'species'` only (no subspecies, variety or
     form).
   - Stage 1B: record `not_registry_species` rather than `not_species` for the
     unanchored case in future runs.
   - Same execution surface as today: postgres-owned, `search_path = ''`, no
     new grants.
2. **Retiring-concept check:** add `private.shared_reference_contributions`
   and the curated tables to the pre-import check template, since on-demand
   anchors can later be retired by a supersession.
3. **Existing blocked cases** (617026, 55368): either wait for the owners'
   next sync, which re-shares through the trigger, or run a reviewed,
   dry-run-first operator step that calls `refresh_shared_reference_for_use_row`
   for exactly those uses. Owner decision.

### Tests

- `supabase/tests/shared_reference_contributions_test.sql`: a release species
  absent from the registry now shares and materialises exactly one row with
  the expected values; genus, variety, a concept outside the active release,
  and a retired concept still refuse; banned owner and withdrawn source are
  unchanged; an existing row with a different name refuses.
- `supabase/tests/public_curated_reference_reads_test.sql`: a materialised
  species appears in species-page reads and search.
- `supabase/tests/taxon_identity_repair_test.sql`: a promotion to an
  unanchored release species shares; label for the genuinely non-species case.
- `supabase/tests/shared_reference_backfill_test.sql`: unchanged behaviour.
- Installer interplay: a later manifest install for the same id with the same
  name succeeds (merge idiom in `20260802120000`), and with a different name
  still raises.

### Migration and rollout implications

- Additive; no data migration. New registry rows appear only when an owner
  shares (or through step 3).
- Registry meaning widens from "reviewed historical anchors" to also "species
  an owner has shared against". Record this in
  `docs/taxonomy-v2-cloud-contract.md`.
- **Risk:** canonical-name drift. Registry names freeze at first
  materialisation, and a later v3 manifest with a different name for the same
  id raises an identity conflict. Canonical names are stable per concept today
  (the 09.30-01 probes check it), but a future release that renames a concept
  needs a reviewed registry update.
- Rollback: restore the previous function bodies. Materialised rows are
  harmless anchors; contributions created meanwhile can be withdrawn by the
  owner or through moderation.

## Worked examples

| | 617026 *Conocybe vexans* | 55368 *Psilocybe semilanceata* |
|---|---|---|
| Identity today | `selected_sporely_taxon_id` set by Stage 1B run 1 (NorTaxa 58766, 2 observations) | set by Stage 1B run 1 (NorTaxa 55311, 1 observation) |
| Release | species in `tax-2026.09.30-01` (display *Pholiotina vexans* in `no`) | species in `tax-2026.09.30-01` |
| Registry | absent | absent |
| Today | `invalid_taxon`; Stage 1B logged 3 × `not_species` | `invalid_taxon`; 1 × `not_species` |
| Option A | first share inserts registry row (617026, "Conocybe vexans", species, not_evaluated, out_of_cache, tax-2026.09.30-01), then creates the contribution, public under the canonical name | same, row (55368, "Psilocybe semilanceata", …) |
| Option C | stays private until a reviewed step anchors 617026 | stays private |

## Open questions for the owner

1. Should automatic, attributed public sharing cover every species in the
   active release, as the contract's wording implies, or stay limited to
   reviewed anchors? This decides A versus C.
2. Scope state for materialised rows: `not_evaluated` (matches existing
   anchors) or `review` (flags them for later audit)?
3. The two blocked observations: wait for the owners' next sync, or run a
   reviewed operator step?
