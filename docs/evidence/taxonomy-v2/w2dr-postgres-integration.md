# W2D-R PostgreSQL integration proof

**Status:** PostgreSQL proof complete; real historical audit blocked pending an authorized anonymized snapshot.

## Environment

* Supabase CLI: 2.98.2 (local disposable stack)
* Docker: OrbStack 29.4.0
* Target: 127.0.0.1 only — no hosted Supabase project, no production credentials, no production URL, no production database
* Discovery: `scripts/taxonomy-v2/lib/docker-psql.mjs` `discoverLocalTarget`

## Manifest under test

Synthetic fixture manifest from the desktop repo:

* Path: `../sporely-py/database/taxonomy/evidence/historical-reconciliation/reconciliation-manifest.json`
* Semantic SHA-256: `c4785a25c8690144abd64a75ff369292aaf139dc4030c2ce2ce3df413462d72c`
* Record count: 13 synthetic fixtures — **not** real observations

## Test results

```
node --test scripts/taxonomy-v2/w2d-migration-simulation.test.mjs                  → 10/10 pass, 11 skipped (integration off)
W2D_INTEGRATION=1 node --test scripts/taxonomy-v2/w2d-migration-simulation.test.mjs → 21/21 pass, 0 skipped, 5.14 s
```

All 11 previously skipped PostgreSQL integration tests now execute and pass.

## Lifecycle proofs (verified against real PostgreSQL rows and constraints)

| proof | status | how verified |
|---|---|---|
| Exact resolved identity materializes expected registry concept | ✓ | `exact resolved observation materialises concept + mapping with scope_state preserved` |
| Legacy-mapped resolution preserves evidence chain | ✓ | `legacy-mapped resolution preserves the chain in resolution_evidence` |
| Unresolved states create no registry concept | ✓ | `every unresolved state writes snapshot + resolution_link without registry_concept` |
| Conflicting exact evidence creates no registry concept | ✓ | `conflicting exact evidence writes resolution_link=conflicting and creates no registry row for the ambiguous concept` |
| Namespaced mapping uniqueness enforced | ✓ | UNIQUE `(source_system, namespace, external_id)` constraint exercised by idempotent second apply |
| Same raw id in separate namespaces remains distinct | ✓ | Same test asserts (source_system, namespace) segregation |
| Out-of-cache identity materializes without entering the cache | ✓ | `out-of-cache concept materialises with scope_state=required_ancestor` |
| Later exact resolution preserves original snapshot | ✓ | `later exact resolution preserves the original snapshot verbatim` |
| Snapshot immutability trigger rejects `original_*` mutation | ✓ | `snapshot immutability trigger rejects direct UPDATE to original_*` |
| Applying same manifest twice is idempotent | ✓ | `idempotency — applying the fixture manifest twice yields identical row counts and snapshot fingerprint` |
| Rollback leaves zero partial or orphaned rows | ✓ | `rollback simulation leaves zero orphan rows` |

Idempotency and rollback record row-count and snapshot-fingerprint invariants
before and after each transaction inside the test bodies; failing invariants
would fail the assertion. Rollback deliberately induces a constraint violation
inside `simulate_migration` to exercise the transactional wrapper.

## Real-data audit

**Not performed.** No human-authorized anonymized snapshot has been supplied.
The synthetic 13-fixture manifest was used solely to exercise the disposable
schema and lifecycle invariants. Applying the manifest to the disposable schema
is not a substitute for a real-data audit.

Source-recovery tooling to unblock the real audit lives in the desktop repo
under `database/taxonomy/reconciliation/snapshot/` and
`database/taxonomy/docs/w2d-input-snapshot-contract.md`.

## Safety

* production Supabase accessed: **no**
* production writes: **no**
* production migrations created: **no**
* production migrations applied: **no**
* client cutover: **no**
* real observation rows modified: **no**
