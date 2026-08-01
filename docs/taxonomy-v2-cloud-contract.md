# Taxonomy v2 cloud contract

## Status and boundary

This document records the additive W2A experiment in migration
`20260724130000_add_taxonomy_v2_schema_and_search.sql`. The legacy
`public.taxa`, `public.taxa_vernacular`, and `public.search_taxa(text,text,integer)`
path remains active. No client uses taxonomy v2 yet, and no complete W1 release
or production release is loaded or activated in W2A.

W2A added the schema, fixture-tested validation/activation, prefix search, and
authoritative resolver. W2B proved the importer and complete local load, but
also proved that the complete global-Fungi production scope is inappropriate.
W2C is redefined as global macrofungi scope plus sparse-registry design. W3
owns observation identity and sync/backfill. W4 owns the web picker and
Artsorakel integration. Client
cutover and legacy removal remain W5 work.

W2C Phase B is now complete as a disposable local experiment. It recommends
S2: a persistent sparse registry plus a replaceable compact macrofungi cache.
This is architecture evidence, not a production migration or activation. A
separate historical taxonomy reconciliation stage is required before W3 because
none of the 337 audited observations currently has stable taxonomy-v2 identity.

## Historical W2A Model B decomposition

Model B describes what W2A and W2B tested. It is not the selected production
architecture and must not be deployed merely because its importer is valid.

`taxonomy_v2_concepts` stores only stable positive `sporely_taxon_id` identity,
its first-seen release, and creation time. All mutable taxonomy content is
release-scoped:

- `taxonomy_v2_releases`: W1 provenance, hashes, lifecycle, expected counts,
  dangling-parent audit, source manifest, and operational timestamps.
- `taxonomy_v2_taxa`: canonical name, hierarchy, rank, family, status, and
  canonical source snapshot, keyed by `(release_id, sporely_taxon_id)`.
- `taxonomy_v2_scientific_names`: preferred names and aliases; W1 `note` maps
  without reinterpretation to `alias_reason`.
- `taxonomy_v2_vernacular_names`: literal language-tagged names.
- `taxonomy_v2_external_ids`: authoritative namespaced identifiers and the only
  external-ID input to automatic resolution.
- `taxonomy_v2_legacy_external_ids`: namespace-lost audit/compatibility rows.
- `taxonomy_v2_redlist`: assessment snapshots and enrichment, never identity.
- `taxonomy_v2_import_runs`: credential-free W2B operational audit records.

The exact columns, constraints, keys, indexes, comments, RLS, and grants are in
the migration and generated `supabase/schema.sql` snapshot. Release-scoped child
tables have composite foreign keys to `taxonomy_v2_taxa`. Taxa reference stable
concepts. `parent_sporely_taxon_id` intentionally has no self-FK: W1 preserves
the accepted dangling parent `150361` for Fungi concept `152331`.

### Exact table fields and keys

- `taxonomy_v2_releases`: `release_id text` PK;
  `taxonomy_schema_version integer`; `export_schema_version integer`;
  `manifest_schema_version integer`; `exporter_version text`;
  `scope_predicate_id text`; `source_gz_sha256 text`;
  `source_sqlite_sha256 text`; `whole_export_sha256 text` unique;
  `manifest_sha256 text`; `generated_at timestamptz`; `status text`;
  `row_counts jsonb`; `authoritative_namespace_counts jsonb`;
  `legacy_source_counts jsonb`; `dangling_parent_count bigint`;
  `dangling_parent_report jsonb`; `source_manifest jsonb`; and nullable
  lifecycle fields `loaded_at`, `activated_at`, `failed_at`, and
  `failure_message`, plus `created_at default now()`.
- `taxonomy_v2_concepts`: positive `sporely_taxon_id bigint` PK,
  `first_seen_release_id text` FK, and `created_at default now()`.
- `taxonomy_v2_taxa`: composite PK `(release_id, sporely_taxon_id)`;
  `parent_sporely_taxon_id`; non-null default-empty `genus` and
  `specific_epithet`; nullable `family`, `canonical_scientific_name`,
  `taxon_rank`, `taxonomic_status`, and `source_system`; non-null
  `canonical_source_system` and `canonical_external_id`.
- `taxonomy_v2_scientific_names`: `release_id`, `sporely_taxon_id`,
  `language_code`, `scientific_name`, `is_preferred_name`, nullable `source`
  and `alias_reason`; unique on release, taxon, language, and name.
- `taxonomy_v2_vernacular_names`: `release_id`, `sporely_taxon_id`,
  `language_code`, `vernacular_name`, `is_preferred_name`, nullable `source`;
  unique on release, taxon, language, and name.
- `taxonomy_v2_external_ids`: `release_id`, `sporely_taxon_id`, nonblank
  `source_system`, `namespace`, and `external_id`; `id_role`, `is_preferred`,
  nullable `external_name` and `note`; unique on release, namespaced external
  key, and taxon.
- `taxonomy_v2_legacy_external_ids`: the same audit fields except namespace,
  with no uniqueness/lookup contract beyond its release/taxon index.
- `taxonomy_v2_redlist`: release/taxon; source system/release, assessment ID
  and area; assessed-name source/namespace/ID; scientific-name, authorship, and
  rank snapshots; raw/code/downgrade category; criteria, expert group, and URL;
  unique on release, source system/release, and assessment ID.
- `taxonomy_v2_import_runs`: identity `id bigint` PK; nullable `release_id` FK;
  start/finish timestamps; status; importer version; source directory;
  whole-export hash; count and relation-size JSON; error message. It contains
  no credential or connection-string field.

## Release metadata and lifecycle

Release IDs match `tax-YYYY.MM.DD-NN`; taxonomy schema version is exactly 2;
all four SHA-256 fields are 64 lowercase hexadecimal characters; the whole
export hash is unique. Status is `loading`, `ready`, `active`, `retired`, or
`failed`. A partial unique index permits zero or one active release.

Count JSON objects are flat, non-negative integer maps:

- `row_counts` keys are the six W1 child filenames: `taxon.jsonl`,
  `scientific_name.jsonl`, `vernacular.jsonl`, `taxon_external_id.jsonl`,
  `taxon_external_id_legacy_integer.jsonl`, and `taxon_redlist.jsonl`.
- authoritative keys are `source_system/namespace`.
- legacy keys are `source_system` only.

`taxonomy_v2_validate_release(p_release_id text) returns jsonb` reports `ok`,
`release_id`, `status`, `expected_counts`, `actual_counts`, and an error array.
It checks existence; ready/active status; schema version; exact dataset,
authoritative namespace, and legacy source counts; dangling parents; stable
concept coverage; child integrity; nonblank authoritative identifier parts;
authoritative semantic uniqueness; and that deployed search/resolver definitions
do not refer to the legacy-ID table. Database keys also enforce every child-to-
taxon relationship.

`taxonomy_v2_activate_release(p_release_id text) returns jsonb` takes a dedicated
transaction advisory lock, locks the target and active release rows, requires a
`ready` target, and invokes the same validator. Validation failure raises before
any active row changes. Success retires the old active row, activates the target,
and sets `activated_at` in the same transaction. The unique partial index is the
concurrent one-active backstop. W2A activates fixtures locally only.

## Search and language behavior

`search_taxa_v2(q text, lang text default 'no', lim integer default 20)` is a
stable security-definer prefix-search RPC over the active release only. With no
active release it returns no rows. It trims the query, rejects queries shorter
than two characters, and clamps the limit to 1–50.

It ranks one best match per stable concept as follows:

1. canonical scientific exact;
2. scientific-name/alias exact;
3. preferred vernacular exact;
4. non-preferred vernacular exact;
5. canonical scientific prefix;
6. scientific-name/alias prefix;
7. preferred vernacular prefix;
8. non-preferred vernacular prefix.

Distinct IDs are never collapsed. Equal-rank ordering prefers COL-canonical
concepts only as a tie-break, followed by canonical scientific name, rank, and
Sporely ID. Match fields describe the actual candidate. Scientific matches pick
a display vernacular independently.

Blank/null language means `no`. The `no` query umbrella selects literal `nb`,
then `nn`, then stored `no`; `nb`, `nn`, `se`, `sma`, and `smj` remain separate.
Other language codes are matched as exact trimmed literals. No stored code is
rewritten and no `no` row is synthesized. There is no unaccent, transliteration,
fuzzy matching, infix matching, or name-based concept identity in W2A.

Convenience `col_usage_id` and `nortaxa_taxon_id` values come only from exact
`col_xr/col_usage_id` and `nortaxa/nortaxa_taxon_id` authoritative rows.

## Authoritative external-ID resolution

`resolve_taxon_external_id_v2(p_source_system text, p_namespace text,
p_external_id text)` searches the active release's `taxonomy_v2_external_ids`
only. It trims outer whitespace, requires nonblank inputs, and compares source,
namespace, and identifier exactly and case-sensitively. It returns every match,
preferred mappings first and then Sporely ID. It has no scientific-name fallback.

Namespace-lost legacy integer rows are audit data only. Numeric equality does
not establish identity. They are never read by search, resolution, or Red List
logic, and the legacy table has only a release/taxon operational index.

## Security

RLS is enabled on all nine tables. `PUBLIC`, `anon`, and `authenticated` have
explicitly revoked table access and no policies; `service_role` retains import
and operational table access. Normal clients use RPCs only.

All security-definer functions set `search_path = public, pg_catalog` and have
execution revoked from `PUBLIC`. Search and resolver are granted to `anon`,
`authenticated`, and `service_role`. Validation and activation are service-role
only. Database-owner operations remain available.

## W2B verdict and approved cloud direction

W2B imported the complete accepted W1 artifact locally and recorded
`pg_relation_size`, `pg_indexes_size`, and `pg_total_relation_size` for every new
taxonomy table and index. It must calculate:

```text
projected production total
= current production database bytes
+ measured taxonomy-v2 relation and index bytes
```

The additive projection must not subtract legacy taxonomy storage. Stop for an
explicit capacity decision if projected total is at least 350 MiB, or if
headroom below a 500 MiB limit is under 150 MiB. JSONL byte size is not a valid
database-size estimate.

The pinned `tax-2026.07.30-02` artifact is historical broad-scope evidence, not
a production candidate. Its complete-Fungi scope and the W2A table model are
rejected for production. The importer remains valid as an importer experiment.
No production taxonomy write or activation is authorized, and W3 remains
blocked.

The approved direction is external discovery plus a sparse internal Sporely
taxon registry, observation identification snapshots, and an optional compact
global macrofungi search cache. Catalogue of Life XR remains the complete pinned
identity/reconciliation backbone and may remain an immutable build artifact.
Supabase must not store the complete global fungal catalogue. The desktop may
distribute a substantially broader offline reference, but it must be a reviewed
macrofungi subset rather than the entire Fungi kingdom. Plants are outside
taxonomy-v2 and the macrofungi search pack.

Supabase materializes a concept only when used by an observation, selected via
an external service, received through desktop sync, accepted through a manual
resolution, explicitly curated, or placed in an approved small cache. The row
retains a Sporely ID, canonical snapshot, namespaced mappings, selected-name
snapshots, provenance, scope reason, and review state. Scientific-name equality
never establishes identity.

iNaturalist may support international discovery and Artsorakel image
identification. NorTaxa supplies Norwegian mappings/names, Artsorakel
reconciliation, and legacy continuity. National Red Lists supply regional
conservation enrichment only. These sources never replace COL or filter the
global macrofungi scope.

## W2B importer and runbook

W2B adds a Node 22 standard-library importer under `scripts/taxonomy-v2/`. It
discovers exactly one running database container from the current Supabase
project label through the active Docker-compatible CLI/context. It does not
assume Docker Desktop, OrbStack, or any context name. It verifies the project,
database, PostgreSQL version, W2A table, and migration before writes, then runs
container `psql` through `docker exec -i` without a TTY.

The importer performs full manifest/hash/type preflight before opening its main
transaction. It takes advisory lock `846920026072413003`, stages one JSONL file
at a time through CSV COPY using control-character delimiter/quote bytes, inserts
explicit typed columns, clears staging, marks the release ready, calls the W2A
validator, and commits. It never activates. Audit statuses are `running`,
`succeeded`, `failed`, and `verified_existing`; stored source directories are
basenames only and failures are sanitized.

Prerequisites and reproducible workflow:

```bash
docker version
docker context show
npm run check:node
npx supabase db reset

npm run taxonomy:v2:import -- \
  --source ../sporely-py/database/reference_data/generated/taxonomy_v2/cloud_export_tax-2026.07.30-02 \
  --release tax-2026.07.30-02

npm run taxonomy:v2:measure -- \
  --release tax-2026.07.30-02 --activate-local \
  --output docs/evidence/taxonomy-v2/w2b-tax-2026.07.30-02.json
```

Local activation is an explicit measurement option and is prohibited for a
remote target. Exact reruns of a ready/active release with the same hash validate
and record `verified_existing` without duplicating data. A conflicting hash,
retired release, or incomplete `loading`/`failed` release stops for manual
inspection. There is no force/delete option. After a failed import, inspect the
sanitized audit row; the main transaction leaves no partial release data. Reset
the disposable local stack or resolve the incomplete release deliberately.

The complete W2B measurement found 634,894 concepts, 662,649 scientific-name
rows, and 754,417,664 bytes (about 719.47 MiB) of taxonomy-v2 relations.
Combined additively with the 103,304,339-byte production baseline, the projected
total is 857,722,003 bytes. Capacity is therefore `review_required_capacity`.
Selective search also remained around 0.65–0.71 seconds; representation/index
design needs an explicit review. These findings reject the full global-Fungi
production scope, redefine W2C as macrofungi-scope and sparse-registry design,
and block W3 and production load.

Future observation identification must snapshot the resolved Sporely ID when
available, selected scientific/vernacular names and rank, source system and
namespace, raw external ID, source release or response time, selection time,
resolution state, and original selected result. Historical display must not
depend on an external API or cache entry remaining available.

## W2C sparse-registry prototype result

The accepted Phase-A `tax-2026.08.01-01` preload is experimental and
non-exhaustive. `include` concepts are cache-eligible. `review`, `exclude`, and
`not_evaluated` concepts remain externally discoverable and registerable but
are absent from the v1 cache. Scope state never establishes or prohibits
identity.

The local-only `w2c_sparse_experiment` schema compared:

* S1: source metadata, sparse concepts, complete namespaced mappings,
  registered names, and durable identification snapshots;
* S2: the same persistent registry plus release-slotted minimal cache concepts,
  aliases, vernaculars, and COL resolver identities.

The current sparse fixture occupies 376,832 relation bytes. The one-slot cache
occupies 22,142,976 bytes and the combined final state 22,519,808 bytes. An
actual two-cache-slot replacement measured 46,022,656 cache bytes and
46,399,488 bytes combined. Against the 103,304,339-byte baseline, projected S2
final and replacement-peak totals are 125,824,147 and 149,703,827 bytes, so all
formal capacity gates pass.

The v1 cache contains exactly 52,881 Phase-A `include` concepts, 4,888 aliases,
3,923 vernacular names, and 52,881 minimal COL mappings. It contains zero
review-state concepts, plants, or selectable non-Fungi.

Indexed warm p50 execution was approximately 0.110 ms canonical exact, 0.304
ms canonical prefix, 0.108–0.113 ms alias/vernacular, and 2.139 ms for a broad
two-character prefix. Registration fixtures prove exact mapping reuse,
namespaced raw-ID separation, same-name concept separation, unresolved result
preservation, later exact resolution without snapshot loss, and deliberate
out-of-cache registration for review-state taxa.

S2 is recommended over S1 because its measured cache and two-slot publication
peak are small while it preserves resilient local autocomplete. The cache does
not own identity; dropping or replacing it cannot remove registry concepts,
mappings, or historical snapshots. See
`docs/evidence/taxonomy-v2/w2c-sparse-registry-comparison.{json,md}`.

No production taxonomy write, migration, activation, client cutover,
observation backfill, or W3 work is authorized by this result.
