# Reference measurement content v2 rollout

Status: approved direction (owner decisions 2026-10-01). Stage A **LIVE**
(deployed 2026-10-02). Stage M server candidate on
`feature/reference-v2-stage-m` awaiting review; not deployed.

Driving case: `"Sp. 7–9.5(–10.5) × 4–5.5 µm, Qav = 1.6–2"`. `Qav 1.6–2` is a
reported **mean interval**: not Q extremes, not a typical Q range, never a
midpoint scalar. That distinction must survive on every surface (desktop, web,
landing, public API, species pages, compare tray, reference sharing).

## Owner decisions (2026-10-01)

1. **Public display: yes.** Mean intervals are shown publicly once readers
   support them, preserved exactly as a mean interval.
2. **Server-side minimum-client capability mechanism (Stage M) is mandatory**
   and must be implemented, reviewed and live before Stage D/E enable ordinary
   v2 writing/attachment. One v2 reference must never make an older client
   reject the owner's entire reference feed, and no older client may
   round-trip a v2 set into loss. It is also the foundation for later opening
   the desktop bundle-export gate. It does not block Stage A.
3. **Wording:** compact scientific display in plots/tables `Qav 1.6–2`;
   explanatory UI localized `Mean Q: 1.6–2` / `Gjennomsnittlig Q: 1,6–2`
   (sv/de equivalents), locale number formatting (decimal comma in nb/sv/de).
4. **Automatic-share version/scope gap is fixed in Stage A**, not as a
   separate emergency release. It is a hard prerequisite for Stage D.
5. The local-only/no-sync stopgap is rejected.

## Invariants

- Mean-interval semantics are fixed by the contract
  (`sporely-py` `docs/reference-data/measurement-content-contract.md` §1, §7).
  No reader re-derives or approximates them.
- **Fail closed.** A reader that cannot represent v2 rejects it or visibly
  marks it; it never silently drops it, renders it as a range/extremes, or
  invents a scalar mean.
- **Server authoritative** for what a client may write and what anon/public
  readers receive. A client-declared capability only ever *restricts* what
  the server sends or accepts for that client; it never unlocks a privilege
  the server does not independently enforce.
- No production deployment without separate explicit owner approval per stage
  (`AGENTS.md` migration safety). `20260914090000` stays deferred until Stage D.
- New migrations sort after `20261001213000` (Stage A, deployed 2026-10-02).

## Verified facts

- Desktop `v0.9.23`/`v0.9.24` contain v2 snapshot reader code
  (`database/reference_citation.py` `SNAPSHOT_SCHEMA_VERSION_ENHANCED = 2`,
  `database/curated_reference_forks.py` `_SNAPSHOT_KEYS_BY_VERSION`), via
  release-branch cherry-picks. Desktops `< 0.9.23` are v1-only and reject the
  whole use-feed when one use is v2. Both desktop gates
  (`references/measurement_content_gates.py`) ship closed, so no released
  desktop writes or attaches v2.
- `20260914090000_extend_reference_snapshots_to_version_2.sql` is deferred
  (`supabase/deploy-exceptions.json`); production canonical snapshot and
  validators are v1-only.
- `private.reference_contribution_share_core` (`20261001113007`) checks scope
  (`reference_share_scope_within`) only for a `consented` refresh or a
  `grant`; a new **automatic** share (insert path) skips it. Once the
  canonical snapshot can emit v2, that path would publish v2 to anon readers
  unchecked.
- Public reads `search_public_reference_contributions(_v2)` /
  `get_public_reference_contribution(_v2)` return `envelope_json` verbatim,
  with no version awareness (finding of `8f88042`, still open).
- `sporely-landing` `src/lib/publicReferenceSnapshot.ts:116` rejects
  `schema_version !== 1` (fails closed; no v2 display).
- Sync RPCs (`sync_reference_measurement_set`, `sync_observation_reference_use`)
  take no client-version/capability parameter (before Stage M).
  `stage_observation_reference_use_feed` and `reconcile_reference_library_feed`
  are **desktop-local** functions, not RPCs: desktops read the owner feeds
  with plain PostgREST table GETs (see Stage M design). `record_client_activity`
  (`20260723120000`) records client + app version, but desktop does not call
  it today.

## Reader/writer inventory

| Surface | Symbol | State | Change |
|---|---|---|---|
| Desktop codec/validation | `references/measurement_content.py` | v2-ready | none |
| Desktop gates | `references/measurement_content_gates.py` | both closed | Stage E (reader/attach); export gate later |
| Desktop snapshot/use-feed/curated/portable readers | `database/reference_citation.py`, `database/reference_use_sync_reconciliation.py`, `database/curated_reference_forks.py`, `utils/archive/portable_import.py` | v2-ready, released ≥ 0.9.23 | none |
| Desktop sync RPC calls | `utils/cloud_sync.py` | no capability declaration | Stage M |
| Desktop client activity | not called | missing | Stage M |
| Server canonical snapshot / validators / curated CHECK | `private.reference_canonical_snapshot`, `private.reference_snapshot_valid` | v2 only in deferred `20260914090000` | Stage D |
| Server automatic share | `private.reference_contribution_share_core` | scope gap on insert path | Stage A |
| Public anon reads | `search_public_reference_contributions(_v2)`, `get_public_reference_contribution(_v2)` | verbatim, version-unaware | Stage A |
| Sync/use-feed guard | `sync_reference_measurement_set_unthrottled`, use-feed RPCs | no client capability enforcement | Stage M |
| Web reference UI | `src/**` | not inventoried | inventory Stage A, implement Stage C |
| Desktop shared-reference catalogue | `utils/cloud_sync.py` `search/get_public_reference_contribution_v2` (2b branch :16583), `database/curated_reference_forks.py` `normalize_curated_bundle` (`_SHARED_KEYS`, exact keys) | a marked envelope fails exact keys and the `_FULL_KEYS` fallback, raising `CuratedReferenceError`; `search_shared_reference_contributions` does not catch per row, so **the whole page fails** | accept the marker or opt in `{1,2}` before Stage D (Stage E/M scope) |
| Landing species page / compare tray | `publicReferenceSnapshot.ts`, `sporeSummary.ts`, `compareTray.ts` | rejects v2 | Stage B |
| Landing relationship labels | PR #3 `feature/reference-relationship-labels` | unmerged, v1 | coordinate in Stage B |

## Old-client behavior

| Client | On v2 | Round-trip risk |
|---|---|---|
| Desktop `< 0.9.23` | rejects whole use-feed (visible error); does not even select the set extension columns, so an enhanced set looks like a plain v1 set | edit of a stale enhanced set pushes a legacy payload; Stage M withholds v2 from the table feeds and refuses the write (`requires_newer_client`) |
| Desktop `≥ 0.9.23`, gates closed | reads v2 | cannot create/attach/export v2 |
| Desktop with reader code, never-upgraded local library | editing a set yields a legacy-only local row; push rejected (`invalid_payload`) | local copy loses the claim; Stage M must refuse non-capable writes server-side |
| Landing | rejects v2 | fails closed |
| Web | unverified | Stage A inventory |

## Public envelope policy

Public reads become version-aware. They take an explicit opt-in parameter
(e.g. `p_accept_snapshot_versions int[]`, default `{1}`). For a caller that
does not accept v2, a v2 snapshot is projected server-side to the v1 shape and
stamped `measurement_details_omitted: true`; nothing is silently dropped and
no scalar is invented. v1 snapshots are returned unchanged (no behavior change
for current production data). Landing opts in to v2 in Stage B.

## Stages

### Stage A — server: version-aware public reads and automatic-share scope gap

- Repo `sporely-web`; new additive migration.
- Scope:
  1. Version-aware `search_public_reference_contributions(_v2)` /
     `get_public_reference_contribution(_v2)` with the opt-in parameter and
     the v2→v1 projection + `measurement_details_omitted` marker. Signatures
     stay backward compatible for current callers (landing).
  2. Automatic-share insert path in `reference_contribution_share_core`
     enforces the same snapshot-version/scope check as `consented`/`grant`;
     until Stage D, automatic shares are limited to v1.
  3. Read-only inventory of web `src/` readers of reference snapshots /
     measurement content, recorded in this plan for Stage C.
- Tests: SQL tests for both read families (v1 unchanged, v2 projected +
  marker, v2 returned to opt-in caller) and for the automatic-share check,
  with an enhanced fixture forced through the new-share path. Prove each test
  fails on the pre-stage definitions.
- Review: general + security.
- Prod approval: yes (no visible v1 behavior change).
- Rollback: rollback script restoring prior definitions.
- Exit: no public read returns an unmarked v2 envelope to a non-opted-in
  caller; automatic shares are version/scope checked.

### Stage M — server-side minimum-client capability

- Repos `sporely-web` (migration + web calls) and `sporely-py` (declaration).
- Declaration: explicit `p_client_capabilities jsonb` (e.g.
  `{"reference_snapshot_versions":[1,2]}`) on the reference sync and
  use-feed/reconcile RPCs. Omitted ⇒ v1-only (how every existing client calls
  them today). Added as overloads/defaults so old clients keep working.
- Feeds for non-capable clients: v2 items are never sent. Whether they appear
  as a placeholder (`requires_newer_sporely`) or are omitted is decided by
  testing the actual `< 0.9.23` and `0.9.23/0.9.24` feed parsers; the feed as
  a whole must never fail. The server returns a count of withheld items so a
  capable UI can explain them.
- Writes: a non-capable client's write/update to an enhanced set is refused
  with a distinct status (`requires_newer_client`); never downgraded for
  writeback.
- Creation guard: creating new v2 content is refused while the owner has
  another device active within a window (proposed 30 days) whose last
  reported version is not capable, using `record_client_activity`. Requires
  desktop to call `record_client_activity`; included in this stage.
- Desktop UI: notice "N references need a newer Sporely to view or edit",
  driven by the withheld count and `requires_newer_client`.
- Web declares `[1,2]` once Stage C ships. Landing uses Stage A public reads.
- Foundation for the bundle-export gate: the same capability model must later
  cover bundle import/export before `MINIMUM_SUPPORTED_DESKTOP_VERSION_GATE_OPEN`
  flips (separate stage).
- Tests: declared/undeclared capability, feed behavior against real old-parser
  fixtures, write refusal, creation guard.
- Review: general + security (trust boundary). Prod approval: yes.
- Dependencies: Stage A. Rollback: additive; rollback script.

#### Stage M design (server part, 2026-10-02)

Old-parser evidence (sporely-py tags; file:line at `v0.9.22` / `v0.9.24`):

- Feeds are table GETs, not RPCs: `utils/cloud_sync.py`
  `list_reference_measurement_sets` 15431 / 16396 and
  `list_observation_reference_uses` 15445 / 16411
  (`reference_measurement_sets?user_id=eq.…&select=…`, full feed every pull,
  paginated). v0.9.22 does not select `measurement_details_json,q_core_*`;
  v0.9.24 does (16403). No parameter can reach these reads, so the only lever
  over a released desktop is **row visibility (RLS)**.
- Placeholder rows are unsafe: `database/reference_sync_reconciliation.py`
  `stage_reference_library_feed` raises for any row missing canonical fields
  (138 / 180) and `_validate_graph` raises for a successor whose predecessor
  is absent (216 / 264); `reference_use_sync_reconciliation.py` raises for
  `schema_version != 1` (v0.9.22 :102-104; v0.9.24 accepts {1,2} :103-109).
  Each raise rejects the **whole** feed. (A table read cannot carry a
  placeholder anyway.)
- Omission is safe: deletions are applied only from rows carrying
  `deleted_at` (`reconcile_reference_library_feed` `deleted_sets` 837 / 953,
  use tombstone pass); an absent row is never treated as deleted remotely
  and never pushed as a deletion. A live use whose set is absent is only
  `blocked` (`reference_use_sync_reconciliation.py` 696 / 701; cursor not
  advanced, no loss).
- Write envelope: the adapter requires keys exactly `{status,row}` and a
  known status (`utils/reference_cloud_adapter.py` 154-158 / 158-162); an
  unknown status raises a protocol error that `utils/reference_cloud_sync.py`
  735 records as a per-item error and continues with the next item (local
  row kept, still pending). Released desktops therefore **retry a refused
  write on every sync** and show a sync error each time: non-destructive,
  but noisy until the user upgrades.
- Curated forks: `list_reference_curated_forks` reads the
  `reference_curated_forks` table. `utils/curated_reference_sync.py`
  `pull_curated_reference_forks` (v0.9.22 = v0.9.24) appends
  "private graph not reconciled" (:177) for a fork whose private set is not
  reconciled locally, on every pull; `reference_cloud_sync.py` :884 then
  skips **all** pushes of that sync. Omission is harmless: the pull only
  iterates remote rows and never deletes local forks; the push
  (`push_curated_reference_forks`, :74) sends only local pending rows, never
  absent-remote ones.

Chosen strategy (migration `20261002120000_reference_client_capability_minimum.sql`):

| Feed / call | Undeclared (all released desktops) | Strategy |
|---|---|---|
| `reference_measurement_sets` table read | v1 only | **omission** via restrictive SELECT policy: hide a live enhanced set (`measurement_details_json`/`q_core_*` non-null) and every set whose supersedes chain reaches one (else the old graph check fails the feed). Tombstones stay visible. |
| `observation_reference_uses` table read | v1 only | **omission**: hide any use whose snapshot `schema_version` is not 1 (live or deleted) and any use of a withheld set (avoids permanent `blocked`). |
| `reference_curated_forks` table read | v1 only | **omission**: hide a fork bound to a withheld set |
| works / treatments | unchanged | never withheld |
| `sync_reference_measurement_set`, `sync_observation_reference_use` | v1 only | refuse with `requires_newer_client` (`row: null`, envelope unchanged) |

Client contract (desktop Stage M part, web Stage C):

- Declaration `p_client_capabilities jsonb`, trailing, `DEFAULT NULL`:
  `{"reference_snapshot_versions":[1,2],"device_id":"<uuid per install>","client":"desktop_app","app_version":"0.9.x"}`.
  NULL/omitted or no `reference_snapshot_versions` = `[1]`. Versions must be
  a non-empty subset of {1,2} containing 1; non-object, bad versions or a
  non-uuid or nil-uuid `device_id` raise 22023 (versions must be the JSON
  integers 1/2; `1.0` is 22023). Unknown keys ignored.
- Sync RPCs: `sync_reference_measurement_set(p_payload, p_expected_row_version, p_client_capabilities)`,
  `sync_observation_reference_use(p_payload, p_expected_row_version, p_snapshot_mode, p_client_capabilities)`.
  New statuses (envelope stays `{status,row}`):
  `requires_newer_client` (row null) — caller is v1-only and the write
  touches a withheld/enhanced set or use, would create enhanced content, or
  a successor/use of a withheld set; never downgraded.
  `older_client_active` (row = current row or null) — creation guard.
  A capable caller otherwise reaches the unchanged validator
  (`_unthrottled`), so v2 payload validation still applies (a capable use
  write with a non-boolean `deleted` is `invalid_payload`).
- Handling both statuses (new clients): keep the local change pending (never
  drop or downgrade it); do **not** retry on every sync — retry only when
  the declared capability or device set changes (e.g. after upgrade, or a
  device report) or on explicit user action; surface a notice
  (`requires_newer_client`: "needs a newer Sporely"; `older_client_active`:
  "another of your devices needs updating first").
- Feed: capable clients stop reading the three tables directly and call
  `list_reference_library_feed(p_entity 'measurement_set'|'observation_use'|'curated_fork', p_client_capabilities, p_after_updated_at, p_after_id, p_limit 1..1000 default 500)`
  → `{status:'ok', entity, rows:[full table rows], withheld_count, next_cursor:{updated_at,id}|null}`,
  order `(updated_at,id)`, keyset cursor. Every pull is a **full pull**
  (as desktops do today): start with no cursor and page with `next_cursor`
  only within that pull; never seed `p_after_*` from the local
  `reference_cloud_pull_cursors` or any persisted cursor.
  `withheld_count` = owner rows of that entity a v1-only reader does not
  get; computed only on the first page of a v1-only caller (later pages:
  null; `[1,2]`: 0); drives the notice "N references need a newer Sporely
  to view or edit". The feed is read-only: it does not refresh the device
  record. Not rate-limited, like the table GETs it replaces (bounded by
  `p_limit` over the caller's own rows; the shared reference bucket is
  sized for writes and would starve the same sync's pushes).
- Portable import/export (bundles) of enhanced content is out of scope until
  the bundle-export gate stage.
- Device report: `record_reference_client_capabilities(p_client_capabilities)`
  (requires `device_id`; rate-limited like the sync RPCs) → `{status:'recorded'}`;
  call at sign-in/start. Every sync write call with `device_id` also
  refreshes the record (the feed does not). `public.reference_client_devices` (owner SELECT only; no client
  writes; pruned after 90 days; max 32 per owner) — no other telemetry.
  `record_client_activity` is not changed (it has no device identity).
- Trust: a declared `[1,2]` only selects how the caller sees its **own**
  rows; it unlocks no other row, and validation is unchanged. A client
  lying `[1]` restricts itself. The RLS predicates live in schema
  `reference_rls` (USAGE for authenticated, not exposed by PostgREST) and
  answer only for `auth.uid()`'s own rows (false without a caller).

Creation guard (fail-closed but usable): a capable write creating new
enhanced content (new enhanced set, v1→enhanced, new/re-pointed use of an
enhanced set or a v2 snapshot) returns `older_client_active` while another
device record of the owner (`device_id` ≠ caller) has
`last_seen_at > now() - 30 days` and no version 2. Undeclared sync writes
record the nil-uuid pseudo-device `undeclared` ([1]), so any released
desktop that pushed within 30 days blocks creation. Read-only old desktops
cannot be detected (table GETs record nothing); they are protected by
withholding, not by the guard. With no reports at all creation is allowed:
nothing an old reader can see changes and every old write to the content is
refused. Editing already-enhanced content is not creation.
Owner decision (2026-10-02): keep the guard exactly as implemented; no
account override feature, no UI, no general mechanism. Both wrappers call
`private.reference_creation_blocked_by_older_client(owner, capabilities)`.

Operator procedure (post-upgrade lockout): when an owner is blocked
(`older_client_active`) after upgrading every desktop, an operator — with
explicit owner approval for that account in production — runs
`supabase/reference-client-devices-clear-stale.sql`:

    psql "$DB_URL" -v ON_ERROR_STOP=1 -v user_id=<account uuid> \
      -f supabase/reference-client-devices-clear-stale.sql

It deletes, in one transaction, only that account's
`reference_client_devices` rows lacking version 2 (the `undeclared`
pseudo-device and v1-only devices), prints `removed|N` and the remaining
rows, and refuses an unset/non-uuid/nil/unknown `user_id`. Idempotent. It
touches no reference data and no guard logic: a desktop that still writes
undeclared re-registers on its next write and the guard blocks again.
Tested by `supabase/tests/reference_client_devices_clear_stale_test.sh`.

Performance (2026-10-02): production has 1 owner with reference rows (max
and p99 per owner: 41 sets, 51 uses, 0 curated forks; supersedes chain max
depth 0). Locally, one owner seeded at 2x (82 sets) and a 10k stress owner
(10k sets in 3-chains, 20% enhanced roots so 40% withheld; 12k uses; 1k
forks), max ms per 1000-row page, before -> after `20261002120000`:

| | 82 sets | 10k sets |
|---|---|---|
| legacy sets (offset paging) | 0.6 -> 1.1 | 0.7 -> 5.4 |
| legacy uses | 0.2 -> 0.4 | 4.6 -> 8.5 |
| legacy forks | 0.1 -> 0.3 | 0.5 -> 3.8 |
| feed v1 sets / uses / forks | -> 1.3 / 1.1 / 0.8 | -> 15 / 37 / 9 |
| feed [1,2] sets / uses / forks | -> 1.1 / 1.1 / 0.1 | -> 10 / 14 / 4 |

The first version (per-row SECURITY DEFINER predicate in the policies) took
up to ~1 s per page at 10k uses; the policies and feed now filter on a
hashed `NOT IN (SELECT reference_rls.caller_withheld_set_ids())` (one
supersedes walk per query), plus a partial index of live enhanced sets.

### Stage B — landing: v2 display and wording

- Repo `sporely-landing`. Accept v2 and the omitted marker; render `Qav 1.6–2`
  (compact) and `Mean Q: 1.6–2` / locale equivalents (explanatory), never as a
  range/extremes; show the marker visibly. Coordinate with PR #3.
- Tests: normalization (v1, v2, v2+marker, malformed), locale formatting.
- Review: general. Prod approval: yes (landing deploy). Depends on Stage A.

### Stage C — web: reference UI readers

- Repo `sporely-web` (client). Implement v2 display on the surfaces from the
  Stage A inventory; declare capability per Stage M.
- Review: general. Prod approval: yes (web deploy). Depends on A, M.
- Stage A inventory (2026-10-01, read-only, `src/**` excluding tests, base
  `8afc74f`): web has **no reader of reference snapshots, measurement
  content or `envelope_json`**.
  - `src/shared-references.js` (rendered by `src/screens/profile.js`): owner
    list via `list_my_reference_sharing` and the owner RPCs
    `stop_sharing_reference_set` / `share_reference_set_again`. Renders
    status, revision, dates, `canonical_scientific_name`,
    `source_short_label`, `source_raw_text` and the public observation count;
    no snapshot, `measurements`, `measurement_details` or `schema_version`.
    v2-safe as is (raw text is the source's own text).
  - No call to `search_public_reference_contributions(_v2)`,
    `get_public_reference_contribution(_v2)`,
    `search/get_public_observation_references`, the reference sync RPCs, or
    any `reference_*` / `observation_reference_uses` table.
  - `src/screens/find_detail.js` spore summaries
    (`observation_spore_summaries`, `get_public_observation_spore_summaries`)
    are the observation's own measurements, not references.
  - Consequence: Stage C has no display surface to change today. It reduces
    to (a) the Stage M capability declaration, only if web ever calls a
    reference sync/use-feed RPC, and (b) any future web reference UI must
    call the public reads with `p_accept_snapshot_versions => '{1,2}'` only
    once it renders mean intervals per the wording decision.

### Stage D — deploy the deferred migration

- Apply `20260914090000` through `scripts/supabase-deploy-tree.mjs` and remove
  it from `supabase/deploy-exceptions.json` in the same commit, per
  `docs/deployments/2026-09-25-migration-order-exception.md`. Widen
  `private.reference_automatic_share_scope()` to versions [1,2] in a
  migration deployed **before** `20260914090000` (or earlier in the same
  deploy), never after: `20260914090000` is SHA-pinned and cannot carry it,
  and each migration file commits separately. Widening first is safe because
  the canonical snapshot cannot emit v2 until `20260914090000` applies;
  widening after would leave a window where every automatic refresh of an
  enhanced set withdraws it with `snapshot_version_unsupported`.
- Prerequisite: desktop public-read callers accept the
  `measurement_details_omitted` marker or opt in `{1,2}` (see Stage E/M).
- Tests: `reference_snapshot_v2_test.sql`,
  `reference_measurement_content_extension_test.sql`, replay dry run.
- Review: general + security. Prod approval: yes, explicit.
- Depends on: Stage A live, Stage M live, B and C deployed.
- Rollback: tested rollback in the deploy-tree flow (highest-risk stage).

### Stage E — desktop gate flip

- Repo `sporely-py`. Flip `MINIMUM_SUPPORTED_READER_VERSION_GATE_OPEN = True`
  in a new desktop release (which also carries the Stage M declaration).
  `MINIMUM_SUPPORTED_DESKTOP_VERSION_GATE_OPEN` stays closed until the
  capability model covers bundle import/export.
- Tests: activation-gate fixtures (contract §12 item 19); full manual test.
- Review: general. Depends on A, M, D live and B/C deployed.
- Rollback: revert the flag; no persisted content is rewritten.

## Gate-flip conditions

- Stage M live before Stage D (decision 2).
- Stage A scope fix live before Stage D (decision 4).
- Desktop reader/attach gate flips only after A, M, D are live and B/C deployed.
- Bundle-export gate: separate later stage on top of Stage M.

## End-to-end manual test (Qav)

1. Desktop (gate open): enter the source text; `metrics.q.mean_interval =
   {1.6, 2}`, `q_mean` NULL, no Q bounds set from it.
2. Attach to a public observation; sync to a second capable desktop and back;
   no loss.
3. Simulated non-capable client: v2 item withheld (feed still loads), write
   refused with `requires_newer_client`.
4. Before Stage D: automatic share does not publish v2.
5. After Stage D: anon read returns the mean interval to opted-in callers and
   the v1 projection + marker to others.
6. Landing species page and compare tray: `Qav 1.6–2` / `Mean Q: 1.6–2`
   (`Gjennomsnittlig Q: 1,6–2` in nb), never a Q range or extremes.

## Open questions

- Recently-active window (30 days proposed) and whether support can override it.
- ~~Placeholder vs omission~~: omission (Stage M design).
- Stage M: support override of the 30-day guard; whether pseudo-device
  `undeclared` should expire sooner once all owner devices declare.
- Stage M: owner decision on the post-upgrade lockout of the creation guard
  (acknowledgement override).
- Stage M: `sync_reference_curated_fork` takes no capability (forks are
  immutable creates of curated v1 content); revisit if forks can bind an
  enhanced set.
- Stage M: public reads by desktop (`search_shared_reference_contributions`
  page failure on a marked envelope) remain a desktop Stage M/E item.
- Whether any client outside these three repos calls the sync RPCs.
- Supported-desktop-version floor policy (contract §6).
- Timing of the bundle-export gate stage.

## Handoff

- 2026-10-01: plan written; Stage A started on `feature/reference-v2-stage-a`.
- 2026-10-01: Stage A candidate (implementation claim, not acceptance).
  Branch `feature/reference-v2-stage-a`, base `8afc74f` (origin/main), plan
  commit `422997a`, inventory `6d111c2`, migration `4bb24b5`.
  - Migration `supabase/migrations/20261001213000_version_aware_public_reference_reads.sql`;
    rollback `supabase/rollbacks/20261001213000_rollback.sql`. Not deployed;
    `20260914090000` untouched and still deferred.
  - Overloads: the four public reads (`search/get_public_reference_contribution_v2`,
    `search/get_public_observation_references`) are DROPped and recreated with
    a trailing `p_accept_snapshot_versions integer[] DEFAULT '{1}'`; one
    function per name, so landing's named-argument calls resolve unchanged.
    NULL = default; otherwise a subset of {1,2} containing 1, else 22023.
    Private `_unthrottled` reads, rate limit, page policy, byte cap, owner,
    SECURITY DEFINER, `search_path=''` and grants unchanged (fingerprint
    checked).
  - Projection (v2 -> v1, non-accepting caller): drop `measurement_details`
    and `measurements.q_core_min/q_core_max`; `schema_version` 1; every
    other value as stored (`q_mean` stays NULL for a mean interval; Q core
    never folded into `q_min/q_max`); a length/width core pair tagged
    `percentile_interval` is nulled. Item stamped
    `measurement_details_omitted: true` at envelope/item level (snapshot
    keeps the exact v1 key set). Unknown versions are not served to that
    caller. Note: landing's exact-key normalizers drop a marked item today
    (fails closed); Stage B must accept the marker.
  - Automatic share: `reference_contribution_share_core` binds every
    automatic outcome (new share, re-share, new revision of an automatic
    row) to `private.reference_automatic_share_scope()` (v1 only); out of
    scope it writes nothing and returns `snapshot_version_unsupported`.
    Triggers and Share again ignore it; Stage 1B records
    `not_shareable:snapshot_version_unsupported`; the 2d deploy refresh
    ignores statuses. Consented refresh and grant unchanged.
  - Tests (local `supabase db reset` only): new
    `supabase/tests/reference_snapshot_version_public_reads_test.sql` passes;
    on the pre-stage definitions (reset without `20261001213000`) all 9
    blocks fail (A1-A4, F on sharing v2; B, C1 cascade from the automatic
    share; C2, D, E undefined opt-in signature).
    `supabase/tests/reference_snapshot_version_rollback_test.sh` passes:
    rollback state fingerprint equals a pre-stage reset exactly, forward
    re-apply identical. Existing SQL tests pass (public_observation_references,
    reference_measurement_content_extension, reference_snapshot_v2,
    shared_reference_{backfill,consent_grant,consent_data_step,default_on,roles,contributions,production_policy},
    taxon_identity_repair{,_label}); `shared_reference_rollback_test.sh`,
    `shared_reference_consent_concurrency_test.sh`,
    `taxon_identity_repair_concurrency_test.sh` pass. Two tests' privilege
    checks updated to the new signatures.
    `shared_reference_backfill_migration_test.sh` fails ("migration not
    applied") independently of Stage A: it pins max version
    `20261001113007` after `migration up`, already false at base since
    `20261001195524`.
  - `supabase migration list` not run: the worktree is not linked (no
    production access attempted).
  - Open: (1) an automatic row whose source becomes v2 keeps serving its
    last v1 revision (stale) rather than being withdrawn; withdrawal would
    need a new reason. (2) Percentile-core nulling is a policy choice beyond
    the brief; confirm. (3) Curated public reads
    (`reference_curated_public_envelope`) not made version-aware: curation
    still publishes v1 only. (4) Rolling back 2d after A drops the new
    Stage 1B status (unreachable then).
- 2026-10-01: Stage A approved at `4ad0c4f` (general + security). Follow-ups
  as new commits (PR #23 stays draft, nothing deployed):
  - `01113af`: a shared automatic row whose source becomes v2 is withdrawn
    with new reason `snapshot_version_unsupported` (event reason CHECK and
    `withdraw_shared_reference_contribution` redefined in `20261001213000`;
    no opt-out, so the Stage D refresh re-shares). Trigger/refresh paths do
    not error (set-update trigger exercised in the test). Rollback restores
    the helper and CHECK and refuses (55000) while events with the new
    reason exist. Tests: withdrawn tombstone (search nothing, get current
    nothing, get revision 1 a withdrawn stub for both callers); explicit v1
    revision 1 under a v2 current revision unchanged for both callers, the
    current one projected/marked or as stored; consented rows unchanged.
    Rollback test now asserts equality with the embedded pre-stage
    fingerprint (includes the helper and the CHECK). All Stage A and
    existing reference SQL tests and the three `.sh` tests pass after reset.
  - Owner-facing reason labels: web `src/shared-references.js` renders no
    withdrawal reason (tolerant). Desktop `_withdrawal_reason_label` was not
    found in `ui/reference_sharing_dialogs.py` or anywhere on
    `origin/feature/reference-sharing-consent-2b-desktop` (`86da707`) or
    other refs; desktop owners would see whatever its list renders for an
    unknown reason, to be checked when that UI lands.
  - Desktop public reads: a marked envelope makes the whole
    `search_shared_reference_contributions` page raise (see inventory row).
    Harmless before Stage D (no v2 exists); a Stage E/M prerequisite of D.
  - The Stage D plan requires widening the automatic scope in a migration
    deployed before `20260914090000` (or earlier in the same deploy), never
    after (corrected in the security re-review follow-up below).
- 2026-10-01: security re-review of `71583e4`: approved with two lows,
  fixed in a new commit: (1) the rollback no longer refuses on events with
  reason `snapshot_version_unsupported` (the events table is append-only, so
  the refusal could become permanent); it restores the prior withdrawal
  function but keeps the widened event reason CHECK (harmless superset),
  documented in the rollback header; the rollback test's expected
  fingerprint carries the widened CHECK. (2) Stage D wording corrected
  (widen before `20260914090000`, never after). Rollback test and Stage A
  SQL test pass after a local reset.
- 2026-10-02: **Stage A LIVE.** Deployed to production via the deploy tree
  (`20261001213000`). Smoke: v1 public reads byte-identical before/after;
  opt-in `[1,2]` identical on v1 data; invalid `[2]` → 22023.
- 2026-10-02: Stage M server candidate (implementation claim, not
  acceptance). Branch `feature/reference-v2-stage-m` from `1bda3c1`.
  - Migration `supabase/migrations/20261002120000_reference_client_capability_minimum.sql`;
    rollback `supabase/rollbacks/20261002120000_rollback.sql`. Not deployed.
  - Tests (local `supabase db reset` only): new
    `supabase/tests/reference_client_capability_test.sql` (blocks A-G:
    legacy reads, old-parser fixture, v1 unchanged, feed RPC, write refusal,
    creation guard incl. window edges, trust boundary) passes; on the
    pre-stage definitions (reset without `20261002120000`) all 7 blocks fail.
    `reference_client_capability_rollback_test.sh` passes (rollback
    fingerprint equals the pre-stage one in
    `reference_client_capability_rollback_pre_stage.txt`; forward re-apply
    identical). `reference_measurement_content_extension_test.sql` and
    `reference_snapshot_v2_test.sql` now declare `[1,2]` (they test the
    content validator). All reference/shared-reference/curation/taxon-repair
    SQL tests and the Stage A, 2d rollback and concurrency `.sh` tests pass.
  - Local stack note: calling a function created in the session (e.g.
    `pg_temp`) after `SET ROLE authenticated` segfaults the local backend;
    the test avoids it.
  - Next: desktop part (sporely-py): declare capabilities on both sync RPCs,
    read the two feeds through `list_reference_library_feed` when capable,
    call `record_reference_client_capabilities`, handle the two statuses and
    `withheld_count`. Web: no reference sync call today (Stage C).
- 2026-10-02: Stage M review fixes (security approve-with-fixes, general
  needs-changes) as new commits on `feature/reference-v2-stage-m`:
  curated forks of withheld sets withheld from legacy reads (restrictive
  policy) and served by `list_reference_library_feed('curated_fork')`;
  `withheld_count` only on a v1 caller's first page; predicates moved to
  non-exposed schema `reference_rls` without the `auth.uid() IS NULL`
  branch; nil device id and `1.0` versions → 22023; capable non-boolean
  `deleted` → `invalid_payload`; creation guard factored behind
  `private.reference_creation_blocked_by_older_client` (semantics
  unchanged); rollback header states it is safe only before any v2 content
  exists; contract text (full pull, status handling, retry noise of
  released desktops, export out of scope, feed does not refresh devices).
  Tests: block C now a v1-only owner (legacy reads and undeclared feed
  byte-identical to raw rows); new fixtures (deleted successor of a live
  enhanced set, deleted v1 use on a hidden set, live v1 predecessor of an
  enhanced successor, forks). All 7 blocks fail on pre-stage definitions;
  on the previous candidate `2e6f338` blocks A, B, C, D, E, G fail (fork,
  feed entity, withheld-count, deleted, schema fixes). Rollback test (new
  pre-stage fingerprint incl. fork policies/schema) and all reference SQL
  and `.sh` regression tests pass after local reset.
- 2026-10-02: owner decision on the post-upgrade lockout: guard unchanged,
  no override feature; operator script
  `supabase/reference-client-devices-clear-stale.sql` + shell test added.
  Perf fix (`caller_withheld_set_ids`, hashed NOT IN, partial index); numbers
  in Stage M design. Read-only production preflight: remote migrations =
  origin/main except deferred `20260914090000`, latest remote
  `20261001213000`, `20261002120000` absent; fingerprint of every object the
  migration touches (both write RPCs and their `_unthrottled`, policies on
  the three tables, sets indexes, table ACLs, `reference_rls`) is identical
  to the local pre-stage reset; none of the new object names exist in
  production. Production PostgREST exposes only `public` (PGRST106 for
  `Accept-Profile: reference_rls`). All Stage M and regression tests pass.
- 2026-10-02: Fix (outside the A–E stages), branch
  `fix/curated-fork-from-shared-contribution`, draft PR, nothing deployed.
  sporely-py PR #13's two-account harness showed every copy of a shared
  contribution pushed a curated fork that `sync_reference_curated_fork`
  rejected (`invalid_source`: it knew only legacy curated publications).
  `20261002150000_fork_from_shared_reference_contribution.sql` adds
  `reference_curated_forks.source_kind` (+ two generated per-kind FK
  columns: publication taxa as before, contribution revisions RESTRICT) and
  redefines the RPC: legacy path verbatim when a publication exists at the
  identity, else the contribution revision must be shared and served to the
  caller at creation and the stored envelope must equal the revision
  `envelope_json` exactly (marker `measurement_details_omitted` or live
  `relationship_roles` rejected). Owner decision (a): existing forks are not
  re-validated, so stop sharing / hide keep them (re-push `no_change`).
  Self-forks allowed (legacy has no rule). Rollback
  `supabase/rollbacks/20261002150000_rollback.sql` refuses while
  contribution forks exist. Test
  `supabase/tests/reference_curated_fork_from_contribution_test.sql`
  (10 checks fail on the old definition); legacy fork test passes on both.
