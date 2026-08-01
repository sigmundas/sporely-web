# W2D historical reconciliation — web disposable simulation

**SYNTHETIC FIXTURES ONLY — REAL 337 AUDIT BLOCKED.**

The 337 / 227 / 87 / 23 Phase-A audit counts are hard-coded
`generate_series(...)` constants in
`scripts/taxonomy-v2/run-sparse-registry-experiment.mjs`. No local snapshot
of real historical observations exists in either repo. Per the W2D "no
usable local snapshot" branch, this simulation runs against the **desktop
fixture manifest** (13 records), not real observations.

Real-data audit remains **blocked pending an anonymised snapshot** conforming
to `sporely-py/database/taxonomy/docs/w2d-input-snapshot-contract.md`.

## Input

* Reconciliation manifest:
  `../sporely-py/database/taxonomy/evidence/historical-reconciliation/reconciliation-manifest.json`
* Manifest semantic SHA-256:
  `c4785a25c8690144abd64a75ff369292aaf139dc4030c2ce2ce3df413462d72c`
* Policy SHA-256:
  `c408601f71b7d89de0283c307220b06876d80a7418bbb9089337b6d3941c43d6`
* Taxonomy release: `tax-2026.08.01-01`
* Scope-manifest SHA-256:
  `72758b2c574e8aea27432b6b55c62dfb6ad87f3fadc11ad1c892a61abf23ac4e`
* Records: 13 synthetic fixtures

## Disposable schema

Isolated in `w2d_migration_simulation` (dropped and recreated at start). It
does **not** live under `supabase/migrations/`. No production migration was
created, applied, or authorised.

Tables (contract §6 / §7 / §8):

* `reconciliation_result` — verbatim manifest rows keyed by `observation_id`.
* `registry_concept` — sparse registry (`sporely_taxon_id`, canonical name,
  rank, scope_state, first_materialized_from_release).
* `external_mapping` — `(source_system, namespace, external_id) → sporely_taxon_id`
  with `UNIQUE` on the triple.
* `identification_snapshot` — the immutable original identification snapshot.
  A trigger raises an exception on any UPDATE to `original_*` columns while
  `snapshot_locked = true`.
* `resolution_link` — mutable resolution attaching identity to a snapshot;
  multiple resolution attempts overwrite `resolution_link` but never the
  snapshot.

Functions:

* `apply_reconciliation_manifest(jsonb)` — idempotent apply.
* `simulate_migration(jsonb)` — transactional wrapper with rollback semantics.

## Runner

`scripts/taxonomy-v2/run-w2d-migration-simulation.mjs`

* `--manifest <path>` (default: sibling desktop path)
* verifies `.sha256.txt` before apply
* `--twice` proves idempotency (row counts and snapshot hash invariant)
* `--rollback-simulate` proves rollback safety (zero orphan rows post-failure)

## Tests

`node --test scripts/taxonomy-v2/w2d-migration-simulation.test.mjs`

* 10 non-integration tests pass (manifest shape, deterministic JSON,
  semantic-SHA verification, SQL isolation, SQL literal escaping, external
  mapping derivation).
* 11 integration tests present (skipped by default; run with
  `W2D_INTEGRATION=1` against a local OrbStack-hosted Supabase target
  discovered by `scripts/taxonomy-v2/lib/docker-psql.mjs`). Integration
  coverage:
  * exact resolved observation → concept + mapping, scope_state preserved
  * legacy-mapped resolution preserves chain in `resolution_evidence`
  * synonym fixture cleanly skipped when pinned release lacks the relationship
  * out-of-cache concept materialises with `scope_state=required_ancestor`
  * every unresolved state writes snapshot + `resolution_link`, no
    `registry_concept`
  * conflicting exact evidence writes `resolution_link=conflicting` and
    creates no `registry_concept`
  * later exact resolution preserves original snapshot verbatim
  * applying the manifest twice yields identical row counts and snapshot
    fingerprint (idempotency)
  * rollback simulation leaves zero orphan rows
  * snapshot immutability trigger rejects direct UPDATE of `original_*`

## Aggregate application (against desktop fixture manifest)

Same distribution as the desktop report (13 records):

| primary state | count |
|---|---:|
| resolved_exact | 3 |
| resolved_exact_via_legacy_mapping | 1 |
| resolved_exact_via_synonym_relationship | 0 |
| ambiguous_multiple_candidates | 1 |
| conflicting_exact_evidence | 1 |
| unresolved_external_identifier | 1 |
| unresolved_legacy_identifier | 1 |
| manual_unresolved | 2 |
| no_identity_evidence | 1 |
| source_record_missing | 1 |
| invalid_or_unnamespaced_identifier | 1 |

Migration actions when applied:

* `materialize_existing_taxonomy_v2_concept`: 4
* `manual_review_required`: 2
* `retain_unresolved_without_registry_concept`: 7
* `reuse_existing_registry_concept`: 0 (no pre-registered anchor in this
  fixture set)

## Verdicts

* Determinism (upstream manifest): confirmed byte-identical across desktop runs.
* Idempotency: asserted by integration test; requires local Supabase to run
  the assertion against real Postgres rows.
* Rollback: asserted by integration test.
* Snapshot preservation: asserted by two integration tests + the SQL trigger.
* Out-of-cache materialisation: asserted by integration test; scope_state
  preserved verbatim from the pinned release.

## Production safety

* production Supabase writes: **no**
* production migrations created: **no**
* production migrations applied: **no**
* client cutover: **no**
* legacy taxonomy removed: **no**
* name-only automatic resolutions: **no**

## W3 readiness verdict

**`legacy-source recovery required`.**

The engine, policy, manifest generator, disposable schema, apply function,
and simulation runner are ready to consume an anonymised historical
snapshot deterministically. The real 337-observation audit and its
resulting migration manifest remain blocked until such a snapshot is
produced per the input contract in
`sporely-py/database/taxonomy/docs/w2d-input-snapshot-contract.md`.
