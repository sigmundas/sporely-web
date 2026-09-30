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

The operator must create the untracked environment file. Before execution,
verify project ref `zkpjklzfwzefhjluvhfw` and the SQL SHA-256, and execute only
within the authorised window. Production writes require explicit operator
authorization. Once authorized, an agent may execute the exact guarded runbook
command after all required prechecks pass (`AGENTS.md`, "Production writes by
agents").

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

## Release transition: `tax-2026.09.30-01` (taxonomy v3)

`tax-2026.09.30-01` is the taxonomy-v3 release built and accepted in sporely-py
Stage 6P (`9609542`, fingerprints in
`database/taxonomy/evidence/taxonomy-v3/stage6p/release-candidate.json`). It
replaces the active `tax-2026.09.26-02`. Every production step below needs
its own explicit go-ahead. Production writes require explicit operator
authorization. Once authorized, an agent may execute the exact guarded runbook
command after all required prechecks pass (`AGENTS.md`, "Production writes by
agents"). The read-only pre-checks and probes need no separate approval.

### What changes

| Object | 09.26-02 | 09.30-01 |
|---|---:|---:|
| concepts / release taxa | 52,917 | 52,917 (identical set, identical canonical names) |
| scientific names | 57,770 | 60,697 |
| vernacular names | 10,645 | 13,760 |
| authoritative external IDs | 52,884 | 56,959 |
| of which `col_xr/col_usage_id` | 52,881 | 52,881 |
| of which `nortaxa/nortaxa_taxon_id` | 3 | 3,256 |
| of which `dyntaxa/dyntaxa_taxon_id` | 0 | 822 |
| legacy namespace-lost IDs | 0 | 0 |
| red-list assessments | 2,262 | 2,600 |
| `preferred_scientific_name_no` / `_sv` | — | 1,992 / 822 |

- **NorTaxa bridges:** the Stage 1A owner-approved `ordinary` manifest and the
  Stage 2 reviewed supersessions. NorTaxa 56227 (*Craterellus tubaeformis*)
  stays unresolved: its association was not approved.
- **Dyntaxa bridges:** Stage 4P reviewed Dyntaxa ids, as full LSIDs
  (`urn:lsid:dyntaxa.se:Taxon:<n>`); a bare number does not resolve.
- **National names:** Stage 3P/4P display metadata; identity and
  `canonical_scientific_name` are unchanged.
- **Rollback:** the concept set is identical, so observations bound under
  either release remain members after a rollback.

### Prerequisites (each its own go-ahead)

1. This branch's two additive migrations are on `main` and deployed:
   `20260930193000_add_unresolved_observation_identity_repair.sql` (Stage 1B)
   and `20260930193100_add_taxonomy_v2_national_scientific_names.sql`
   (Stage 3W). The payload inserts the national-name columns and its preflight
   requires `taxonomy_v2_national_name_errors(text)`, so it aborts, changing
   nothing, if the Stage 3W migration is missing. While
   `supabase/deploy-exceptions.json` lists `20260914090000`, deploy them only
   through the deploy tree (`AGENTS.md`, steps 7–9) with
   `--allow 20260930193000,20260930193100`; `20260914090000` stays undeployed.
   These two were committed as `20260929120000` / `20260929130000` and
   retimed, unchanged, on 2026-09-30 to sort after the production hotfix
   `20260930181742`; the Stage 1B/3W sparring records cite the old versions.
2. Web and desktop: the web build carrying the Stage 3W label and the Stage 4W
   resolver ships after activation. Old web clients keep working in between
   (`search_taxa_v2` only gained trailing columns). As for 0.9.24, the cloud
   must serve `tax-2026.09.30-01` before the desktop release that bundles it.

### Build the release directory from tracked desktop files

From `sporely-py` at `9609542`, the tracked bundle
`database/reference_data/generated/taxonomy_v2/tax-2026.09.30-01.sqlite3.gz`
(gz SHA-256 `593cd537…0e907f`, SQLite `e4591d6b…95c20a`) is the single source.
Use a scratch directory without symlinked components (on macOS `/private/tmp`,
not `/tmp`; the exporter refuses symlinks):

```bash
W=/private/tmp/taxonomy-v2/w1-tax-2026.09.30-01; R=/private/tmp/taxonomy-v2/global_macrofungi_tax-2026.09.30-01
B=database/reference_data/generated/taxonomy_v2
.venv/bin/python -c "from pathlib import Path; from database.taxonomy import cloud_export as ce; \
ce.run_export(artifact_gz=Path('$B/tax-2026.09.30-01.sqlite3.gz'), manifest=Path('$B/manifest.json'), \
output_dir=Path('$W'), policy_dir=Path('database/taxonomy/policies'), generated_at='2026-09-30T12:00:00Z')"
.venv/bin/python database/taxonomy/macrofungi_scope.py \
  --policy database/taxonomy/policies/global-macrofungi-scope.yml \
  --source-gz $B/tax-2026.09.30-01.sqlite3.gz --w1-dir "$W" --output-dir "$R" \
  --desktop "$R/desktop-tax-2026.09.30-01.sqlite3" --evidence /private/tmp/taxonomy-v2/scope-evidence.json \
  --release-id tax-2026.09.30-01 --starting-revision 79f18ae92ea8b7efad68377855dee85978e7684f
(cd "$R" && shasum -a 256 taxonomy_export_manifest.json scope-manifest.json scoped-export.jsonl.gz desktop-tax-2026.09.30-01.sqlite3)
```

The files must equal the Stage 6P `global_macrofungi_scoped_export` record;
stop if any differs:

| File | SHA-256 |
|---|---|
| `taxonomy_export_manifest.json` | `ee55d0d38be12acc7cec94c402952a95d1b92b5c7f335ec34f0fb68b72a7e8ac` |
| `scope-manifest.json` | `7ec0a202e0bd85096db70fc472a0fc21a9d496f586b1d68f517de159f45430ed` |
| `scoped-export.jsonl.gz` | `556bef15037b152e32e36ff700e8b97c2f70abee62e804e57b06c3a5c36e729c` |
| `desktop-tax-2026.09.30-01.sqlite3` | `1a5758d39c90071095ce5c0f44063761693667c2970afe4ecec7c726c85356a2` |

The seven JSONL files are pinned in the manifest, which the generator checks
row by row.

### Prepare and hand over

```bash
node scripts/taxonomy-v2/prepare-production-release-import.mjs \
  --release-id tax-2026.09.30-01 --release-dir "$R" \
  --output /private/tmp/taxonomy-v2/tax-2026.09.30-01-import.sql
```

Expected table counts: `{"concepts":52917,"taxa":52917,"scientific_names":60697,
"vernacular_names":13760,"external_ids":56959,"legacy_external_ids":0,
"redlist":2600,"releases":1,"import_runs":1,"active_releases":1}`. Built as
above from this branch's generator, the SQL has SHA-256
`ed62423c5a44f0b7ed58c8de31961505135341e864b1159ca69fb764da89387f` (two
independent generations were identical). The release row will record
whole-export SHA-256 `c7bb4b98e8312096a4468e739bd4d13c52418804b821cf2ea5fa2b979f2cfc79`.
Besides its representative searches, the payload proves before `COMMIT` that
`urn:lsid:dyntaxa.se:Taxon:1` resolves to exactly 86889 (*Abortiporus
biennis*) and the bare `1` resolves to nothing.

Local proof (2026-09-30, disposable stack reset from this branch, which also
applies the deferred `20260914090000`; the import touches none of its
objects). The stack imported `tax-2026.09.26-02` (payload regenerated with the
current generator), then this payload, which committed, activated
`tax-2026.09.30-01` and retired `tax-2026.09.26-02`. Then:

- `taxonomy-v3-tax-2026.09.30-01-post-activation-probes.sql` passed; with an
  expected value altered it failed on that probe (display, resolver and count
  variants tried);
- a replay stopped with "identical completed release already installed";
- the rollback drill below made `tax-2026.09.26-02` active (the probes then
  failed on release state, as they must), and the roll-forward restored
  `tax-2026.09.30-01`, after which the probes passed again;
- `taxonomy-v3-tax-2026.09.30-01-retiring-concept-check.sql` passed (0
  references); it refused an altered id list, and stopped when a scratch copy
  of the observations table held one retired id in `selected_sporely_taxon_id`
  or in `resolved_sporely_taxon_id`;
- `private.taxon_identity_repair_dry_run()` ran against the new release
  (0 candidates on the empty local stack).

### Read-only pre-checks (before the import; stop on any failure)

After the prerequisites, and immediately before the import in the same
authorised window:

1. `tax-2026.09.26-02` is the only active release; `20260930193000` and
   `20260930193100` are applied and `20260914090000` is not; `nortaxa/58766`
   does not resolve yet. `taxonomy-v3-tax-2026.09.30-01-precheck-1.sql` checks
   all of these (READ ONLY, ends in ROLLBACK, raises `STOP` on a mismatch):

   ```bash
   docker run --rm --env-file /path/to/private/production-db.env \
     -v "$PWD/supabase:/probes:ro" postgres:17 \
     sh -c 'psql "$DATABASE_URL" --file=/probes/taxonomy-v3-tax-2026.09.30-01-precheck-1.sql'
   ```

2. **No cloud observation references a retiring concept** (plan "Production
   steps after Stage 6W", step 1; the Stage 2 check repeated before the
   supersessions ship):

   ```bash
   docker run --rm --env-file /path/to/private/production-db.env \
     -v "$PWD/supabase:/probes:ro" postgres:17 \
     sh -c 'psql "$DATABASE_URL" --file=/probes/taxonomy-v3-tax-2026.09.30-01-retiring-concept-check.sql'
   ```

   The script carries the 1,353 `superseded_sporely_taxon_id` values of the
   approved records in the pinned ledger (sporely-py
   `database/taxonomy/policies/concept_supersessions.yml` at `9609542`,
   SHA-256 `04a77c05…47033`) and refuses to run unless the list hashes to
   `5fa0d85f…754b4`. It counts references in
   `observations.selected_sporely_taxon_id`,
   `observations.resolved_sporely_taxon_id` and
   `taxonomy_v3.resolution_link.resolved_sporely_taxon_id`, in a `READ ONLY`
   transaction ending in `ROLLBACK`, and prints counts only. The expected
   result is the NOTICE "0 references". **Any reference raises `STOP`: do not
   import.** Report the three counts and wait for a reviewed decision; do not
   edit observations or the payload to get past it.

   To re-derive the list from the ledger (1,353 ids and the hash above):

   ```bash
   git -C ../sporely-py show 9609542:database/taxonomy/policies/concept_supersessions.yml | python3 -c "import json,sys,hashlib; d=json.load(sys.stdin); ids=sorted({r['superseded_sporely_taxon_id'] for r in d['supersessions'] if r['review_status']=='approved'}); print(len(ids), hashlib.sha256(''.join(f'{i}\n' for i in ids).encode()).hexdigest())"
   ```

   None of these ids is in the searchable cloud scope of either release, but
   that does not make the count zero: W3 `taxonomy_v3.resolution_link` rows
   (and the `observations.resolved_sporely_taxon_id` values copied from them)
   can point at any registry concept. The first production run (2026-09-30)
   stopped with 0 selected, 36 resolved and 37 links (one link's observation
   no longer exists), all on 19 retiring concepts. Those are cleared by the
   repair below; after it, the expected result is "0 references".

### Retired-concept resolution repair (before the import)

Owner decision: repair then import, adding missing survivors to the registry
from the active release. Migration `20260930202803` provides
`private.retired_resolution_repair_dry_run()` and
`private.retired_resolution_repair_apply(plan_sha256)`; operator detail is in
`supabase/taxonomy-v3-retired-concept-resolution-repair-runbook.md`. Each step
needs its own go-ahead:

1. **Deploy** `20260930202803` through the deploy tree only
   (`node scripts/supabase-deploy-tree.mjs prepare --allow 20260930202803 --ref <committed ref>`,
   `check`, `supabase db push --linked` inside the tree, `post-verify`).
2. **Read-only dry run** as `postgres`, inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`.
   Expect `release_id` `tax-2026.09.26-02`, `manifest_sha256`
   `2585d08a…21a49`, `link_count` 37, `observation_count` 36,
   `orphan_link_count` 1, 15 `registry_additions`, and `refusals` `[]`.
3. **Present** the report (counts, per-pair table, registry additions) and
   keep `plan_sha256`. Any refusal: STOP.
4. **Apply** with that hash at a quiet time:
   `SELECT private.retired_resolution_repair_apply('<plan_sha256>');`
5. **Re-run** `taxonomy-v3-tax-2026.09.30-01-retiring-concept-check.sql`; it
   must now report 0 references.
6. Only then continue with the import below.

### Production activation (explicitly authorised, authorised window only)

Only after both pre-checks pass, verify project ref `zkpjklzfwzefhjluvhfw` and
the SQL SHA-256 above, then run the unchanged payload with the session-only
timeout the 09.26-02 activation needed (Session pooler, port 5432):

```bash
docker run --rm --env-file /path/to/private/production-db.env \
  -v '/private/tmp/taxonomy-v2:/payload:ro' postgres:17 \
  sh -c 'psql "$DATABASE_URL" -c "SET statement_timeout = 1800000" --file=/payload/tax-2026.09.30-01-import.sql'
```

### Post-activation probes (read-only)

```bash
docker run --rm --env-file /path/to/private/production-db.env \
  -v "$PWD/supabase:/probes:ro" postgres:17 \
  sh -c 'psql "$DATABASE_URL" --file=/probes/taxonomy-v3-tax-2026.09.30-01-post-activation-probes.sql'
```

The script runs in a `READ ONLY` transaction ending in `ROLLBACK` and raises on
the first failure. It covers the regression table:

| Species | Probes |
|---|---|
| *Entoloma conferendum* 7821 | NorTaxa 53482 and Dyntaxa Taxon:3957 → 7821; name, nb and sv vernacular searches |
| *Pholiotina rugosa* 83668 | NorTaxa 52369, 58722 and Dyntaxa Taxon:3423 → 83668; `Pholiotina rugosa` and `Conocybe rugosa` find it; display Pholiotina rugosa in `no` and `sv` (sv from the approved Dyntaxa bridge, owner decision `ec231125b0c84fbea345900eba5f3c4f`), Conocybe rugosa in `en` |
| *Craterellus tubaeformis* 620306 | NorTaxa 56227 unresolved; no national name; COL display; nb and sv vernacular searches |
| *Conocybe vexans* / *Pholiotina vexans* 617026 | NorTaxa 58766 → 617026; "vrang ringerlehatt" finds it; display Pholiotina vexans in `no`, canonical Conocybe vexans in `sv` |
| *Cantharellus cibarius* 168873 | NorTaxa 56210 → 168873; "kantarell" finds it |

It also checks the release hashes and counts, that exactly one release is
active, that the concept set and every canonical name equal those of
`tax-2026.09.26-02`, that NorTaxa 56449 now resolves to 11307 (*Gloeophyllum
odoratum*, reconciled in Stage 2), and that `nortaxa/7821` and a bare Dyntaxa
number do not resolve.

### Stage 1B repair of historical unresolved observations (after activation)

Two further steps, each needing its own go-ahead, follow a passing probe run:

1. **Production dry run:** `SELECT private.taxon_identity_repair_dry_run();`
   as `postgres` (`supabase/taxonomy-v3-unresolved-observation-repair-runbook.md`,
   step 1). Confirm `release_id` is `tax-2026.09.30-01`, and review
   `outcome_counts`, `promotions` and `flagged`. No promotion may target a
   NorTaxa 56227 row. Keep `plan_sha256`.
2. **Repair:** `SELECT private.taxon_identity_repair_apply('<plan_sha256>');`
   at a quiet time, then that runbook's post-run audit and the idempotence
   check (a fresh dry run reports `promote = 0`).

After a rollback, re-run the dry run before any apply: its plan hash covers the
active release, so an apply planned against `tax-2026.09.30-01` is refused.
Promotions already applied are not undone by a release rollback; they point at
concepts present in both releases.

### Execution record (2026-09-30)

- **Prerequisites:** `20260930193000` and `20260930193100` (retimed from
  `20260929120000` / `20260929130000`, sporely-web PR #5) deployed through the
  deploy tree at `39cd697`; `post-verify` passed. `20260914090000` not applied.
- **Pre-check 2, first run (read-only):** STOP. `observations.selected` 0,
  `observations.resolved` 36, `taxonomy_v3.resolution_link` 37 (one orphan
  link). 19 retired Group-B NorTaxa-derived concepts, all
  `trusted_secondary_provider_mapping` links with no release; none in
  `taxonomy_v2_concepts`, so the "none is in the cloud scope" reasoning did not
  cover them. Owner decision: repair, then import.
- **Retired-concept resolution repair:** migration `20260930202803`
  (PR #7, `56e6758`) deployed through the deploy tree; `post-verify` passed.
  Dry run: no refusals, 37 links, 36 observations, 1 orphan, 15 registry
  additions, manifest `2585d08a…21a49`, plan `a4461ad9…ef0498`. Apply, run 1,
  committed with the same counts. Afterwards: pre-check 2 reported 0/0/0, a
  fresh dry run found nothing, registry 194 → 209 concepts.
- **Pre-checks, immediately before the import (psql, READ ONLY):** both passed
  (`taxonomy-v3-tax-2026.09.30-01-precheck-1.sql` and the retiring-concept
  check).
- **Activation, 20:46:04–20:59:31Z:** payload SHA-256 `ed62423c…387f`
  re-verified, run with `SET statement_timeout = 1800000` over the Session
  pooler; `COMMIT`, psql exit 0.
- **Post-activation probes:** passed (release state, counts, identity
  continuity, 8 resolving and 3 unresolved ids, 17 search/display probes,
  national names). Releases: `tax-2026.08.01-01` retired, `tax-2026.09.26-02`
  retired, `tax-2026.09.30-01` active; 3 of 3 import runs succeeded.
- **Stage 1B dry run (read-only, against `tax-2026.09.30-01`):** 17 candidates;
  6 `promote`, 11 `no_match`, 0 ambiguous, 0 error; no promotion targets NorTaxa
  56227; plan `b1a94448…cef377`. 2 of the 6 have live reference uses. Apply not
  yet authorised.

### Rollback

As for 09.26-02: make `tax-2026.09.26-02` `ready` and activate it, in one
transaction:

```sql
BEGIN;
UPDATE public.taxonomy_v2_releases SET status = 'ready'
 WHERE release_id = 'tax-2026.09.26-02' AND status = 'retired';
SELECT public.taxonomy_v2_activate_release('tax-2026.09.26-02');
COMMIT;
```

That retires `tax-2026.09.30-01` without deleting it; the same statement with
the IDs swapped rolls forward. The migrations are not rolled back: they are
additive and `tax-2026.09.26-02` carries no national names.

## Release transition: `tax-2026.09.26-02` (desktop 0.9.24)

Desktop 0.9.24 bundles `tax-2026.09.26-02`. It supersedes `tax-2026.09.23-01`,
which was never imported to the cloud, so the transition is from the active
`tax-2026.08.01-01`. The cloud must serve the new release before the desktop
0.9.24 tag is released. This is a data import into the existing taxonomy-v2
tables. It adds no migration and does not depend on the deferred
`20260914090000_extend_reference_snapshots_to_version_2.sql`, which stays
undeployed.

### What changes

Against the active `tax-2026.08.01-01`, the scoped release is purely additive:

| Object | 08.01-01 | 09.26-02 |
|---|---:|---:|
| concepts / release taxa | 52,917 | 52,917 (identical set) |
| scientific names | 57,769 | 57,770 (`Pholiotina rugosa` on 83668) |
| vernacular names | 3,923 | 10,645 |
| authoritative external IDs | 52,881 | 52,884 |
| legacy namespace-lost IDs | 0 | 0 |
| red-list assessments | 2,262 | 2,262 |

- **External IDs:** the three new ones are the reviewed NorTaxa bridges of
  09.23-01: `nortaxa/nortaxa_taxon_id/53482 → 7821` (*Entoloma conferendum*),
  `52369 → 83668` and `58722 → 83668` (*Conocybe rugosa*).
- **Vernacular names:** the new ones come from the desktop's legacy
  enrichment: Swedish 1,577, English 1,020, French 1,144, Finnish 1,012,
  German 719, Danish 650, Polish 423, Spanish 114, Portuguese 33 and
  Italian 28, besides the Norwegian and Sámi names.
- **Publishing IDs:** Artportalen and iNaturalist IDs stay desktop-only; the
  scoped export suppresses the namespace-lost integer channel.
- **Rollback:** no concept disappears, so observations bound under either
  release remain members after a rollback.

Known gap, unchanged from 08.01-01: species whose Norwegian names sit on a
NorTaxa concept that was not merged with its COL namesake (for example
*Cantharellus cibarius*, "kantarell") have no vernacular name in the cloud
scope. It is tracked in sporely-py `docs/plans/INBOX.md`.

### Build the release directory from tracked desktop files

From `sporely-py` at the 0.9.24 release commit, the tracked bundle
`database/reference_data/generated/taxonomy_v2/tax-2026.09.26-02.sqlite3.gz`
(SQLite SHA-256 `9bf71b7e…8547d`) is the single source:

```bash
W=/tmp/taxonomy-v2/w1-tax-2026.09.26-02; R=/tmp/taxonomy-v2/global_macrofungi_tax-2026.09.26-02
B=database/reference_data/generated/taxonomy_v2
.venv/bin/python -c "from pathlib import Path; from database.taxonomy import cloud_export as ce; \
ce.run_export(artifact_gz=Path('$B/tax-2026.09.26-02.sqlite3.gz'), manifest=Path('$B/manifest.json'), \
output_dir=Path('$W'), policy_dir=Path('database/taxonomy/policies'), generated_at='2026-09-26T12:00:00Z')"
.venv/bin/python database/taxonomy/macrofungi_scope.py \
  --policy database/taxonomy/policies/global-macrofungi-scope.yml \
  --source-gz $B/tax-2026.09.26-02.sqlite3.gz --w1-dir "$W" --output-dir "$R" \
  --desktop "$R/desktop-tax-2026.09.26-02.sqlite3" --evidence /tmp/taxonomy-v2/scope-evidence.json \
  --release-id tax-2026.09.26-02 --starting-revision 150e9eb
```

The export checks its own pinned counts (`PINNED_RELEASE_EXPECTATIONS` in
`cloud_export.py`). The scoped desktop pack has SHA-256 `1886504f…15`.

### Prepare, prove locally, and hand over

```bash
node scripts/taxonomy-v2/prepare-production-release-import.mjs \
  --release-id tax-2026.09.26-02 --release-dir "$R" \
  --output /tmp/taxonomy-v2/tax-2026.09.26-02-import.sql
```

Expected table counts: `{"concepts":52917,"taxa":52917,"scientific_names":57770,
"vernacular_names":10645,"external_ids":52884,"legacy_external_ids":0,
"redlist":2262,"releases":1,"import_runs":1,"active_releases":1}`. Built as
above, the SQL has SHA-256
`6ddb577d077a01647b5208d201d60737b786fe4d8c03b3f353bec194a547da1e`.

Local proof (2026-09-26, disposable stack from `main` without the deferred
migration). The stack imported `tax-2026.08.01-01`, then this payload, which
activated `tax-2026.09.26-02` and retired `tax-2026.08.01-01`. The following
were confirmed, as `anon` where an RPC was called:

- row counts match the export (10,645 vernacular names);
- `resolve_taxon_external_id_v2('nortaxa','nortaxa_taxon_id','53482')` returns 7821, `'52369'` returns 83668, and an unbridged id and `'7821'` return nothing;
- `search_taxa_v2` finds *Conocybe rugosa*, *Entoloma conferendum*, *Pholiotina rugosa* and *Cantharellus cibarius* first;
- observations are untouched;
- a replay stops without changes;
- the rollback drill below and a roll-forward both work.

### Production activation (human operator, authorised window only)

Same procedure as for 09.23-01 below: the single production write is the
containerised `psql` printed by the generator, run against project
`zkpjklzfwzefhjluvhfw` after verifying the SQL SHA-256. It loads, validates
and activates `tax-2026.09.26-02` in one transaction and retires
`tax-2026.08.01-01`. Codex and agents must not run it.

Read-only post-checks:

- exactly one active release, `tax-2026.09.26-02`;
- the two `resolve_taxon_external_id_v2` probes above;
- a `search_taxa_v2` probe;
- the vernacular count: 10,645 rows for the release.

**Statement timeout.** Production sessions default to `statement_timeout =
2min`. The generator's command failed at `taxonomy_v2_validate_release` on
the freshly loaded, uncommitted tables and rolled back completely. Run it with
a session-only limit in front of the unchanged payload:

```bash
docker run --rm --env-file /path/to/private/production-db.env \
  -v '<dir with the SQL>:/payload:ro' postgres:17 \
  sh -c 'psql "$DATABASE_URL" -c "SET statement_timeout = 1800000" --file=/payload/tax-2026.09.26-02-import.sql'
```

The `DATABASE_URL` is the Session pooler string (port 5432), not the
transaction pooler.

### Execution record (2026-09-26)

- **Pre-checks, read-only:** only `tax-2026.08.01-01`, active; one import run, succeeded; 52,917 concepts; no duplicates; `20260914090000` not applied (110 migrations, latest `20260925160000`); `53482` did not resolve.
- **Attempt 1, 14:43–14:45Z, the generator's command as printed:** `ERROR: canceling statement due to statement timeout` in `taxonomy_v2_validate_release`; psql exit 3. A read-only check afterwards found production unchanged: no `tax-2026.09.26-02` rows, no import run, no idle transaction.
- **Attempt 2, ≈14:48–15:03:00Z, with `SET statement_timeout = 1800000` and the same payload (SHA-256 `6ddb577d…`, re-verified):** `COMMIT`, psql exit 0. The activation step took about 12 minutes.
- **Post-checks, read-only:**
  - releases are `tax-2026.08.01-01: retired` and `tax-2026.09.26-02: active`, with exactly 1 active;
  - `53482 → 7821` *Entoloma conferendum*, `52369 → 83668` *Conocybe rugosa*, and an unbridged id resolves to nothing;
  - 52,917 concepts, with no duplicate concept ids or release taxa;
  - both import runs succeeded and finished;
  - `20260914090000` is still not applied;
  - release rows are taxa 52,917, scientific names 57,770, vernacular 10,645, external 52,884, legacy 0, red list 2,262;
  - `search_taxa_v2` finds *Cantharellus cibarius*, *Entoloma conferendum* and *Pholiotina rugosa* (→ 83668) first.

### Rollback

Make `tax-2026.08.01-01` `ready` and activate it, as in the 09.23-01 rollback
below. That retires `tax-2026.09.26-02` without deleting it, and the same
statement with the release IDs swapped rolls forward.

## Release transition: `tax-2026.09.23-01` (desktop 0.9.23)

> **Superseded, never imported.** `tax-2026.09.23-01` was replaced by
> `tax-2026.09.26-02` before its cloud activation. The section is kept for
> its procedure, which the 09.26-02 section refers to.

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
