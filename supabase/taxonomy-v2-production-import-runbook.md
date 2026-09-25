# Taxonomy-v2 production release import runbook

This runbook prepares the searchable `tax-2026.08.01-01` release locally for a
separately human-authorised production window. The generator does not connect
to Supabase or execute SQL. The generated file contains the complete release
and must remain private and outside Git.

## Prepare locally

From `sporely-web`:

```bash
node scripts/taxonomy-v2/prepare-production-release-import.mjs \
  --release-id tax-2026.08.01-01 \
  --release-dir ../sporely-py/database/reference_data/generated/taxonomy_v2/global_macrofungi_tax-2026.08.01-01 \
  --output /tmp/taxonomy-v2/tax-2026.08.01-01-import.sql
```

The command reads every JSONL row and refuses mismatched file hashes, byte
counts, row counts, compressed-archive hash, scope-manifest hash, release ID,
or metadata. It creates the SQL with mode `0600` and refuses to overwrite an
existing file or write beneath the repository. Record the printed SQL SHA-256
and independently verify it at operator handoff.

The sparse macrofungi export predates the richer cloud-export manifest shape.
The payload records its original manifest unchanged under `source_manifest`
and adds an explicit `production_import_compatibility` block. Database fields
absent from the sparse format are derived deterministically: schema versions
from format v1, exporter version from the format identifier, generated time as
UTC midnight from the immutable release date, SQLite SHA from the bundled
desktop database, and whole-export SHA from the ordered manifest files.

## Local proof

Use only the disposable local Supabase project:

```bash
supabase db reset --local
TAXONOMY_V2_PRODUCTION_IMPORT_INTEGRATION=1 \
  node --test scripts/taxonomy-v2/production-release-import.test.mjs
```

Expected counts:

| Object | Rows |
|---|---:|
| concepts | 52,917 |
| release-scoped taxa | 52,917 |
| scientific names | 57,769 |
| vernacular names | 3,923 |
| authoritative external IDs | 52,881 |
| legacy namespace-lost IDs | 0 |
| red-list assessments | 2,262 |
| release rows | 1 |
| import runs | 1 |
| active releases | 1 |

The 52,917 taxon rows comprise the 52,881 searchable concepts plus required
classification ancestors. All authoritative external identifiers in this
frozen base release are COL usage IDs. “NorTaxa-backed” search proof therefore
uses a stored NorTaxa scientific-name usage; the separate COL-only proof
requires `col_usage_id` and explicitly requires `nortaxa_taxon_id IS NULL`.

## Human-authorised execution

The generator prints the exact containerised command. It has this form:

```bash
docker run --rm \
  --env-file /path/to/private/production-db.env \
  -v '/tmp/taxonomy-v2:/payload:ro' \
  postgres:17 \
  sh -c 'psql "$DATABASE_URL" --file=/payload/tax-2026.08.01-01-import.sql'
```

The human operator must create the untracked environment file, verify project
ref `zkpjklzfwzefhjluvhfw`, verify the SQL SHA-256, and execute only within the
authorised window. Codex must not run this production command.

The transaction checks schema availability and replay state before inserting a
`loading` release. Six bulk `COPY` streams load the tables in foreign-key-safe
order. It then verifies every count, marks the release `ready`, requires
`taxonomy_v2_validate_release(...).ok`, activates it, requires exactly one
active release, runs representative searches, and proves that legacy taxonomy,
`public.search_taxa`, taxonomy-v3, and observations are unchanged before the
final `COMMIT`.

Replay behavior is fail-closed:

- an identical complete release is reported and stopped without changes;
- the same release ID with different immutable hashes aborts;
- a partial or invalid existing release aborts for manual recovery.

## Release transition: `tax-2026.09.23-01` (desktop 0.9.23)

Desktop 0.9.23 bundles `tax-2026.09.23-01`. The cloud must serve the same
release before that desktop tag is released. The generator takes the release
explicitly (`--release-id`) and refuses any export whose manifests name a
different one; nothing is imported by default.

This is a data import into the existing taxonomy-v2 tables. It adds no
migration and does not depend on the deferred
`20260914090000_extend_reference_snapshots_to_version_2.sql`, which stays
undeployed.

### What changes

Against the active `tax-2026.08.01-01`, the scoped release is purely additive:

| Object | 08.01-01 | 09.23-01 |
|---|---:|---:|
| concepts / release taxa | 52,917 | 52,917 (identical set) |
| scientific names | 57,769 | 57,770 (`Pholiotina rugosa` on 83668) |
| vernacular names | 3,923 | 3,925 |
| authoritative external IDs | 52,881 | 52,884 |
| legacy namespace-lost IDs | 0 | 0 |
| red-list assessments | 2,262 | 2,262 |

The three new external IDs are the reviewed NorTaxa bridges:
`nortaxa/nortaxa_taxon_id/53482 → 7821` (*Entoloma conferendum*),
`52369 → 83668` and `58722 → 83668` (*Conocybe rugosa*). No concept disappears,
so observations bound under either release remain members after a rollback.

### Build the release directory from tracked desktop files

From `sporely-py` at the 0.9.23 release commit. The tracked bundle
`database/reference_data/generated/taxonomy_v2/tax-2026.09.23-01.sqlite3.gz`
(SQLite SHA-256 `2d128d08…a8a7`) is the single source:

```bash
R=/tmp/taxonomy-v2/global_macrofungi_tax-2026.09.23-01
.venv/bin/python -c "from pathlib import Path; from database.taxonomy import cloud_export as ce; \
ce.run_export(artifact_gz=Path('database/reference_data/generated/taxonomy_v2/tax-2026.09.23-01.sqlite3.gz'), \
manifest=Path('database/reference_data/generated/taxonomy_v2/manifest.json'), \
output_dir=Path('/tmp/taxonomy-v2/w1-tax-2026.09.23-01'), policy_dir=Path('database/taxonomy/policies'), \
generated_at='2026-09-23T12:00:00Z')"
.venv/bin/python database/taxonomy/macrofungi_scope.py \
  --policy database/taxonomy/policies/global-macrofungi-scope.yml \
  --source-gz database/reference_data/generated/taxonomy_v2/tax-2026.09.23-01.sqlite3.gz \
  --w1-dir /tmp/taxonomy-v2/w1-tax-2026.09.23-01 --output-dir "$R" \
  --desktop "$R/desktop-tax-2026.09.23-01.sqlite3" --evidence /tmp/taxonomy-v2/scope-evidence.json \
  --release-id tax-2026.09.23-01 --starting-revision 150e9eb
```

Every scoped data file, and the scoped desktop pack (SHA-256
`6a1aff46…70eb`), is byte-identical to the reviewed Stage 3 build; only
source-hash provenance differs, because it records the shipped bundle gzip.

### Prepare, prove locally, and hand over

```bash
node scripts/taxonomy-v2/prepare-production-release-import.mjs \
  --release-id tax-2026.09.23-01 --release-dir "$R" \
  --output /tmp/taxonomy-v2/tax-2026.09.23-01-import.sql
```

Expected table counts: `{"concepts":52917,"taxa":52917,"scientific_names":57770,
"vernacular_names":3925,"external_ids":52884,"legacy_external_ids":0,
"redlist":2262,"releases":1,"import_runs":1,"active_releases":1}`. A release
directory named `global_macrofungi_tax-2026.09.23-01` built as above produced
SQL SHA-256 `6f0c66e9f3132b8503575c489f63e46b93546ebac2a74adfb6884a33ccd280c1`.

Local proof on the disposable stack (deferred migration absent): import
`tax-2026.08.01-01`, then this payload, then confirm as `anon` that
`resolve_taxon_external_id_v2('nortaxa','nortaxa_taxon_id','53482')` returns 7821,
`'52369'` returns 83668, an unbridged id and `'7821'` return nothing,
`search_taxa_v2` finds *Conocybe rugosa*, *Entoloma conferendum*, *Pholiotina
rugosa* and *Cantharellus cibarius*, and a replay stops without changes.

### Production activation (human operator, authorised window only)

The single production write is the containerised `psql` printed by the
generator, run against project `zkpjklzfwzefhjluvhfw` after verifying the SQL
SHA-256. In one transaction it loads the release, marks it `ready`, validates
it, and calls `taxonomy_v2_activate_release('tax-2026.09.23-01')`, which retires
`tax-2026.08.01-01`. Codex and agents must not run it.

Read-only post-checks: exactly one active release, `tax-2026.09.23-01`; the two
`resolve_taxon_external_id_v2` probes above; a `search_taxa_v2` probe.

### Rollback

`taxonomy_v2_activate_release` only accepts a `ready` release, so a retired
release must be made `ready` first. As the operator, in one transaction:

```sql
BEGIN;
UPDATE public.taxonomy_v2_releases SET status = 'ready'
 WHERE release_id = 'tax-2026.08.01-01' AND status = 'retired';
SELECT public.taxonomy_v2_activate_release('tax-2026.08.01-01');
COMMIT;
```

This retires `tax-2026.09.23-01` without deleting it; the same statement with
the release IDs swapped rolls forward. Rows of both releases stay in place, and
the concept set is identical, so no observation loses its selected concept.
