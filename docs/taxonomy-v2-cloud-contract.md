# Taxonomy v2 cloud contract

## Status and boundary

This document describes the additive W2A implementation in migration
`20260724130000_add_taxonomy_v2_schema_and_search.sql`. The legacy
`public.taxa`, `public.taxa_vernacular`, and `public.search_taxa(text,text,integer)`
path remains active. No client uses taxonomy v2 yet, and no complete W1 release
or production release is loaded or activated in W2A.

W2A adds the schema, fixture-tested validation/activation, prefix search, and
authoritative resolver. W2B owns the importer, complete local load, storage and
performance measurements, and capacity decision. W3 owns observation identity
and sync/backfill. W4 owns the web picker and Artsorakel integration. Client
cutover and legacy removal remain W5 work.

## Model B decomposition

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

## W2B capacity and publication gates

W2B must import the complete accepted W1 artifact locally, then record
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

The pinned candidate `tax-2026.07.30-02` is not activated in production.
Production activation remains blocked by W2B capacity validation and the
programme publication/provenance gate, including unresolved Red List licence
evidence. Import automation, production-readiness policy enforcement, full-load
performance, retired-release retention beyond the one-active invariant, client
integration, and legacy retirement are known deferred concerns.
