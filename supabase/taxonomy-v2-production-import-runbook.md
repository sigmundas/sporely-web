# Taxonomy-v2 production release import runbook

This runbook prepares the searchable `tax-2026.08.01-01` release locally for a
separately human-authorised production window. The generator does not connect
to Supabase or execute SQL. The generated file contains the complete release
and must remain private and outside Git.

## Prepare locally

From `sporely-web`:

```bash
node scripts/taxonomy-v2/prepare-production-release-import.mjs \
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
